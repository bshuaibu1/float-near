#!/usr/bin/env node
/**
 * Deliberately get a payment REFUSED, as a positive control.
 *
 * `prove-no-refusals.mjs` says this vault has had zero refusals. That claim is
 * worthless until the method can be shown to detect one — a counter that
 * always reports zero reports zero correctly by accident. So: cause exactly
 * one refusal, re-run the proof, and confirm it moves from 0 to 1.
 *
 * HOW IT REFUSES: the root node's recipient allowlist is ["floatv4.testnet"],
 * so paying anyone else returns RECIPIENT_NOT_ALLOWED. Chosen over busting a
 * cap because it moves no money and consumes no budget — the refusal happens
 * before any reservation is taken.
 *
 * It costs gas from the agent's own key and nothing else. The secret is read
 * from .float/agent-keys.json and never printed.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VAULT = process.env.VAULT ?? "floatv4-testnet.fac.floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";
// NOT on the root's allowlist. That is the point.
const BAD_RECIPIENT = process.env.BAD_RECIPIENT ?? "work12.testnet";
const AMOUNT = process.env.AMOUNT ?? "1";
const KEYS = join(ROOT, ".float", "agent-keys.json");
const SERVER = join(ROOT, "packages", "mcp", "dist", "server.js");

for (const f of [KEYS, SERVER]) {
  if (!existsSync(f)) {
    console.error(`FATAL: ${f} missing.`);
    process.exit(1);
  }
}
const raw = JSON.parse(readFileSync(KEYS, "utf8"));
const list = Array.isArray(raw) ? raw : (raw.agents ?? raw.keys ?? []);
const hit = (Array.isArray(list) ? list : []).find(
  (a) => a?.vault === VAULT || a?.vaultId === VAULT || a?.contractId === VAULT,
);
const SECRET = hit?.secret ?? hit?.privateKey ?? hit?.private_key ?? hit?.secretKey;
if (typeof SECRET !== "string" || !SECRET.startsWith("ed25519:")) {
  console.error(`FATAL: no agent secret for ${VAULT} in ${KEYS}`);
  process.exit(1);
}

console.log(`\n  vault     ${VAULT}`);
console.log(`  paying    ${AMOUNT} -> ${BAD_RECIPIENT}  (deliberately NOT on the allowlist)\n`);

const child = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    NEAR_VAULT_CONTRACT: VAULT,
    NEAR_VAULT_NETWORK: "testnet",
    NEAR_VAULT_RPC_URL: process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com",
    NEAR_VAULT_TOKEN: TOKEN,
    NEAR_VAULT_TOKEN_DECIMALS: "6",
    NEAR_VAULT_AGENT_ID: VAULT,
    NEAR_VAULT_AGENT_KEY: SECRET,
  },
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += String(d)));

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
const rpc = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`${method} timed out`));
      }
    }, 90_000);
  });

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "trigger-refusal", version: "1" },
  });
  const m = await rpc("tools/call", {
    name: "vault_pay",
    arguments: { amount: AMOUNT, recipient: BAD_RECIPIENT, memo: "deliberate refusal, positive control" },
  });
  const text = m.result?.content?.[0]?.text ?? JSON.stringify(m.error ?? m);
  console.log(text.split("\n").map((l) => `  ${l}`).join("\n"));
  const refused = /BLOCKED|RECIPIENT_NOT_ALLOWED|not allowed/i.test(text);
  console.log();
  console.log(`  refused as expected: ${refused ? "YES" : "NO — check the reason above"}`);
} catch (e) {
  console.log(`  threw: ${e.message}`);
  if (stderr) console.log(`  stderr: ${stderr.slice(0, 300)}`);
} finally {
  child.kill();
}
console.log();
