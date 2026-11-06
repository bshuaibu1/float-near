#!/usr/bin/env node
/**
 * Reclaim a factory's storage stake. The thing that makes "recoverable" real.
 *
 * WHY THIS EXISTS BEFORE THE MAINNET DEPLOY. Telling someone "you can get the
 * 1.6 back" is a promise until the command that gets it back exists and has
 * been run. This repo already has two accounts whose balance is gone forever
 * because the recovery path was assumed rather than built —
 * `r1.float.test015.near` (0.546779) and three keyless testnet vaults
 * (0.80) — so a stake is only recoverable once something can actually sign
 * the delete.
 *
 * THE SEQUENCE, in the order the chain requires:
 *
 *   1. `purge_settled` has no equivalent here — a factory stores no registry
 *      (deliberately: the vault id is derivable), so its state is ~306 B and
 *      already tiny. Nothing to purge.
 *   2. deploy the 33-byte stub: frees ~1e19 per byte of contract code.
 *   3. delete-account: returns the WHOLE remaining balance, stake included.
 *
 * Measured on mainnet 2026-11-02: an account at 3,300 B deleted cleanly and
 * returned everything. A shrunk factory sits at ~339 B, ten times smaller.
 *
 * VAULTS IT CREATED ARE UNAFFECTED. They are independent accounts with their
 * own code and their own owner key; the factory is only needed at creation
 * time. Tearing it down stops NEW vaults being made and nothing else.
 *
 * Mainnet runs are refused unless CONFIRM_MAINNET=1, and mainnet writes are
 * blocked for the assistant by the permission classifier — on mainnet this
 * prints the commands instead of sending them.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const NETWORK = process.env.NETWORK ?? "testnet";
const FACTORY = process.env.FACTORY ?? (NETWORK === "mainnet" ? "" : "fac.floatv4.testnet");
const BENEFICIARY = process.env.BENEFICIARY ?? (NETWORK === "mainnet" ? "" : "floatv4.testnet");
const STUB = join(ROOT, ".demo", "stub-new.wasm");
const RPC =
  process.env.RPC ??
  (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");

if (!FACTORY || !BENEFICIARY) {
  console.error("FATAL: set FACTORY and BENEFICIARY.");
  process.exit(2);
}
if (NETWORK === "mainnet" && process.env.CONFIRM_MAINNET !== "1") {
  console.error("FATAL: mainnet requires CONFIRM_MAINNET=1. This DELETES an account.");
  process.exit(2);
}
if (!existsSync(STUB)) {
  console.error(`FATAL: ${STUB} missing — run: node scripts/make-stub-wasm.mjs`);
  process.exit(1);
}

const p = new JsonRpcProvider({ url: RPC });
const near = (y) => (Number(y) / 1e24).toFixed(6);
const credPath = (a) => join(homedir(), ".near-credentials", NETWORK, `${a}.json`);

// THE ONE PRECONDITION. Without a key on the factory nothing can sign the
// delete and the stake is gone permanently — the exact failure that stranded
// r1 and the keyless vaults. Check it BEFORE touching anything, because the
// shrink is irreversible and a shrunk factory that cannot be deleted is
// strictly worse than one left alone.
if (!existsSync(credPath(FACTORY))) {
  console.error(`FATAL: no credential at ${credPath(FACTORY)}`);
  console.error(`  Without it nothing can sign DeleteAccount and the stake is UNRECOVERABLE.`);
  console.error(`  Do not shrink the contract — that would free the stake into an account`);
  console.error(`  you cannot empty, which is worse than leaving it alone.`);
  process.exit(1);
}
const keys = (await p.viewAccessKeyList({ accountId: FACTORY, blockQuery: { finality: "final" } }))
  .keys;
const stored = JSON.parse(readFileSync(credPath(FACTORY), "utf8"));
const storedPk = stored.public_key ?? stored.publicKey;
const onChain = keys.find((k) => k.public_key === storedPk && k.access_key.permission === "FullAccess");
if (!onChain) {
  console.error(`FATAL: the saved key is not a FullAccess key on ${FACTORY}.`);
  console.error(`  saved:    ${storedPk}`);
  console.error(`  on chain: ${JSON.stringify(keys.map((k) => k.public_key))}`);
  console.error(`  Refusing to shrink an account this cannot afterwards delete.`);
  process.exit(1);
}

const acct = await p.viewAccount({ accountId: FACTORY, blockQuery: { finality: "final" } });
const code = Buffer.from(
  (await p.viewContractCode({ contractId: FACTORY, blockQuery: { finality: "final" } })).code_base64,
  "base64",
);
const state = acct.storage_usage - code.length;

console.log(`\n  network      ${NETWORK}`);
console.log(`  factory      ${FACTORY}`);
console.log(`  beneficiary  ${BENEFICIARY}`);
console.log(`  balance      ${near(BigInt(acct.amount))} NEAR`);
console.log(`  storage      ${acct.storage_usage} B = ${code.length} code + ${state} state`);
console.log(`  after shrink ${33 + state} B  (a mainnet delete succeeded at 3,300 B today)`);
console.log(`  signer       ${storedPk} — FullAccess, confirmed on chain`);
console.log(`\n  recovers     ~${near(BigInt(acct.amount))} to ${BENEFICIARY}`);
console.log(`\n  Vaults this factory created keep working. It is only needed to CREATE.\n`);

if (NETWORK === "mainnet") {
  // Mainnet writes are blocked for the assistant by the permission classifier.
  // Print, do not send.
  const q = (s) => `'${s}'`;
  console.log(`  Mainnet — run these yourself, one line each:\n`);
  console.log(
    `near contract deploy ${FACTORY} use-file ${q(STUB)} without-init-call network-config mainnet sign-with-access-key-file ${q(credPath(FACTORY))} send`,
  );
  console.log();
  console.log(
    `near account delete-account ${FACTORY} beneficiary ${BENEFICIARY} network-config mainnet sign-with-access-key-file ${q(credPath(FACTORY))} send`,
  );
  console.log();
  process.exit(0);
}

// ---- testnet: do it ---------------------------------------------------------
const signer = new KeyPairSigner(
  KeyPair.fromString(stored.private_key ?? stored.secret_key),
);
const fac = new Account(FACTORY, p, signer);
const beforeBeneficiary = BigInt(
  (await p.viewAccount({ accountId: BENEFICIARY, blockQuery: { finality: "final" } })).amount,
);

console.log(`  shrinking to the 33-byte stub…`);
await fac.deployContract(new Uint8Array(readFileSync(STUB)));
await new Promise((r) => setTimeout(r, 3000));
const mid = await p.viewAccount({ accountId: FACTORY, blockQuery: { finality: "final" } });
console.log(`  storage ${acct.storage_usage} -> ${mid.storage_usage} B`);

console.log(`  deleting…`);
let deleted = false;
try {
  await fac.deleteAccount(BENEFICIARY);
  deleted = true;
} catch (e) {
  console.log(`  delete REFUSED: ${String(e.message).slice(0, 140)}`);
}

// Poll to an EXPECTED value. A read straight after a write can be a whole
// transaction behind, and this project has drawn five wrong conclusions from
// reading once.
const want = beforeBeneficiary + BigInt(mid.amount) - 2n * 10n ** 22n;
let got = 0n;
for (let i = 0; i < 30; i++) {
  got = BigInt(
    (await p.viewAccount({ accountId: BENEFICIARY, blockQuery: { finality: "final" } })).amount,
  );
  if (got >= want) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const gone = (await p.viewAccount({ accountId: FACTORY, blockQuery: { finality: "final" } }).catch(() => null)) === null;

console.log(`\n  ${FACTORY}: ${gone ? "DELETED" : "still exists"}`);
console.log(`  ${BENEFICIARY}: ${near(beforeBeneficiary)} -> ${near(got)}  (+${near(got - beforeBeneficiary)})`);
console.log(`\n  ${deleted && gone ? "RECOVERED." : "NOT fully recovered — read the chain before assuming."}\n`);
process.exit(deleted && gone ? 0 : 1);
