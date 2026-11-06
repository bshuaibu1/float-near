#!/usr/bin/env node
/**
 * Give the vault something to pay WITH.
 *
 * A vault with caps and an agent still cannot settle a payment if it holds no
 * tokens, and the failure surfaces at the token contract as a cryptic transfer
 * revert rather than as "you have no money" — so this is done explicitly
 * rather than discovered.
 *
 * STORAGE REGISTRATION COMES FIRST. A NEP-141 `ft_transfer` to an unregistered
 * account fails, and on some tokens it fails by BURNING the amount rather than
 * reverting. Both the vault (sender) and the recipient must be registered
 * before any transfer is attempted.
 *
 * Testnet only, with a mock token that has a permissionless `mint`.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const SIGNER = process.env.SIGNER ?? "floatv4.testnet";
const VAULT = process.env.VAULT ?? "floatv4-testnet.fac.floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";
const RECIPIENT = process.env.RECIPIENT ?? "floatv4.testnet";
/**
 * Gas per call, and it is a FUNDING constraint, not just a limit.
 *
 * A transaction reserves `prepaid_gas * 1e9` at the maximum gas price for its
 * duration, refunding the unused part a receipt later. At 30 TGas that is
 * 0.03 NEAR the signer must HOLD, which dwarfs the 0.00125 storage deposit
 * and is what actually failed here:
 *
 *   NotEnoughBalanceError: balance 21775363487500000000000,
 *                          cost    32169558876244500000000
 *
 * 0.0218 against 0.0322 — the signer could afford the operation ten times
 * over and could not afford to RESERVE for it. `storage_deposit` and `mint`
 * both burn a few TGas, so 15 is generous and reserves half as much.
 */
const GAS = BigInt(process.env.GAS_TGAS ?? "15") * 10n ** 12n;
const AMOUNT = BigInt(process.env.AMOUNT ?? "500000000"); // 500.0 at 6dp

for (const [l, id] of [["SIGNER", SIGNER], ["VAULT", VAULT], ["TOKEN", TOKEN]]) {
  if (!id.endsWith(".testnet")) {
    console.error(`FATAL: ${l}=${id} is not testnet.`);
    process.exit(2);
  }
}

const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
if (!existsSync(credPath(SIGNER))) {
  console.error(`FATAL: no credential for ${SIGNER}`);
  process.exit(1);
}
const k = JSON.parse(readFileSync(credPath(SIGNER), "utf8"));
const acct = new Account(SIGNER, p, new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key)));

const view = (m, a = {}) =>
  p.callFunction({ contractId: TOKEN, method: m, args: a, blockQuery: { finality: "optimistic" } });
const bal = async (id) => BigInt(await view("ft_balance_of", { account_id: id }));
const human = (b) => (Number(b) / 1e6).toFixed(6);

console.log(`\n  token  ${TOKEN}`);
console.log(`  vault  ${VAULT}`);
console.log(`  payee  ${RECIPIENT}\n`);

// ---- register both parties --------------------------------------------------
for (const who of [VAULT, RECIPIENT]) {
  const reg = await view("storage_balance_of", { account_id: who }).catch(() => null);
  if (reg !== null && reg !== undefined) {
    console.log(`  ${who} already registered`);
    continue;
  }
  // ASK THE TOKEN WHAT IT CHARGES, rather than padding a guess.
  //
  // This was hardcoded to 0.0125 — "the usual NEP-145 floor with headroom".
  // Measured 2026-11-03 against usdc.fakes.testnet: `storage_balance_bounds`
  // reports min AND max of 0.001250, so the constant was TEN TIMES the real
  // cost, and a max equal to min means the excess is not even usable.
  //
  // Overpaying is not harmless. Even where the excess is refunded, the SENDER
  // must hold the full amount at send time — which is exactly what blocked
  // this script with a signer holding 0.019955, comfortably above the 0.0025
  // that two registrations actually cost. A padded constant turned an
  // affordable operation into an impossible one.
  const bounds = await view("storage_balance_bounds");
  const deposit = BigInt(bounds.min);
  console.log(`  registering ${who}… (${(Number(deposit) / 1e24).toFixed(6)} NEAR, asked of the token)`);
  await acct.callFunction({
    contractId: TOKEN,
    methodName: "storage_deposit",
    args: { account_id: who, registration_only: true },
    gas: GAS,
    deposit,
  });
}

// ---- mint ------------------------------------------------------------------
const before = await bal(VAULT);
if (before >= AMOUNT) {
  console.log(`\n  vault already holds ${human(before)} — not minting`);
} else {
  const need = AMOUNT - before;
  console.log(`\n  minting ${human(need)} to the vault…`);
  await acct.callFunction({
    contractId: TOKEN,
    methodName: "mint",
    args: { account_id: VAULT, amount: need.toString() },
    gas: GAS,
  });
  // POLL TO AN EXPECTED VALUE. A read straight after a write can be a whole
  // transaction behind, and this project has paid for that repeatedly.
  for (let i = 0; i < 25; i++) {
    if ((await bal(VAULT)) >= AMOUNT) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const v = await bal(VAULT);
const r = await bal(RECIPIENT);
console.log(`\n  ${VAULT}`);
console.log(`    balance ${human(v)}`);
console.log(`  ${RECIPIENT}`);
console.log(`    balance ${human(r)}`);
console.log();
if (v < AMOUNT) {
  console.log(`  WARNING: vault balance never reached ${human(AMOUNT)} — read again`);
  process.exit(1);
}
