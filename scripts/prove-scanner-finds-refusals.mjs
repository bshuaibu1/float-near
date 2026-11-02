#!/usr/bin/env node
/**
 * Can the block scanner actually FIND a refusal? Narrow positive control.
 *
 * Two scans have now reported "0 refusals" over windows that should have
 * contained one — a deliberate RECIPIENT_NOT_ALLOWED that the contract
 * confirmed with `status: BLOCKED`. Either the refusal fell outside both
 * windows, or `scanRange` cannot see refusals at all. Those are very
 * different problems and "0 found" looks identical for both, which is exactly
 * the ambiguity this whole module exists to kill.
 *
 * So: record the head, cause ONE refusal, record the head again, and scan
 * precisely that span. The window is a handful of blocks, so a miss cannot be
 * blamed on coverage.
 *
 * Writes to a THROWAWAY store, never the real one — a diagnostic must not
 * mutate the coverage record it is diagnosing.
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const VAULT = process.env.VAULT ?? "floatv4-testnet.fac.floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";
const BAD_RECIPIENT = process.env.BAD_RECIPIENT ?? "work12.testnet";
const RPC_URL = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const KEYS = join(ROOT, ".float", "agent-keys.json");
const SERVER = join(ROOT, "packages", "mcp", "dist", "server.js");
const DIST = resolve(ROOT, "packages/float-adapter/dist/blocked-scan.js");

for (const f of [KEYS, SERVER, DIST]) {
  if (!existsSync(f)) {
    console.error(`FATAL: ${f} missing.`);
    process.exit(1);
  }
}
const { scanRange, createRpc } = await import(pathToFileURL(DIST).href);

const raw = JSON.parse(readFileSync(KEYS, "utf8"));
const list = Array.isArray(raw) ? raw : (raw.agents ?? raw.keys ?? []);
const hit = (Array.isArray(list) ? list : []).find(
  (a) => a?.vault === VAULT || a?.vaultId === VAULT || a?.contractId === VAULT,
);
const SECRET = hit?.secret ?? hit?.privateKey ?? hit?.private_key ?? hit?.secretKey;
if (!SECRET?.startsWith?.("ed25519:")) {
  console.error(`FATAL: no agent secret for ${VAULT}`);
  process.exit(1);
}

const head = async () => {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } }),
  });
  return (await r.json()).result.header.height;
};

const before = await head();
console.log(`\n  head before : ${before}`);

// ---- cause exactly one refusal ---------------------------------------------
const child = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    NEAR_VAULT_CONTRACT: VAULT,
    NEAR_VAULT_NETWORK: "testnet",
    NEAR_VAULT_RPC_URL: RPC_URL,
    NEAR_VAULT_TOKEN: TOKEN,
    NEAR_VAULT_TOKEN_DECIMALS: "6",
    NEAR_VAULT_AGENT_ID: VAULT,
    NEAR_VAULT_AGENT_KEY: SECRET,
  },
});
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += String(d);
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      const r = pending.get(m.id);
      if (r) {
        pending.delete(m.id);
        r(m);
      }
    } catch {
      /* partial */
    }
  }
});
let nextId = 1;
const rpcCall = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`${method} timed out`))), 90_000);
  });

let requestId = null;
try {
  await rpcCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "scanner-control", version: "1" },
  });
  const m = await rpcCall("tools/call", {
    name: "vault_pay",
    arguments: { amount: "1", recipient: BAD_RECIPIENT, memo: "scanner positive control" },
  });
  const text = m.result?.content?.[0]?.text ?? "";
  const parsed = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  requestId = parsed?.request_id ?? null;
  console.log(`  refusal     : ${parsed?.status} ${parsed?.reason_code} (${requestId})`);
  if (parsed?.status !== "BLOCKED") {
    console.error(`  FATAL: expected BLOCKED, got ${text.slice(0, 200)}`);
    process.exit(1);
  }
} finally {
  child.kill();
}

const after = await head();
console.log(`  head after  : ${after}`);

// Widen by a few blocks each side: the tx lands a block or two after the call
// returns, and finality lags.
const from = before - 3;
const to = after + 6;
console.log(`\n  scanning ${from}..${to} (${to - from + 1} blocks) for that refusal\n`);

const rpc = createRpc(RPC_URL, { onThrottle: () => {} });
const res = await scanRange(rpc, VAULT, from, to);

console.log(`  blocks seen     : ${res.blocksSeen}`);
console.log(`  chunks fetched  : ${res.chunksFetched}, skipped empty ${res.chunksSkipped}`);
console.log(`  unreadable      : ${res.holes.length}`);
console.log(`  refusals found  : ${res.records.length}`);
for (const r of res.records) {
  console.log(`      ${r.requestId}  ${r.reasonCode}  node ${r.nodeId}  block ${r.blockHeight}`);
}

const found = res.records.some((r) => r.requestId === requestId);
console.log();
if (found) {
  console.log(`  => the scanner CAN find refusals. The earlier zeroes were coverage,`);
  console.log(`     not blindness: the refusal fell outside the windows scanned.`);
} else {
  console.log(`  => THE SCANNER DID NOT FIND A REFUSAL IT WAS POINTED AT.`);
  console.log(`     ${requestId} is confirmed BLOCKED by the contract and is inside`);
  console.log(`     ${from}..${to}, so "0 refusals" from this scanner means NOTHING`);
  console.log(`     until this is explained. Do not trust any coverage claim it makes.`);
}
console.log();
process.exit(found ? 0 : 1);
