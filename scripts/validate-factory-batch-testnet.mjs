#!/usr/bin/env node
/**
 * Prove the factory's create batch works ON CHAIN, for ~0.2 NEAR.
 *
 * WHY THIS EXISTS. The factory has 14 green tests and all 14 are unit tests.
 * They call the Rust functions directly and never cross the generated
 * `extern "C"` wrapper — which is exactly where this project has already been
 * bitten once: the vault's kill switch called `assert_one_yocto` without
 * `#[payable]`, near-sdk rejected the deposit in the wrapper, the method was
 * permanently unreachable, and 10/10 unit tests passed before AND after the
 * fix. A green unit suite says nothing about reachability.
 *
 * WHY THE STUB AND NOT THE REAL VAULT. The real vault costs 3.37 per attempt
 * and there is ~2 NEAR left in the pool. The 33-byte stub exports a no-op
 * `new` (verified: export section names exactly "new", code body is `0b` —
 * end, nothing else), so the full batch — CreateAccount, Transfer,
 * DeployContract, FunctionCall "new", and the on_vault_created callback —
 * runs end to end for the price of the deposit floor.
 *
 * WHAT IT DOES AND DOES NOT PROVE.
 *   proves:    the batch's five actions compose; `new` is reachable through
 *              the wrapper; the deposit floor scales with the code argument;
 *              the callback fires and reports.
 *   does NOT:  that the VAULT's `new` writes correct state (already validated
 *              7/7 on mainnet), nor that a wallet will sign a 401 KB argument
 *              (that is the browser question and only a wallet can answer it).
 *
 * It also exercises the `label` path, which currently has NO test coverage and
 * NO validation — see the squatting note in the run output.
 *
 * Testnet only, by suffix.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const CALLER = process.env.CALLER ?? "floatv4.testnet";
const FACTORY = process.env.FACTORY ?? "fac.floatv4.testnet";
const LABEL = process.env.LABEL ?? "stub1";
const STUB = join(ROOT, ".demo", "stub-new.wasm");

for (const [l, id] of [["CALLER", CALLER], ["FACTORY", FACTORY]]) {
  if (!id.endsWith(".testnet")) {
    console.error(`FATAL: ${l}=${id} is not testnet. This SPENDS balance.`);
    process.exit(2);
  }
}
if (!existsSync(STUB)) {
  console.error(`FATAL: ${STUB} missing — run: node scripts/make-stub-wasm.mjs`);
  process.exit(1);
}

const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const near = (y) => (Number(y) / 1e24).toFixed(5);
const signer = (a) => {
  const f = join(homedir(), ".near-credentials", "testnet", `${a}.json`);
  const k = JSON.parse(readFileSync(f, "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
};
const acctOrNull = (id) =>
  p.viewAccount({ accountId: id, blockQuery: { finality: "final" } }).catch(() => null);

const code = readFileSync(STUB);
const VAULT = `${LABEL}.${FACTORY}`;

// Mirror the contract's own floor: required_deposit + bytes * 1e19. Attach a
// little over, because the new account also pays for its own account record and
// an underfunded CreateAccount succeeds while leaving the account below its
// storage requirement — a bricked vault rather than a failed call.
const floor = 10n ** 23n + BigInt(code.length) * 10n ** 19n;
const attach = floor + 5n * 10n ** 22n;

console.log(`\n  network   testnet`);
console.log(`  factory   ${FACTORY}`);
console.log(`  caller    ${CALLER}`);
console.log(`  creating  ${VAULT}   (${code.length} B of stub code)`);
console.log(`  floor     ${near(floor)}   attaching ${near(attach)}\n`);

if ((await acctOrNull(VAULT)) !== null) {
  console.error(`FATAL: ${VAULT} already exists. Set LABEL= to something fresh.`);
  process.exit(1);
}

const caller = new Account(CALLER, p, signer(CALLER));
const before = BigInt((await acctOrNull(CALLER)).amount);

// `callFunctionRaw`, NOT `callFunction`. Account.callFunction returns the
// PARSED RETURN VALUE, not the outcome — so `out.status` was undefined, the
// `"Failure" in status` test was never reached, and this script printed a
// confident green "SUCCESS" for every possible result including a revert. An
// absent field and a passing field are not the same thing.
const out = await caller.callFunctionRaw({
  contractId: FACTORY,
  methodName: "create_vault_with_code",
  args: {
    code: code.toString("base64"),
    label: LABEL,
    root_limits: [],
    root_recipients: null,
  },
  gas: 300n * 10n ** 12n,
  deposit: attach,
  waitUntil: "FINAL",
});

console.log(`  tx        ${out?.transaction?.hash ?? "MISSING"}`);

// Assert the field is THERE before trusting what it says.
const status = out?.status;
if (status === undefined) {
  console.log(`  status    UNREADABLE — cannot judge this run`);
  console.log(`            top-level keys: ${Object.keys(out ?? {}).join(", ") || "(none)"}`);
} else if (typeof status === "object" && "Failure" in status) {
  console.log(`  status    FAILURE`);
  console.log(`  ${JSON.stringify(status.Failure).slice(0, 400)}`);
} else {
  console.log(`  status    SUCCESS`);
}

const ret = typeof status === "object" ? status?.SuccessValue : undefined;
if (ret !== undefined && ret !== "") {
  console.log(`  returned  ${Buffer.from(ret, "base64").toString("utf8")}`);
}

for (const r of out?.receipts_outcome ?? []) {
  const f = r.outcome?.status?.Failure;
  if (f) console.log(`  receipt FAILED: ${JSON.stringify(f).slice(0, 300)}`);
  for (const l of r.outcome?.logs ?? []) console.log(`  log: ${l}`);
}

// VERIFY FROM CHAIN, not from the tx result. A SuccessValue on the outer call
// says the factory returned a Promise, not that the Promise's actions landed.
await new Promise((r) => setTimeout(r, 3000));
const made = await acctOrNull(VAULT);
console.log(`\n  ${VAULT}`);
if (!made) {
  console.log(`    DOES NOT EXIST — the batch did not land`);
} else {
  // `contractId`, NOT `accountId`. With the wrong key the RPC answers
  // "missing field `account_id`", the `.catch` swallowed it, and this printed
  // "0 B != the stub" — reporting a FAILED DEPLOY when the deploy had worked.
  // The account's own 133 B of storage (100 B keyless base + 33 B of code) was
  // sitting right above it saying otherwise. A read that cannot succeed and a
  // read that returns nothing produce the same number, so compare bytes rather
  // than trusting a length, and let the error surface.
  let n = null;
  let identical = false;
  try {
    const dc = await p.viewContractCode({ contractId: VAULT, blockQuery: { finality: "final" } });
    const buf = Buffer.from(dc.code_base64, "base64");
    n = buf.length;
    identical = buf.equals(code);
  } catch (e) {
    console.log(`    code        UNREADABLE: ${e.message}`);
  }
  console.log(`    exists      yes`);
  console.log(`    balance     ${near(BigInt(made.amount))}`);
  console.log(`    storage     ${made.storage_usage} B   (expect ${100 + code.length}: 100 B keyless base + code)`);
  if (n !== null) {
    console.log(`    code        ${n} B   ${identical ? "BYTE-IDENTICAL to the stub" : `NOT the stub (expected ${code.length} B)`}`);
  }
  const keys = await p
    .viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } })
    .catch(() => ({ keys: [] }));
  console.log(`    access keys ${keys.keys.length}   (0 expected — a factory holds no key)`);
}

const after = BigInt((await acctOrNull(CALLER)).amount);
console.log(`\n  ${CALLER} paid ${near(before - after)} all in`);
console.log(`\n  NOTE: this ran through the \`label\` path, which has no`);
console.log(`  validation and no tests. Any caller can pass another user's`);
console.log(`  derived prefix as a label and squat their vault id.\n`);
