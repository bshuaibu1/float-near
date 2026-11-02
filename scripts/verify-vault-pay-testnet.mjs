#!/usr/bin/env node
/**
 * Prove `vault_pay` actually moves money, through the MCP server, end to end.
 *
 * This is the last unproven link. The agent key is bound and funded, but
 * "bound" is not "can spend": the contract resolves the node from
 * `signer_account_pk()`, the per-tx and daily caps are checked at every level
 * of the tree, and the payee allowlist is checked — any of which can refuse.
 *
 * THE SECRET IS NEVER PRINTED. It is read from .float/agent-keys.json and
 * passed to the child through the environment. This repo has a scar from a CLI
 * that echoed a private key into a terminal and a chat transcript, which is why
 * `sign-with-access-key-file` replaced `sign-with-plaintext-private-key`
 * everywhere.
 *
 * Settlement is confirmed by reading TOKEN BALANCES before and after, not by
 * trusting the tool's own report. A tool that says SETTLED while nothing moved
 * is exactly the failure mode worth guarding.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const VAULT = process.env.VAULT ?? "floatv4-testnet.fac.floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";
const RECIPIENT = process.env.RECIPIENT ?? "floatv4.testnet";
const AMOUNT = process.env.AMOUNT ?? "2.5";
const KEYS = join(ROOT, ".float", "agent-keys.json");
const SERVER = join(ROOT, "packages", "mcp", "dist", "server.js");

let pass = 0;
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  ok ? pass++ : fail++;
};

for (const f of [KEYS, SERVER]) {
  if (!existsSync(f)) {
    console.error(`FATAL: ${f} is missing.`);
    process.exit(1);
  }
}

// ---- find this vault's agent key, without ever logging it -------------------
const raw = JSON.parse(readFileSync(KEYS, "utf8"));
const list = Array.isArray(raw) ? raw : (raw.agents ?? raw.keys ?? []);
const entry = (Array.isArray(list) ? list : []).find(
  (a) => a?.vault === VAULT || a?.vaultId === VAULT || a?.contractId === VAULT,
);
if (!entry) {
  console.error(`FATAL: no entry for ${VAULT} in ${KEYS}.`);
  console.error(`  entries present: ${JSON.stringify((Array.isArray(list) ? list : []).map((a) => a?.vault ?? a?.vaultId ?? "?"))}`);
  process.exit(1);
}
const SECRET = entry.secret ?? entry.privateKey ?? entry.private_key ?? entry.secretKey;
const PUBLIC = entry.publicKey ?? entry.public_key ?? entry.pk;
if (typeof SECRET !== "string" || !SECRET.startsWith("ed25519:")) {
  console.error(`FATAL: no usable secret for ${VAULT}. Fields: ${Object.keys(entry).join(", ")}`);
  process.exit(1);
}

const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const bal = async (id) =>
  BigInt(
    await p.callFunction({
      contractId: TOKEN,
      method: "ft_balance_of",
      args: { account_id: id },
      blockQuery: { finality: "final" },
    }),
  );
const human = (b) => (Number(b) / 1e6).toFixed(6);

console.log(`\n  vault     ${VAULT}`);
console.log(`  agent pk  ${PUBLIC ?? "(not recorded)"}`);
console.log(`  token     ${TOKEN}`);
console.log(`  paying    ${AMOUNT} -> ${RECIPIENT}\n`);

// The gas key's own balance is what pays. Record it: the headline claim of the
// whole design is that the VAULT pays no gas, only storage.
const keyList = await p.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } });
const gasEntry = keyList.keys.find((k) => k.public_key === PUBLIC);

/**
 * Read a gas key's balance.
 *
 * The permission variant is `GasKeyFunctionCall`, NOT `FunctionCall`, and the
 * balance sits at the TOP LEVEL of it — not under `gas_key_info` where
 * near-api-js's TypeScript shape suggests. Reading the documented shape once
 * produced five FAILED checks against a protocol that was working correctly,
 * with the answer printed on screen beside the failures
 * (docs/SPIKE-gas-keys-2026-10-31.md). The first version of this function
 * looked for `perm.FunctionCall` and reported "unreadable" for a key that was
 * present and funded.
 *
 * `allowance` is null on a gas key by design: the BALANCE is the cap.
 */
const gasBalanceOf = (e) => {
  const perm = e?.access_key?.permission;
  if (!perm || typeof perm !== "object") return null;
  const g = perm.GasKeyFunctionCall ?? perm.FunctionCall;
  const b = g?.balance ?? g?.gas_key_info?.balance;
  return b === undefined || b === null ? null : BigInt(b);
};
const gasBefore = gasEntry ? gasBalanceOf(gasEntry) : null;
check(
  !!gasEntry && gasBefore !== null,
  `the agent key is installed on the vault, as a funded gas key`,
  gasEntry
    ? `gas balance ${gasBefore === null ? "UNREADABLE" : (Number(gasBefore) / 1e24).toFixed(9)} NEAR`
    : "key not found on the vault",
);

const vaultBefore = await bal(VAULT);
const payeeBefore = await bal(RECIPIENT);
const vaultNearBefore = BigInt(
  (await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } })).amount,
);

// ---- drive the MCP server ---------------------------------------------------
const child = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    NEAR_VAULT_CONTRACT: VAULT,
    NEAR_VAULT_NETWORK: "testnet",
    NEAR_VAULT_RPC_URL: "https://test.rpc.fastnear.com",
    NEAR_VAULT_TOKEN: TOKEN,
    NEAR_VAULT_TOKEN_DECIMALS: "6",
    // The virtual-agent shape: the agent IS the vault, and the contract
    // resolves which node from the signing key.
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

let payText = "";
try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-pay", version: "1" },
  });
  const m = await rpc("tools/call", {
    name: "vault_pay",
    arguments: { amount: AMOUNT, recipient: RECIPIENT, memo: "mcp end-to-end test" },
  });
  payText = m.result?.content?.[0]?.text ?? JSON.stringify(m.error ?? m);
  console.log(`\n  vault_pay returned:\n${payText.split("\n").map((l) => `    ${l}`).join("\n")}\n`);
} catch (e) {
  console.log(`\n  vault_pay THREW: ${e.message}`);
  if (stderr) console.log(`  stderr: ${stderr.slice(0, 400)}`);
} finally {
  child.kill();
}

// ---- settlement is a BALANCE fact, not a report -----------------------------
const want = BigInt(Math.round(Number(AMOUNT) * 1e6));
let moved = false;
for (let i = 0; i < 30; i++) {
  if ((await bal(RECIPIENT)) >= payeeBefore + want) {
    moved = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
const vaultAfter = await bal(VAULT);
const payeeAfter = await bal(RECIPIENT);

check(moved, `the payee actually received ${AMOUNT}`, `${human(payeeBefore)} -> ${human(payeeAfter)}`);
check(
  vaultBefore - vaultAfter === want,
  `the vault paid exactly ${AMOUNT}`,
  `${human(vaultBefore)} -> ${human(vaultAfter)} (delta ${human(vaultBefore - vaultAfter)})`,
);

// THE DESIGN'S HEADLINE CLAIM: the gas key pays its own gas, the vault pays
// none. Checked on BOTH sides, because either alone is weak evidence.
//
// A correction to how this reported before: it printed the change in the
// vault's `amount` and called it "storage for the payment record". That was
// wrong twice over. Storage stake does not SPEND balance, it LOCKS it — the
// amount is untouched and the free portion shrinks — so an unchanged `amount`
// means the vault paid NOTHING, which is the actual claim and a stronger one.
const vaultAcctAfter = await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } });
const vaultNearAfter = BigInt(vaultAcctAfter.amount);
const nearDelta = vaultNearBefore - vaultNearAfter;
// EXACTLY ONE YOCTO, and that is correct rather than a rounding artefact.
//
// NEP-141 requires `assert_one_yocto` on `ft_transfer`, so the vault attaches
// ONE_YOCTO to the token call — and the token keeps it. That single yocto is
// the vault's entire NEAR cost per payment. No gas: the gas key pays that,
// asserted separately below.
//
// This first asserted `=== 0n` and went red at `delta 1 yocto`. The assertion
// was wrong, not the contract — but it is worth keeping as an exact equality
// rather than relaxing to `<= 1`, because any OTHER value means the vault
// burned gas and the whole gas-key design is not doing what it claims.
check(
  nearDelta === 1n,
  `the vault paid exactly 1 yocto — the NEP-141 deposit, and no gas`,
  `delta ${nearDelta} yocto`,
);

const gasAfter = gasBalanceOf(
  (await p.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } })).keys.find(
    (k) => k.public_key === PUBLIC,
  ),
);
if (gasBefore !== null && gasAfter !== null) {
  const burned = gasBefore - gasAfter;
  check(
    burned > 0n,
    `the GAS KEY's own balance paid for it`,
    `${(Number(gasBefore) / 1e24).toFixed(9)} -> ${(Number(gasAfter) / 1e24).toFixed(9)}, burned ${(Number(burned) / 1e24).toFixed(9)}`,
  );
}

console.log(
  `\n  vault storage ${vaultAcctAfter.storage_usage} B — the payment record is stored,`,
);
console.log(`    which LOCKS more of the existing balance rather than spending it,`);
console.log(`    and is reclaimable with purge_settled.`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
