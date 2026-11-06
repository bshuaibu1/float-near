#!/usr/bin/env node
/**
 * Prove `.mcp.json` actually starts a working server.
 *
 * "The file exists and hashes match the template" establishes nothing about
 * whether Claude can use it — the template could be wrong, the path could point
 * at a deleted build, the env could name a vault that does not exist. This
 * reads the file Claude will read, launches exactly what it specifies, and
 * calls a tool through it.
 *
 * Read-only: lists tools and reads the vault config. Signs nothing.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG = join(ROOT, ".mcp.json");

let pass = 0;
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  ok ? pass++ : fail++;
};

if (!existsSync(CONFIG)) {
  console.error(`FATAL: ${CONFIG} does not exist.`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  check(true, `.mcp.json is valid JSON`);
} catch (e) {
  check(false, `.mcp.json is valid JSON`, e.message);
  process.exit(1);
}

const entry = cfg?.mcpServers?.["float-near"];
check(!!entry, `it defines mcpServers["float-near"]`, entry ? "" : `keys: ${Object.keys(cfg?.mcpServers ?? {}).join(", ") || "(none)"}`);
if (!entry) process.exit(1);

check(entry.type === "stdio", `type is "stdio"`, `got ${JSON.stringify(entry.type)}`);
check(entry.command === "node", `command is "node"`, `got ${JSON.stringify(entry.command)}`);

// RELATIVE PATHS ARE NOT SUPPORTED here — args go straight to the OS process
// launcher rather than being resolved against the project root.
const arg0 = entry.args?.[0];
const absolute = typeof arg0 === "string" && /^[A-Za-z]:[\\/]/.test(arg0);
check(absolute, `the server path is absolute`, `got ${JSON.stringify(arg0)}`);
check(existsSync(arg0 ?? ""), `the server file exists on disk`, arg0 ?? "");

// ---- launch EXACTLY what the config says ------------------------------------
const child = spawn(entry.command, entry.args ?? [], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ...(entry.env ?? {}) },
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
    }, 25_000);
  });

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-mcp-json", version: "1" },
  });
  check(
    init.result?.serverInfo?.name === "float",
    `the server starts and identifies itself`,
    `serverInfo: ${JSON.stringify(init.result?.serverInfo)}`,
  );

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  // 19, and the arithmetic is worth stating so the next change to this number
  // has to be justified rather than just bumped:
  //   17 original
  //  + 1 vault_create (onboarding)
  //  + 1 vault_plan_create_agent became TWO tools, bind_agent and unbind_agent
  //  = 19
  // This said 18 and was simply stale — I had counted before splitting the
  // agent tool in two. The server was right; the assertion was wrong.
  check(names.length === 19, `it exposes 19 tools`, `got ${names.length}: ${names.sort().join(", ")}`);
  check(names.includes("vault_create"), `vault_create is present`);
  check(names.includes("vault_plan_bind_agent"), `vault_plan_bind_agent is present (replaces create_agent)`);
  check(!names.includes("vault_plan_create_agent"), `the retired vault_plan_create_agent is GONE`);

  // The decisive one: a real read, through the config Claude will use.
  const call = await rpc("tools/call", { name: "vault_config", arguments: {} });
  const body = call.result?.content?.[0]?.text ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* not json */
  }
  check(
    parsed?.owner === "work12.testnet",
    `vault_config reads the real vault through this config`,
    parsed ? `owner ${parsed.owner}, nodes ${parsed.node_count}, clock ${parsed.clock_mode}` : body.slice(0, 160),
  );
} catch (e) {
  check(false, `the server responded`, `${e.message}${stderr ? `\n        stderr: ${stderr.slice(0, 300)}` : ""}`);
} finally {
  child.kill();
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
