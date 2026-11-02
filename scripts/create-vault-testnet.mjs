#!/usr/bin/env node
/**
 * Create a vault through the factory, signed by an owner whose key we hold.
 *
 * WHY NOT REUSE work12-testnet.fac.floatv4.testnet: it was made by the OLD
 * factory and has ZERO access keys. Installing a gas key is an `AddKey` action
 * ON the vault, which only a full-access key holder on that account can sign —
 * and adding such a key would itself need a key. So the self-submit rail is
 * closed on that vault permanently, and its 3.37 NEAR is unrecoverable for the
 * same reason (nothing can sign `DeleteAccount` either).
 *
 * This is also the FIRST ON-CHAIN EXERCISE of the factory's owner-key install.
 * Until now that behaviour had unit tests only — asserted against
 * `MockAction::AddKeyWithFullAccess` in a mock VM that does not execute
 * promises. The check at the end is the part that matters.
 *
 * HEADROOM IS DELIBERATE. `float-agent` funds the gas key FROM THE VAULT's own
 * balance, so a vault funded to exactly its storage floor cannot host an agent
 * at all — it would create cleanly and then refuse the next step.
 *
 * Testnet only, by suffix.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const OWNER = process.env.OWNER ?? "floatv4.testnet";
const FACTORY = process.env.FACTORY ?? "fac.floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";
const DAILY = process.env.DAILY ?? "100000000"; // 100.0 at 6dp
const PER_TX = process.env.PER_TX ?? "10000000"; // 10.0 at 6dp
const WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");
// Enough for a virtual agent's gas key (gasKeyFunding() default is 0.12) with
// room for a second. Without this the vault is created and immediately stuck.
const HEADROOM = 25n * 10n ** 22n; // 0.25

for (const [l, id] of [["OWNER", OWNER], ["FACTORY", FACTORY]]) {
  if (!id.endsWith(".testnet")) {
    console.error(`FATAL: ${l}=${id} is not testnet. This SPENDS balance.`);
    process.exit(2);
  }
}
if (!existsSync(WASM)) {
  console.error(`FATAL: ${WASM} missing. Run scripts/build-factory.sh vault, then bundle.`);
  process.exit(1);
}

const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const near = (y) => (Number(y) / 1e24).toFixed(5);
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
if (!existsSync(credPath(OWNER))) {
  console.error(`FATAL: no credential for ${OWNER} at ${credPath(OWNER)}`);
  process.exit(1);
}
const k = JSON.parse(readFileSync(credPath(OWNER), "utf8"));
const kp = KeyPair.fromString(k.private_key ?? k.secret_key);
const owner = new Account(OWNER, p, new KeyPairSigner(kp));

const code = readFileSync(WASM);
const cfg = await p.callFunction({
  contractId: FACTORY,
  method: "get_config",
  args: {},
  blockQuery: { finality: "optimistic" },
});
const VAULT = await p.callFunction({
  contractId: FACTORY,
  method: "vault_id_for",
  args: { owner: OWNER },
  blockQuery: { finality: "optimistic" },
});
if (!VAULT) {
  console.error(`FATAL: ${OWNER} has no legal derived vault id under ${FACTORY}`);
  process.exit(1);
}

const floor = BigInt(cfg.required_deposit) + BigInt(code.length) * 10n ** 19n;
const attach = floor + HEADROOM;

console.log(`\n  factory  ${FACTORY}  (paused: ${cfg.paused})`);
console.log(`  owner    ${OWNER}`);
console.log(`  vault    ${VAULT}`);
console.log(`  code     ${code.length} B`);
console.log(`  floor    ${near(floor)}   attaching ${near(attach)} (+${near(HEADROOM)} for a gas key)`);
console.log(`  token    ${TOKEN}   daily ${DAILY}  per-tx ${PER_TX}\n`);

const exists = await p
  .viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } })
  .catch(() => null);
if (exists) {
  console.error(`FATAL: ${VAULT} already exists. Nothing to do.`);
  process.exit(1);
}

const before = BigInt(
  (await p.viewAccount({ accountId: OWNER, blockQuery: { finality: "final" } })).amount,
);

const out = await owner.callFunctionRaw({
  contractId: FACTORY,
  methodName: "create_vault_with_code",
  args: {
    code: code.toString("base64"),
    label: null,
    root_limits: [{ token: TOKEN, daily_cap: DAILY, per_tx_cap: PER_TX }],
    root_recipients: [OWNER],
  },
  gas: 250n * 10n ** 12n,
  deposit: attach,
  waitUntil: "FINAL",
});

console.log(`  tx       ${out?.transaction?.hash ?? "MISSING"}`);
const status = out?.status;
if (status === undefined) {
  console.log(`  status   UNREADABLE — keys: ${Object.keys(out ?? {}).join(", ")}`);
} else if (typeof status === "object" && "Failure" in status) {
  console.log(`  status   FAILURE\n  ${JSON.stringify(status.Failure).slice(0, 500)}`);
  process.exit(1);
} else {
  console.log(`  status   SUCCESS`);
}
for (const r of out?.receipts_outcome ?? []) {
  for (const l of r.outcome?.logs ?? []) console.log(`  log: ${l}`);
  const f = r.outcome?.status?.Failure;
  if (f) console.log(`  receipt FAILED: ${JSON.stringify(f).slice(0, 300)}`);
}

await new Promise((r) => setTimeout(r, 3000));

// ---- verify from chain, not from the tx result -----------------------------
let pass = 0;
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  ok ? pass++ : fail++;
};
console.log();

const acct = await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } }).catch(() => null);
check(!!acct, `the vault exists`, acct ? `${near(BigInt(acct.amount))} balance, ${acct.storage_usage} B` : "");
if (!acct) process.exit(1);

const chain = Buffer.from(
  (await p.viewContractCode({ contractId: VAULT, blockQuery: { finality: "final" } })).code_base64,
  "base64",
);
check(chain.equals(code), `the deployed code is byte-identical`, `${chain.length} B`);

// THE NEW BEHAVIOUR. Until this ran, the owner-key install existed only as a
// unit test against a mock VM that does not execute promises.
const keys = (await p.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } })).keys;
const full = keys.filter((x) => x.access_key.permission === "FullAccess").map((x) => x.public_key);
const ownerPk = kp.getPublicKey().toString();
check(
  full.length === 1 && full[0] === ownerPk,
  `the OWNER's full-access key is installed on the vault`,
  `keys: ${keys.length}, full-access: ${JSON.stringify(full)}, owner pk: ${ownerPk}`,
);

const vcfg = await p.callFunction({ contractId: VAULT, method: "get_config", args: {}, blockQuery: { finality: "optimistic" } });
check(vcfg.owner === OWNER, `owner recorded as ${OWNER}`, `get_config -> ${JSON.stringify(vcfg)}`);
check(vcfg.clock_mode === "production", `production clock`);
check(vcfg.node_count >= 1, `root node created`, `node_count ${vcfg.node_count}`);

const freeV = BigInt(acct.amount) - BigInt(acct.storage_usage) * 10n ** 19n;
check(
  freeV >= 12n * 10n ** 22n,
  `the vault has free balance for a gas key`,
  `${near(freeV)} free (a virtual agent needs ~0.12, funded FROM the vault)`,
);

const after = BigInt(
  (await p.viewAccount({ accountId: OWNER, blockQuery: { finality: "final" } })).amount,
);
console.log(`\n  ${OWNER} paid ${near(before - after)} all in`);
console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail === 0) {
  console.log(`  Next:`);
  console.log(`    node packages/create-float/bin/float-agent.mjs \\`);
  console.log(`      --vault ${VAULT} --owner ${OWNER} --node 0 --network testnet\n`);
}
process.exit(fail === 0 ? 0 : 1);
