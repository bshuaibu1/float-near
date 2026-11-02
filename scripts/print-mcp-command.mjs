#!/usr/bin/env node
/**
 * Print the exact `claude mcp add-json` command, with the path verified.
 *
 * WHY A SCRIPT AND NOT A COMMAND IN A MESSAGE.
 *
 * Two separate things went wrong trying to hand this over by hand:
 *
 *   1. `claude mcp add ... -- node <path>` FAILS in PowerShell with
 *      "missing required argument 'commandOrUrl'". PowerShell consumes the
 *      `--` separator, so commander never sees the command. `add-json` takes
 *      the whole server definition as one JSON argument and needs no
 *      separator, which sidesteps it entirely.
 *
 *   2. Generating that JSON through `node -e` inside a shell mangled every
 *      backslash in the Windows path — it printed
 *      `C:UsersBASHIRDocuments\near-vault...`, a path that does not exist, in
 *      a command that would have registered a server which could never start.
 *
 * So the path is built with `path.resolve` from this file's own location, and
 * asserted to EXIST before anything is printed. A command that cannot work is
 * not printed at all.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER = resolve(ROOT, "packages", "mcp", "dist", "server.js");

if (!existsSync(SERVER)) {
  console.error(`FATAL: ${SERVER} does not exist.`);
  console.error(`  Build it first:  cd packages/mcp && npm run build`);
  process.exit(1);
}

const VAULT = process.env.VAULT ?? "work12-testnet.fac.floatv4.testnet";
const NETWORK = process.env.NETWORK ?? "testnet";
const FACTORY = process.env.FACTORY ?? "fac.floatv4.testnet";
const RPC =
  process.env.RPC ??
  (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
const TOKEN = process.env.TOKEN ?? (NETWORK === "mainnet" ? "" : "usdc.fakes.testnet");
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:8787";

const env = {
  NEAR_VAULT_CONTRACT: VAULT,
  NEAR_VAULT_NETWORK: NETWORK,
  NEAR_VAULT_RPC_URL: RPC,
  NEAR_VAULT_TOKEN_DECIMALS: "6",
  NEAR_VAULT_FACTORY: FACTORY,
  NEAR_VAULT_APP_URL: APP_URL,
};
if (TOKEN) env.NEAR_VAULT_TOKEN = TOKEN;

// No agent key. `vault_pay` refuses without one, which is correct until a
// virtual agent is actually bound — and a key does not belong in a shell
// command that lands in terminal history either way.
const json = JSON.stringify({ command: "node", args: [SERVER], env });

// PowerShell single-quoting is literal, so the one character that would break
// it is a single quote. Check rather than assume.
if (json.includes("'")) {
  console.error("FATAL: the JSON contains a single quote; PowerShell quoting would break.");
  process.exit(1);
}
JSON.parse(json); // must round-trip

console.log(`\n  server   ${SERVER}`);
console.log(`  vault    ${VAULT}`);
console.log(`  network  ${NETWORK}\n`);
console.log(`Run this in PowerShell:\n`);
console.log(`claude mcp add-json float-near --scope user '${json}'`);
console.log(`\nThen start a NEW Claude session and type /mcp\n`);
