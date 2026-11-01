#!/usr/bin/env node
/**
 * Recover testnet NEAR locked as storage stake in superseded accounts.
 *
 * WHY. Most of this pool's balance is not spendable: it is staked behind
 * contracts on accounts we no longer use. Measured 2026-11-01, 12.83 NEAR
 * existed across the pool while `floatv4.testnet` had 0.38 FREE, which is not
 * enough to run the factory validation (needs 1.39). Deleting an account
 * returns its ENTIRE balance, stake included, to a beneficiary.
 *
 * WHAT IS AND IS NOT SUPERSEDED, measured rather than remembered:
 *
 *   approve.floatv4.testnet      299,620 B  the CURRENT generation, byte-identical
 *                                           to mainnet. The testnet mirror. KEEP.
 *   v4.floatv4.testnet           280,249 B  an OLDER generation with no
 *                                           NEAR_BUDGET, no PARENT_COOLDOWN and no
 *                                           approval gate -- precisely why
 *                                           `approve` was chosen over it for the
 *                                           self-submit work. Superseded.
 *   v3.floatvault-12329.testnet  253,190 B  the untouched working demo, and a
 *                                           DIFFERENT owner. Never touch.
 *   ft.floatv4.testnet           the mock FT every vault test transfers. KEEP.
 *
 * TESTNET ONLY, and the deny list is the real guard: deletion is irreversible,
 * so the accounts that must survive are named explicitly and checked before
 * anything is signed, rather than relying on the delete list being right.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const RPC = "https://test.rpc.fastnear.com";
const BENEFICIARY = "floatv4.testnet";

/** Accounts that must NEVER be deleted, whatever the delete list says. */
const KEEP = new Set([
  "floatv4.testnet", // the parent and beneficiary
  "approve.floatv4.testnet", // current-generation vault, mirrors mainnet
  "ft.floatv4.testnet", // the mock FT the vault tests transfer
  "v3.floatvault-12329.testnet", // the untouched working demo
]);

const DELETE = [
  "v4.floatv4.testnet",
  "ga155544.floatv4.testnet",
  "gb155544.floatv4.testnet",
  "gc155544.floatv4.testnet",
  "gd155544.floatv4.testnet",
  "p1.floatv4.testnet",
  "solver.floatv4.testnet",
];

for (const id of DELETE) {
  if (KEEP.has(id)) {
    console.error(`FATAL: ${id} is on both lists. Refusing to delete anything.`);
    process.exit(2);
  }
  if (!id.endsWith(".testnet")) {
    console.error(`FATAL: ${id} is not a testnet account. Refusing.`);
    process.exit(2);
  }
}

const provider = new JsonRpcProvider({ url: RPC });
const near = (y) => (Number(y) / 1e24).toFixed(5);
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);

const before = await provider.viewAccount({ accountId: BENEFICIARY, blockQuery: { finality: "final" } });
console.log(`beneficiary ${BENEFICIARY}: ${near(BigInt(before.amount))} NEAR`);
console.log(`keeping: ${[...KEEP].join(", ")}\n`);

let recovered = 0n;
for (const id of DELETE) {
  if (!existsSync(credPath(id))) {
    console.log(`  skip    ${id.padEnd(30)} no credential file`);
    continue;
  }
  const acct = await provider
    .viewAccount({ accountId: id, blockQuery: { finality: "final" } })
    .catch(() => null);
  if (!acct) {
    console.log(`  skip    ${id.padEnd(30)} does not exist`);
    continue;
  }
  const bal = BigInt(acct.amount);
  const k = JSON.parse(readFileSync(credPath(id), "utf8"));
  const signer = new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
  try {
    await new Account(id, provider, signer).deleteAccount(BENEFICIARY);
    recovered += bal;
    console.log(`  deleted ${id.padEnd(30)} +${near(bal)}`);
  } catch (e) {
    console.log(`  FAILED  ${id.padEnd(30)} ${String(e.message).slice(0, 80)}`);
  }
}

await new Promise((r) => setTimeout(r, 4000));
const after = await provider.viewAccount({ accountId: BENEFICIARY, blockQuery: { finality: "final" } });
const free = BigInt(after.amount) - BigInt(after.storage_usage) * 10n ** 19n;
console.log(`\n  recovered ${near(recovered)} NEAR`);
console.log(`  ${BENEFICIARY}: ${near(BigInt(after.amount))} total, ${near(free)} FREE`);
