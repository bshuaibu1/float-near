#!/usr/bin/env node
/**
 * Proves that a contract upgrade preserved the vault's state.
 *
 * The upgrade this was written for adds `propose_owner`, `accept_ownership`,
 * `get_pending_owner` and `withdraw`. It keeps the pending owner under its own
 * storage key rather than as a `Vault` field precisely so the borsh layout is
 * unchanged and the live vault's tree, ledgers and payment history survive a
 * plain redeploy. That is a CLAIM. This script is what turns it into a
 * checked fact, by snapshotting before and comparing after.
 *
 * One trap it exists to avoid. Probing for a new method by calling it and
 * checking for a non-null answer does not work: `get_pending_owner` returns
 * null when nothing is pending, and a method that does not exist also comes
 * back empty through a naive client. "The method is absent" and "the method
 * says no" are the same output unless you look at the RPC error itself. So
 * presence is decided on MethodNotFound, never on the value.
 *
 *   node scripts/verify-upgrade.mjs snapshot   # before deploying
 *   node scripts/verify-upgrade.mjs verify     # after deploying
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const VAULT = process.env.NEAR_VAULT_CONTRACT ?? "v3.floatvault-12329.testnet";
const SNAP = process.env.UPGRADE_SNAPSHOT ?? ".demo/upgrade-snapshot.json";

const mode = process.argv[2];
if (!["snapshot", "verify"].includes(mode)) {
  console.error("usage: verify-upgrade.mjs <snapshot|verify>");
  process.exit(2);
}

/**
 * A view call that reports WHY it failed, so a missing method is
 * distinguishable from a method that legitimately returned null.
 * Returns {ok:true, value} | {ok:false, missing:boolean, error:string}.
 */
async function view(method, args = {}) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
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
  const j = await r.json();
  const err = j.error ?? j.result?.error;
  if (err) {
    const text = typeof err === "string" ? err : JSON.stringify(err);
    return { ok: false, missing: /MethodNotFound|MethodResolveError/i.test(text), error: text };
  }
  return { ok: true, value: JSON.parse(Buffer.from(j.result.result).toString()) };
}

async function capture() {
  const cfg = await view("get_config");
  const tree = await view("get_tree");
  const reqs = await view("list_requests", { from_index: 0, limit: 100 });
  if (!cfg.ok || !tree.ok || !reqs.ok) {
    throw new Error(`cannot read vault state: ${cfg.error ?? tree.error ?? reqs.error}`);
  }
  return {
    vault: VAULT,
    owner: cfg.value.owner,
    paused: cfg.value.paused,
    strictAllocation: cfg.value.strict_allocation,
    nodeCount: tree.value.length,
    nodeIds: tree.value.map((n) => n.id).sort((a, b) => a - b),
    nodeLabels: tree.value.map((n) => `${n.id}:${n.label}`),
    requestCount: reqs.value.length,
    requestIds: reqs.value.map((r) => r.request_id).sort(),
  };
}

if (mode === "snapshot") {
  const s = await capture();
  mkdirSync(".demo", { recursive: true });
  writeFileSync(SNAP, JSON.stringify(s, null, 2) + "\n");
  console.log(`Snapshot of ${VAULT} BEFORE upgrade:`);
  console.log(`  owner ${s.owner}  nodes ${s.nodeCount}  requests ${s.requestCount}`);
  console.log(`  -> ${SNAP}`);
  process.exit(0);
}

// ---- verify
if (!existsSync(SNAP)) {
  console.error(`FATAL: no snapshot at ${SNAP}. Run 'snapshot' BEFORE deploying.`);
  console.error("       Without a before-picture, 'state survived' is unfalsifiable.");
  process.exit(1);
}
const before = JSON.parse(readFileSync(SNAP, "utf8"));
const after = await capture();

let bad = 0;
const cmp = (field, a, b) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) bad++;
  const show = (x) => (Array.isArray(x) ? `[${x.length} items]` : String(x));
  console.log(`  ${same ? "ok  " : "DRIFT"} ${field.padEnd(18)} before=${show(a)}  after=${show(b)}`);
};

console.log(`State comparison for ${VAULT}:`);
cmp("owner", before.owner, after.owner);
cmp("paused", before.paused, after.paused);
cmp("strictAllocation", before.strictAllocation, after.strictAllocation);
cmp("nodeCount", before.nodeCount, after.nodeCount);
cmp("nodeIds", before.nodeIds, after.nodeIds);
cmp("nodeLabels", before.nodeLabels, after.nodeLabels);
cmp("requestCount", before.requestCount, after.requestCount);
cmp("requestIds", before.requestIds, after.requestIds);

// ---- the new surface must actually be callable.
console.log("\nNew methods (presence decided by MethodNotFound, not by value):");
const EXPECTED = ["get_pending_owner"];
for (const m of EXPECTED) {
  const r = await view(m);
  if (r.ok) console.log(`  ok    ${m.padEnd(18)} present, returned ${JSON.stringify(r.value)}`);
  else if (r.missing) {
    bad++;
    console.log(`  ABSENT ${m.padEnd(18)} MethodNotFound — the new wasm is NOT live`);
  } else {
    bad++;
    console.log(`  ERROR ${m.padEnd(18)} ${r.error.slice(0, 90)}`);
  }
}

// ---- Build-health probe: did panic messages survive?
//
// near-sdk picks its host functions by cfg. Built with cargo-near it gets the
// real ones; built with a plain `cargo build --target wasm32-unknown-unknown`
// it silently links pure-Rust fallbacks and `env::panic_str` never reaches the
// host. Every panic then arrives as "WebAssembly trap: unreachable opcode" and
// every reason code this vault's UX depends on is gone — while the contract
// still appears to work.
//
// A read-only call of a #[payable] method executes far enough to hit
// `assert_one_yocto` and panic, and the RPC returns the text. Costs nothing,
// needs no key, and distinguishes the two builds exactly.
{
  const probe = await view("set_paused", { paused: true });
  const text = probe.ok ? "<no panic — unexpected>" : probe.error;
  const readable = /yoctoNEAR|GuestPanic/i.test(text);
  const dead = /unreachable/i.test(text);
  if (!readable || dead) bad++;
  console.log("\nPanic-message health (plain-cargo builds destroy this silently):");
  console.log(`  ${readable && !dead ? "ok   " : "BROKEN"} ${text.slice(0, 110)}`);
}

// The clock guard, repeated here so verification is self-contained.
const clock = await view("clock_mode");
const clockOk = clock.ok && clock.value === "production";
if (!clockOk) bad++;
console.log(
  `\nClock: expected='production' actual=${clock.ok ? `'${clock.value}'` : `<${clock.error?.slice(0, 50)}>`}`,
);

console.log(
  bad === 0
    ? "\nPASS: state intact, new methods live, production clock."
    : `\nFAIL: ${bad} problem(s) above.`,
);
process.exit(bad === 0 ? 0 : 1);
