#!/usr/bin/env node
/**
 * Stand the vault factory up on MAINNET. Real money.
 *
 * A SEPARATE FILE FROM THE TESTNET SCRIPT, on purpose. The obvious move is one
 * network-parameterised script, but then the guard that stops a mainnet
 * accident is itself network-aware — and a bug in that guard deploys to
 * mainnet while the operator believes they are on testnet. Two files, each
 * with a hard suffix check, cannot make that mistake. The duplication is
 * cheap; the blast radius is not.
 *
 * WHAT THE FACTORY IS FOR, so the cost is a decision and not a surprise:
 * a wallet refuses a `DeployContract` action from a web page — measured in
 * Meteor, blanket, even when the target is a brand-new sub-account the user is
 * paying for. So the browser cannot deploy a vault. It signs ONE ordinary
 * function call and the deploy happens inside this contract. The factory buys
 * the browser onboarding flow and nothing else; the CLI path needs no factory.
 *
 * THE STAKE IS RECOVERABLE, and that claim is only true because of the key
 * this script creates. ~1.6 NEAR sits as storage stake while the factory
 * exists. `scripts/teardown-factory.mjs` shrinks it to a 33-byte stub and
 * deletes it, returning everything — verified at 3,300 B on mainnet on
 * 2026-11-02, and a shrunk factory is ~339 B.
 *
 * THE KEY IS WRITTEN BEFORE ANY MONEY MOVES. `createAccount` transfers the
 * funds and installs the key in one action, so writing the credential
 * afterwards leaves a window where the account is funded and the only key to
 * it exists solely in this process's memory. If the write failed there — disk
 * full, permissions, a crash — the stake would be stranded at birth, exactly
 * like `r1.float.test015.near`'s 0.546779. So: generate, write, read back,
 * THEN create.
 *
 * Refuses to send anything without CONFIRM_MAINNET=1. Without it, prints the
 * plan and the exact cost and exits.
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider, baseEncode } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const PARENT = process.env.PARENT ?? "test015.near";
const FACTORY = process.env.FACTORY ?? `fac.${PARENT}`;
const RPC = process.env.RPC ?? "https://free.rpc.fastnear.com";
const FACTORY_WASM = join(ROOT, "target", "near", "factory", "factory.wasm");
const VAULT_WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");
const REQUIRED_DEPOSIT = BigInt(process.env.REQUIRED_DEPOSIT_YOCTO ?? (10n ** 23n).toString());

const LIVE = process.env.CONFIRM_MAINNET === "1";

// ---- hard guards ------------------------------------------------------------
// MAINNET ONLY, by suffix. The mirror of the testnet script's check. A
// `.testnet` id reaching here means someone copied the wrong command, and the
// cost of finding out later is an account on the wrong chain holding 1.6.
for (const [label, id] of [["PARENT", PARENT], ["FACTORY", FACTORY]]) {
  if (!id.endsWith(".near") || id.endsWith(".testnet")) {
    console.error(`FATAL: ${label}=${id} is not a mainnet account id.`);
    console.error(`  This script is mainnet-only. For testnet use deploy-factory-testnet.mjs.`);
    process.exit(2);
  }
}
for (const f of [FACTORY_WASM, VAULT_WASM]) {
  if (!existsSync(f)) {
    console.error(`FATAL: ${f} missing.`);
    console.error(`  Build it:  bash scripts/build-factory.sh`);
    console.error(`  (git-bash, not PowerShell's bash — that is WSL and cannot see cargo)`);
    process.exit(1);
  }
}

// REFUSE A STALE ARTIFACT. `target/near/...` is a build output whose contents
// flip with whatever was last built. This bit once already: a security fix was
// edited into the factory's source, the wasm on disk was one build older, and
// a redeploy would have put the vulnerable code back on chain while reporting
// the fix as shipped — 24 bytes and one hash apart, invisible in a log.
{
  const wasmAge = statSync(FACTORY_WASM).mtimeMs;
  const srcDir = join(ROOT, "contracts", "factory", "src");
  const newer = readdirSync(srcDir)
    .filter((f) => f.endsWith(".rs"))
    .filter((f) => statSync(join(srcDir, f)).mtimeMs > wasmAge);
  if (newer.length) {
    console.error(`FATAL: ${FACTORY_WASM} is older than ${newer.join(", ")}.`);
    console.error(`  Rebuild:  bash scripts/build-factory.sh`);
    process.exit(1);
  }
}

const p = new JsonRpcProvider({ url: RPC });
const near = (y) => (Number(y) / 1e24).toFixed(5);
const credPath = (a) => join(homedir(), ".near-credentials", "mainnet", `${a}.json`);
const acctOrNull = (id) =>
  p.viewAccount({ accountId: id, blockQuery: { finality: "final" } }).catch(() => null);
const free = async (id) => {
  const a = await acctOrNull(id);
  return a ? BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n : null;
};

if (!existsSync(credPath(PARENT))) {
  console.error(`FATAL: no mainnet credential for ${PARENT} at ${credPath(PARENT)}`);
  process.exit(1);
}

const code = readFileSync(FACTORY_WASM);
const vaultBytes = statSync(VAULT_WASM).size;
// Storage stake for the code, plus headroom for the state `new` writes and the
// gas reservations the factory's own calls will hold.
const FUND = BigInt(code.length) * 10n ** 19n + 12n * 10n ** 22n;

const parentFree = await free(PARENT);
const existing = await acctOrNull(FACTORY);

console.log(`\n${"=".repeat(74)}`);
console.log(`  MAINNET FACTORY DEPLOY${LIVE ? "" : "   (DRY RUN — nothing will be sent)"}`);
console.log("=".repeat(74));
console.log(`  parent        ${PARENT}        free ${near(parentFree ?? 0n)}`);
console.log(`  factory       ${FACTORY}${existing ? "   ALREADY EXISTS" : ""}`);
console.log(`  factory wasm  ${code.length.toLocaleString()} B   sha256 ${createHash("sha256").update(code).digest("hex").slice(0, 16)}…`);
console.log(`  vault wasm    ${vaultBytes.toLocaleString()} B   (what it will deploy per vault)`);
console.log();
console.log(`  COST`);
console.log(`    ${near(BigInt(code.length) * 10n ** 19n).padStart(9)}  storage stake for the code   RECOVERABLE`);
console.log(`    ${near(12n * 10n ** 22n).padStart(9)}  headroom for state + gas`);
console.log(`    ${"-".repeat(9)}`);
console.log(`    ${near(FUND).padStart(9)}  total, moved from ${PARENT}`);
console.log();
console.log(`  each vault created through it will then cost its owner`);
console.log(`    ${near(BigInt(vaultBytes) * 10n ** 19n + REQUIRED_DEPOSIT)} deposit + 0.20000 gas reservation`);
console.log(`  (the global contract would take that to ~0.11 — see scripts/onboarding-ux-compare.mjs)`);

if (parentFree !== null && parentFree < FUND + 5n * 10n ** 22n) {
  console.error(`\n  FATAL: ${PARENT} holds ${near(parentFree)}, needs ~${near(FUND + 5n * 10n ** 22n)}.`);
  process.exit(1);
}

if (!LIVE) {
  console.log(`\n  Nothing was sent. To do it for real:`);
  console.log(`    $env:CONFIRM_MAINNET="1"; node scripts/deploy-factory-mainnet.mjs\n`);
  process.exit(0);
}

// ---- 1. the key, BEFORE the money ------------------------------------------
let kp;
if (existing) {
  if (!existsSync(credPath(FACTORY))) {
    console.error(`\nFATAL: ${FACTORY} exists but there is no credential at ${credPath(FACTORY)}.`);
    console.error(`  Without it nothing can sign for that account — including the teardown`);
    console.error(`  that recovers the stake. Refusing to add more to an account that`);
    console.error(`  cannot be emptied.`);
    process.exit(1);
  }
  const stored = JSON.parse(readFileSync(credPath(FACTORY), "utf8"));
  kp = KeyPair.fromString(stored.private_key ?? stored.secret_key);
  console.log(`\n  account exists — reusing the saved key, skipping creation`);
} else {
  kp = KeyPair.fromRandom("ed25519");
  const body = {
    account_id: FACTORY,
    public_key: kp.getPublicKey().toString(),
    private_key: kp.toString(),
  };
  mkdirSync(join(homedir(), ".near-credentials", "mainnet"), { recursive: true });
  writeFileSync(credPath(FACTORY), JSON.stringify(body, null, 2));

  // READ IT BACK before any money moves. If this write silently failed, the
  // next action would fund an account whose only key lives in this process.
  const back = JSON.parse(readFileSync(credPath(FACTORY), "utf8"));
  if (back.private_key !== body.private_key || back.public_key !== body.public_key) {
    console.error(`\nFATAL: ${credPath(FACTORY)} did not round-trip. Nothing has been spent.`);
    process.exit(1);
  }
  console.log(`\n  key written and verified -> ${credPath(FACTORY)}`);

  console.log(`  creating ${FACTORY} with ${near(FUND)}…`);
  const parent = new Account(PARENT, p, new KeyPairSigner(
    KeyPair.fromString(
      (() => {
        const k = JSON.parse(readFileSync(credPath(PARENT), "utf8"));
        return k.private_key ?? k.secret_key;
      })(),
    ),
  ));
  await parent.createAccount({
    newAccountId: FACTORY,
    publicKey: kp.getPublicKey(),
    nearToTransfer: FUND, // yocto, despite the name
  });
}

// ---- 2. the code ------------------------------------------------------------
const fac = new Account(FACTORY, p, new KeyPairSigner(kp));
const deployed = await p
  .viewContractCode({ contractId: FACTORY, blockQuery: { finality: "final" } })
  .catch(() => null);
const have = deployed ? Buffer.from(deployed.code_base64, "base64") : null;
if (have && have.equals(code)) {
  console.log(`  code already matches — skipping deploy`);
} else {
  console.log(`  deploying ${code.length.toLocaleString()} B…`);
  await fac.deployContract(new Uint8Array(code));
  await new Promise((r) => setTimeout(r, 3000));
}

// ---- 3. initialisation ------------------------------------------------------
const view = (method, args = {}) =>
  p.callFunction({ contractId: FACTORY, method, args, blockQuery: { finality: "optimistic" } });
let inited = true;
try {
  await view("get_config");
} catch {
  inited = false;
}
if (inited) {
  console.log(`  already initialised`);
} else {
  const hash = baseEncode(createHash("sha256").update(readFileSync(VAULT_WASM)).digest());
  console.log(`  initialising — owner ${PARENT}, code_hash ${hash}`);
  await fac.callFunction({
    contractId: FACTORY,
    methodName: "new",
    args: {
      owner: PARENT,
      code_hash: hash,
      network: "mainnet",
      required_deposit: REQUIRED_DEPOSIT.toString(),
    },
    gas: 30n * 10n ** 12n,
  });
  await new Promise((r) => setTimeout(r, 2000));
}

// ---- 4. verify from chain ---------------------------------------------------
let pass = 0;
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  ok ? pass++ : fail++;
};
console.log();

const chain = Buffer.from(
  (await p.viewContractCode({ contractId: FACTORY, blockQuery: { finality: "final" } })).code_base64,
  "base64",
);
check(chain.equals(code), `deployed code is byte-identical`, `${chain.length.toLocaleString()} B`);

const cfg = await view("get_config");
check(cfg.owner === PARENT, `owner is ${PARENT}`, JSON.stringify(cfg));
check(cfg.network === "mainnet", `network is mainnet`);
check(cfg.paused === false, `not paused`);

// THE RECOVERY PRECONDITION, asserted rather than assumed. If the saved key is
// not a FullAccess key on chain, the 1.6 can never be reclaimed.
const keys = (await p.viewAccessKeyList({ accountId: FACTORY, blockQuery: { finality: "final" } }))
  .keys;
const mine = keys.find(
  (k) => k.public_key === kp.getPublicKey().toString() && k.access_key.permission === "FullAccess",
);
check(!!mine, `the saved key is a FullAccess key on the factory`, `${keys.length} key(s) total`);

console.log(`\n  ${PARENT}   free ${near(await free(PARENT))}`);
console.log(`  ${FACTORY}   free ${near(await free(FACTORY))}`);
console.log(`\n  ${pass} passed, ${fail} failed`);

console.log(`\n${"!".repeat(74)}`);
console.log(`  BACK UP THIS FILE NOW:`);
console.log(`    ${credPath(FACTORY)}`);
console.log();
console.log(`  It is the ONLY key to ${FACTORY}. Lose it and the`);
console.log(`  ${near(BigInt(code.length) * 10n ** 19n)} of storage stake is unrecoverable — nothing will be`);
console.log(`  able to sign DeleteAccount, exactly like r1.float.test015.near's`);
console.log(`  0.546779 that is stranded forever.`);
console.log();
console.log(`  Recover it with:`);
console.log(`    NETWORK=mainnet CONFIRM_MAINNET=1 FACTORY=${FACTORY} BENEFICIARY=${PARENT} \\`);
console.log(`      node scripts/teardown-factory.mjs`);
console.log("!".repeat(74) + "\n");

process.exit(fail === 0 ? 0 : 1);
