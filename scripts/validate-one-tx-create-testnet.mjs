#!/usr/bin/env node
/**
 * Can ONE transaction create a complete, usable vault? If yes, the browser
 * flow ships without the factory and without the 30 NEAR global publish.
 *
 * THE ASSUMPTION THIS TESTS. docs/DESIGN-browser-signing-flow.md concluded that
 * browser vault-creation needs a FACTORY, because `new` demanded
 * `predecessor == current` and a wallet signs as the OWNER, not as the vault.
 * That was true when it was written. Two things have changed since:
 *
 *   1. `new` now accepts the vault's PARENT — and when `alice.near` creates
 *      `float.alice.near`, the signer IS the parent.
 *   2. `new` now creates the root node, so one call produces a usable vault
 *      rather than an empty one.
 *
 * So the factory may be unnecessary for creation. It was only ever needed to
 * work around a restriction that no longer exists.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Every action here —
 * CreateAccount, Transfer, DeployContract, FunctionCall — is in
 * wallet-selector's LEGACY eight-member action union, the one every wallet has
 * handled since day one. No NEP-591 action, so none of the "will this wallet
 * serialise it" risk that drove the factory design.
 *
 * And the contract fits: 301,033 bytes against a measured
 * max_transaction_size of 1,572,864 — 19.1%.
 *
 * WHAT THIS DOES NOT PROVE. A wallet's own UI may refuse a 301 KB transaction,
 * or truncate it, or time out. That needs a real wallet and a human. This
 * proves the CHAIN accepts the shape; the wallet is the next unknown.
 *
 * TESTNET ONLY.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider, actions } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const RPC = "https://test.rpc.fastnear.com";
const OWNER = process.env.OWNER ?? "floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";
const VAULT = `b${Date.now().toString(36).slice(-6)}.${OWNER}`;
const WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");
const STUB = join(ROOT, ".demo", "stub-new.wasm");

if (!OWNER.endsWith(".testnet")) {
  console.error("FATAL: testnet only.");
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
const FUND = STAKE + 36n * 10n ** 22n; // + 0.36 for root-node state and headroom

console.log(`\n${C.b("network")}  ${C.g("testnet")}`);
console.log(`${C.b("owner")}    ${OWNER}   ${C.d("signs — exactly what a wallet would do")}`);
console.log(`${C.b("vault")}    ${VAULT}   ${C.d("created and deleted by this run")}`);

const owner = new Account(OWNER, p, signerFor(OWNER));
const vaultKp = KeyPair.fromRandom("ed25519");
let created = false;

try {
  step(0, "Preflight");
  const a0 = await p.viewAccount({ accountId: OWNER, blockQuery: { finality: "final" } });
  const free = BigInt(a0.amount) - BigInt(a0.storage_usage) * 10n ** 19n;
  info(`contract ${code.length} B, 19.1% of the 1,572,864 B transaction limit`);
  info(`${OWNER} free ${near(free)}, needs ${near(FUND)}`);
  if (free < FUND) {
    console.error(`\nFATAL: short by ${near(FUND - free)}. Nothing created.`);
    process.exit(1);
  }
  check("the owner can afford it", true);

  step(1, "ONE transaction: CreateAccount + Transfer + DeployContract + new()");
  info("every action is in wallet-selector's LEGACY union — no NEP-591 type");
  const t0 = Date.now();
  const outcome = await owner.signAndSendTransaction({
    receiverId: VAULT,
    actions: [
      actions.createAccount(),
      actions.transfer(FUND),
      // A full-access key so the run can clean up afterwards. The REAL browser
      // flow would omit this: a keyless vault cannot be drained by a stolen
      // key, and the owner controls it through `predecessor_account_id` alone.
      actions.addFullAccessKey(vaultKp.getPublicKey()),
      actions.deployContract(new Uint8Array(code)),
      actions.functionCall(
        "new",
        {
          owner: OWNER,
          network: "testnet",
          strict_allocation: false,
          root_limits: [{ token: TOKEN, daily_cap: "100000000", per_tx_cap: "10000000" }],
          root_recipients: [OWNER],
        },
        60n * 10n ** 12n,
        0n,
      ),
    ],
  });
  created = true;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check("the chain ACCEPTED a 301 KB multi-action transaction", true, `${secs}s`);
  info(`tx ${outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? "(hash not in response)"}`);

  step(2, "Is the vault real and usable?");
  await wait(3000);
  const acct = await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } }).catch(() => null);
  check("the account exists", acct !== null, acct ? `${acct.storage_usage} B` : "");
  const live = await p
    .query({ request_type: "view_code", finality: "final", account_id: VAULT })
    .then((r) => Buffer.from(r.code_base64, "base64").length, () => 0);
  check("it runs the vault contract", live === code.length, `${live} B`);

  const view = (m, args = {}) =>
    p.callFunction({ contractId: VAULT, method: m, args, blockQuery: { finality: "optimistic" } });
  const cfg = await view("get_config").catch(() => null);
  check("it is INITIALIZED", cfg !== null, cfg ? `owner ${cfg.owner}` : "get_config failed");
  check("the owner is the signer", cfg?.owner === OWNER);

  // THE THING THE FACTORY RUN COULD NOT SHOW: a usable vault out of one
  // transaction, not an empty one.
  const tree = await view("get_tree").catch(() => []);
  check("it has a ROOT NODE — usable, not empty", tree.length === 1, `${tree.length} node(s)`);
  if (tree.length) {
    check("the root carries the token limit", (tree[0].limits ?? []).length === 1, JSON.stringify(tree[0].limits?.[0]?.token));
    check(
      "the root allowlists the owner — not NO_RECIPIENTS_SET",
      Array.isArray(tree[0].recipients) && tree[0].recipients.includes(OWNER),
      JSON.stringify(tree[0].recipients),
    );
  }
} catch (e) {
  check("run completed", false, String(e.message).slice(0, 220));
} finally {
  step("Z", "Cleanup");
  if (created) {
    const v = new Account(VAULT, p, new KeyPairSigner(vaultKp));
    await v
      .deployContract(new Uint8Array(readFileSync(STUB)))
      .then(() => info("shrunk to the 33-byte stub so NEAR will allow the delete"))
      .catch((e) => info(`shrink failed: ${String(e.message).slice(0, 70)}`));
    await wait(2500);
    await v
      .deleteAccount(OWNER)
      .then(() => info(`deleted ${VAULT}`))
      .catch((e) => info(`delete failed: ${String(e.message).slice(0, 80)}`));
    await wait(4000);
  }
  const end = await p.viewAccount({ accountId: OWNER, blockQuery: { finality: "final" } }).catch(() => null);
  if (end) info(`${OWNER} free ${near(BigInt(end.amount) - BigInt(end.storage_usage) * 10n ** 19n)}`);
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${C.b(`${pass}/${results.length}`)} checks passed  ${C.d("— one-transaction vault creation")}`);
  for (const r of results.filter((r) => !r.pass)) console.log(`  ${C.r("FAIL")} ${r.name}`);
  process.exitCode = pass === results.length ? 0 : 1;
}
