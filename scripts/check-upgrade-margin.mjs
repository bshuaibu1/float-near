#!/usr/bin/env node
/**
 * Refuses an upgrade that will not fit the account's balance.
 *
 * NEAR locks `storage_usage * 1e19` yocto. A deploy changes usage by the
 * code-size delta, so a bigger contract raises the locked amount — and if that
 * exceeds the balance, the deploy fails with LackBalanceForState.
 *
 * Measured 2026-10-31: the approval gate grew the vault 284,572 -> 299,016
 * bytes. On float.test015.near that took locked from 2.90165 to 3.04609 against
 * a 2.98807 balance — SHORT by 0.05802. upgrade-vault.sh had no balance check,
 * so it would have sent the deploy and failed in flight. Atomic, so nothing
 * breaks, but on a live mainnet vault that reads as a broken upgrade rather
 * than "top the account up first".
 *
 * Exits 1 with the exact top-up when it will not fit, so the caller can stop
 * before spending anything.
 *
 *   node scripts/check-upgrade-margin.mjs <vault> <wasm> [rpcUrl] [headroomNear]
 */
import { statSync } from "node:fs";
import { JsonRpcProvider } from "near-api-js";
import { storageMargin } from "../packages/create-float/bin/funding.mjs";

const [vault, wasm, rpc = "https://free.rpc.fastnear.com", headroomNear = "0.1"] =
  process.argv.slice(2);
if (!vault || !wasm) {
  console.error("usage: node scripts/check-upgrade-margin.mjs <vault> <wasm> [rpc] [headroomNear]");
  process.exit(2);
}

const p = new JsonRpcProvider({ url: rpc });
const near = (y) => (Number(y) / 1e24).toFixed(5);

const acct = await p.viewAccount({ accountId: vault });
// The DEPLOYED code, measured rather than assumed from a KB figure in a doc.
const deployed = await p.viewContractCode({ contractId: vault });
const oldCodeBytes = BigInt(Buffer.from(deployed.code_base64, "base64").length);
const newCodeBytes = BigInt(statSync(wasm).size);
const headroom = BigInt(Math.round(Number(headroomNear) * 1e6)) * 10n ** 18n;

const m = storageMargin({
  balance: BigInt(acct.amount),
  storageUsage: BigInt(acct.storage_usage),
  oldCodeBytes,
  newCodeBytes,
  headroom,
});

console.log(`  vault           ${vault}`);
console.log(`  balance         ${near(acct.amount)} NEAR`);
console.log(`  storage_usage   ${acct.storage_usage} bytes -> locked ${near(BigInt(acct.storage_usage) * 10n ** 19n)}`);
console.log(`  deployed code   ${oldCodeBytes} bytes`);
console.log(`  new code        ${newCodeBytes} bytes  (delta ${m.deltaBytes >= 0n ? "+" : ""}${m.deltaBytes})`);
console.log(`  locked after    ${near(m.lockedAfter)} NEAR`);
console.log(`  margin after    ${near(m.margin)} NEAR`);

if (m.fits && m.topUp === 0n) {
  console.log(`  VERDICT         fits, with ${headroomNear} NEAR headroom to spare`);
  process.exit(0);
}
console.error("");
console.error(`  VERDICT         WILL NOT FIT${m.fits ? " with the requested headroom" : ""}`);
console.error(`  top up ${vault} by at least ${near(m.topUp)} NEAR before deploying.`);
console.error("");
console.error("  Note this is the SHORTFALL, not the code-size delta — the account");
console.error("  may already carry headroom, so the two differ.");
process.exit(1);
