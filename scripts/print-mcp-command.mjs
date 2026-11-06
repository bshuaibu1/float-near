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
// `readFileSync` was missing here and the script died at runtime with
// "ReferenceError: readFileSync is not defined". `node --check` passed, because
// it is a SYNTAX check and never resolves identifiers — it cannot catch a
// missing import, so it is not the safety net it looks like.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:8080";

const env = {
  NEAR_VAULT_CONTRACT: VAULT,
  NEAR_VAULT_NETWORK: NETWORK,
  NEAR_VAULT_RPC_URL: RPC,
  NEAR_VAULT_TOKEN_DECIMALS: "6",
  NEAR_VAULT_FACTORY: FACTORY,
  NEAR_VAULT_APP_URL: APP_URL,
};
if (TOKEN) env.NEAR_VAULT_TOKEN = TOKEN;

// THE AGENT KEY, if this vault has one bound.
//
// Without it `vault_pay` refuses, which is correct but means the server can
// read and plan and never spend. With it, paying works from inside the client.
//
// Safe to write here because BOTH ends are gitignored: `.demo/` (line 21) and
// `.mcp.json` itself (added after discovering it was tracked). It is never
// PRINTED — the console output below redacts it. This repo carries a scar from
// a CLI that echoed a private key into a terminal and a chat transcript.
const KEYS = join(ROOT, ".float", "agent-keys.json");
let agent = null;
if (existsSync(KEYS)) {
  const raw = JSON.parse(readFileSync(KEYS, "utf8"));
  const list = Array.isArray(raw) ? raw : (raw.agents ?? raw.keys ?? []);
  const hit = (Array.isArray(list) ? list : []).find(
    (a) => a?.vault === VAULT || a?.vaultId === VAULT || a?.contractId === VAULT,
  );
  const secret = hit?.secret ?? hit?.privateKey ?? hit?.private_key ?? hit?.secretKey;
  if (typeof secret === "string" && secret.startsWith("ed25519:")) {
    // The agent id is the VAULT. That is what "virtual agent" means: there is
    // no separate account, and the contract resolves the node from the signing
    // key via `signer_account_pk()`.
    env.NEAR_VAULT_AGENT_ID = VAULT;
    env.NEAR_VAULT_AGENT_KEY = secret;
    agent = hit?.publicKey ?? hit?.public_key ?? "(public key not recorded)";
  }
}

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

// Redacted copy for the console. Printing the real one would put a private key
// in the terminal scrollback and in any transcript of this session.
const shown = JSON.parse(text);
if (shown.mcpServers["float-near"].env.NEAR_VAULT_AGENT_KEY) {
  shown.mcpServers["float-near"].env.NEAR_VAULT_AGENT_KEY = "<redacted — written to the file>";
}
const shownText = `${JSON.stringify(shown, null, 2)}\n`;

mkdirSync(join(ROOT, ".demo"), { recursive: true });
const out = join(ROOT, ".demo", "mcp-json-to-save.txt");

// DELETE BEFORE WRITING, so a crash leaves nothing behind to copy.
//
// This script died once at a missing import, leaving the PREVIOUS run's file
// in place — and the `Copy-Item .demo\... .mcp.json` that followed happily
// copied it, installing a config for the wrong vault with no agent key. The
// copy reported success. Same failure shape as a stale build artifact, and the
// same fix as scripts/build-factory.sh: remove first, require existence after,
// so "did nothing" cannot masquerade as "succeeded".
if (existsSync(out)) rmSync(out);
writeFileSync(out, text, "utf8");
if (!existsSync(out)) {
  console.error(`FATAL: ${out} was not written.`);
  process.exit(1);
}

console.log(`\n  server   ${SERVER}`);
console.log(`  vault    ${VAULT}`);
console.log(`  network  ${NETWORK}`);
console.log(`  agent    ${agent ?? "none bound — vault_pay will refuse, reads and plans still work"}`);
console.log(`\n  Written to: ${out}\n`);
console.log(`Save this as  .mcp.json  in the repo root:\n`);
console.log(shownText);
console.log(`PowerShell one-liner to do that:\n`);
console.log(`  Copy-Item .demo\\mcp-json-to-save.txt .mcp.json`);
console.log(`\nThen start a NEW Claude session. It will ask you to approve the`);
console.log(`project MCP server; say yes, then /mcp shows float-near.\n`);
console.log(`Alternative, if you would rather it be USER scope (every project):`);
console.log(`  put the same "mcpServers" block into  ${process.env.USERPROFILE ?? "~"}\\.claude.json\n`);
