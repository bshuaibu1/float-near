#!/usr/bin/env node
/**
 * Emit the MCP server config, verified rather than guessed.
 *
 * FOUR ATTEMPTS FAILED BEFORE THIS, and the reasons are all Windows-shell
 * specific rather than anything wrong with the server:
 *
 *   claude mcp add ... -- node <path>
 *     -> "missing required argument 'commandOrUrl'". PowerShell's `claude.ps1`
 *        wrapper does not forward the `--` separator.
 *
 *   claude mcp add-json <name> '{...}'
 *     -> "Invalid configuration: : Invalid input". PowerShell strips the outer
 *        quotes and interprets backslash sequences in the Windows path BEFORE
 *        the CLI parses the JSON, so malformed JSON arrives. Adding
 *        `"type":"stdio"` changed nothing, because the shape was never the
 *        problem.
 *
 *   claude mcp add --% ...
 *     -> "unknown option '--%'". The stop-parsing token only applies to native
 *        executables; `claude` here is a PowerShell SCRIPT, so `--%` was passed
 *        through as a literal argument.
 *
 * So this writes a `.mcp.json` BODY to a plain text file for the user to copy,
 * which avoids every shell-quoting layer. Confirmed against the Claude Code
 * docs: `.mcp.json` takes `mcpServers.<name>.{type,command,args,env}`, and
 * RELATIVE PATHS ARE NOT SUPPORTED in `args` — they are handed straight to the
 * OS process launcher — so the path is absolute and asserted to exist.
 */
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER = resolve(ROOT, "packages", "mcp", "dist", "server.js");

if (!existsSync(SERVER)) {
  console.error(`FATAL: ${SERVER} does not exist.`);
  console.error(`  Build it first:  cd packages/mcp && npm run build`);
  process.exit(1);
}

const NETWORK = process.env.NETWORK ?? "testnet";
const VAULT = process.env.VAULT ?? "work12-testnet.fac.floatv4.testnet";
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

// No agent key: `vault_pay` correctly refuses until a virtual agent is bound,
// and a private key does not belong in a committed file regardless.
const body = {
  mcpServers: {
    "float-near": {
      type: "stdio",
      command: "node",
      args: [SERVER],
      env,
    },
  },
};

const text = `${JSON.stringify(body, null, 2)}\n`;
JSON.parse(text); // must round-trip

mkdirSync(join(ROOT, ".demo"), { recursive: true });
const out = join(ROOT, ".demo", "mcp-json-to-save.txt");
writeFileSync(out, text, "utf8");

console.log(`\n  server   ${SERVER}`);
console.log(`  vault    ${VAULT}`);
console.log(`  network  ${NETWORK}`);
console.log(`\n  Written to: ${out}\n`);
console.log(`Save this as  .mcp.json  in the repo root:\n`);
console.log(text);
console.log(`PowerShell one-liner to do that:\n`);
console.log(`  Copy-Item .demo\\mcp-json-to-save.txt .mcp.json`);
console.log(`\nThen start a NEW Claude session. It will ask you to approve the`);
console.log(`project MCP server; say yes, then /mcp shows float-near.\n`);
console.log(`Alternative, if you would rather it be USER scope (every project):`);
console.log(`  put the same "mcpServers" block into  ${process.env.USERPROFILE ?? "~"}\\.claude.json\n`);
