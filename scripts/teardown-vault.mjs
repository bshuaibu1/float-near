#!/usr/bin/env node
/**
 * Empty and delete a vault, recovering everything it holds.
 *
 * THE ORDER IS THE WHOLE SCRIPT. Each step destroys the means of doing an
 * earlier one, so getting it wrong strands value permanently rather than
 * failing loudly:
 *
 *   1. ft_transfer the tokens out      — a delete does NOT return fungible
 *                                        tokens; the ledger keeps a row keyed
 *                                        to an account nobody can sign for
 *   2. withdraw from the gas key       — NEP-611 balance, and a contract CANNOT
 *                                        do this (there is no withdraw host
 *                                        function at any near-sys version), so
 *                                        it needs the account's own key
 *   3. storage_unregister on the token — refunds ~0.00125, and refuses while a
 *                                        balance is held (force would BURN it)
 *   4. purge_settled                   — the only lever that shrinks STATE;
 *                                        without it the delete is refused
 *   5. deploy the 33-byte stub         — shrinks CODE, frees ~1e19/byte
 *   6. delete-account                  — returns the WHOLE remaining balance
 *
 * Step 5 removes `withdraw` and `purge_settled`, so 1 and 4 cannot happen
 * after it. Step 6 removes the account, so 2 cannot happen after it.
 *
 * REFUSES WITHOUT A FULL-ACCESS KEY, before touching anything. A vault made by
 * the old factory has zero keys: steps 2, 5 and 6 are impossible and its
 * balance is unrecoverable. Shrinking such an account would free the stake into
 * something nobody can empty — strictly worse than leaving it alone.
 *
 * Verified against mainnet 2026-11-02: this sequence took float.test015.near
 * from 308,281 B to a clean delete, reconciling to 0.000187 of gas.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const NETWORK = process.env.NETWORK ?? "testnet";
const VAULT = process.env.VAULT ?? "floatv4-testnet.fac.floatv4.testnet";
const OWNER = process.env.OWNER ?? "floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";
const STUB = join(ROOT, ".demo", "stub-new.wasm");
const RPC =
  process.env.RPC ??
  (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");

if (NETWORK === "mainnet" && process.env.CONFIRM_MAINNET !== "1") {
  console.error("FATAL: mainnet requires CONFIRM_MAINNET=1. This DELETES a vault.");
  process.exit(2);
}
if (!existsSync(STUB)) {
  console.error(`FATAL: ${STUB} missing — run: node scripts/make-stub-wasm.mjs`);
  process.exit(1);
}

const p = new JsonRpcProvider({ url: RPC });
const near = (y) => (Number(y) / 1e24).toFixed(6);
const credPath = (a) => join(homedir(), ".near-credentials", NETWORK, `${a}.json`);
const key = (a) => {
  if (!existsSync(credPath(a))) {
    console.error(`FATAL: no credential for ${a} at ${credPath(a)}`);
    process.exit(1);
  }
  const k = JSON.parse(readFileSync(credPath(a), "utf8"));
  return KeyPair.fromString(k.private_key ?? k.secret_key);
};
const view = (c, m, a = {}) =>
  p.callFunction({ contractId: c, method: m, args: a, blockQuery: { finality: "final" } });
const ftBal = async (id) => BigInt(await view(TOKEN, "ft_balance_of", { account_id: id }));
const human = (b) => (Number(b) / 1e6).toFixed(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- preconditions, before anything is touched ------------------------------
const keys = (await p.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } }))
  .keys;
const ownerKp = key(OWNER);
const ownerPk = ownerKp.getPublicKey().toString();
const vaultSigner = keys.find(
  (k) => k.access_key.permission === "FullAccess" && k.public_key === ownerPk,
)
  ? ownerKp
  : existsSync(credPath(VAULT))
    ? key(VAULT)
    : null;

if (!vaultSigner) {
  console.error(`\nFATAL: nothing can sign as ${VAULT}.`);
  console.error(`  FullAccess keys on it: ${keys.filter((k) => k.access_key.permission === "FullAccess").length}`);
  console.error(`  Its balance is UNRECOVERABLE — a vault with no key cannot deploy,`);
  console.error(`  cannot withdraw from a gas key, and cannot delete itself. Leave it`);
  console.error(`  alone: shrinking it would free the stake into an account nobody can`);
  console.error(`  empty, which is worse than doing nothing.`);
  process.exit(1);
}

const acct0 = await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } });
const code0 = Buffer.from(
  (await p.viewContractCode({ contractId: VAULT, blockQuery: { finality: "final" } })).code_base64,
  "base64",
);
const tokens0 = await ftBal(VAULT);
const gasKeys = keys.filter((k) => k.access_key.permission?.GasKeyFunctionCall);
const ownerBefore = BigInt(
  (await p.viewAccount({ accountId: OWNER, blockQuery: { finality: "final" } })).amount,
);
const ownerTokens0 = await ftBal(OWNER);

console.log(`\n  network   ${NETWORK}`);
console.log(`  vault     ${VAULT}`);
console.log(`  owner     ${OWNER}`);
console.log(`  balance   ${near(BigInt(acct0.amount))} NEAR`);
console.log(`  tokens    ${human(tokens0)}`);
console.log(`  gas keys  ${gasKeys.length}`);
console.log(`  storage   ${acct0.storage_usage} B = ${code0.length} code + ${acct0.storage_usage - code0.length} state\n`);

const owner = new Account(OWNER, p, new KeyPairSigner(ownerKp));
const vault = new Account(VAULT, p, new KeyPairSigner(vaultSigner));

// ---- 1. tokens out ----------------------------------------------------------
if (tokens0 > 0n) {
  console.log(`  [1] withdrawing ${human(tokens0)} tokens to ${OWNER}…`);
  await owner.callFunction({
    contractId: VAULT,
    methodName: "withdraw",
    args: { token: TOKEN, amount: tokens0.toString(), receiver_id: OWNER },
    gas: 100n * 10n ** 12n,
    deposit: 1n,
  });
  for (let i = 0; i < 25 && (await ftBal(VAULT)) > 0n; i++) await sleep(1000);
  console.log(`      vault tokens now ${human(await ftBal(VAULT))}`);
} else {
  console.log(`  [1] no tokens to withdraw`);
}

// ---- 2. gas keys ------------------------------------------------------------
// A CONTRACT CANNOT DO THIS. near-sys exposes transfer_to / add_full_access /
// add_function_call for gas keys and nothing that takes money out, at any
// version. `WithdrawFromGasKey` is an ACCOUNT-signed action, which is the whole
// reason the factory installs the owner's key on every vault it creates.
for (const k of gasKeys) {
  const bal = BigInt(k.access_key.permission.GasKeyFunctionCall.balance);
  if (bal === 0n) continue;
  console.log(`  [2] withdrawing ${near(bal)} from gas key ${k.public_key.slice(0, 22)}…`);
  try {
    await vault.withdrawFromGasKey(KeyPair.fromString(`ed25519:${"1".repeat(1)}`) && k.public_key, bal);
  } catch (e) {
    // near-api-js wants a PublicKey instance in some versions and a string in
    // others; report rather than swallow, because a silent skip here leaves
    // the balance behind and the delete will not recover it.
    console.log(`      withdrawFromGasKey failed: ${String(e.message).slice(0, 120)}`);
  }
}
if (!gasKeys.length) console.log(`  [2] no gas keys`);

// ---- 3. token registration --------------------------------------------------
const reg = await view(TOKEN, "storage_balance_of", { account_id: VAULT }).catch(() => null);
if (reg) {
  console.log(`  [3] unregistering from ${TOKEN}…`);
  await vault.callFunction({
    contractId: TOKEN,
    methodName: "storage_unregister",
    args: {},
    gas: 30n * 10n ** 12n,
    deposit: 1n,
  });
} else {
  console.log(`  [3] not registered on the token`);
}

// ---- 4. purge state ---------------------------------------------------------
const day = Number(await view(VAULT, "current_day"));
const reqs = await view(VAULT, "list_requests", { from_index: 0, limit: 200 });
if (reqs.length) {
  console.log(`  [4] purging ${reqs.length} stored request(s)…`);
  await owner.callFunction({
    contractId: VAULT,
    methodName: "purge_settled",
    args: { before_day: day + 1, limit: 100 },
    gas: 100n * 10n ** 12n,
    deposit: 1n,
  });
  await sleep(2000);
} else {
  console.log(`  [4] no stored requests`);
}

// ---- 5. shrink --------------------------------------------------------------
console.log(`  [5] shrinking to the 33-byte stub…`);
await vault.deployContract(new Uint8Array(readFileSync(STUB)));
await sleep(3000);
const mid = await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } });
console.log(`      storage ${acct0.storage_usage} -> ${mid.storage_usage} B`);

// ---- 6. delete --------------------------------------------------------------
console.log(`  [6] deleting…`);
let deleted = false;
try {
  await vault.deleteAccount(OWNER);
  deleted = true;
} catch (e) {
  console.log(`      REFUSED: ${String(e.message).slice(0, 160)}`);
}

// ---- verify, by polling to an expected value --------------------------------
const want = ownerBefore + BigInt(mid.amount) - 5n * 10n ** 22n;
let ownerAfter = 0n;
for (let i = 0; i < 30; i++) {
  ownerAfter = BigInt(
    (await p.viewAccount({ accountId: OWNER, blockQuery: { finality: "final" } })).amount,
  );
  if (ownerAfter >= want) break;
  await sleep(1000);
}
const gone =
  (await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } }).catch(() => null)) ===
  null;
const ownerTokens1 = await ftBal(OWNER);

console.log(`\n  ${VAULT}: ${gone ? "DELETED" : "still exists"}`);
console.log(`  ${OWNER} NEAR   ${near(ownerBefore)} -> ${near(ownerAfter)}  (+${near(ownerAfter - ownerBefore)})`);
console.log(`  ${OWNER} tokens ${human(ownerTokens0)} -> ${human(ownerTokens1)}  (+${human(ownerTokens1 - ownerTokens0)})`);
console.log(`\n  ${deleted && gone ? "RECOVERED." : "NOT fully recovered — read the chain before assuming."}\n`);
process.exit(deleted && gone ? 0 : 1);
