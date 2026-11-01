#!/usr/bin/env node
/**
 * Verify the vault's PARENT-INIT exemption on a real chain, for 3 NEAR.
 *
 * WHAT IS UNTESTED. `new()` used to demand `predecessor == current`, which a
 * factory cannot satisfy — it holds no key to sign as the vault, and its
 * promise-batch `function_call` arrives with the FACTORY as predecessor. So the
 * vault now also accepts its immediate PARENT. That change has 156 unit tests
 * and has never run on a chain.
 *
 * WHY NOT JUST RUN THE FACTORY AGAINST THE REAL VAULT. That was the plan, and
 * it costs 29.9996 NEAR to publish the vault as a global contract — funds this
 * testnet pool does not have and the faucet is not reliably giving. But that
 * run would verify two things, and only one of them is unknown:
 *
 *   factory batch mechanics   ALREADY PROVEN, 12/12 with 33-byte stubs
 *   parent-init on a chain    UNKNOWN
 *
 * The unknown one needs no global contract. Deploy the vault NORMALLY to a
 * sub-account and have the PARENT call `new` on it: same predecessor/current
 * relationship, same code path, 3.0 NEAR instead of 30.
 *
 * BOTH BRANCHES FOR THE SAME MONEY. `new` is `#[init]`, so the account stays
 * uninitialized until someone succeeds — which means the STRANGER case can be
 * tested first, on the same account, for free. That ordering is the only way
 * to get the negative case without a second 3 NEAR deploy.
 *
 * TESTNET ONLY.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider, baseEncode } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const RPC = "https://test.rpc.fastnear.com";
const PARENT = process.env.PARENT ?? "floatv4.testnet";
/** A third party that is neither the vault nor its parent. */
const STRANGER = process.env.STRANGER ?? "ft.floatv4.testnet";
const CHILD = `pv${Date.now().toString(36).slice(-5)}.${PARENT}`;
const WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");
const STUB = join(ROOT, ".demo", "stub-new.wasm");

if (!PARENT.endsWith(".testnet")) {
  console.error(`FATAL: ${PARENT} is not testnet.`);
  process.exit(2);
}

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const info = (m) => console.log(`    ${C.d(m)}`);
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`    ${pass ? C.g("ok") : C.r("FAIL")} ${name}${detail ? ` ${C.d(detail)}` : ""}`);
};

const p = new JsonRpcProvider({ url: RPC });
const near = (y) => (Number(y) / 1e24).toFixed(5);
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
const signerFor = (a) => {
  const k = JSON.parse(readFileSync(credPath(a), "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const code = readFileSync(WASM);
const STAKE = BigInt(code.length) * 10n ** 19n;
const FUND = STAKE + 15n * 10n ** 22n; // + 0.15 for state and gas

console.log(`\n${C.b("network")}  ${C.g("testnet")}`);
console.log(`${C.b("child")}    ${CHILD}   ${C.d("created and deleted by this run")}`);
console.log(`${C.b("parent")}   ${PARENT}`);
console.log(`${C.b("stranger")} ${STRANGER}`);

const parent = new Account(PARENT, p, signerFor(PARENT));
const childKp = KeyPair.fromRandom("ed25519");
let created = false;

try {
  step(0, "Preflight");
  const pa = await p.viewAccount({ accountId: PARENT, blockQuery: { finality: "final" } });
  const free = BigInt(pa.amount) - BigInt(pa.storage_usage) * 10n ** 19n;
  info(`vault wasm ${code.length} B -> stake ${near(STAKE)}, funding ${near(FUND)}`);
  info(`${PARENT} free ${near(free)}`);
  if (free < FUND) {
    console.error(`\nFATAL: short by ${near(FUND - free)} NEAR. Nothing created.`);
    process.exit(1);
  }
  check("the pool can afford a real vault deploy", true, `${near(free)} vs ${near(FUND)}`);
  if (!existsSync(credPath(STRANGER))) {
    console.error(`FATAL: no credential for the stranger ${STRANGER}`);
    process.exit(1);
  }

  step(1, "Deploy the real vault to a fresh sub-account, UNINITIALIZED");
  await parent.createAccount({
    newAccountId: CHILD,
    publicKey: childKp.getPublicKey(),
    nearToTransfer: FUND,
  });
  created = true;
  const child = new Account(CHILD, p, new KeyPairSigner(childKp));
  await child.deployContract(new Uint8Array(code));
  await wait(2500);
  const deployed = await p
    .query({ request_type: "view_code", finality: "final", account_id: CHILD })
    .then((r) => Buffer.from(r.code_base64, "base64"));
  check("the real vault is deployed", deployed.length === code.length, `${deployed.length} B`);
  check(
    "it is the artifact create-float ships",
    baseEncode(createHash("sha256").update(deployed).digest()) ===
      baseEncode(createHash("sha256").update(code).digest()),
  );

  const args = { owner: PARENT, network: "testnet", strict_allocation: false };
  const callNew = (acct) =>
    acct.callFunction({
      contractId: CHILD,
      methodName: "new",
      args,
      gas: 60n * 10n ** 12n,
      deposit: 0n,
    });

  // ---- 2. THE NEGATIVE FIRST, which is only possible because `new` is #[init]
  // and the account stays uninitialized until someone succeeds. Running it
  // after the parent would cost a second 3 NEAR deploy.
  step(2, "A STRANGER cannot initialize it");
  let msg = "";
  try {
    await callNew(new Account(STRANGER, p, signerFor(STRANGER)));
    check("2: the stranger was refused", false, "it SUCCEEDED — the exemption is too wide");
  } catch (e) {
    msg = String(e.message);
    info(msg.slice(0, 120));
    check("2: the stranger was refused", /INIT_NOT_SELF/.test(msg));
  }

  // ---- 3. THE POSITIVE: the parent, which is the whole point
  step(3, "The PARENT can initialize it — the factory's enabling change");
  try {
    await callNew(parent);
    check("3: the parent initialized the vault", true);
  } catch (e) {
    check("3: the parent initialized the vault", false, String(e.message).slice(0, 160));
  }

  const cfg = await p
    .callFunction({ contractId: CHILD, method: "get_config", args: {}, blockQuery: { finality: "optimistic" } })
    .catch(() => null);
  check("3: the vault answers get_config", cfg !== null, cfg ? `owner ${cfg.owner}` : "no answer");
  check("3: the owner is the one the parent passed", cfg?.owner === PARENT, `${cfg?.owner}`);
  check("3: it is not paused and has a root node", cfg?.paused === false && cfg?.node_count >= 1, `${cfg?.node_count} node(s)`);
} catch (e) {
  check("run completed", false, String(e.message).slice(0, 200));
} finally {
  step("Z", "Cleanup — shrink, then delete, to recover the stake");
  if (created) {
    const child = new Account(CHILD, p, new KeyPairSigner(childKp));
    // DELETION IS BOUNDED WORK, so NEAR refuses it for an account carrying a
    // 300 KB contract — "cannot be deleted because it has a large state".
    // Deploying the 33-byte stub first drops storage_usage and makes the
    // delete legal. Learned on v4.floatv4.testnet.
    await child
      .deployContract(new Uint8Array(readFileSync(STUB)))
      .then(() => info("shrunk to the 33-byte stub"))
      .catch((e) => info(`shrink failed: ${String(e.message).slice(0, 70)}`));
    await wait(2500);
    await child
      .deleteAccount(PARENT)
      .then(() => info(`deleted ${CHILD}, stake returned to ${PARENT}`))
      .catch((e) => info(`delete failed: ${String(e.message).slice(0, 90)}`));
  }
  const end = await p.viewAccount({ accountId: PARENT, blockQuery: { finality: "final" } }).catch(() => null);
  if (end) info(`${PARENT} free ${near(BigInt(end.amount) - BigInt(end.storage_usage) * 10n ** 19n)}`);
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${C.b(`${pass}/${results.length}`)} checks passed  ${C.d("— parent-init on testnet")}`);
  for (const r of results.filter((r) => !r.pass)) console.log(`  ${C.r("FAIL")} ${r.name}`);
  process.exitCode = pass === results.length ? 0 : 1;
}
