#!/usr/bin/env node
/**
 * Drive the BUILT MCP server over real JSON-RPC, with the real .mcp.json env.
 *
 * WHY NOT just call the library. Because the thing that broke was never the
 * library — it was the env the server is actually started with. A test that
 * imports `rpcForNetwork` and asserts it returns a mainnet URL passes happily
 * while `.mcp.json` carries a stale `NEAR_VAULT_RPC_URL` pointing at testnet,
 * which is precisely what it carried. The config IS the subject.
 *
 * It also cannot be verified through the MCP tools in a running session: the
 * client starts its servers once, so an edit to `.mcp.json` has no effect until
 * a restart. Without this, "I fixed the config" would be unverifiable until
 * someone restarted and found out during the demo.
 *
 * So: spawn `dist/server.js` exactly as the client would, speak the protocol,
 * call read-only tools, print what came back.
 *
 *   node scripts/drive-mcp.mjs vault_config
 *   node scripts/drive-mcp.mjs vault_budget '{"nodeId":1}'
 *   node scripts/drive-mcp.mjs --list
 *
 * READ-ONLY BY DESIGN. It refuses `vault_pay`: this repo's rule is that mainnet
 * writes are staged and human-run, and a convenience script that can spend is
 * one typo from spending.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const SERVER_NAME = "float-near";
/**
 * `vault_pay` stays refused BY DEFAULT, for the reason in the header: a
 * convenience script that can spend is one typo from spending.
 *
 * FLOAT_DRIVE_ALLOW_OVER_CAP=1 opens it for amounts that CANNOT settle, and the
 * check is the same one scripts/prove-refusal.mjs uses: read the smallest
 * per-payment cap in the node's ancestor chain from the chain, and refuse
 * unless the amount exceeds it. So the escape hatch cannot move money -- it is
 * narrowed by live state, not by my intention to be careful.
 */
const REFUSED = new Set(["vault_pay"]);
const ALLOW_OVER_CAP = process.env.FLOAT_DRIVE_ALLOW_OVER_CAP === "1";

const [toolArg, argsArg] = process.argv.slice(2);
const LIST = toolArg === "--list";
const tool = LIST ? null : (toolArg ?? "vault_config");

if (tool && REFUSED.has(tool) && !ALLOW_OVER_CAP) {
  console.error(
    `drive-mcp: refusing ${tool}. This script is read-only — mainnet writes are staged and ` +
      `human-run. Run the payment yourself, deliberately, from the MCP client.` +
      `${String.fromCharCode(10)}  To demonstrate a REFUSAL (an amount that cannot settle), set ` +
      `FLOAT_DRIVE_ALLOW_OVER_CAP=1.`,
  );
  process.exit(2);
}

if (tool === "vault_pay" && ALLOW_OVER_CAP) {
  // Enforced HERE rather than trusted: the amount must exceed the smallest
  // per-payment cap in the chain, so no transfer is reachable on this path.
  //
  // CAUGHT, not left to an unhandled rejection. A refusal here is an expected
  // outcome of a safety check, and a 20-line stack trace reads like the script
  // is broken rather than like the guard did its job.
  const { assertCannotSettle } = await import("./cannot-settle.mjs");
  try {
    await assertCannotSettle(JSON.parse(argsArg ?? "{}"));
  } catch (e) {
    console.error(`drive-mcp: ${e.message}`);
    process.exit(2);
  }
}

/**
 * A MISSING .mcp.json IS A CONFIGURATION STATE, NOT A CRASH.
 *
 * This read used to throw a raw ENOENT stack trace, which reads like the
 * script is broken rather than like the client is unconfigured — and the
 * commonest time to run it is exactly when you have just reinstalled and have
 * not written the config yet.
 */
function readMcpConfig() {
  if (!existsSync(".mcp.json")) {
    console.error(
      `no .mcp.json in ${process.cwd()}, so there is no MCP server to read.${String.fromCharCode(10)}` +
        `  Configure one (npx -y @floatonnear/mcp, NEAR_VAULT_NETWORK=mainnet,${String.fromCharCode(10)}` +
        `  NEAR_VAULT_FACTORY=usefloat.near), or let create-float write it for you.`,
    );
    process.exit(2);
  }
  return JSON.parse(readFileSync(".mcp.json", "utf8"));
}

const cfg = readMcpConfig();
const srv = (cfg.mcpServers ?? cfg.servers ?? {})[SERVER_NAME];
if (!srv) {
  console.error(`drive-mcp: no "${SERVER_NAME}" server in .mcp.json`);
  process.exit(1);
}

// NAMES ONLY for anything secret-shaped — this output gets pasted.
const envNames = Object.keys(srv.env ?? {});
console.log(`drive-mcp: ${[srv.command, ...(srv.args ?? [])].join(" ")}`);
console.log(`  env: ${envNames.join(", ")}`);
console.log(
  `  vault=${srv.env?.NEAR_VAULT_CONTRACT ?? "(unset)"} network=${srv.env?.NEAR_VAULT_NETWORK ?? "(unset)"}`,
);
console.log("");

const child = spawn(srv.command, srv.args ?? [], {
  env: { ...process.env, ...(srv.env ?? {}) },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (b) => {
  stderr += b.toString();
});

/** Framed JSON-RPC over stdio: one JSON object per line. */
let buf = "";
const waiters = new Map();
child.stdout.on("data", (b) => {
  buf += b.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not a protocol line
    }
    if (msg.id !== undefined && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30_000);
    waiters.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "drive-mcp", version: "0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  if (LIST) {
    const r = await rpc("tools/list", {});
    const names = (r.result?.tools ?? []).map((t) => t.name).sort();
    console.log(`${names.length} tools:`);
    for (const n of names) console.log(`  ${n}`);
  } else {
    const r = await rpc("tools/call", {
      name: tool,
      arguments: argsArg ? JSON.parse(argsArg) : {},
    });
    const content = r.result?.content ?? [];
    const text = content.map((c) => c.text ?? "").join("\n");
    if (r.error) {
      console.log(`ERROR  ${JSON.stringify(r.error)}`);
      process.exitCode = 1;
    } else if (r.result?.isError) {
      console.log(`TOOL ERROR${String.fromCharCode(10)}${text}`);
      process.exitCode = 1;
    } else {
      console.log(text);
    }
  }
} finally {
  if (stderr.trim()) console.log(`${String.fromCharCode(10)}--- server stderr ---${String.fromCharCode(10)}${stderr.trim()}`);
  child.kill();
}
