#!/usr/bin/env node
/**
 * What a NEW USER must hold to get a vault, on each path.
 *
 * The number that decides adoption is not what the vault costs us — it is what
 * a stranger must already have in their wallet before they can try the product
 * at all. A wallet checks the balance against deposit PLUS the gas reservation
 * (`prepaid_gas * 1e9`, at the maximum gas price) and refuses below it, so the
 * figure a user needs is the peak, not the eventual net cost. Quoting net is
 * what bounced the first real browser attempt.
 *
 * Every input is a measured artifact size or a constant from this repo's
 * history, not an estimate. The global-contract figures come from the mainnet
 * measurement: publishing BURNS 1e20 yocto/byte, and REFERENCING a published
 * contract costs a flat 214 bytes whatever its size — 132 if the account holds
 * no access key, which ours now does since the factory installs the owner's.
 */
import { statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VAULT_WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");
if (!existsSync(VAULT_WASM)) {
  console.error(`FATAL: ${VAULT_WASM} missing.`);
  process.exit(1);
}
const vaultBytes = statSync(VAULT_WASM).size;

const B = 10n ** 19n; // yocto per byte of storage
const near = (y) => (Number(y) / 1e24).toFixed(4);
const tgasReservation = (t) => BigInt(t) * 10n ** 12n * 10n ** 9n;

// Measured in this repo. See memory: global-contract-rate-is-10x-burned.
const GLOBAL_REF_BYTES = 214n; // flat, whatever the contract's size
const VAULT_BASE_STATE = 2341n; // flat vault state
const NODE_STATE = 192n; // per node; a fresh vault has one root

// The measured gas commitment for the with-code path was 124.88 TGas, of which
// 42.79 was delivering and decoding the 401 KB base64 argument and 34.16 was
// the DeployContract action itself. The global path carries neither: no wasm
// in the transaction, and UseGlobalContract instead of DeployContract.
const TGAS_WITH_CODE = 200; // what web/index.html attaches today
const TGAS_GLOBAL = 50; // no 401 KB argument, no per-byte deploy cost

const vaultStorage = BigInt(vaultBytes) * B;
const globalVaultStorage = (GLOBAL_REF_BYTES + VAULT_BASE_STATE + NODE_STATE) * B;

const paths = [
  {
    name: "BROWSER, code-as-argument (today)",
    deposit: vaultStorage + 10n ** 23n, // + factory required_deposit 0.1
    reservation: tgasReservation(TGAS_WITH_CODE),
    friction: "connect wallet, one signature",
    note: "the wallet must render a 401 KB argument; measured 124.88 TGas",
  },
  {
    name: "CLI (create-float)",
    deposit: vaultStorage + 5n * 10n ** 22n,
    reservation: 0n, // the CLI holds the key; no wallet balance check
    friction: "install node, put a FULL-ACCESS key in ~/.near-credentials",
    note: "cheapest today, but asks a stranger for their private key",
  },
  {
    name: "BROWSER + GLOBAL CONTRACT",
    deposit: globalVaultStorage + 3n * 10n ** 22n, // floor lowered to suit
    reservation: tgasReservation(TGAS_GLOBAL),
    friction: "connect wallet, one signature",
    note: "transaction carries NO wasm — references a published code hash",
  },
];

console.log(`\n  vault wasm ${vaultBytes.toLocaleString()} B\n`);
console.log(
  `  ${"path".padEnd(36)} ${"deposit".padStart(9)} ${"reserve".padStart(9)} ${"MUST HOLD".padStart(10)}`,
);
console.log(`  ${"-".repeat(70)}`);
for (const p of paths) {
  const hold = p.deposit + p.reservation;
  console.log(
    `  ${p.name.padEnd(36)} ${near(p.deposit).padStart(9)} ${near(p.reservation).padStart(9)} ${near(hold).padStart(10)}`,
  );
}

console.log(`\n  friction, which is the other half of UX:\n`);
for (const p of paths) {
  console.log(`    ${p.name}`);
  console.log(`      ${p.friction}`);
  console.log(`      ${p.note}\n`);
}

// What the global publish costs, and when it pays for itself.
const PUBLISH_BURN = BigInt(vaultBytes) * 10n ** 20n; // 10x storage, BURNED
const today = paths[0].deposit;
const global = paths[2].deposit;
const savedPerVault = today - global;
const breakEven = Number(PUBLISH_BURN) / Number(savedPerVault);

console.log(`  ${"=".repeat(70)}`);
console.log(`  the global publish is a REAL cost, not a deposit:`);
console.log(`    burns ${near(PUBLISH_BURN)} NEAR, per version, unrecoverable`);
console.log(`    saves ${near(savedPerVault)} per vault created`);
console.log(`    breaks even at ${Math.ceil(breakEven)} vaults`);
console.log();
console.log(`  but the point is not the saving. It is that a stranger needs`);
console.log(`  ${near(paths[2].deposit + paths[2].reservation)} instead of ${near(paths[0].deposit + paths[0].reservation)} to try the product —`);
console.log(`  a ${(Number(paths[0].deposit + paths[0].reservation) / Number(paths[2].deposit + paths[2].reservation)).toFixed(0)}x lower barrier to the first click.\n`);
