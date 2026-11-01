#!/usr/bin/env node
/**
 * What does a vault's STATE actually cost, per component?
 *
 * WHY. `create-float` asks for `codeStake(wasmBytes) + STATE_HEADROOM`, and
 * STATE_HEADROOM is a flat 0.35 NEAR chosen for safety. Under global contracts
 * the code term collapses from 2.996 to a measured 0.00214, which makes that
 * 0.35 the DOMINANT cost of a vault — about 160x everything else. Sizing it by
 * measurement instead of caution is therefore worth more after the global
 * contract change than before it.
 *
 * WHAT STOPPED THE OBVIOUS EXPERIMENT. The clean measurement is a fresh vault
 * with a flat tree, read straight after `new`. That needs 3.35 NEAR of testnet
 * funds to deploy, and this testnet pool holds ~2.7 NEAR in total with most of
 * it locked as storage stake behind existing contracts. So the base is derived
 * by DIFFERENTIAL on a live vault instead, which is cheaper and needs no faucet.
 *
 * THE METHOD. Add one node and measure; purge settled requests and measure.
 * Those give per-node and per-request costs directly. The remainder after
 * subtracting the measured components from the live total is the base — config,
 * collection prefixes and the root node.
 *
 * PURGING IS ALSO THE POINT, not just an instrument. It establishes that
 * request-ledger growth is RECLAIMABLE, which decides whether headroom has to
 * cover a vault's whole lifetime or only its active window.
 *
 * TESTNET ONLY. It mutates the tree and destroys settled request history.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const RPC = "https://test.rpc.fastnear.com";
const VAULT = process.env.VAULT ?? "approve.floatv4.testnet";
const OWNER = process.env.OWNER ?? "floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";

if (!VAULT.endsWith(".testnet")) {
  console.error(`FATAL: ${VAULT} is not testnet. This mutates state; testnet only.`);
  process.exit(2);
}

const p = new JsonRpcProvider({ url: RPC });
const signerFor = (a) => {
  const k = JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${a}.json`), "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
};
const owner = new Account(OWNER, p, signerFor(OWNER));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (m, args = {}) =>
  p.callFunction({ contractId: VAULT, method: m, args, blockQuery: { finality: "optimistic" } });

/**
 * Settled account state. Same discipline as everywhere else in this repo: a
 * `final` read right after a write can be a whole transaction behind, and here
 * the measured quantity IS a storage delta, so one early read would be reported
 * as a precise per-component cost.
 */
async function settled(tries = 60) {
  const QUIET_READS = 6;
  const QUIET_BLOCKS = 8n;
  let prev = null;
  let runStart = null;
  let run = 0;
  for (let i = 0; i < tries; i++) {
    const a = await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } });
    const s = {
      bytes: BigInt(a.storage_usage),
      amount: BigInt(a.amount),
      height: BigInt(a.block_height),
    };
    if (prev && s.bytes === prev.bytes && s.amount === prev.amount) {
      run += 1;
      runStart ??= prev;
      if (run >= QUIET_READS && s.height - runStart.height >= QUIET_BLOCKS) return s;
    } else {
      run = 0;
      runStart = null;
    }
    prev = s;
    await wait(800);
  }
  throw new Error("the vault never stopped moving — refusing to report a figure");
}

const B = (bytes) => `${bytes} B = ${(Number(bytes) / 1e5).toFixed(5)} NEAR`;
const CODE = 299620n;

console.log(`vault ${VAULT} on testnet`);
const s0 = await settled();
const tree0 = await view("get_tree");
const reqs0 = await view("list_requests", { from_index: 0, limit: 100 });
console.log(`  storage ${s0.bytes} B, code ${CODE} => STATE ${s0.bytes - CODE} B`);
console.log(`  ${tree0.length} nodes, ${reqs0.length} stored requests`);

// ---- per-node
console.log("\n[1] PER-NODE cost — add one leaf, measure");
let nodeCost = null;
try {
  const id = await owner.callFunction({
    contractId: VAULT,
    methodName: "add_node",
    args: {
      parent: 0,
      label: "measure-tmp",
      limits: [{ token: TOKEN, daily_cap: "1000000", per_tx_cap: "1000000" }],
      cooldown_sec: 0,
      recipients: null,
    },
    gas: 60n * 10n ** 12n,
    deposit: 1n,
  });
  const s1 = await settled();
  nodeCost = s1.bytes - s0.bytes;
  console.log(`  added node ${JSON.stringify(id)}`);
  console.log(`  storage ${s0.bytes} -> ${s1.bytes}   PER NODE ${B(nodeCost)}`);
  console.log(`  (one token limit, no recipients, 11-char label)`);
} catch (e) {
  console.log(`  FAILED: ${String(e.message).slice(0, 180)}`);
}

// ---- per-request, via purge
console.log("\n[2] PER-REQUEST cost — purge settled requests, measure the reclaim");
let reqCost = null;
const sBefore = await settled();
try {
  const today = Number(await view("current_day"));
  // before_day = today, so only requests from PREVIOUS days are eligible —
  // today's are left alone, which keeps the run idempotent-ish.
  const purged = await owner.callFunction({
    contractId: VAULT,
    methodName: "purge_settled",
    args: { before_day: today, limit: 20 },
    gas: 120n * 10n ** 12n,
    deposit: 1n,
  });
  const n = Number(purged);
  const sAfter = await settled();
  const freed = sBefore.bytes - sAfter.bytes;
  console.log(`  purged ${n} request(s)`);
  console.log(`  storage ${sBefore.bytes} -> ${sAfter.bytes}   freed ${B(freed)}`);
  if (n > 0) {
    reqCost = freed / BigInt(n);
    console.log(`  PER REQUEST ${B(reqCost)}`);
    console.log(`  -> request-ledger growth IS reclaimable by the owner`);
  } else {
    console.log(`  nothing eligible (all requests are from today) — per-request not measured here`);
  }
} catch (e) {
  console.log(`  FAILED: ${String(e.message).slice(0, 180)}`);
}

// ---- what it means
console.log("\n[3] WHAT A FLAT VAULT NEEDS");
const sNow = await settled();
const treeNow = await view("get_tree");
const reqsNow = await view("list_requests", { from_index: 0, limit: 100 });
const stateNow = sNow.bytes - CODE;
console.log(`  live state ${B(stateNow)} across ${treeNow.length} nodes, ${reqsNow.length} requests`);

if (nodeCost !== null && reqCost !== null) {
  // base = everything that is not a non-root node and not a request record.
  const base = stateNow - nodeCost * BigInt(treeNow.length - 1) - reqCost * BigInt(reqsNow.length);
  console.log(`  minus ${treeNow.length - 1} non-root nodes at ${nodeCost} B`);
  console.log(`  minus ${reqsNow.length} requests at ${reqCost} B`);
  console.log(`  => BASE (config + prefixes + root node) ${B(base)}`);
  console.log("");
  const flat = base;
  console.log(`  a FLAT vault at rest:            ${B(flat)}`);
  for (const n of [10, 50, 100]) {
    console.log(`  flat + ${String(n).padStart(3)} unpurged payments:  ${B(flat + reqCost * BigInt(n))}`);
  }
  console.log("");
  console.log(`  current STATE_HEADROOM is 0.35 NEAR = ${35000n} B`);
  const covered = (35000n - flat) / reqCost;
  console.log(`  which covers the base plus ~${covered} unpurged payments`);
} else {
  console.log(`  not enough components measured to derive the base this run`);
}

console.log("\n[4] CLEANUP — remove the temporary node");
try {
  const t = await view("get_tree");
  const tmp = t.find((n) => n.label === "measure-tmp");
  if (!tmp) console.log("  no measure-tmp node found");
  else {
    // FREEZE FIRST. `remove_node` refuses an unfrozen node —
    // "freezing is what stops new reservations" — so removal is deliberately a
    // two-step operation. The first version of this cleanup called remove_node
    // directly and left the temporary node behind on a live vault.
    await owner.callFunction({
      contractId: VAULT,
      methodName: "freeze_node",
      args: { node_id: tmp.id, frozen: true },
      gas: 60n * 10n ** 12n,
      deposit: 1n,
    });
    await owner.callFunction({
      contractId: VAULT,
      methodName: "remove_node",
      args: { node_id: tmp.id },
      gas: 60n * 10n ** 12n,
      deposit: 1n,
    });
    const sEnd = await settled();
    console.log(`  removed node ${tmp.id}; storage now ${sEnd.bytes} B (state ${sEnd.bytes - CODE} B)`);
  }
} catch (e) {
  console.log(`  cleanup FAILED: ${String(e.message).slice(0, 180)} — measure-tmp may remain`);
}
