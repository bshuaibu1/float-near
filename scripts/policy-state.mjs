/**
 * Print the policy the CONTRACT actually enforces, for every node.
 *
 * Deliberately INDEPENDENT of the dashboard and of the adapter: it calls the
 * vault's own view methods over raw RPC. If this and the dashboard disagree,
 * the dashboard is wrong - which is the whole point of having a second
 * opinion that shares no code with the thing it checks.
 *
 *   node scripts/policy-state.mjs            # print current state
 *   node scripts/policy-state.mjs --save     # print and snapshot to .demo/
 *   node scripts/policy-state.mjs --diff     # print and diff against snapshot
 *
 * The intended use around a signature:
 *   1. node scripts/policy-state.mjs --save      (before signing)
 *   2. sign the transaction in the wallet
 *   3. node scripts/policy-state.mjs --diff      (after)
 *
 * A --diff showing no change is NOT proof the change failed: a view call at
 * final finality can trail a just-landed write. Re-run it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const RPC = process.env.NEAR_VAULT_RPC_URL || "https://test.rpc.fastnear.com";
const VAULT =
  process.env.NEAR_VAULT_CONTRACT || "work12-testnet-fleet.fac.floatv4.testnet";
const SNAP = ".demo/policy-snapshot.json";

async function view(method, args = {}) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: VAULT,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  if (j.result?.error) throw new Error(`${method}: ${j.result.error}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}

const cfg = await view("get_config");
const tree = await view("get_tree");

const state = {
  vault: VAULT,
  paused: cfg.paused,
  strict_allocation: cfg.strict_allocation,
  owner: cfg.owner,
  nodes: tree.map((n) => ({
    id: n.id,
    label: n.label,
    frozen: n.frozen,
    cooldown_sec: n.cooldown_sec,
    recipients: n.recipients ?? null,
    limits: (n.limits ?? []).map((l) => ({
      token: l.token,
      daily_cap: l.daily_cap,
      per_tx_cap: l.per_tx_cap,
    })),
  })),
};

console.log(`  vault   ${state.vault}`);
console.log(`  owner   ${state.owner}`);
console.log(`  paused  ${state.paused}        strict_allocation  ${state.strict_allocation}`);
console.log("");
for (const n of state.nodes) {
  console.log(
    `  node ${String(n.id).padEnd(3)} ${String(n.label).padEnd(14)} frozen=${String(n.frozen).padEnd(5)} cooldown=${String(n.cooldown_sec).padEnd(6)}`,
  );
  for (const l of n.limits) {
    console.log(`           limits  daily=${l.daily_cap}  per_tx=${l.per_tx_cap}  (${l.token})`);
  }
  console.log(`           recipients ${n.recipients ? n.recipients.join(", ") : "(inherit)"}`);
}

const flag = process.argv[2];

if (flag === "--save") {
  if (!existsSync(".demo")) mkdirSync(".demo", { recursive: true });
  writeFileSync(SNAP, JSON.stringify(state, null, 2));
  console.log(`\n  snapshot written to ${SNAP}`);
} else if (flag === "--diff") {
  if (!existsSync(SNAP)) {
    console.log(`\n  no snapshot at ${SNAP} - run with --save first`);
    process.exit(1);
  }
  const before = JSON.parse(readFileSync(SNAP, "utf8"));
  const diffs = [];
  // Recurse into ARRAYS as well as objects. Without the array branch the
  // whole `nodes` list was reported as a single changed value - a wall of
  // JSON in which the reader has to find the one field that moved, which is
  // exactly the work this script exists to do for them.
  const walk = (a, b, path) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[k], b[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    diffs.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  };
  walk(before, state, "");
  console.log("");
  if (!diffs.length) {
    console.log("  NO CHANGE since the snapshot.");
    console.log("  That is not proof a signature failed - a final-finality view can");
    console.log("  trail a just-landed write. Re-run this in a few seconds.");
  } else {
    console.log(`  ${diffs.length} field(s) changed since the snapshot:`);
    for (const d of diffs) console.log(`    ${d}`);
  }
}
