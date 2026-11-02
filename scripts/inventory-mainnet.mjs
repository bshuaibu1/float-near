#!/usr/bin/env node
/**
 * What is actually recoverable from the mainnet Float accounts, and in what
 * order must it come out?
 *
 * READ ONLY. This spends nothing and signs nothing.
 *
 * WHY THE ORDER MATTERS, and why this script exists before any teardown:
 *
 *   A NEAR account delete returns the NEAR balance. It does NOT return
 *   fungible tokens. USDC lives in the token contract's own ledger keyed by
 *   account id, so deleting `float.test015.near` leaves its USDC sitting in a
 *   row that no key can ever sign for again. Unrecoverable, permanently.
 *
 *   The same is true of the STORAGE DEPOSIT each account registers with the
 *   token contract (0.00125 NEAR each, typically). That is refundable, but
 *   only via `storage_unregister` BEFORE the account goes.
 *
 * So the teardown order is:
 *   1. ft_transfer every USDC balance out to a keeper account
 *   2. storage_unregister(force) to reclaim the registration deposit
 *   3. withdraw / delete the NEAR accounts
 *
 * Doing 3 first destroys 1 and 2.
 */
import { JsonRpcProvider } from "near-api-js";

const RPC = process.env.RPC ?? "https://free.rpc.fastnear.com";
const USDC = process.env.USDC ?? "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ROOT = process.env.ROOT ?? "test015.near";
const VAULT = process.env.VAULT ?? "float.test015.near";

const p = new JsonRpcProvider({ url: RPC });
const near = (y) => (Number(y) / 1e24).toFixed(5);
const usdc = (u) => (Number(u) / 1e6).toFixed(6);

const view = async (contractId, method, args = {}) => {
  try {
    return { ok: true, v: await p.callFunction({ contractId, method, args, blockQuery: { finality: "optimistic" } }) };
  } catch (e) {
    return { ok: false, e: String(e.message) };
  }
};
const acct = (id) => p.viewAccount({ accountId: id, blockQuery: { finality: "final" } }).catch(() => null);

// Candidates: the root, the vault, and every node account the vault names.
// Reading the tree rather than guessing names means a node added later is not
// silently missed when its balance is the thing being swept.
const candidates = new Set([ROOT, VAULT]);
const tree = await view(VAULT, "get_tree");
if (tree.ok) {
  for (const n of tree.v) if (n.account) candidates.add(n.account);
}
for (const extra of (process.env.EXTRA ?? "").split(",").filter(Boolean)) candidates.add(extra);

console.log(`\n  RPC   ${RPC}`);
console.log(`  USDC  ${USDC}`);
if (tree.ok) console.log(`  tree  ${tree.v.length} nodes, accounts: ${tree.v.filter((n) => n.account).map((n) => n.account).join(", ") || "(none)"}`);
else console.log(`  tree  UNREADABLE: ${tree.e.slice(0, 120)}`);

let totalNear = 0n;
let totalLocked = 0n;
let totalUsdc = 0n;
let totalStorage = 0n;

console.log(`\n  account                            NEAR free   stake-locked   USDC        ft-storage  keys`);
console.log(`  ${"-".repeat(104)}`);

for (const id of candidates) {
  const a = await acct(id);
  if (!a) {
    console.log(`  ${id.padEnd(34)} DOES NOT EXIST`);
    continue;
  }
  const amount = BigInt(a.amount);
  const locked = BigInt(a.storage_usage) * 10n ** 19n;
  const free = amount > locked ? amount - locked : 0n;

  const bal = await view(USDC, "ft_balance_of", { account_id: id });
  const u = bal.ok && bal.v ? BigInt(bal.v) : 0n;

  const st = await view(USDC, "storage_balance_of", { account_id: id });
  const sTotal = st.ok && st.v ? BigInt(st.v.total ?? 0) : 0n;

  const keys = await p.viewAccessKeyList({ accountId: id, blockQuery: { finality: "final" } }).catch(() => ({ keys: [] }));

  totalNear += free;
  totalLocked += locked;
  totalUsdc += u;
  totalStorage += sTotal;

  console.log(
    `  ${id.padEnd(34)} ${near(free).padStart(9)}   ${near(locked).padStart(12)}   ${usdc(u).padStart(9)}   ${near(sTotal).padStart(9)}   ${keys.keys.length}`,
  );
}

console.log(`  ${"-".repeat(104)}`);
console.log(`  ${"TOTAL".padEnd(34)} ${near(totalNear).padStart(9)}   ${near(totalLocked).padStart(12)}   ${usdc(totalUsdc).padStart(9)}   ${near(totalStorage).padStart(9)}`);

console.log(`\n  RECOVERABLE`);
console.log(`    free NEAR now               ${near(totalNear)}`);
console.log(`    NEAR locked as storage      ${near(totalLocked)}   (returned only by DELETING the accounts)`);
console.log(`    USDC                        ${usdc(totalUsdc)}   (MUST ft_transfer out BEFORE any delete)`);
console.log(`    ft storage registrations    ${near(totalStorage)}   (storage_unregister, also before delete)`);
console.log(`    ----`);
console.log(`    NEAR total if fully torn down ${near(totalNear + totalLocked + totalStorage)}`);

if (totalUsdc > 0n) {
  console.log(`\n  WARNING: ${usdc(totalUsdc)} USDC is still held.`);
  console.log(`  Deleting any account holding USDC strands it permanently — the token`);
  console.log(`  ledger keeps the row and no key will ever be able to sign for it again.`);
}
console.log();
