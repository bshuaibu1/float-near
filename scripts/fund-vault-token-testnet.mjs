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
  console.log(`  registering ${who}…`);
  await acct.callFunction({
    contractId: TOKEN,
    methodName: "storage_deposit",
    args: { account_id: who, registration_only: true },
    gas: 30n * 10n ** 12n,
    deposit: 125n * 10n ** 20n, // 0.0125, the usual NEP-145 floor with headroom
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
    gas: 30n * 10n ** 12n,
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
