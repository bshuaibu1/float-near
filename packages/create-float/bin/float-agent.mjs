#!/usr/bin/env node
/**
 * Adds a VIRTUAL AGENT to an existing vault.
 *
 * A virtual agent is a NEP-611 gas key bound to a node. It is NOT a NEAR
 * account: no sub-account to create, no 0.05 of account storage, no 0.5 key
 * allowance. The key carries its own balance and pays its own gas.
 *
 *   old, per agent   a sub-account + a restricted key          0.55 NEAR
 *   now, per agent   a gas key bound to a node                ~0.12 NEAR
 *
 * 0.12 is `gasKeyFunding()` at its defaults: a 0.06 reservation plus burn for
 * 50 payments. The reservation is what NEAR holds per in-flight call and is
 * returned each time, so it is charged once however many payments are funded.
 *
 * This exists because setup deliberately creates NOTHING that can spend. The
 * wizard makes a flat vault and stops; delegation is a thing the owner does
 * when they have something to delegate. So the wizard tells you nothing can
 * spend yet, and this is the command that fixes it.
 *
 * VALIDATED ON MAINNET 2026-11-01. A gas key bound to node 3 of
 * float.test015.near self-submitted a request_payment that SETTLED, moved real
 * USDC, burned 0.000925 of its OWN balance, and the vault's balance moved by
 * exactly its storage growth — zero gas. The sequence below is that same
 * sequence; see scripts/validate-self-submit-testnet.mjs.
 *
 * Usage:
 *   npx -p @floatonnear/create-float float-agent --vault <v> --owner <o> [--node 0]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

import { gasKeyFunding, gasReservation, signerChoice, MIN_TGAS } from "./gas-key.mjs";
import { makeReaders, NETWORKS, RPC_DEFAULTS, UsageError } from "./args.mjs";

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};
const ok = (m) => console.log(`    ${C.g("ok")}   ${m}`);
const info = (m) => console.log(`    ${C.d(m)}`);
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const near6 = (y) => (Number(y) / 1e24).toFixed(6);

/**
 * The default ask, DERIVED and ROUNDED UP.
 *
 * This said "About 0.06 NEAR" — the reservation alone, not the funding. The
 * real default is `gasKeyFunding()` = reservation + burn x 50 payments = 0.12,
 * so the help understated by 2x and a user topping up to the documented figure
 * would fund a key that cannot cover even one call.
 *
 * Exactly the failure create-float 0.3.2 shipped to fix, reintroduced here by
 * writing a derived number down by hand. The only durable fix is not to write
 * it down. Rounds UP: an overstatement costs nothing because the balance is
 * withdrawable, an understatement produces a broken agent.
 */
const defaultAsk = () => (Math.ceil((Number(gasKeyFunding()) / 1e24) * 100) / 100).toFixed(2);

export function usage() {
  return `float-agent — add a virtual agent to an existing Float vault

USAGE
  npx -p @floatonnear/create-float float-agent --vault <account> --owner <account>

WHAT A VIRTUAL AGENT IS
  A gas key bound to a node on your vault. It is not a NEAR account: there is
  no sub-account, and it pays its OWN gas rather than drawing on the vault.
  About ${defaultAsk()} NEAR by default, and withdrawable.

  Its key may call exactly one method on exactly one contract. It cannot move
  tokens directly, raise its own limit, or reach owner functions.

OPTIONS
  --vault <account>     the vault to add the agent to          (required)
  --owner <account>     the vault's owner                      (required)
  --node <id>           which node to bind it to               (default 0, root)
  --payments <n>        fund for this many payments            (default 50)
  --tgas <n>            gas per call, at least ${MIN_TGAS}             (default 60)
  --network <net>       mainnet | testnet                      (default mainnet)
  --rpc <url>           override the RPC endpoint
  --dry-run             print the plan and stop, spending nothing
  -h, --help            print this and exit
`;
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
  console.log(usage());
  process.exit(0);
}

const { opt, has } = makeReaders(argv);
const NETWORK = opt("--network", "mainnet");
if (!NETWORKS.includes(NETWORK)) {
  console.error(`Unknown network '${NETWORK}'. Use testnet or mainnet.`);
  process.exit(2);
}
const RPC = opt("--rpc", null) ?? RPC_DEFAULTS[NETWORK];
const VAULT = opt("--vault", null);
const OWNER = opt("--owner", null);
const NODE = Number(opt("--node", "0"));
const PAYMENTS = Number(opt("--payments", "50"));
const TGAS = Number(opt("--tgas", "60"));
const DRY = has("--dry-run");

if (!VAULT || !OWNER) {
  console.error("--vault and --owner are both required.\n");
  console.error(usage());
  process.exit(2);
}

const provider = new JsonRpcProvider({ url: RPC });
const credPath = (a) => join(homedir(), ".near-credentials", NETWORK, `${a}.json`);
const readKey = (a) => {
  const k = JSON.parse(readFileSync(credPath(a), "utf8"));
  return KeyPair.fromString(k.private_key ?? k.secret_key);
};
const view = (method, args = {}) =>
  provider.callFunction({ contractId: VAULT, method, args, blockQuery: { finality: "optimistic" } });

console.log(`\n${C.b("float-agent")} ${C.d(`— a virtual agent on ${NETWORK}`)}`);
if (NETWORK === "mainnet") console.log(`  ${C.y("MAINNET — this spends real funds.")}`);

try {
  // ---- 0. preflight. Everything here is read-only and refuses rather than
  // discovering the problem halfway through a three-transaction sequence.
  step(0, "Preflight");
  if (!existsSync(credPath(OWNER))) {
    throw new Error(`no credential for ${OWNER} at ${credPath(OWNER)} — run: near login`);
  }
  const ownerKp = readKey(OWNER);
  const ownerPk = ownerKp.getPublicKey().toString();
  ok(`owner ${OWNER} (key found)`);

  const cfg = await view("get_config");
  if (cfg.owner !== OWNER) {
    throw new Error(`${VAULT} is owned by ${cfg.owner}, not ${OWNER}`);
  }
  ok(`vault ${VAULT} — owner matches, ${cfg.node_count} node(s)`);
  if (cfg.paused) throw new Error(`${VAULT} is paused; unpause before adding an agent`);

  const tree = await view("get_tree");
  const node = tree.find((n) => n.id === NODE);
  if (!node) throw new Error(`node ${NODE} does not exist (tree has ${tree.map((n) => n.id)})`);
  if (node.frozen) throw new Error(`node ${NODE} ("${node.label}") is frozen`);
  ok(`node ${NODE} "${node.label}" — ${(node.limits ?? []).length} token limit(s)`);

  // WHICH CREDENTIAL SIGNS AS THE VAULT. Resolved, not assumed: a wizard-made
  // vault carries the owner's key, but a vault upgraded from an older
  // deployment may hold its own. Guessing fails with InvalidAccessKeyError,
  // which reads like a contract bug.
  const vaultKeys = (await provider.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } }))
    .keys.filter((k) => k.access_key.permission === "FullAccess")
    .map((k) => k.public_key);
  const choice = signerChoice({
    ownerPublicKey: ownerPk,
    vaultKeys,
    hasVaultCredential: existsSync(credPath(VAULT)),
  });
  if (choice === "none") {
    throw new Error(
      `nothing here can sign for ${VAULT}.\n` +
        `  Adding a gas key is an AddKey ON the vault, so it needs one of the vault's\n` +
        `  full-access keys. ${OWNER}'s key is not among them, and there is no\n` +
        `  credential at ${credPath(VAULT)}.`,
    );
  }
  ok(`signing as the vault with the ${choice.toUpperCase()}'s key`);
  const vaultKp = choice === "owner" ? ownerKp : readKey(VAULT);

  // ---- 1. the plan
  const fund = gasKeyFunding({ tgas: TGAS, payments: PAYMENTS });
  step(1, "Plan");
  info(`bind a gas key to node ${NODE} ("${node.label}")`);
  info(`fund it with ${near6(fund)} NEAR`);
  info(`  reservation  ${near6(gasReservation(TGAS))}  ${C.d(`held per in-flight call at ${TGAS} TGas, returned after`)}`);
  info(`  burn budget  ${near6(fund - gasReservation(TGAS))}  ${C.d(`~${PAYMENTS} payments`)}`);
  info(`the key pays its OWN gas; the vault pays only storage for the ledger record`);
  info(`withdrawable later with withdrawFromGasKey`);

  const vaultAcctView = await provider.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } });
  const free = BigInt(vaultAcctView.amount) - BigInt(vaultAcctView.storage_usage) * 10n ** 19n;
  info(`vault free balance ${near6(free)}`);
  if (free < fund) {
    throw new Error(
      `the vault's free balance ${near6(free)} cannot fund ${near6(fund)}.\n` +
        `  The gas key is funded FROM the vault, so top the vault up first.`,
    );
  }

  if (DRY) {
    console.log(`\n${C.y("dry run")} — nothing was sent.\n`);
    process.exit(0);
  }

  // ---- 2. the three transactions, in the order validated on mainnet
  step(2, "Creating the agent");
  const kp = KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();

  const owner = new Account(OWNER, provider, new KeyPairSigner(ownerKp));
  const asVault = new Account(VAULT, provider, new KeyPairSigner(vaultKp));

  // BIND FIRST. The binding is what makes the key an agent; a gas key installed
  // before it is bound can call request_payment and be refused
  // NOT_VIRTUAL_AGENT, which is a confusing intermediate state to leave behind
  // if the next step fails.
  await owner.callFunction({
    contractId: VAULT,
    methodName: "bind_virtual_agent",
    args: { node_id: NODE, public_key: pk },
    gas: 60n * 10n ** 12n,
    deposit: 1n,
  });
  ok(`bound ${pk.slice(0, 26)}… to node ${NODE}`);

  await asVault.addFunctionCallGasKey({
    publicKey: kp.getPublicKey(),
    contractId: VAULT,
    methodNames: ["request_payment"],
    numNonces: 1,
  });
  ok(`gas key installed — may call request_payment on ${VAULT}, nothing else`);

  await asVault.transferToGasKey(VAULT, kp.getPublicKey(), fund);
  ok(`funded with ${near6(fund)} NEAR`);

  // ---- 3. write the key where the adapter expects it
  step(3, "Saving");
  mkdirSync(".float", { recursive: true });
  const keysPath = join(".float", "agent-keys.json");
  const existing = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : [];
  existing.push({ kind: "virtual", vault: VAULT, node: NODE, publicKey: pk, privateKey: kp.toString() });
  writeFileSync(keysPath, JSON.stringify(existing, null, 2) + "\n");
  ok(`${keysPath} ${C.d("(plain text — anyone who reads it can spend up to this node's caps)")}`);

  console.log(`
  ${C.b("Done.")} Point your agent at it:

    NEAR_VAULT_CONTRACT=${VAULT}
    NEAR_VAULT_AGENT_ID=${VAULT}
    NEAR_VAULT_AGENT_KEY=${C.d("(from .float/agent-keys.json)")}

  The agent id is the VAULT, not a separate account — that is what a virtual
  agent means. The contract resolves which node it is by the signing key.
`);
} catch (e) {
  console.error(`\n${C.r("failed")}  ${e.message}\n`);
  // process.exitCode, never process.exit: RPC handles may still be closing and
  // process.exit aborts the loop with UV_HANDLE_CLOSING, replacing a clean 1
  // with -1073740791. Already fixed twice in this repo.
  process.exitCode = 1;
}
