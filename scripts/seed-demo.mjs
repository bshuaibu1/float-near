#!/usr/bin/env node
/**
 * Seed the demo budget tree, with the swarm as VIRTUAL agents.
 *
 * Mirrors the shape v3.floatvault-12329.testnet has been demoing:
 *
 *   root
 *   ├── research ── r1, r2          overcommitted: r1+r2 > research
 *   └── swarm ───── s0 .. s15       16 siblings on one pool
 *
 * The difference is what an "agent" costs. On v3 each of the 16 swarm members
 * is a real NEAR sub-account created with 0.55 NEAR attached — 8.8 NEAR for the
 * swarm, and per docs/DEFERRED-agent-key-recovery.md that NEAR is stranded,
 * because an agent's only key is function-call scoped and cannot sign
 * DeleteAccount. Here each member is a keypair bound with `bind_virtual_agent`:
 * ~0.001 NEAR of contract state, and `unbind_virtual_agent` reclaims most of it.
 *
 * The overcommit is the point, not a mistake. 16 siblings each capped at the
 * whole swarm pool is what makes contention visible from `get_tree` alone —
 * `strict_allocation` is false on this vault precisely so the shared pool can
 * be demonstrated.
 *
 * Idempotent on re-run: labels that already exist are skipped rather than
 * duplicated, so a partial run can be finished without building a second tree.
 *
 * Usage: node scripts/seed-demo.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";

const VAULT = process.env.NEAR_VAULT_CONTRACT ?? "v4.floatv4.testnet";
const OWNER = process.env.NEAR_VAULT_OWNER ?? "floatv4.testnet";
const TOKEN = process.env.NEAR_VAULT_TOKEN ?? "ft.floatv4.testnet";
const PAYEE = process.env.NEAR_VAULT_PAYEE ?? "floatv4.testnet";
const KEYS_OUT = ".demo/swarm-virtual-keys.json";
const DRY = process.argv.includes("--dry-run");

const USDC = 1_000_000n; // 6dp
// fastnear, matching every other script in this repo. `rpc.testnet.near.org`
// is deprecated and answers a sustained run with
// `-429 WARNING! THIS ENDPOINT IS DEPRECATED!` partway through, which for a
// multi-transaction seed means a half-built tree.
const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const provider = new JsonRpcProvider({ url: RPC });

function ownerAccount() {
  const p = join(homedir(), ".near-credentials", "testnet", `${OWNER}.json`);
  const { private_key, secret_key } = JSON.parse(readFileSync(p, "utf8"));
  return new Account(OWNER, provider, new KeyPairSigner(KeyPair.fromString(private_key ?? secret_key)));
}

const view = (method, args = {}) => provider.callFunction({ contractId: VAULT, method, args });

/** Owner-only mutators are #[payable] with assert_one_yocto. */
async function ownerCall(acct, methodName, args) {
  return acct.callFunction({
    contractId: VAULT, methodName, args,
    gas: 50n * 10n ** 12n, deposit: 1n,
  });
}

const limits = (daily, perTx) => [{
  token: TOKEN,
  daily_cap: String(daily * USDC),
  per_tx_cap: String(perTx * USDC),
}];

async function main() {
  const tree = await view("get_tree");
  const byLabel = new Map(tree.map((n) => [n.label, n.id]));
  console.log(`${VAULT}: ${tree.length} existing nodes -> ${tree.map((n) => n.label).join(", ")}`);

  const root = byLabel.get("root");
  if (root === undefined) throw new Error("no root node; deploy and add_node a root first");

  // label, parent label, daily cap, per-tx cap, recipients
  // Children pass recipients:null so the allowlist is INHERITED from root —
  // exercising inheritance rather than restating the payee 20 times.
  const plan = [
    ["research", "root", 250, 50],
    ["r1", "research", 250, 50],
    ["r2", "research", 250, 50],
    ["swarm", "root", 250, 50],
    ...Array.from({ length: 16 }, (_, i) => [`s${i}`, "swarm", 250, 50]),
  ];

  if (DRY) {
    console.log("\n--dry-run, nothing will be sent:");
    for (const [label, parent, d, p] of plan) {
      console.log(`  ${byLabel.has(label) ? "skip (exists)" : "add_node     "} ${label.padEnd(9)} parent=${parent.padEnd(9)} daily=${d} perTx=${p}`);
    }
    console.log(`  bind 16 virtual agents to s0..s15`);
    return;
  }

  const acct = ownerAccount();

  // ---- the tree
  for (const [label, parentLabel, daily, perTx] of plan) {
    if (byLabel.has(label)) {
      console.log(`  skip   ${label} (already node ${byLabel.get(label)})`);
      continue;
    }
    const parent = byLabel.get(parentLabel);
    if (parent === undefined) throw new Error(`parent ${parentLabel} missing for ${label}`);
    const id = await ownerCall(acct, "add_node", {
      parent, label, limits: limits(BigInt(daily), BigInt(perTx)),
      cooldown_sec: 0, recipients: null,
    });
    byLabel.set(label, id);
    console.log(`  add    ${label.padEnd(9)} -> node ${id} (parent ${parentLabel}/${parent})`);
  }

  // ---- the swarm, as virtual agents
  //
  // Keys are generated here and written to .demo/ (gitignored). Each is bound
  // to its OWN node, mirroring v3's per-agent budgets. Many keys may also share
  // one node — that is what pubkey_to_node being many-to-one buys — but the
  // per-node shape is what makes the contention visible in get_tree.
  mkdirSync(".demo", { recursive: true });
  const existing = existsSync(KEYS_OUT) ? JSON.parse(readFileSync(KEYS_OUT, "utf8")) : {};
  for (let i = 0; i < 16; i++) {
    const label = `s${i}`;
    const nodeId = byLabel.get(label);
    let rec = existing[label];
    if (!rec) {
      const kp = KeyPair.fromRandom("ed25519");
      rec = { node_id: nodeId, public_key: kp.getPublicKey().toString(), secret_key: kp.toString() };
      existing[label] = rec;
      writeFileSync(KEYS_OUT, JSON.stringify(existing, null, 2) + "\n");
    }
    const bound = await view("get_virtual_agent_node", { public_key: rec.public_key });
    if (bound !== null && bound !== undefined) {
      console.log(`  skip   ${label} virtual agent (already bound to node ${bound})`);
      continue;
    }
    await ownerCall(acct, "bind_virtual_agent", { node_id: nodeId, public_key: rec.public_key });
    console.log(`  bind   ${label.padEnd(9)} virtual agent -> node ${nodeId}`);
  }

  // ---- prove it
  const after = await view("get_tree");
  const cfg = await view("get_config");
  console.log(`\n${VAULT}: ${after.length} nodes, owner ${cfg.owner}, clock ${cfg.clock_mode}`);
  console.log(`virtual agent keys -> ${KEYS_OUT} (gitignored)`);

  // The contention the tree is built to show, read back from chain rather than
  // asserted from the plan.
  const swarm = after.find((n) => n.label === "swarm");
  const kids = after.filter((n) => n.path?.includes(swarm.id));
  const sumKids = kids.reduce((a, n) => a + Number(n.limits.find((l) => l.token === TOKEN)?.daily_cap ?? 0), 0);
  const pool = Number(swarm.limits.find((l) => l.token === TOKEN)?.daily_cap ?? 0);
  console.log(
    `swarm pool ${pool / 1e6} vs ${kids.length} children summing ${sumKids / 1e6} ` +
    `-> ${(sumKids / pool).toFixed(0)}x overcommitted (this is the demo, not a bug)`,
  );
}

/**
 * `--prove`: demonstrate the shared pool actually binding, on chain.
 *
 * This is the claim the whole tree exists to make, and it is the one thing a
 * screenshot of `get_tree` cannot establish: that a sibling's spend is limited
 * by the POOL and not merely by its own cap. s0 spends the swarm pool dry at
 * its per-tx ceiling, then a DIFFERENT agent with its own untouched 250 cap is
 * refused — and refused with PARENT_DAILY_BUDGET rather than DAILY_BUDGET,
 * which is what distinguishes "this agent is out of budget" from "the pool it
 * shares is". Those two reason codes render as deliberately different
 * sentences in the dashboard; conflating them would make the hierarchy
 * invisible on screen.
 */
async function prove() {
  const keys = JSON.parse(readFileSync(KEYS_OUT, "utf8"));
  const { sign } = await import("../packages/create-float/bin/float-relay.mjs");
  const acct = ownerAccount();
  const nowNs = BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp);

  const spend = async (label, amountTokens, tag) => {
    const rec = keys[label];
    const nonce = Number(await view("get_virtual_agent_nonce", { public_key: rec.public_key }));
    const binding = {
      vault: VAULT, nonce,
      deadlineNs: String(nowNs + 3_600_000_000_000n),
      requestId: `demo-${tag}-${label}-${nonce}`,
      token: TOKEN, amount: String(BigInt(amountTokens) * USDC),
      recipient: PAYEE, memo: `swarm ${label}`, route: null,
    };
    const signed = sign(rec.secret_key, binding);
    const out = await acct.callFunctionRaw({
      contractId: VAULT, methodName: "request_payment_signed",
      args: {
        request_id: binding.requestId, token: binding.token, amount: binding.amount,
        recipient: binding.recipient, memo: binding.memo, route: null,
        public_key: signed.public_key, nonce, deadline_ns: binding.deadlineNs,
        signature: signed.signature,
      },
      gas: 100n * 10n ** 12n, deposit: 0n,
    });
    const sv = out.status?.SuccessValue;
    const o = sv !== undefined ? JSON.parse(Buffer.from(sv, "base64").toString()) : { status: "PANIC" };
    // THIS agent's own node, not a hardcoded one. An earlier version read
    // s0's budget for every row, so the s5 line printed "own avail 0" and
    // flatly contradicted the conclusion underneath it — the whole point being
    // that s5's own cap is untouched. A rendered number that argues against the
    // sentence beside it is worse than printing nothing.
    const own = await view("get_node_budget", { node_id: rec.node_id, token: TOKEN, day: null });
    const swarmPool = await view("get_node_budget", { node_id: 7, token: TOKEN, day: null });
    console.log(
      `  ${label.padEnd(4)} spend ${String(amountTokens).padStart(3)} -> ${o.reason_code.padEnd(21)}` +
      ` | ${label} own avail ${(Number(own.available) / 1e6).toString().padStart(4)}` +
      ` | SWARM POOL avail ${(Number(swarmPool.available) / 1e6).toString().padStart(4)}`,
    );
    return o.reason_code;
  };

  console.log("\n=== shared-pool contention, on chain ===");
  console.log("swarm pool = 250, each of s0..s15 capped at 250, per-tx 50\n");
  for (let i = 0; i < 5; i++) await spend("s0", 50, "fill");

  console.log("\n  s0 has now drained the shared pool. s5 has spent NOTHING and its own cap is untouched:");
  const code = await spend("s5", 50, "contend");

  console.log();
  if (code === "PARENT_DAILY_BUDGET") {
    console.log("PASS: s5 was refused by the POOL it shares, not by its own budget.");
    console.log("      PARENT_DAILY_BUDGET, not DAILY_BUDGET — the hierarchy is load-bearing.");
  } else {
    console.log(`UNEXPECTED: s5 got ${code}. Expected PARENT_DAILY_BUDGET.`);
    process.exitCode = 1;
  }
}

const run = process.argv.includes("--prove") ? prove : main;
run().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
