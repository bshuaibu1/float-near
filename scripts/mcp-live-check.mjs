#!/usr/bin/env node
/**
 * Call the MCP server's tools against a LIVE vault, over real stdio.
 *
 * The unit tests cover the pure logic and the smoke test covers registration,
 * but neither proves a tool returns real data from a real chain. That gap is
 * the same one the vault's unreachable kill switch lived in: everything green,
 * nothing reachable.
 *
 * Reads and the create plan only. Nothing here signs.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VAULT = process.env.VAULT ?? "work12-testnet.fac.floatv4.testnet";
const FACTORY = process.env.FACTORY ?? "fac.floatv4.testnet";
const OWNER = process.env.OWNER ?? "work12.testnet";
// An owner that genuinely has NO vault. This said `floatv4.testnet`, which
// acquired one partway through the session — so the check started failing
// because the FIXTURE went stale, not the tool: vault_create correctly refused
// to plan a second vault for an owner who already had one. A test whose
// premise the system has since invalidated reports a bug that is not there.
const NEW_OWNER = process.env.NEW_OWNER ?? "alice.testnet";

const p = spawn("node", [resolve(ROOT, "packages", "mcp", "dist", "server.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    NEAR_VAULT_CONTRACT: VAULT,
    NEAR_VAULT_NETWORK: "testnet",
    NEAR_VAULT_RPC_URL: "https://test.rpc.fastnear.com",
    NEAR_VAULT_TOKEN: "usdc.fakes.testnet",
    NEAR_VAULT_TOKEN_DECIMALS: "6",
    NEAR_VAULT_FACTORY: FACTORY,
    NEAR_VAULT_APP_URL: "http://127.0.0.1:8787",
  },
});
p.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

const pending = new Map();
let buf = "";
p.stdout.on("data", (d) => {
  buf += d.toString();
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
      /* not a json line */
    }
  }
});

let nextId = 1;
const rpc = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`${method} timed out`));
      }
    }, 25_000);
  });

const call = async (name, args = {}) => {
  const m = await rpc("tools/call", { name, arguments: args });
  if (m.error) return { error: m.error.message ?? JSON.stringify(m.error) };
  const t = m.result?.content?.[0]?.text ?? "";
  try {
    return { value: JSON.parse(t) };
  } catch {
    return { value: t };
  }
};

let pass = 0;
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  ok ? pass++ : fail++;
};

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "live-check", version: "1" },
});

console.log(`\n  vault   ${VAULT}`);
console.log(`  factory ${FACTORY}\n`);

// ── reads ─────────────────────────────────────────────────────────────────────
const cfgR = await call("vault_config");
check(
  !cfgR.error && cfgR.value?.owner === OWNER,
  `vault_config returns the real owner`,
  cfgR.error ?? `owner -> ${cfgR.value?.owner}, clock -> ${cfgR.value?.clock_mode}`,
);

const treeR = await call("vault_tree");
check(
  !treeR.error && Array.isArray(treeR.value) && treeR.value.length >= 1,
  `vault_tree returns the node list`,
  treeR.error ?? `${treeR.value?.length} node(s), root label "${treeR.value?.[0]?.label}"`,
);

const budR = await call("vault_budget", { nodeId: 0 });
check(
  !budR.error && budR.value?.daily_cap !== undefined,
  `vault_budget converts caps to human units`,
  budR.error ?? `daily_cap ${budR.value?.daily_cap}, available ${budR.value?.available}`,
);

// ── a plan tool must emit an UNSIGNED payload ─────────────────────────────────
const planR = await call("vault_plan_pause", { paused: true });
check(
  !planR.error && planR.value?.unsigned_payload?.method_name === "set_paused",
  `vault_plan_pause emits an unsigned payload, not a transaction`,
  planR.error ?? `method ${planR.value?.unsigned_payload?.method_name}, note present: ${!!planR.value?.note}`,
);

// ── pay must REFUSE without a key ─────────────────────────────────────────────
// The negative that matters. Configured with no agent key, the signing tool
// must decline rather than attempt anything.
const payR = await call("vault_pay", { amount: "1", recipient: OWNER, nodeId: 0 });
const refused = payR.error || /key|NEAR_VAULT_AGENT/i.test(JSON.stringify(payR.value ?? ""));
check(
  !!refused,
  `vault_pay refuses with no agent key configured`,
  String(payR.error ?? JSON.stringify(payR.value)).slice(0, 150),
);

// ── onboarding ────────────────────────────────────────────────────────────────
// A fresh owner with no vault: the whole point of the tool.
const newR = await call("vault_create", { owner: NEW_OWNER });
const nv = newR.value;
check(
  !newR.error && typeof nv === "object" && !!nv?.url,
  `vault_create plans a vault for an owner who has none`,
  newR.error ?? `vault ${nv?.vault}, deposit ${nv?.depositNear}, total ${nv?.totalRequiredNear}`,
);
if (nv?.url) console.log(`        url ${nv.url}`);

// The existing owner must be told to connect, not to create a second one.
const dupR = await call("vault_create", { owner: OWNER });
check(
  /already exists/i.test(String(dupR.value ?? dupR.error ?? "")),
  `vault_create refuses an owner who already has a vault`,
  String(dupR.value ?? dupR.error).slice(0, 150),
);

// An implicit account has no legal derived id.
const impR = await call("vault_create", { owner: "a".repeat(64) });
check(
  /no legal vault id/i.test(String(impR.value ?? impR.error ?? "")),
  `vault_create refuses an implicit account`,
  String(impR.value ?? impR.error).slice(0, 150),
);

p.kill();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
