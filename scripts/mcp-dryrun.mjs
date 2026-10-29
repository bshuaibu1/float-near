#!/usr/bin/env node
/**
 * Exercise the MCP server the way an AI agent does: over stdio, as JSON-RPC.
 *
 * WHY NOT JUST IMPORT ITS FUNCTIONS. packages/float-adapter does that, and it
 * proves the library works — not that the SERVER does. The MCP surface is a
 * process boundary with its own framing, tool schemas, env parsing and error
 * mapping, and a demo that puts Claude in front of it depends on all four. The
 * whole point of this file is that nothing here imports the package: it spawns
 * `dist/server.js` and talks to it exactly as a client would.
 *
 * Read-only by default. `--pay <amount>` spends real money on mainnet.
 *
 * Usage:
 *   node scripts/mcp-dryrun.mjs
 *   node scripts/mcp-dryrun.mjs --plan-agent 2 --sub-label r1
 *   node scripts/mcp-dryrun.mjs --pay 0.10 --rail intents --to 0x…
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryVerdict, deliveryLine } from "../packages/create-float/bin/delivery.mjs";
import { toBaseUnits } from "../packages/create-float/bin/tree.mjs";

/** USDC is 6dp. Only ever used for display. */
const fmtUsdc = (n) => `${(Number(n) / 1e6).toFixed(6)} USDC`;

const SERVER = "packages/mcp/dist/server.js";
if (!existsSync(SERVER)) {
  console.error(`${SERVER} not found — run: npm run build --workspace @near-vault/mcp`);
  process.exit(2);
}

const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PAY = arg("--pay");
/**
 * `near` by default, matching the MCP tool's own default — and that is the
 * safer one for a reason worth stating.
 *
 * rail=intents NOW WORKS in the repo, and the reason it did not is worth
 * keeping. 1Click's deposit address is a fresh implicit account that must be
 * registered on the token before it can receive (KNOWN-TRADEOFFS §13), and
 * registering means calling storage_deposit on the TOKEN. The agent key is a
 * function-call key pinned to receiver_id=<vault> and
 * method_names=["request_payment"] — verified on chain — so it structurally
 * cannot make that call, and MCP holds no other key.
 *
 * That is the agent/operator split working as designed, not a defect: an agent
 * is not supposed to be able to pay a token contract for storage. The fix was
 * therefore NOT to widen the key. The VAULT now registers the address itself,
 * from its own balance, as the first link in the Intents promise chain — the
 * only party that can, since it already holds NEAR and already knows the
 * address. See KNOWN-TRADEOFFS §13g.
 *
 * CAVEAT WORTH CHECKING BEFORE TRUSTING --rail intents AGAINST MAINNET: that
 * change is in the repo, not necessarily on the deployed contract. A vault
 * running an older build still answers TRANSFER_FAILED. Redeploy with
 * NO_MIGRATE=1 (no struct field changed) before relying on it.
 */
const RAIL = arg("--rail", "near");
const TO = arg("--to", "0xba82e1acf6058d345e083624b4f841b25f755449");
const PLAN_AGENT = arg("--plan-agent");   // node id to attach the agent to
const SUB_LABEL = arg("--sub-label", "r1");

// The agent credentials the MCP server signs with. Written by whatever created
// the agent account; absent until then, and the read-only tools do not need it.
const STATE = join(".float", "mainnet-intents.json");
const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};

/**
 * The quote-signer key, from .float/adapter.env.
 *
 * `rail=intents` needs it: it binds the payee to the one-time deposit address,
 * and without it the vault refuses with QUOTE_SIGNER_UNSET. It is the
 * OPERATOR's key, not an agent's — which is exactly why this harness may load
 * it and an agent's environment may not. scripts/intents-pay.mjs reads the same
 * file for the same reason.
 *
 * Never printed, and never passed as an argument. It goes into the child's
 * environment and nowhere else; the only thing reported is whether it is there.
 */
function quoteSignerKey() {
  const p = join(".float", "adapter.env");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^FLOAT_QUOTE_SIGNER_KEY=(.+)$/m);
  return m ? m[1].trim() : null;
}
const QUOTE_KEY = process.env.FLOAT_QUOTE_SIGNER_KEY ?? quoteSignerKey();

// ---- the far side of an Intents payment
//
// `verify` on the NEAR side only proves the transfer to the deposit address
// landed. Whether a solver delivered on Base is off-chain and has to be read
// from Base, and reading it has gone wrong three times — see
// packages/create-float/bin/delivery.mjs for which three. The rules those
// produced: the transfer EVENT decides, a failed query is not an empty one, and
// the block number to scan from is captured BEFORE paying.
const BASE_RPCS = [
  // publicnode first: mainnet.base.org rate-limits eth_getLogs with HTTP 429,
  // which is the exact failure that once got read as "nothing was delivered".
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
];
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Throws on anything that is not a real answer. Never returns a default. */
async function baseCall(method, params) {
  let last;
  for (const rpc of BASE_RPCS) {
    try {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 90));
      if (j.result === undefined || j.result === null) throw new Error("null result");
      return j.result;
    } catch (e) {
      last = `${rpc}: ${e.message}`;
    }
  }
  throw new Error(last ?? "no endpoint");
}

const baseBlock = async () => BigInt(await baseCall("eth_blockNumber", []));

async function baseBalance(addr) {
  const data = `0x70a08231${"0".repeat(24)}${addr.replace(/^0x/, "")}`;
  return BigInt(await baseCall("eth_call", [{ to: BASE_USDC, data }, "latest"]));
}

/** Inbound USDC transfers to `addr` since `fromBlock`, or NULL if unreadable. */
async function inboundSince(addr, fromBlock) {
  try {
    const logs = await baseCall("eth_getLogs", [
      {
        address: BASE_USDC,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: "latest",
        topics: [TRANSFER_TOPIC, null, `0x${"0".repeat(24)}${addr.replace(/^0x/, "")}`],
      },
    ]);
    return logs.map((l) => ({
      amount: BigInt(l.data),
      tx: l.transactionHash,
      block: BigInt(l.blockNumber),
    }));
  } catch {
    // NULL, not []. deliveryVerdict treats these as different states precisely
    // because collapsing them is how a 429 became "not delivered".
    return null;
  }
}

const env = {
  ...process.env,
  NEAR_VAULT_CONTRACT: process.env.NEAR_VAULT_CONTRACT ?? "float.test015.near",
  NEAR_VAULT_NETWORK: process.env.NEAR_VAULT_NETWORK ?? "mainnet",
  NEAR_VAULT_RPC_URL: process.env.NEAR_VAULT_RPC_URL ?? "https://free.rpc.fastnear.com",
  NEAR_VAULT_TOKEN:
    process.env.NEAR_VAULT_TOKEN ??
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  NEAR_VAULT_TOKEN_DECIMALS: process.env.NEAR_VAULT_TOKEN_DECIMALS ?? "6",
  ...(st.agentAccountId ? { NEAR_VAULT_AGENT_ID: st.agentAccountId } : {}),
  ...(st.agentAccountKey ? { NEAR_VAULT_AGENT_KEY: st.agentAccountKey } : {}),
  ...(QUOTE_KEY ? { FLOAT_QUOTE_SIGNER_KEY: QUOTE_KEY } : {}),
};

const child = spawn(process.execPath, [SERVER], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (b) => (stderr += b.toString()));

// MCP over stdio is NEWLINE-DELIMITED JSON-RPC, one message per line.
let buf = "";
const pending = new Map();
child.stdout.on("data", (b) => {
  buf += b.toString();
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // a stray log line is not a protocol message
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 45_000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms. stderr:\n${stderr.slice(-400)}`));
    }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
  });
}
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

/** Tool results come back as content parts; pull the text out. */
const textOf = (res) =>
  (res?.result?.content ?? []).map((c) => c.text ?? "").join("").trim() ||
  JSON.stringify(res?.result ?? res?.error ?? res);

async function call(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) return { ok: false, text: JSON.stringify(r.error) };
  // A tool can succeed at the protocol level and still report a failure.
  return { ok: !r.result?.isError, text: textOf(r) };
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-dryrun", version: "0" },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  console.log(`  server     : ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version ?? ""}`);
  notify("notifications/initialized", {});

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  console.log(`  tools      : ${tools.map((t) => t.name).join(", ")}`);

  const hasAgent = Boolean(env.NEAR_VAULT_AGENT_ID && env.NEAR_VAULT_AGENT_KEY);
  console.log(`  agent key  : ${hasAgent ? env.NEAR_VAULT_AGENT_ID : "ABSENT — vault_pay will refuse"}`);
  // Presence only. The value is the operator's signing key and belongs in the
  // child's environment, not in a terminal someone might paste into an issue.
  console.log(
    `  quote key  : ${QUOTE_KEY ? "present (.float/adapter.env)" : "ABSENT — rail=intents will refuse"}`,
  );

  console.log("\n  --- read-only tools against mainnet");
  for (const [name, args] of [
    ["vault_config", {}],
    ["vault_tree", {}],
    ["vault_budget", { nodeId: 0 }],
  ]) {
    const r = await call(name, args);
    const body = r.text.replace(/\s+/g, " ").slice(0, 200);
    console.log(`  ${r.ok ? "ok  " : "FAIL"} ${name.padEnd(14)} ${body}`);
  }

  if (PLAN_AGENT) {
    /**
     * Create the agent sub-account MCP signs with — via MCP's own planner.
     *
     * MCP holds ONLY the agent key, never the owner's, so it cannot create an
     * agent itself. `vault_plan_create_agent` returns an UNSIGNED payload and
     * the owner signs it elsewhere. That separation is the reason an agent
     * compromise cannot escalate, and it is worth seeing rather than asserting.
     *
     * The keypair is generated HERE and the secret saved BEFORE the owner runs
     * anything. Generating it after the account existed would mean an account
     * whose key we never held.
     */
    const { KeyPair } = await import("near-api-js");
    const kp = KeyPair.fromRandom("ed25519");
    const pub = kp.getPublicKey().toString();
    const r = await call("vault_plan_create_agent", {
      nodeId: Number(PLAN_AGENT),
      subLabel: SUB_LABEL,
      publicKey: pub,
      keyAllowanceNear: "0.5",
    });
    console.log(`\n  --- vault_plan_create_agent node ${PLAN_AGENT} as "${SUB_LABEL}"`);
    console.log(`  ${r.ok ? "ok" : "FAIL"}\n${r.text.slice(0, 1400)}`);
    if (r.ok) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(".float", { recursive: true });
      st.agentAccountId = `${SUB_LABEL}.${env.NEAR_VAULT_CONTRACT}`;
      st.agentAccountKey = kp.toString();
      st.agentAccountNode = Number(PLAN_AGENT);
      writeFileSync(STATE, JSON.stringify(st, null, 2) + "\n");
      console.log(`\n  secret saved to ${STATE} (gitignored) for ${st.agentAccountId}`);
      console.log("  Run the owner transaction above, then re-run this script to confirm.");
    }
  } else if (!PAY) {
    console.log("\n  read-only dry run complete. Add --pay <amount> to spend.");
  } else if (!hasAgent) {
    console.log("\n  --pay requested but no agent account is configured.");
    console.log("  MCP signs request_payment with a RESTRICTED function-call key belonging");
    console.log("  to a real agent sub-account. A virtual agent key cannot be used here:");
    console.log("  it signs request_payment_signed, a different method with a different");
    console.log("  authorisation model. Create one first.");
    process.exitCode = 1;
  } else {
    console.log(`\n  --- vault_pay ${PAY} via ${RAIL} to ${TO}  (REAL MONEY)`);
    if (RAIL === "intents") {
      console.log("  NOTE: the VAULT registers the deposit address as the first link in");
      console.log("        the promise chain, from its own balance (0.00125 NEAR). The");
      console.log("        agent key still cannot touch the token — see KNOWN-TRADEOFFS 13g.");
    }
    // THE BEFORE-PICTURE, taken before the money moves. Best effort: a Base RPC
    // hiccup must not abort a payment whose NEAR side is ready.
    let fromBlock = null;
    let beforeBalance = null;
    if (RAIL === "intents") {
      try {
        [fromBlock, beforeBalance] = await Promise.all([baseBlock(), baseBalance(TO)]);
        console.log(`  payee on Base  : ${fmtUsdc(beforeBalance)} at block ${fromBlock} (before)`);
      } catch (e) {
        console.log(`  payee on Base  : unavailable (${String(e.message).slice(0, 60)})`);
      }
    }

    const r = await call("vault_pay", { amount: PAY, recipient: TO, rail: RAIL, memo: "mcp dry run" });
    console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.text.slice(0, 600)}`);
    if (!r.ok) process.exitCode = 1;

    if (r.ok && RAIL === "intents" && fromBlock != null) {
      const expected = toBaseUnits(PAY, 6, "amount");
      const etaMs = 90_000;
      const started = Date.now();
      let v;
      for (;;) {
        const inbound = await inboundSince(TO, fromBlock);
        v = deliveryVerdict({
          inbound,
          expected,
          beforeBalance,
          afterBalance: await baseBalance(TO).catch(() => null),
          elapsedMs: Date.now() - started,
          etaMs,
        });
        if (v.state !== "pending") break;
        process.stdout.write("  waiting for the solver...\r");
        await new Promise((res) => setTimeout(res, 5000));
      }
      console.log(`  ${deliveryLine(v, fmtUsdc)}`);
      if (v.state === "short" || v.state === "not-seen") process.exitCode = 1;
    }
  }
} catch (err) {
  console.error("  ERROR:", err.message);
  if (stderr.trim()) console.error("  server stderr:\n" + stderr.trim().slice(-600));
  process.exitCode = 1;
} finally {
  child.kill();
}
