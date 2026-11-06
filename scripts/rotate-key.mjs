/**
 * Replace an account's full-access key, without a window where nothing can
 * sign for it.
 *
 * Needed because `floatv4.testnet`'s key reached a chat transcript inside a
 * screenshot. That account is the `owner` in `fac.floatv4.testnet`'s config,
 * so the exposed key can flip `paused` and rewrite `required_deposit` on the
 * factory every create link points at — the 5 NEAR of testnet balance is the
 * less interesting half.
 *
 * THE ORDERING IS THE WHOLE DESIGN. Deleting first, or deleting with the old
 * key, risks an account with no usable key — and an account whose only key is
 * gone cannot add another, transfer out, or delete itself. So:
 *
 *   1. AddKey(new)      signed by OLD   — two working keys, no gap
 *   2. write new file   old kept as a .exposed- backup
 *   3. DeleteKey(old)   signed by NEW   — see below
 *
 * Step 3 is signed by the NEW key on purpose. That makes the delete its own
 * proof: a transaction the new key signs can only land if the new key is
 * genuinely on chain and genuinely works. If anything about it is wrong the
 * transaction fails and the OLD key is still there, which is recoverable. The
 * alternative — deleting the old key with the old key — succeeds exactly as
 * readily when the new key is broken, and that failure is permanent.
 *
 * NOTHING SECRET IS PRINTED. The new secret goes to the credential file and
 * the public half goes to stdout. The exposure being cleaned up arrived
 * through a screenshot of a key on screen, so this script never puts one
 * there.
 *
 *   node scripts/rotate-key.mjs <account-id>
 *   NETWORK=mainnet CONFIRM_MAINNET=1 node scripts/rotate-key.mjs <account-id>
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Account, KeyPair, KeyPairSigner, JsonRpcProvider, PublicKey } from "near-api-js";

const ACCOUNT = process.argv[2] ?? process.env.ACCOUNT;
const NETWORK = process.env.NETWORK ?? "testnet";
const RPC =
  process.env.RPC ??
  (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");

const p = new JsonRpcProvider({ url: RPC });
const credPath = join(homedir(), ".near-credentials", NETWORK, `${ACCOUNT}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (y) => {
  const neg = y < 0n;
  const v = neg ? -y : y;
  return `${neg ? "-" : ""}${v / 10n ** 24n}.${(v % 10n ** 24n).toString().padStart(24, "0").slice(0, 6)}`;
};
const fullAccess = async () =>
  (await p.viewAccessKeyList({ accountId: ACCOUNT, blockQuery: { finality: "final" } })).keys.filter(
    (k) => k.access_key.permission === "FullAccess",
  );
const balance = async () =>
  BigInt((await p.viewAccount({ accountId: ACCOUNT, blockQuery: { finality: "final" } })).amount);

/**
 * Runs inside `main` so fatal paths RETURN instead of calling `process.exit()`.
 *
 * `process.exit()` after the provider has opened a socket aborts in libuv's
 * teardown on Windows:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
 *
 * replacing the exit code with 127 and printing a crash over the message. That
 * is intolerable in THIS script specifically: its failure messages are the
 * ones that say "the old key is untouched and nothing was lost", and a libuv
 * abort stacked on top of that reads as though the rotation broke the account.
 */
async function main() {
  // ---- preconditions -------------------------------------------------------
  if (!existsSync(credPath)) {
    console.error(`FATAL: no credential for ${ACCOUNT} at ${credPath}`);
    return 1;
  }
  const oldFile = JSON.parse(readFileSync(credPath, "utf8"));
  const oldSecret = oldFile.private_key ?? oldFile.secret_key;
  if (!oldSecret) {
    console.error(`FATAL: ${credPath} holds no private key — nothing to rotate with.`);
    return 1;
  }
  const oldKp = KeyPair.fromString(oldSecret);
  const oldPk = oldKp.getPublicKey().toString();

  // A credential file on disk does NOT imply a rotatable account, and
  // `viewAccessKeyList` throws rather than returning empty when the account
  // is absent entirely.
  //
  // Measured 2026-11-03 against the files actually in
  // `~/.near-credentials/testnet`: NONE of them are absent. The shrunk ones
  // (v4., approve.) still exist with keys — shrinking code frees stake but
  // does not remove the account — and six more (p1., solver., the four
  // g*155544. gas-key probes) exist with ZERO keys. Keyless is the reachable
  // case here, and it falls through to the FullAccess guard below, which says
  // the right thing. So this catch is for genuine absence: a typo'd id, or an
  // account deleted after its file was written.
  let before;
  try {
    before = await fullAccess();
  } catch (e) {
    console.error(`FATAL: cannot read access keys for ${ACCOUNT} on ${NETWORK}.`);
    console.error(`  ${e.message}`);
    console.error(`  A credential file exists for it, but the account may have been`);
    console.error(`  deleted — a leftover file is not an account.`);
    return 1;
  }

  console.log(`account   ${ACCOUNT}  (${NETWORK})`);
  console.log(`old key   ${oldPk}`);
  console.log(`on chain  ${before.length} FullAccess key(s):`);
  for (const k of before) {
    console.log(`          ${k.public_key}${k.public_key === oldPk ? "  <== the one on disk" : ""}`);
  }

  if (!before.some((k) => k.public_key === oldPk)) {
    console.error(`\nFATAL: the key on disk is not a FullAccess key on ${ACCOUNT}.`);
    console.error(`  It cannot sign an AddKey, so there is nothing to rotate FROM.`);
    console.error(`  Either the file is stale, or this account was already rotated.`);
    return 1;
  }

  const acct = new Account(ACCOUNT, p, new KeyPairSigner(oldKp));
  const bal0 = await balance();
  console.log(`balance   ${near(bal0)} NEAR`);

  // ---- 1. add the new key, signed by the old one ---------------------------
  // Generated here and never logged. `KeyPair.fromRandom` draws from the
  // platform CSPRNG, and its `toString()` emits the `ed25519:`-prefixed form —
  // which is the form a wallet's manual-import field expects, and whose
  // absence is what made the import this rotation follows from fail.
  const newKp = KeyPair.fromRandom("ed25519");
  const newPk = newKp.getPublicKey().toString();
  console.log(`\nnew key   ${newPk}`);
  console.log(`[1/3] AddKey(new, FullAccess) signed by the OLD key ...`);
  await acct.addFullAccessKey(PublicKey.from(newPk));

  // A key read right after a write can be a whole transaction behind, so poll
  // to the EXPECTED value rather than once-and-trust. Nothing below is safe
  // until the network agrees the new key exists.
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) {
    await sleep(1000);
    seen = (await fullAccess()).some((k) => k.public_key === newPk);
  }
  if (!seen) {
    console.error(`\nFATAL: the new key never appeared on chain after 20s.`);
    console.error(`  The OLD key is untouched and still works. Nothing was lost.`);
    console.error(`  The credential file was NOT modified. Re-run to try again.`);
    return 1;
  }
  console.log(`      confirmed on chain.`);

  // ---- 2. persist the new key BEFORE deleting anything ---------------------
  // If this process died after the delete but before the write, the account
  // would be bricked. Writing first means the worst case is two valid keys,
  // which is merely untidy.
  const backup = `${credPath}.exposed-${newPk.slice(8, 16)}`;
  copyFileSync(credPath, backup);
  writeFileSync(
    credPath,
    JSON.stringify(
      { account_id: ACCOUNT, public_key: newPk, private_key: newKp.toString() },
      null,
      2,
    ) + "\n",
  );
  console.log(`[2/3] wrote ${credPath}`);
  console.log(`      old file kept at ${backup}`);
  console.log(`      ^ that backup holds the EXPOSED key. Delete it once you are happy.`);

  // ---- 3. delete the old key, signed by the NEW one ------------------------
  console.log(`[3/3] DeleteKey(old) signed by the NEW key ...`);
  const rotated = new Account(ACCOUNT, p, new KeyPairSigner(newKp));
  try {
    await rotated.deleteKey(PublicKey.from(oldPk));
  } catch (e) {
    console.error(`\nFAILED to delete the old key: ${e.message}`);
    console.error(`  Both keys currently work and the new one is saved to disk, so`);
    console.error(`  nothing is lost — but the EXPOSED key is still live. Re-run.`);
    return 1;
  }

  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    await sleep(1000);
    gone = !(await fullAccess()).some((k) => k.public_key === oldPk);
  }

  const after = await fullAccess();
  console.log(`\nafter     ${after.length} FullAccess key(s):`);
  for (const k of after) console.log(`          ${k.public_key}`);
  console.log(`gas spent ${near(bal0 - (await balance()))} NEAR`);

  if (!gone || after.some((k) => k.public_key === oldPk)) {
    console.error(`\nINCOMPLETE: the exposed key is STILL on ${ACCOUNT}. Re-run.`);
    return 1;
  }
  if (!after.some((k) => k.public_key === newPk)) {
    console.error(`\nALARM: neither key is present. Check ${ACCOUNT} by hand immediately.`);
    return 1;
  }

  console.log(`\nROTATED. ${ACCOUNT} is now controlled only by ${newPk}.`);
  console.log(`The screenshotted key can no longer sign for it.`);
  return 0;
}

// ---- argument checks, before anything opens a socket -----------------------
if (!ACCOUNT) {
  console.error("usage: node scripts/rotate-key.mjs <account-id>");
  process.exit(2);
}
if (NETWORK === "mainnet" && process.env.CONFIRM_MAINNET !== "1") {
  console.error("FATAL: mainnet requires CONFIRM_MAINNET=1. This DELETES an access key.");
  process.exit(2);
}

process.exitCode = await main();
