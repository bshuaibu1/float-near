#!/usr/bin/env node
/**
 * Stand the factory up on testnet so the browser page has something to call.
 *
 * WHY A FACTORY AT ALL. Meteor greys out Approve on any dApp-requested
 * DeployContract action, blanket, even when the target is a brand-new
 * sub-account the user is paying for. Transaction size was never the issue — a
 * 294 KB tx rendered cleanly. So the browser cannot deploy; it signs one
 * ordinary FunctionCall and the deploy happens INSIDE this contract.
 *
 * WHICH PATH THIS SETS UP. `create_vault_with_code` — the vault's 294 KB
 * travels as a base64 ARGUMENT. That is the path the browser needs today,
 * because the global contract is deliberately the last thing we do (it burns
 * ~30 NEAR per version and we are not spending that until everything else is
 * proven). `create_vault` takes the global path and will be the real one.
 *
 * IDEMPOTENT. Re-running skips creation and initialisation if they are already
 * done, so a partial failure can be resumed rather than untangled.
 *
 * Testnet only, by suffix — this creates accounts and spends balance.
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider, baseEncode } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const PARENT = process.env.PARENT ?? "floatv4.testnet";
const FACTORY = process.env.FACTORY ?? "fac.floatv4.testnet";
const WALLET = process.env.WALLET ?? "work12.testnet";
const FACTORY_WASM = join(ROOT, "target", "near", "factory", "factory.wasm");
const VAULT_WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");

for (const [label, id] of [["PARENT", PARENT], ["FACTORY", FACTORY], ["WALLET", WALLET]]) {
  if (!id.endsWith(".testnet")) {
    console.error(`FATAL: ${label}=${id} is not testnet. This SPENDS balance.`);
    process.exit(2);
  }
}
for (const f of [FACTORY_WASM, VAULT_WASM]) {
  if (!existsSync(f)) {
    console.error(`FATAL: ${f} missing.`);
    process.exit(1);
  }
}

// REFUSE A STALE ARTIFACT.
//
// `target/near/factory/factory.wasm` is a BUILD OUTPUT, not a checked-in
// artifact, and its contents flip with whatever was last built. This bit once
// already: the label squatting fix was edited into lib.rs, the wasm on disk was
// 24 bytes and one hash older, and a redeploy would have put the VULNERABLE
// code back on chain while the run reported the fix as shipped. A deploy that
// cannot tell you whether it is deploying your edit is worse than no deploy.
{
  const wasmAge = statSync(FACTORY_WASM).mtimeMs;
  const srcDir = join(ROOT, "contracts", "factory", "src");
  const newer = readdirSync(srcDir)
    .filter((f) => f.endsWith(".rs"))
    .filter((f) => statSync(join(srcDir, f)).mtimeMs > wasmAge);
  if (newer.length) {
    console.error(`FATAL: ${FACTORY_WASM} is older than ${newer.join(", ")}.`);
    console.error(`  Rebuild first:`);
    console.error(`    cd contracts/factory && cargo near build non-reproducible-wasm --no-abi`);
    console.error(`  (--no-abi: the ABI step links a native dll on Windows -> ~52 LNK2019)`);
    process.exit(1);
  }
}

const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const near = (y) => (Number(y) / 1e24).toFixed(5);
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
const signer = (a) => {
  if (!existsSync(credPath(a))) {
    console.error(`FATAL: no credential for ${a}`);
    process.exit(1);
  }
  const k = JSON.parse(readFileSync(credPath(a), "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
};
const acctOrNull = (id) =>
  p.viewAccount({ accountId: id, blockQuery: { finality: "final" } }).catch(() => null);
const free = async (id) => {
  const a = await acctOrNull(id);
  return a ? BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n : null;
};

const code = readFileSync(FACTORY_WASM);
const parent = new Account(PARENT, p, signer(PARENT));

console.log(`\n  network   testnet`);
console.log(`  parent    ${PARENT}   free ${near(await free(PARENT))}`);
console.log(`  factory   ${FACTORY}`);
console.log(`  wallet    ${WALLET}   free ${near(await free(WALLET))}\n`);

// ── 1. the account ────────────────────────────────────────────────────────────
if ((await acctOrNull(FACTORY)) !== null) {
  console.log(`  account exists — skipping creation`);
} else {
  // Stake for the code, plus headroom for the state the contract writes in
  // `new` and for gas reservations on the calls it will make.
  const fund = BigInt(code.length) * 10n ** 19n + 12n * 10n ** 22n;
  const kp = KeyPair.fromRandom("ed25519");
  console.log(`  creating ${FACTORY} with ${near(fund)} (${code.length} B of code)`);
  await parent.createAccount({
    newAccountId: FACTORY,
    publicKey: kp.getPublicKey(),
    nearToTransfer: fund, // yocto, despite the name
  });
  writeFileSync(
    credPath(FACTORY),
    JSON.stringify(
      {
        account_id: FACTORY,
        public_key: kp.getPublicKey().toString(),
        private_key: kp.toString(),
      },
      null,
      2,
    ),
  );
  console.log(`  credential -> ~/.near-credentials/testnet/${FACTORY}.json`);
}

// ── 2. the code ───────────────────────────────────────────────────────────────
const fac = new Account(FACTORY, p, signer(FACTORY));
// `viewContractCode`, not `viewAccount().code_hash`. The latter reports LOCAL
// code only and reads as absent for a global reference — the exact field that
// nearly produced a false "the global never published" refutation. (Sibling
// `viewGlobalContractCode` is the one the global path will need.)
const deployed = await p
  .viewContractCode({ accountId: FACTORY, blockQuery: { finality: "final" } })
  .catch(() => null);
const want = createHash("sha256").update(code).digest();
const have = deployed ? createHash("sha256").update(Buffer.from(deployed.code_base64, "base64")).digest() : null;
if (have && want.equals(have)) {
  console.log(`  code already matches — skipping deploy`);
} else {
  console.log(`  deploying ${code.length} B`);
  await fac.deployContract(new Uint8Array(code));
  await new Promise((r) => setTimeout(r, 3000));
}

// ── 3. initialisation ─────────────────────────────────────────────────────────
const view = (method, args = {}) =>
  p.callFunction({ contractId: FACTORY, method, args, blockQuery: { finality: "optimistic" } });

// The factory exposes NO config view, so probe with `vault_id_for`: it takes
// `&self`, which means near-sdk must load state to serve it, which means it
// fails exactly when the contract is uninitialised. Nothing else to add.
let inited = true;
try {
  await view("vault_id_for", { owner: WALLET });
} catch {
  inited = false;
}

if (inited) {
  console.log(`  already initialised`);
} else {
  // `code_hash` is only read by the GLOBAL path, which this run does not take —
  // but storing the real vault hash rather than a placeholder means the value is
  // true if anyone ever reads it, and the global path works the moment we
  // publish. A fake hash here would be a trap for whoever flips that switch.
  const hash = baseEncode(createHash("sha256").update(readFileSync(VAULT_WASM)).digest());
  console.log(`  initialising`);
  console.log(`    owner            ${PARENT}`);
  console.log(`    code_hash        ${hash}`);
  console.log(`    required_deposit 0.1`);
  await fac.callFunction({
    contractId: FACTORY,
    methodName: "new",
    args: {
      owner: PARENT,
      code_hash: hash,
      network: "testnet",
      required_deposit: (10n ** 23n).toString(),
    },
    gas: 30n * 10n ** 12n,
  });
  await new Promise((r) => setTimeout(r, 2000));
}

const derived = await view("vault_id_for", { owner: WALLET });
console.log(`\n  ${WALLET} would get   ${derived}`);

// ── 4. fund the wallet that will click the button ─────────────────────────────
// The page sends stake-for-the-code + 0.36. If the wallet cannot cover that the
// click fails at signing time and tells us nothing about the question we are
// actually asking, which is whether Meteor will sign a 401 KB argument.
//
// THE GAS RESERVATION IS PART OF THE ASK, and leaving it out is why the first
// real browser attempt failed at the wallet:
//
//   Sender work12.testnet does not have enough balance 3.5234
//   for operation costing 3.674061500357969
//
// 3.674 - 3.3703 of deposit = 0.3037, which is the 300 TGas the page attaches
// priced at the MAXIMUM gas price (prepaid_gas * 1e9), held for the duration of
// the call and refunded a receipt later. It is not a fee — ~0.003 is actually
// burned — but the balance has to be there at signing time or the wallet
// refuses before anything reaches the chain.
//
// Funding to deposit + a little is therefore not enough, and the shortfall
// scales with the gas the caller attaches, not with the contract size.
// 200, matching web/index.html. Was 300; the page was cut to 200 once the real
// commitment was MEASURED at 124.88 TGas, which takes 0.1 NEAR off what a user
// must hold. A stale number here over-funds and, when the parent is thin,
// turns a convenience into a failure.
const PAGE_TGAS = 200n;
const gasReservation = PAGE_TGAS * 10n ** 12n * 10n ** 9n; // 0.2 NEAR
const vaultNeed =
  BigInt(statSync(VAULT_WASM).size) * 10n ** 19n + 36n * 10n ** 22n + gasReservation;
const haveW = await free(WALLET);

// THIS STEP IS OPTIONAL AND MUST NOT FAIL THE RUN.
//
// It bit exactly that way: the factory deployed successfully, then this threw
// `NotEnoughBalanceError` because the parent held 1.21 and the top-up wanted
// 3.31 — and the whole run ended in a stack trace, reading as "the deploy
// failed" when the deploy had in fact worked. The top-up only matters if
// someone is about to create ANOTHER vault through the browser; it has nothing
// to do with whether the factory is live.
if (haveW >= vaultNeed) {
  console.log(`\n  ${WALLET} already covers a new vault`);
} else {
  const short = vaultNeed - haveW;
  const parentFree = await free(PARENT);
  const send = short + 15n * 10n ** 22n;
  if (parentFree < send) {
    console.log(`\n  ${WALLET} holds ${near(haveW)} and a new vault needs ${near(vaultNeed)}.`);
    console.log(`  NOT topping up: ${PARENT} only has ${near(parentFree)} free, short by`);
    console.log(`  about ${near(send - parentFree)}. This does NOT affect the factory, which`);
    console.log(`  is deployed and live — it only means no NEW vault can be created until`);
    console.log(`  ${PARENT} is funded. An existing vault keeps working.`);
  } else {
    console.log(`\n  ${WALLET} has ${near(haveW)}, needs ${near(vaultNeed)} — sending ${near(send)}`);
    try {
      await parent.transfer({ receiverId: WALLET, amount: send });
      let ok = false;
      for (let i = 0; i < 30; i++) {
        if ((await free(WALLET)) >= vaultNeed) {
          ok = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!ok) console.log(`  WARNING: never reached the expected balance — read again`);
    } catch (e) {
      console.log(`  top-up FAILED: ${String(e.message).slice(0, 120)}`);
      console.log(`  The factory is still deployed and live; only the top-up did not happen.`);
    }
  }
}

console.log(`\n  ${PARENT}   free ${near(await free(PARENT))}`);
console.log(`  ${FACTORY}   free ${near(await free(FACTORY))}`);
console.log(`  ${WALLET}   free ${near(await free(WALLET))}   (vault needs ${near(vaultNeed)})`);
console.log(`\n  Serve the page, then open:`);
console.log(`    http://127.0.0.1:8787/?network=testnet&factory=${FACTORY}\n`);
