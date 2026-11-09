#!/usr/bin/env node
/**
 * Re-fund an existing agent's gas key, or just quote what a top-up would buy.
 *
 * WHY THIS EXISTS. A virtual agent's gas key holds its own balance and pays
 * its own gas. When that balance runs down the agent stops — and until now the
 * ONLY route back was `add_role` again, which creates a NEW node and leaves
 * the old one bound, funded-at-zero, and dead. "What happens when it runs
 * out?" had the answer "you make another agent", which is a bad answer to an
 * obvious question.
 *
 * WHY IT IS A SEPARATE BIN rather than a `float-agent topup` subcommand:
 * float-agent is a flat 259-line script with no subcommand structure, and
 * restructuring a working money-moving script to add a sibling is more risk
 * than writing the sibling. `float-exit` is already its own bin for the same
 * reason.
 *
 * WHY IT CANNOT BE A BROWSER FLOW, ever. `transferToGasKey` is an action on
 * the VAULT account, so it needs a full-access key OF the vault. Measured
 * 2026-11-07: Meteor, Intear and the NEAR CLI connector all IGNORE `signerId`
 * — they silently sign as the connected account and return SUCCESS. So a
 * wallet will never produce a vault-signed transaction, and this is a CLI job
 * permanently. Same constraint that makes float-exit operator-shaped.
 *
 * THE QUOTE IS THE POINT, though. `--quote` reads the chain and says what a
 * top-up would buy WITHOUT signing anything, so an agent can answer "how many
 * payments does 0.05 buy?" before a human decides. That is the half an MCP
 * tool can serve.
 *
 * Usage:
 *   float-topup --vault <v> --owner <o> --agent <pk> --quote
 *   float-topup --vault <v> --owner <o> --agent <pk> --payments 50
 *   float-topup --vault <v> --owner <o> --agent <pk> --amount 0.05
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey } from "near-api-js";

import { makeReaders } from "./args.mjs";
import {
  topUpFor,
  paymentsAfterTopUp,
  gasReservation,
  PAYMENT_BURN,
  MIN_TGAS,
} from "./gas-key.mjs";

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
};
const ok = (m) => console.log(`    ${C.g("ok")}   ${m}`);
const info = (m) => console.log(`    ${C.d(m)}`);
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const near6 = (y) => (Number(y) / 1e24).toFixed(6);
const die = (m) => {
  console.error(`\n${C.r("failed")}  ${m}\n`);
  process.exit(1);
};

const RPC_DEFAULTS = {
  mainnet: "https://free.rpc.fastnear.com",
  testnet: "https://test.rpc.fastnear.com",
};

export function usage() {
  return `
${C.b("float topup")} ${C.d("— re-fund an agent's gas key")}

  An agent's gas key pays its own gas. When it runs down the agent stops.
  This adds more, or tells you what a given amount would buy.

${C.b("OPTIONS")}
  --vault <account>     the vault the agent is bound to        (required)
  --owner <account>     the vault's owner                      (required)
  --agent <pubkey>      which agent's gas key                  (required)
  --payments <n>        fund this many MORE payments
  --amount <near>       or add this much NEAR instead
  --tgas <n>            gas per call, at least ${MIN_TGAS}             (default 60)
  --quote               read and report only, sign nothing
  --network <net>       mainnet | testnet                      (default mainnet)
  --rpc <url>           override the RPC endpoint
  -h, --help            print this and exit

${C.d("A browser wallet cannot do this: signing as the vault needs the vault's")}
${C.d("own full-access key, and wallets silently sign as the connected account.")}
`;
}

/**
 * Read a gas key's live balance.
 *
 * Returns `null` when the key is not on the account at all, which is a
 * DIFFERENT answer from a zero balance and must not be flattened into one: a
 * missing key means the wrong `--agent` was passed, and funding it would be a
 * transfer to a key that cannot spend it.
 */
export function findGasKey(keys, publicKey) {
  const hit = keys.find((k) => k.public_key === publicKey);
  if (!hit) return null;
  const perm = hit.access_key?.permission?.GasKeyFunctionCall;
  if (!perm) return { kind: "not-a-gas-key", permission: hit.access_key?.permission };
  return { kind: "gas-key", balance: BigInt(perm.balance), methods: perm.method_names ?? [] };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(usage());
    return;
  }
  const { opt, has } = makeReaders(argv);
  const NETWORK = opt("--network", "mainnet");
  if (!RPC_DEFAULTS[NETWORK]) die(`--network must be mainnet or testnet, got "${NETWORK}"`);
  const RPC = opt("--rpc", null) ?? RPC_DEFAULTS[NETWORK];
  const VAULT = opt("--vault", null) ?? die("--vault is required");
  const OWNER = opt("--owner", null) ?? die("--owner is required");
  const AGENT = opt("--agent", null) ?? die("--agent is required (the gas key's public key)");
  const TGAS = Number(opt("--tgas", "60"));
  const QUOTE = has("--quote");
  const paymentsOpt = opt("--payments", null);
  const amountOpt = opt("--amount", null);

  if (paymentsOpt && amountOpt) {
    die("pass --payments OR --amount, not both — they are two ways to say the same thing");
  }

  console.log(`\n${C.b("float topup")} ${C.d(`— ${NETWORK}`)}`);
  if (NETWORK === "mainnet" && !QUOTE) console.log(`  ${C.y("MAINNET — this spends real funds.")}`);

  const provider = new JsonRpcProvider({ url: RPC });

  step(1, "Reading the agent's gas key");
  const list = await provider
    .viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } })
    .catch((e) => die(`could not read ${VAULT}: ${e.message}`));
  const found = findGasKey(list.keys, AGENT);
  if (!found) {
    die(
      `${AGENT.slice(0, 28)}… is not a key on ${VAULT}.\n` +
        `  Funding a key the vault does not have would send NEAR somewhere it cannot be spent.\n` +
        `  List the agents with: npx @floatonnear/float-exit --vault ${VAULT} --owner ${OWNER} --dry-run`,
    );
  }
  if (found.kind === "not-a-gas-key") {
    die(
      `that key is on ${VAULT} but is NOT a gas key (${JSON.stringify(found.permission)}).\n` +
        `  Only a NEP-611 gas key carries its own balance; a plain function-call key\n` +
        `  draws on the account, so there is nothing to top up.`,
    );
  }

  const balance = found.balance;
  const have = paymentsAfterTopUp({ balance, tgas: TGAS, amount: 0n });
  info(`balance   ${near6(balance)} NEAR`);
  info(`reserves  ${near6(gasReservation(TGAS))} per in-flight call at ${TGAS} TGas`);
  info(`burn      ${near6(PAYMENT_BURN)} per payment`);
  console.log(`    ${C.b("payments left")} ${C.b(String(have))}`);
  if (have === 0) {
    info(
      balance < gasReservation(TGAS)
        ? "below one reservation — this agent cannot transact at all right now"
        : "no burn budget left",
    );
  }

  step(2, "What a top-up buys");
  let add;
  if (amountOpt !== null) {
    add = BigInt(Math.round(Number(amountOpt) * 1e24));
    if (!(add > 0n)) die(`--amount must be a positive number of NEAR, got "${amountOpt}"`);
  } else {
    const n = Number(paymentsOpt ?? "50");
    if (!Number.isInteger(n) || n <= 0) die(`--payments must be a positive integer, got "${paymentsOpt}"`);
    add = topUpFor({ balance, tgas: TGAS, payments: n });
  }
  const after = paymentsAfterTopUp({ balance, tgas: TGAS, amount: add });
  info(`add       ${near6(add)} NEAR`);
  console.log(`    ${C.b("payments after")} ${C.b(String(after))} ${C.d(`(+${after - have})`)}`);

  if (QUOTE) {
    console.log(`\n    ${C.d("quote only — nothing was signed")}\n`);
    return;
  }

  step(3, "Funding");
  // SIGNED AS THE VAULT, which is why this cannot be a browser flow.
  const credPath = (a) => join(homedir(), ".near-credentials", NETWORK, `${a}.json`);
  const readKey = (a) => {
    if (!existsSync(credPath(a))) return null;
    const j = JSON.parse(readFileSync(credPath(a), "utf8"));
    return KeyPair.fromString(j.private_key ?? j.secret_key);
  };
  // The owner's key is normally full-access ON the vault (the factory adds it
  // at creation), so either credential can sign. Preferring the vault's own
  // mirrors float-agent, and falling back is what makes a factory-made vault
  // work with only the owner's wallet key on disk.
  const vaultKp = readKey(VAULT) ?? readKey(OWNER);
  if (!vaultKp) {
    die(
      `no credential for ${VAULT} or ${OWNER} under ~/.near-credentials/${NETWORK}/.\n` +
        `  Topping up signs AS the vault, so it needs a full-access key of the vault.\n` +
        `  A browser wallet cannot do it: wallets ignore signerId and sign as the\n` +
        `  connected account instead, returning success while doing the wrong thing.`,
    );
  }
  const asVault = new Account(VAULT, provider, new KeyPairSigner(vaultKp));
  await asVault.transferToGasKey(VAULT, PublicKey.fromString(AGENT), add);
  ok(`transferred ${near6(add)} to ${AGENT.slice(0, 26)}…`);

  // VERIFY AGAINST THE CHAIN, not against the fact that the call returned.
  const after2 = await provider.viewAccessKeyList({
    accountId: VAULT,
    blockQuery: { finality: "final" },
  });
  const now = findGasKey(after2.keys, AGENT);
  if (now?.kind === "gas-key") {
    ok(`balance now ${near6(now.balance)} — ${paymentsAfterTopUp({ balance: now.balance, tgas: TGAS, amount: 0n })} payments`);
  }
  console.log("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.message ?? String(e)));
}
