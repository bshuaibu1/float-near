#!/usr/bin/env node
/**
 * Prove the label squatting fix is live ON CHAIN, not just green in cargo test.
 *
 * The unit tests call `begin` directly and never cross the generated
 * `extern "C"` wrapper. This project has already shipped a method that was
 * permanently unreachable through that wrapper while 10/10 unit tests passed
 * (`assert_one_yocto` without `#[payable]`), so "the suite is green" is not
 * evidence that a deployed contract behaves.
 *
 * Three claims, each needing its own evidence:
 *   1. the bytes on chain are the bytes I just built  (hash comparison)
 *   2. the squat is REFUSED                            (BAD_LABEL panic)
 *   3. the refusal is the charset rule, not a broken method (legal label works)
 *
 * Claim 3 is the control. Without it, claim 2 is worthless: a method that
 * reverts for every input would satisfy it perfectly.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const FACTORY = process.env.FACTORY ?? "fac.floatv4.testnet";
const CALLER = process.env.CALLER ?? "floatv4.testnet";
const WASM = join(ROOT, "target", "near", "factory", "factory.wasm");
const STUB = join(ROOT, ".demo", "stub-new.wasm");

for (const [l, id] of [["FACTORY", FACTORY], ["CALLER", CALLER]]) {
  if (!id.endsWith(".testnet")) {
    console.error(`FATAL: ${l}=${id} is not testnet.`);
    process.exit(2);
  }
}
for (const f of [WASM, STUB]) {
  if (!existsSync(f)) {
    console.error(`FATAL: ${f} missing.`);
    process.exit(1);
  }
}

const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const signer = (a) => {
  const k = JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${a}.json`), "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
};
const caller = new Account(CALLER, p, signer(CALLER));
const stub = readFileSync(STUB);
const attach = 10n ** 23n + BigInt(stub.length) * 10n ** 19n + 5n * 10n ** 22n;

const create = (label) =>
  caller.callFunctionRaw({
    contractId: FACTORY,
    methodName: "create_vault_with_code",
    args: {
      code: stub.toString("base64"),
      label,
      root_limits: [],
      root_recipients: null,
    },
    gas: 300n * 10n ** 12n,
    deposit: attach,
    waitUntil: "FINAL",
  });

let pass = 0;
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  ok ? pass++ : fail++;
};

console.log(`\n  factory ${FACTORY}   caller ${CALLER}\n`);

// ── 1. the bytes on chain are the bytes I built ───────────────────────────────
const disk = readFileSync(WASM);
const dc = await p.viewContractCode({ contractId: FACTORY, blockQuery: { finality: "final" } });
const chain = Buffer.from(dc.code_base64, "base64");
check(
  chain.equals(disk),
  `deployed code is byte-identical to the local build`,
  `chain ${chain.length} B, disk ${disk.length} B`,
);

// ── 2. the squat is refused ───────────────────────────────────────────────────
// `bob-near` is exactly what bob.near derives. Before the fix this created
// bob-near.<factory> owned by the caller.
let refused = null;
try {
  await create("bob-near");
} catch (e) {
  refused = String(e.message);
}
check(
  refused !== null && refused.includes("BAD_LABEL"),
  `squatting bob.near's derived id is refused`,
  refused === null
    ? `NOT REFUSED — the hole is open on chain`
    : refused.includes("BAD_LABEL")
      ? `BAD_LABEL`
      : `refused, but NOT by BAD_LABEL: ${refused.slice(0, 140)}`,
);

// ── 3. the control: a legal label still works ─────────────────────────────────
// Without this, check 2 would pass against a contract that rejects everything.
const LEGAL = process.env.LEGAL_LABEL ?? "three";
const expected = `${CALLER.replace(/\./g, "-")}-${LEGAL}.${FACTORY}`;
let ctlErr = null;
try {
  await create(LEGAL);
} catch (e) {
  ctlErr = String(e.message);
}
const made = await p
  .viewAccount({ accountId: expected, blockQuery: { finality: "final" } })
  .catch(() => null);
check(
  ctlErr === null && made !== null,
  `a legal label still creates a vault, under the caller's own prefix`,
  ctlErr ? `call failed: ${ctlErr.slice(0, 140)}` : `${expected} ${made ? "exists" : "MISSING"}`,
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
