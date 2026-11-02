#!/usr/bin/env node
/**
 * Did the browser click actually produce a working vault?
 *
 * "The account exists" is not the question. The factory's batch is
 * CreateAccount -> Transfer -> DeployContract -> FunctionCall("new"), and the
 * interesting failure is a vault that exists, holds the right bytes, and was
 * never initialised — or was initialised with the wrong owner, which would
 * mean the browser's derivation and the contract's had drifted.
 *
 * Every check reads from chain. Nothing here trusts the page's own report.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const FACTORY = process.env.FACTORY ?? "fac.floatv4.testnet";
const OWNER = process.env.OWNER ?? "work12.testnet";
const VAULT_WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");

const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const near = (y) => (Number(y) / 1e24).toFixed(5);

let pass = 0;
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  ok ? pass++ : fail++;
};

// The contract's own derivation, not a local copy of it.
const VAULT = await p.callFunction({
  contractId: FACTORY,
  method: "vault_id_for",
  args: { owner: OWNER },
  blockQuery: { finality: "optimistic" },
});

console.log(`\n  factory ${FACTORY}`);
console.log(`  owner   ${OWNER}`);
console.log(`  vault   ${VAULT}\n`);

const acct = await p
  .viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } })
  .catch(() => null);

if (!acct) {
  check(false, `the vault account exists`, `${VAULT} not found — the batch did not land`);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
check(true, `the vault account exists`, `${near(BigInt(acct.amount))} balance, ${acct.storage_usage} B stored`);

// ── the code is the vault, byte for byte ──────────────────────────────────────
// Compare BYTES, not a length. A read that cannot succeed and a read that
// returns nothing both produce 0, and `contractId` is the key this call wants.
if (existsSync(VAULT_WASM)) {
  const want = readFileSync(VAULT_WASM);
  let chain = null;
  try {
    const dc = await p.viewContractCode({ contractId: VAULT, blockQuery: { finality: "final" } });
    chain = Buffer.from(dc.code_base64, "base64");
  } catch (e) {
    check(false, `deployed code is the vault`, `unreadable: ${e.message}`);
  }
  if (chain) {
    check(
      chain.equals(want),
      `deployed code is byte-identical to packages/create-float/res/vault.wasm`,
      `chain ${chain.length} B, disk ${want.length} B`,
    );
  }
}

// ── a factory-created vault holds NO key ──────────────────────────────────────
// This is the whole point of the design: the browser signed one FunctionCall
// and never held a key for the vault. A key here would mean something else
// created it.
const keys = await p
  .viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } })
  .catch(() => ({ keys: [] }));
check(keys.keys.length === 0, `the vault holds no access key`, `${keys.keys.length} keys`);

// ── `new` ran, and ran with the right owner ───────────────────────────────────
// The batch is atomic, so the account existing implies `new` returned — but
// "returned" is not "wrote the state we wanted", and the owner is the one field
// a derivation drift between page and contract would corrupt.
const view = async (method, args = {}) => {
  try {
    return { ok: true, v: await p.callFunction({ contractId: VAULT, method, args, blockQuery: { finality: "optimistic" } }) };
  } catch (e) {
    return { ok: false, e: String(e.message) };
  }
};

// `get_config`, not `get_owner` — there is no `get_owner`, and asking for one
// returned "Contract method is not found", which reads exactly like an
// uninitialised vault. It was a wrong method name against a perfectly healthy
// contract. The account's 301,462 B — 301,033 of code plus 429 of STATE — was
// already saying `new` had run.
const cfg = await view("get_config");
check(
  cfg.ok && cfg.v?.owner === OWNER,
  `the vault is initialised and owned by ${OWNER}`,
  cfg.ok ? `owner -> ${JSON.stringify(cfg.v?.owner)}` : `get_config failed: ${cfg.e.slice(0, 160)}`,
);

// THE CLOCK MUST BE PRODUCTION. `vault_test_clock.wasm` has a settable day
// length and is built for the sandbox only; shipping it would make every
// budget window forgeable. The byte comparison above already pins this, but
// name it explicitly so a future artifact swap fails loudly here too.
check(
  cfg.ok && cfg.v?.clock_mode === "production",
  `the clock is production, not the settable test clock`,
  cfg.ok ? `clock_mode -> ${JSON.stringify(cfg.v?.clock_mode)}` : `unknown`,
);

check(
  cfg.ok && cfg.v?.network === "testnet",
  `the network recorded matches the chain it is on`,
  cfg.ok ? `network -> ${JSON.stringify(cfg.v?.network)}` : `unknown`,
);

// ── the root node exists ──────────────────────────────────────────────────────
// `new` used to leave a vault with zero nodes, which is why the factory passes
// root limits and recipients through — one browser signature, no follow-up.
// A vault with no root cannot pay anything, so node_count 0 is a dead vault
// that every other check here would still call healthy.
check(
  cfg.ok && cfg.v?.node_count >= 1,
  `new created the root node`,
  cfg.ok ? `node_count -> ${cfg.v?.node_count}` : `unknown`,
);

// `node_id`, not `id`.
const root = await view("get_node", { node_id: 0 });
check(
  root.ok && root.v != null,
  `the root node (id 0) is readable`,
  root.ok ? JSON.stringify(root.v).slice(0, 260) : `get_node failed: ${root.e.slice(0, 160)}`,
);

if (cfg.ok) console.log(`\n        config: ${JSON.stringify(cfg.v)}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
