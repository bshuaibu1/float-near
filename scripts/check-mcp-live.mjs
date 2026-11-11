#!/usr/bin/env node
/**
 * Call EVERY tool against a real vault and report what actually works.
 *
 * WHY THIS EXISTS. Tool-level breakage kept being discovered in front of a
 * user, one tool at a time, during a demo. Each individual bug was small; the
 * pattern was that nothing ever exercised the whole surface at once, so a tool
 * could be broken for weeks and only the one someone happened to call that day
 * was known to work.
 *
 * Three found by this harness on its first run, all invisible to the unit
 * suite because none of them is a function returning a wrong value — they are
 * a server talking to the wrong chain, a filter that was never applied, and a
 * display that renders raw base units:
 *
 *   - every read queried TESTNET for a mainnet vault, because `cfg.rpcUrl`
 *     defaulted to the testnet endpoint regardless of NEAR_VAULT_NETWORK
 *   - the keyring was never scoped to the configured vault, so `vault_roles`
 *     listed other vaults' agents and `selectRole` could hand the pay path a
 *     credential from a different network
 *   - `vault_tree` returns `daily_cap: "25000000"` where `vault_budget`
 *     returns `"25"` for the same number
 *
 * NOT IN `verify-all`: it needs the internet and a real vault, and it fails
 * for reasons a working tree cannot fix. Run it before a demo, and after any
 * change to the server's configuration handling.
 *
 * READ AND PLAN ONLY. `vault_pay` signs and moves money, so it is listed as
 * skipped rather than called — a smoke test that spends is not a smoke test.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// A newline ESCAPE inside a generated file is one backslash level away from
// becoming a real newline and a syntax error. This is the fifth time in this
// repo; verify-all.mjs solved it the same way.
const LF = String.fromCharCode(10);

const SERVER = resolve("packages/mcp/dist/server.js");

const VAULT = process.env.NEAR_VAULT_CONTRACT ?? "test015-near.usefloat.near";
const NETWORK = process.env.NEAR_VAULT_NETWORK ?? "mainnet";
const TOKEN =
  process.env.NEAR_VAULT_TOKEN ??
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/**
 * What to call, and what counts as working.
 *
 * `expect` is deliberately a PREDICATE over the parsed result rather than a
 * snapshot: this runs against live state, so pinning values would fail for
 * reasons that are not defects. It asserts shape and the absence of the
 * failure modes actually seen — chiefly "account does not exist", which is how
 * the wrong-chain bug presented while the tool itself returned HTTP 200.
 */
/**
 * A plan tool returns `{action, summary, warnings, unsigned_payload, ...}`,
 * and the payload inside is SNAKE_CASE: `receiver_id`, `method_name`.
 *
 * The builder in payloads.ts returns camelCase `receiverId` and the tool layer
 * converts, so the shape you see in source is not the shape on the wire.
 *
 * THIS PREDICATE WAS WRONG TWICE AND REPORTED FIVE WORKING TOOLS AS BROKEN —
 * first by reading `receiverId` at the top level, then by reading camelCase
 * one level down. Both times the harness was the defect, and both times the
 * output would have sent someone hunting a bug in the one lane of this server
 * that was entirely fine. It was fixed by DUMPING an actual response instead
 * of recalling the shape a third time. An assertion written from memory is a
 * guess wearing a test's clothes.
 */
const plan = (r) =>
  !!r && r.unsigned_payload?.receiver_id === VAULT && !!r.unsigned_payload?.method_name;

const CASES = [
  { tool: "vault_config", args: {}, expect: (r) => r.owner && r.network === NETWORK },
  { tool: "vault_tree", args: {}, expect: (r) => Array.isArray(r) && r.length > 0 },
  { tool: "vault_budget", args: { nodeId: 0 }, expect: (r) => "available" in r },
  { tool: "vault_roles", args: {}, expect: (r) => Array.isArray(r) },
  { tool: "vault_gas", args: {}, expect: (r) => r !== null },
  // Takes a requestId -- it reads ONE request's approval state, not a list.
  // A nonexistent id is the honest smoke case: it must answer cleanly rather
  // than throw. Calling it with {} was MY error, not the tool's.
  {
    tool: "vault_pending_approval",
    args: { requestId: "smoke-check-nonexistent" },
    expect: (r) => r === null || typeof r === "object",
  },
  { tool: "vault_teardown_report", args: {}, expect: (r) => r !== null },
  // PLAN tools return an UNSIGNED payload. The assertion is that one comes
  // back with a receiver and a method — not that anything was signed.
  {
    tool: "vault_plan_set_caps",
    args: { nodeId: 1, limits: [{ token: TOKEN, dailyCap: "25", perTxCap: "10" }] },
    expect: (r) => plan(r),
  },
  {
    tool: "vault_plan_pause",
    args: { paused: false },
    expect: (r) => plan(r),
  },
  {
    tool: "vault_plan_set_recipients",
    args: { nodeId: 1, recipients: ["test015.near"] },
    expect: (r) => plan(r),
  },
  { tool: "vault_plan_freeze", args: { nodeId: 1, frozen: false }, expect: (r) => plan(r) },
  { tool: "vault_plan_set_cooldown", args: { nodeId: 1, cooldownSec: 0 }, expect: (r) => plan(r) },
  // THE PLAN TOOLS NOTHING EXERCISED. Twelve of twenty-six tools had never
  // been called by anything before this list; a payload builder that throws or
  // returns a malformed receiver is indistinguishable from one that works
  // until someone tries it, and the person trying it was the user.
  {
    tool: "vault_plan_set_strict_allocation",
    args: { strict: false },
    expect: (r) => plan(r),
  },
  { tool: "vault_plan_add_node", args: { parent: 0, label: "smoke", limits: [{ token: TOKEN, dailyCap: "1", perTxCap: "1" }] }, expect: (r) => plan(r) },
  { tool: "vault_plan_purge", args: { beforeDate: "2026-01-01" }, expect: (r) => plan(r) },
  { tool: "vault_plan_set_approval_threshold", args: { nodeId: 1, amount: "5" }, expect: (r) => plan(r) },
  { tool: "vault_plan_approve_payment", args: { requestId: "smoke" }, expect: (r) => plan(r) },
  { tool: "vault_plan_reject_payment", args: { requestId: "smoke" }, expect: (r) => plan(r) },
  { tool: "vault_plan_unbind_agent", args: { publicKey: "ed25519:11111111111111111111111111111111" }, expect: (r) => plan(r) },
  { tool: "vault_plan_bind_agent", args: { nodeId: 1, publicKey: "ed25519:11111111111111111111111111111111" }, expect: (r) => plan(r) },
];

/**
 * THE ERROR PATHS, because for most of these the message IS the product.
 *
 * The happy-path sweep above went 12/12 while all four of these were wrong.
 * A user meets the unhappy path far more often than the happy one — wrong
 * node id, token they have not set a cap for, a request that was purged — and
 * each of those answered with something misleading or ambiguous:
 *
 *   vault_budget(999)        "node 999 has no limit for that token" — asserted
 *                            the node EXISTS, sending the user to set a cap on
 *                            a node that is not there
 *   vault_request(bogus)     a bare `null`, indistinguishable from a failure
 *   vault_plan_set_caps(999) a complete signable payload for a nonexistent
 *                            node, refused by the contract AFTER paying gas
 *
 * Asserted on CONTENT, not on failing. These must answer clearly, not throw —
 * an exception is also a bad answer here.
 */
const ERROR_CASES = [
  {
    tool: "vault_budget",
    args: { nodeId: 999 },
    want: /has no node 999/i,
    why: "must not imply node 999 exists",
  },
  {
    tool: "vault_budget",
    args: { nodeId: 1, token: "not-a-real-token.near" },
    want: /exists but has no limit/i,
    why: "node exists, token does not — a different fact",
  },
  {
    tool: "vault_request",
    args: { requestId: "definitely-not-a-real-request" },
    want: /No request/i,
    why: "a bare null is indistinguishable from a failed call",
  },
  {
    tool: "vault_plan_set_caps",
    args: { nodeId: 999, limits: [{ token: TOKEN, dailyCap: "1", perTxCap: "1" }] },
    want: /AFTER you signed/i,
    why: "must refuse rather than hand over a payload the contract will reject",
  },
  {
    tool: "vault_plan_freeze",
    args: { nodeId: 42, frozen: true },
    want: /AFTER you signed/i,
    why: "same guard, every node-scoped plan tool",
  },
];

const SKIPPED = {
  vault_pay: "signs and moves money",
  vault_create: "builds a link; against an existing vault it correctly THROWS",
  vault_await_create: "polls for up to 90s; covered by its own path",
  vault_add_role: "writes a secret to disk and returns a payload to sign",
  vault_plan_withdraw: "covered by unit tests; live it depends on a balance this vault does not have",
};

const proc = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "ignore"],
  env: {
    ...process.env,
    NEAR_VAULT_CONTRACT: VAULT,
    NEAR_VAULT_NETWORK: NETWORK,
    NEAR_VAULT_TOKEN: TOKEN,
  },
});

let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) {
        pending.delete(msg.id);
        r(msg);
      }
    } catch {
      /* not a json line */
    }
  }
});

let nextId = 1;
const call = (method, params) =>
  new Promise((done) => {
    const id = nextId++;
    pending.set(id, done);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) done({ error: { message: "timed out after 30s" } });
    }, 30_000);
  });

await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "check-mcp-live", version: "1" },
});

console.log(`live MCP check: ${VAULT} on ${NETWORK}\n`);

let failed = 0;
for (const { tool, args, expect } of CASES) {
  const msg = await call("tools/call", { name: tool, arguments: args });
  const text = msg.result?.content?.[0]?.text;
  let verdict;
  let detail = "";

  if (msg.error) {
    verdict = "ERROR";
    detail = String(msg.error.message).slice(0, 90);
  } else if (msg.result?.isError) {
    verdict = "ERROR";
    detail = String(text ?? "").slice(0, 90);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    // THE WRONG-CHAIN SIGNATURE. It arrives as a successful tool call whose
    // body says the account is missing, so only a content check catches it.
    if (typeof parsed === "string" && /does not exist|UNKNOWN_ACCOUNT/i.test(parsed)) {
      verdict = "WRONG CHAIN?";
      detail = parsed.slice(0, 90);
    } else {
      let ok = false;
      try {
        ok = !!expect(parsed);
      } catch {
        ok = false;
      }
      verdict = ok ? "ok" : "UNEXPECTED";
      if (!ok) detail = JSON.stringify(parsed).slice(0, 90);
    }
  }

  if (verdict !== "ok") failed++;
  console.log(`  ${verdict === "ok" ? "ok  " : "FAIL"}  ${tool.padEnd(28)} ${detail}`);
}

console.log(LF + "  --- error paths (the message IS the product) ---");
for (const { tool, args, want, why } of ERROR_CASES) {
  const msg = await call("tools/call", { name: tool, arguments: args });
  const body = String(msg.result?.content?.[0]?.text ?? msg.error?.message ?? "");
  const ok = want.test(body);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${tool.padEnd(28)} ${ok ? why : body.replace(/\s+/g, " ").slice(0, 80)}`);
}

console.log();
for (const [tool, why] of Object.entries(SKIPPED)) {
  console.log(`  skip  ${tool.padEnd(28)} ${why}`);
}

proc.kill();

if (failed) {
  console.error(`\n  ${failed} check(s) failed across ${CASES.length} happy + ${ERROR_CASES.length} error paths.`);
  process.exit(1);
}
console.log(`\nlive MCP check: ${CASES.length} tools work, ${ERROR_CASES.length} error paths explain themselves`);
