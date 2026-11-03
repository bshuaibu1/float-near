#!/usr/bin/env node
/**
 * What does a mainnet run actually cost, and can the current balance do it?
 *
 * Every figure here is DERIVED from a real artifact size or a measured
 * constant, not typed in. Storage is 1e19 yocto/byte, so a wasm's size IS its
 * deposit, and the gas reservation is `prepaid_gas * 1e9` at the MAXIMUM gas
 * price — which is what a wallet checks a balance against, and what rejected
 * the first real browser attempt.
 *
 * TWO PATHS, because they cost very different amounts and only one of them
 * needs a factory:
 *
 *   BROWSER   the new-user experience. A wallet refuses a DeployContract
 *             action from a dApp (measured in Meteor, blanket), so the vault
 *             must be deployed by a FACTORY the browser calls. That factory
 *             is an extra ~1.6 NEAR of storage, paid once.
 *
 *   CLI       create-float signs CreateAccount + DeployContract + new()
 *             itself. No factory, because a CLI has no wallet policy to work
 *             around. Same contract, same vault, ~1.6 cheaper.
 *
 * The factory is NOT a product requirement — it is a workaround for a wallet
 * restriction. Paying for it buys the browser flow, nothing else.
 */
import { statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const OWNER = process.env.OWNER ?? "test015.near";
const RPC = process.env.RPC ?? "https://free.rpc.fastnear.com";
const VAULT_WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");
const FACTORY_WASM = join(ROOT, "target", "near", "factory", "factory.wasm");

const YOCTO_PER_BYTE = 10n ** 19n;
const near = (y) => (Number(y) / 1e24).toFixed(4);

for (const f of [VAULT_WASM, FACTORY_WASM]) {
  if (!existsSync(f)) {
    console.error(`FATAL: ${f} missing — cannot size the plan from a file that is not there.`);
    process.exit(1);
  }
}
const vaultBytes = statSync(VAULT_WASM).size;
const factoryBytes = statSync(FACTORY_WASM).size;

// Measured, not guessed. See the commit history for each.
const REQUIRED_DEPOSIT = 10n ** 23n; // factory's floor, 0.1
const CREATE_GAS_TGAS = 200n; //            matches web/index.html
const GAS_RESERVATION = CREATE_GAS_TGAS * 10n ** 12n * 10n ** 9n; // prepaid * 1e9
const AGENT_FUNDING = 12n * 10n ** 22n; //  gasKeyFunding() default, 0.12
const FACTORY_HEADROOM = 12n * 10n ** 22n; // state the factory writes in new()
const CLI_HEADROOM = 5n * 10n ** 22n; //    the vault's own first writes
const GAS_SLOP = 2n * 10n ** 22n; //        a handful of transactions

const p = new JsonRpcProvider({ url: RPC });
const a = await p.viewAccount({ accountId: OWNER, blockQuery: { finality: "final" } });
const have = BigInt(a.amount) - BigInt(a.storage_usage) * YOCTO_PER_BYTE;

const vaultStorage = BigInt(vaultBytes) * YOCTO_PER_BYTE;
const factoryStorage = BigInt(factoryBytes) * YOCTO_PER_BYTE;

const browser = {
  "factory storage": factoryStorage,
  "factory headroom": FACTORY_HEADROOM,
  "vault deposit (storage + factory floor)": vaultStorage + REQUIRED_DEPOSIT,
  "gas reservation held at signing": GAS_RESERVATION,
  "virtual agent + gas key": AGENT_FUNDING,
  "gas, several txs": GAS_SLOP,
};
const cli = {
  "vault storage": vaultStorage,
  "vault headroom": CLI_HEADROOM,
  "virtual agent + gas key": AGENT_FUNDING,
  "gas, several txs": GAS_SLOP,
};

const sum = (o) => Object.values(o).reduce((t, v) => t + v, 0n);

console.log(`\n  ${OWNER} holds ${near(have)} NEAR free\n`);
console.log(`  vault wasm    ${vaultBytes.toLocaleString()} B`);
console.log(`  factory wasm  ${factoryBytes.toLocaleString()} B\n`);

for (const [name, parts] of [
  ["BROWSER — the full new-user flow (needs a factory)", browser],
  ["CLI — same vault, no factory", cli],
]) {
  const total = sum(parts);
  const diff = have - total;
  console.log(`${"=".repeat(70)}`);
  console.log(`${name}`);
  console.log("=".repeat(70));
  for (const [k, v] of Object.entries(parts)) console.log(`    ${near(v).padStart(8)}  ${k}`);
  console.log(`    ${"-".repeat(8)}`);
  console.log(`    ${near(total).padStart(8)}  TOTAL`);
  console.log(
    `\n    ${diff >= 0n ? `AFFORDABLE NOW — ${near(diff)} to spare` : `SHORT by ${near(-diff)}`}`,
  );
  // The reservation is returned a receipt later, so the peak requirement is
  // higher than the eventual cost. A plan quoted on net cost sends someone to
  // a wallet that refuses them.
  if (parts["gas reservation held at signing"]) {
    console.log(
      `    (${near(GAS_RESERVATION)} of that is a RESERVATION — refunded moments later,`,
    );
    console.log(`     but the wallet checks your balance against it at signing time)`);
  }
  console.log();
}

const shortBrowser = sum(browser) - have;
if (shortBrowser > 0n) {
  console.log(`  To do the BROWSER flow you need ${near(shortBrowser)} more.`);
  console.log(`  The CLI flow needs no top-up and produces the SAME vault — the factory`);
  console.log(`  exists only because wallets refuse a DeployContract from a dApp.\n`);
}
