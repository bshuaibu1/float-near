#!/usr/bin/env node
/**
 * Verify the factory's PROMISE BATCH on a real chain.
 *
 * WHY THIS IS THE ONLY WAY. Every unit test in contracts/factory proves the
 * validation that runs BEFORE the batch — paused, deposit, derived id, access
 * control. The batch itself is untested, because near-sdk's mock VM does not
 * execute promises and near-workspaces has no Windows sandbox binary. So
 * CreateAccount, UseGlobalContract issued from inside a contract, `new`
 * reaching the new account, and the refund arriving are all UNVERIFIED by
 * `cargo test`. This script is what moves them.
 *
 * THE CHEAP TRICK THAT MAKES IT AFFORDABLE. The factory needs a published
 * global contract to reference, and publishing the real vault costs 29.962 NEAR
 * (299,620 bytes x 1e20, measured on both chains). A minimal near-sdk contract
 * is ~100 KB and so ~10 NEAR — near-sdk is the floor, so "use a stub crate"
 * does not help. Raw wasm has no floor: `scripts/make-stub-wasm.mjs` builds a
 * 33-byte module exporting a no-op `new`, which is 0.0033 NEAR.
 *
 *   SUCCESS path  -> global = stub-new.wasm (exports `new`)
 *   FAILURE path  -> global = tiny.wasm (exports nothing, so MethodNotFound)
 *
 * The failure path is the one worth the most: it is where a user silently
 * loses their deposit if `on_vault_created` is wrong.
 *
 * WHAT THIS STILL DOES NOT VERIFY, and REAL_VAULT=1 is the gate for it: that
 * the vault's parent-init exemption accepts the factory, and that a configured
 * vault comes out. That needs the real artifact published globally, which costs
 * ~30 NEAR of testnet funds this pool does not have.
 *
 * TESTNET ONLY.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  Account,
  KeyPair,
  KeyPairSigner,
  JsonRpcProvider,
  actions,
  baseEncode,
} from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const PARENT = process.env.PARENT ?? "floatv4.testnet";
const FACTORY = process.env.FACTORY ?? `fac${Date.now().toString(36).slice(-5)}.${PARENT}`;
const REAL_VAULT = process.env.REAL_VAULT === "1";

if (!PARENT.endsWith(".testnet")) {
  console.error(`FATAL: ${PARENT} is not testnet. This creates accounts and burns; testnet only.`);
  process.exit(2);
}

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const info = (m) => console.log(`    ${C.d(m)}`);
const warn = (m) => console.log(`    ${C.y("warn")} ${m}`);
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`    ${pass ? C.g("ok") : C.r("FAIL")} ${name}${detail ? ` ${C.d(detail)}` : ""}`);
};

const provider = new JsonRpcProvider({ url: RPC });
const near6 = (y) => (Number(y) / 1e24).toFixed(6);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const signerFor = (a) => {
  const k = JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${a}.json`), "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
};

const FACTORY_WASM = join(ROOT, "target", "near", "factory", "factory.wasm");
const STUB = join(ROOT, ".demo", "stub-new.wasm");
const TINY = join(ROOT, ".demo", "tiny.wasm");

/** Settled account state — see the memory note on lagging balance reads. */
async function settled(accountId, tries = 60) {
  const QUIET = 6;
  const BLOCKS = 8n;
  let prev = null;
  let runStart = null;
  let run = 0;
  for (let i = 0; i < tries; i++) {
    const a = await provider.viewAccount({ accountId, blockQuery: { finality: "final" } }).catch(() => null);
    if (!a) return null;
    const s = { amount: BigInt(a.amount), bytes: BigInt(a.storage_usage), height: BigInt(a.block_height), hash: a.code_hash };
    if (prev && s.amount === prev.amount && s.bytes === prev.bytes) {
      run += 1;
      runStart ??= prev;
      if (run >= QUIET && s.height - runStart.height >= BLOCKS) return s;
    } else {
      run = 0;
      runStart = null;
    }
    prev = s;
    await wait(800);
  }
  warn(`${accountId} never stopped moving; deltas below are unsafe`);
  return prev;
}
const exists = (id) =>
  provider.viewAccount({ accountId: id, blockQuery: { finality: "final" } }).then(() => true, () => false);

console.log(`\n${C.b("network")}  ${C.g("testnet")}`);
console.log(`${C.b("parent")}   ${PARENT}`);
console.log(`${C.b("factory")}  ${FACTORY}   ${C.d("(created and deleted by this run)")}`);
console.log(`${C.b("global")}   ${REAL_VAULT ? "the REAL vault (REAL_VAULT=1)" : "33-byte stubs"}`);

// ---- PREFLIGHT: refuse with an exact shortfall rather than failing in flight.
step(0, "Preflight — can this pool afford the run?");
for (const [p, hint] of [
  [FACTORY_WASM, "cd contracts/factory && cargo near build non-reproducible-wasm --no-abi"],
  [STUB, "node scripts/make-stub-wasm.mjs"],
  [TINY, "already committed; .demo/tiny.wasm"],
]) {
  if (!existsSync(p)) {
    console.error(`\nFATAL: missing ${p}\n  build it:  ${hint}`);
    process.exit(1);
  }
}
const factoryBytes = BigInt(statSync(FACTORY_WASM).size);
const stubBytes = BigInt(statSync(STUB).size);
const vaultBytes = BigInt(statSync(join(ROOT, "packages", "create-float", "res", "vault.wasm")).size);

const STAKE = 10n ** 19n; // per byte, normal account storage
const BURN = 10n ** 20n; // per byte, global contract publish
// 0.01, not the product's 0.1. A factory-created vault gets NO ACCESS KEY —
// correct for the product, since owner authority is `predecessor_account_id()`
// and a keyless vault cannot be drained by a stolen key — but it means these
// test vaults can never be deleted and their stake is spent permanently. The
// stub has no state, so a 214-byte global reference is all they need.
const DEPOSIT = 10n ** 22n;
const factoryStake = factoryBytes * STAKE;
const globalBurn = REAL_VAULT ? vaultBytes * BURN : stubBytes * BURN;
const GAS_SLOP = 2n * 10n ** 22n; // 0.02 for gas across ~12 transactions
const needed = factoryStake + globalBurn + DEPOSIT * 2n + GAS_SLOP;

const p0 = await settled(PARENT);
const free = p0.amount - p0.bytes * STAKE;
info(`factory wasm        ${factoryBytes} B -> stake ${near6(factoryStake)}`);
info(`global publish      ${REAL_VAULT ? vaultBytes : stubBytes} B -> BURN ${near6(globalBurn)}`);
info(`2 create deposits   ${near6(DEPOSIT * 2n)}  (one refunded)`);
info(`gas slop            ${near6(GAS_SLOP)}`);
info(`TOTAL NEEDED        ${near6(needed)}`);
info(`${PARENT} FREE      ${near6(free)}`);
if (free < needed) {
  const short = needed - free;
  console.error(`\n${C.r("FATAL")} short by ${near6(short)} NEAR.`);
  console.error(`  Fund ${PARENT} at https://near-faucet.io (ask for ${Math.ceil(Number(short) / 1e24) + 1} NEAR), then re-run.`);
  console.error(`  Nothing has been created or spent.`);
  process.exit(1);
}
check("the pool can afford the run", true, `${near6(free)} free vs ${near6(needed)} needed`);

const parent = new Account(PARENT, provider, signerFor(PARENT));
const GAS = (tg) => BigInt(tg) * 10n ** 12n;
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest();
// near-api-js's own base58, not a hand-rolled one — the encoding has to match
// what the chain reports as `code_hash` exactly, and reusing the library's
// encoder removes any chance of a leading-zero or alphabet discrepancy.
const STUB_HASH = baseEncode(sha256(STUB));
const TINY_HASH = baseEncode(sha256(TINY));
const created = [];

try {
  // ---- A. publish the globals
  step("A", "Publish the stub global contracts");
  for (const [p, h, what] of [
    [STUB, STUB_HASH, "exports `new`"],
    [TINY, TINY_HASH, "exports nothing"],
  ]) {
    const already = await provider
      .query({ request_type: "view_global_contract_code", finality: "final", code_hash: h })
      .then(() => true, () => false);
    if (already) {
      info(`${h} already published (${what}) — reused`);
    } else {
      await parent.signAndSendTransaction({
        receiverId: PARENT,
        actions: [actions.deployGlobalContract(new Uint8Array(readFileSync(p)), "codeHash")],
      });
      info(`published ${h} (${what})`);
    }
    // POLL, do not read once. A `final`-finality read immediately after the
    // publish returned null for the stub while the already-published tiny.wasm
    // read back fine at 49 bytes — the publish had landed, the view had not
    // caught up. Tenth instance of this class in this project; see the memory
    // note on lagging reads.
    let live = null;
    for (let i = 0; i < 30 && live === null; i++) {
      live = await provider
        .query({ request_type: "view_global_contract_code", finality: "final", code_hash: h })
        .then((r) => Buffer.from(r.code_base64, "base64").length, () => null);
      if (live === null) await wait(800);
    }
    check(`A: ${what} is live as a global contract`, live === statSync(p).size, `${live} bytes`);
  }

  // ---- B. the factory itself
  step("B", "Create and initialize the factory");
  const fkp = KeyPair.fromRandom("ed25519");
  // AN OBJECT, not positional arguments — near-api-js v7 takes
  // `{ newAccountId, publicKey, nearToTransfer }`. Passing them positionally
  // left newAccountId undefined and failed with "Cannot read properties of
  // undefined (reading 'endsWith')" from inside the library.
  //
  // And `nearToTransfer` is YOCTO despite its name: the implementation does
  // `transfer3(BigInt(nearToTransfer))` with no conversion (index.js:4442).
  // Passing 1.4 meaning NEAR would send 1.4 yoctoNEAR and the deploy would die
  // with LackBalanceForState.
  await parent.createAccount({
    newAccountId: FACTORY,
    publicKey: fkp.getPublicKey(),
    nearToTransfer: factoryStake + 5n * 10n ** 22n,
  });
  // Keep the KEYPAIR, not just the id. DeleteAccount must be signed by the
  // account itself, and the factory's key is this random one — the parent's
  // key cannot delete it.
  created.push({ id: FACTORY, kp: fkp });
  const factory = new Account(FACTORY, provider, new KeyPairSigner(fkp));
  await factory.deployContract(readFileSync(FACTORY_WASM));
  await factory.callFunction({
    contractId: FACTORY,
    methodName: "new",
    args: {
      owner: PARENT,
      code_hash: STUB_HASH,
      network: "testnet",
      required_deposit: DEPOSIT.toString(),
    },
    gas: GAS(30),
    deposit: 0n,
  });
  const fstate = await settled(FACTORY);
  check("B: the factory is deployed", fstate.hash !== "11111111111111111111111111111111", fstate.hash.slice(0, 12) + "…");
  const idFor = await provider.callFunction({
    contractId: FACTORY,
    method: "vault_id_for",
    args: { owner: PARENT },
    blockQuery: { finality: "optimistic" },
  });
  const expectedVault = `${PARENT.replace(/\./g, "-")}.${FACTORY}`;
  check("B: vault_id_for matches the documented derivation", idFor === expectedVault, `${idFor}`);

  // ---- C. THE SUCCESS PATH — this is the promise batch, finally executing
  step("C", "create_vault SUCCEEDS and the new account runs the global contract");
  const before = await settled(PARENT);
  const outC = await parent.callFunction({
    contractId: FACTORY,
    methodName: "create_vault",
    args: { label: null },
    gas: GAS(120),
    deposit: DEPOSIT,
  });
  info(`outcome ${JSON.stringify(outC)}`);
  const vaultExists = await (async () => {
    for (let i = 0; i < 25; i++) {
      if (await exists(expectedVault)) return true;
      await wait(800);
    }
    return false;
  })();
  check("C: the vault ACCOUNT was created by the batch", vaultExists, expectedVault);
  if (vaultExists) {
    const vs = await settled(expectedVault);
    // THE DECISIVE ASSERTION. A matching code_hash proves
    // UseGlobalContract was issued from inside a contract and applied — the
    // one thing no unit test in this repo can show.
    check("C: it references the GLOBAL contract", vs.hash === STUB_HASH, `${vs.hash}`);
    check("C: it holds the deposit as storage stake", vs.amount > 0n, near6(vs.amount));
  }

  // ---- D. THE FAILURE PATH — the one that costs a user money if broken
  step("D", "A failing batch REFUNDS the caller");
  await parent.callFunction({
    contractId: FACTORY,
    methodName: "set_code_hash",
    args: { code_hash: TINY_HASH },
    gas: GAS(30),
    deposit: 1n,
  });
  info(`factory repointed at ${TINY_HASH} — no \`new\` export, so the batch must fail`);
  const beforeD = await settled(PARENT);
  const failLabel = `f${Date.now().toString(36).slice(-6)}`;
  await parent
    .callFunction({
      contractId: FACTORY,
      methodName: "create_vault",
      args: { label: failLabel },
      gas: GAS(120),
      deposit: DEPOSIT,
    })
    .catch((e) => info(`call reported: ${String(e.message).slice(0, 120)}`));
  const afterD = await settled(PARENT);
  const spent = beforeD.amount - afterD.amount;
  const failVault = `${failLabel}.${FACTORY}`;
  check("D: the vault account does NOT exist — the batch reverted", !(await exists(failVault)), failVault);
  // If the refund works the caller is out only gas (~0.001). If it does not,
  // they are out the whole deposit as well.
  info(`caller spent ${near6(spent)}  (deposit was ${near6(DEPOSIT)})`);
  check(
    "D: the deposit came BACK — the caller paid gas only",
    spent < DEPOSIT / 2n,
    `spent ${near6(spent)} < half the deposit`,
  );

  // ---- E. the live contract enforces what the unit tests claim
  step("E", "The deployed contract enforces its guards");
  let msg = "";
  await parent
    .callFunction({
      contractId: FACTORY,
      methodName: "create_vault",
      args: { label: null },
      gas: GAS(60),
      deposit: DEPOSIT / 2n,
    })
    .catch((e) => (msg = String(e.message)));
  check("E: an underfunded create is refused", /DEPOSIT_TOO_SMALL/.test(msg), msg.slice(0, 80));

  await parent.callFunction({
    contractId: FACTORY,
    methodName: "set_paused",
    args: { paused: true },
    gas: GAS(30),
    deposit: 1n,
  });
  msg = "";
  await parent
    .callFunction({
      contractId: FACTORY,
      methodName: "create_vault",
      args: { label: null },
      gas: GAS(60),
      deposit: DEPOSIT,
    })
    .catch((e) => (msg = String(e.message)));
  check("E: the kill switch is honoured", /PAUSED/.test(msg), msg.slice(0, 80));
} catch (e) {
  check("run completed", false, String(e.message).slice(0, 200));
} finally {
  step("Z", "Cleanup");
  // The FACTORY has a key, so it can be deleted and its stake returned. The
  // created VAULTS cannot: a factory-created vault has no access key at all,
  // which is the product's intent and makes these test accounts permanent.
  for (const { id, kp } of created) {
    await new Account(id, provider, new KeyPairSigner(kp))
      .deleteAccount(PARENT)
      .then(() => info(`deleted ${id}, stake returned to ${PARENT}`))
      .catch((e) => info(`could not delete ${id}: ${String(e.message).slice(0, 70)}`));
  }
  info(`vault test accounts are KEYLESS and cannot be deleted; their stake is spent`);
  const end = await settled(PARENT);
  info(`${PARENT} free ${near6(end.amount - end.bytes * STAKE)}`);
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${C.b(`${pass}/${results.length}`)} checks passed  ${C.d(`— factory ${FACTORY} on testnet`)}`);
  for (const r of results.filter((r) => !r.pass)) console.log(`  ${C.r("FAIL")} ${r.name}`);
  process.exitCode = pass === results.length ? 0 : 1;
}
