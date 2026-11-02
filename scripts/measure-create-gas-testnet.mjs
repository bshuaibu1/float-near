#!/usr/bin/env node
/**
 * What does delivering and decoding a 301 KB code argument actually cost?
 *
 * WHY IT MATTERS. The page attaches 300 TGas. Unused gas is refunded, so that
 * costs nothing to BURN — but the reservation is `prepaid_gas * 1e9`, which is
 * 0.3 NEAR the user must hold at signing time, on top of a 3.37 deposit. That
 * reservation is what rejected the first real attempt. Every 10 TGas shaved is
 * 0.01 NEAR off the sticker price at the exact moment a user decides whether
 * to go ahead.
 *
 * HOW, WITHOUT SPENDING 3.37 A TIME. Attach the full 301 KB argument but an
 * INSUFFICIENT deposit. near-sdk must deserialize the whole `Base64VecU8`
 * before the method body can run, and the body then panics in `begin` with
 * DEPOSIT_TOO_SMALL. So the burn includes the entire argument delivery and
 * decode — the one cost a fee table cannot predict — while the deposit is
 * refunded and no account is created. Only gas is spent.
 *
 * WHAT IT DOES NOT COVER: the downstream receipts (CreateAccount, Transfer,
 * DeployContract, the vault's own `new`, the callback). Those are separate
 * receipts with their own gas, measured here from a real successful run's
 * receipt tree when one is available.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const FACTORY = process.env.FACTORY ?? "fac.floatv4.testnet";
const CALLER = process.env.CALLER ?? "floatv4.testnet";
const WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");
const TGAS = BigInt(process.env.TGAS ?? "300");

if (!CALLER.endsWith(".testnet") || !FACTORY.endsWith(".testnet")) {
  console.error("FATAL: testnet only.");
  process.exit(2);
}
if (!existsSync(WASM)) {
  console.error(`FATAL: ${WASM} missing.`);
  process.exit(1);
}

const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const signer = (a) => {
  const k = JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${a}.json`), "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
};
const tg = (g) => (Number(g) / 1e12).toFixed(2);
const near = (y) => (Number(y) / 1e24).toFixed(6);

const code = readFileSync(WASM);
const b64 = code.toString("base64");
console.log(`\n  wasm        ${code.length} B`);
console.log(`  base64 arg  ${b64.length} B  (${((b64.length / code.length - 1) * 100).toFixed(1)}% expansion)`);
console.log(`  attaching   ${TGAS} TGas\n`);

const caller = new Account(CALLER, p, signer(CALLER));
const before = BigInt(
  (await p.viewAccount({ accountId: CALLER, blockQuery: { finality: "final" } })).amount,
);

// Deliberately 1 yocto: enough to be a payable call, far below the floor.
let out = null;
let threw = null;
try {
  out = await caller.callFunctionRaw({
    contractId: FACTORY,
    methodName: "create_vault_with_code",
    args: { code: b64, label: null, root_limits: [], root_recipients: null },
    gas: TGAS * 10n ** 12n,
    deposit: 1n,
    waitUntil: "FINAL",
  });
} catch (e) {
  // near-api-js throws a ContractExecutionError carrying the FULL outcome on
  // `transactionResult` — transaction_outcome, receipts_outcome, status. The
  // first version of this script looked for `e.context.transactionOutcome`,
  // found nothing, and silently printed no gas figures at all, leaving only a
  // balance delta to divide by the gas price. A derived number is not a
  // measurement; read the receipts.
  threw = e;
  out = e.transactionResult ?? null;
}

// The panic is the POINT, so a throw is the expected path. What matters is
// that it panicked for the RIGHT reason — if it failed on anything other than
// the deposit floor, the argument never finished decoding and the number below
// would understate the real cost.
const msg = threw ? String(threw.message) : "";
const rightReason = msg.includes("DEPOSIT_TOO_SMALL");
console.log(`  panicked on the deposit floor: ${rightReason ? "yes" : `NO — ${msg.slice(0, 200)}`}`);
if (!rightReason && !threw) {
  console.log(`  NOTE: the call SUCCEEDED. A vault was created — this was meant to be free.`);
}

const txo = out?.transaction_outcome ?? null;
const receipts = out?.receipts_outcome ?? [];
if (!txo && !receipts.length) {
  console.log(`\n  NO RECEIPTS READ — refusing to derive a gas figure from the balance delta.`);
  console.log(`  outcome keys: ${Object.keys(out ?? {}).join(", ") || "(none)"}`);
}

if (txo) {
  console.log(`\n  transaction receipt   ${tg(BigInt(txo.outcome.gas_burnt))} TGas burnt`);
}
let total = txo ? BigInt(txo.outcome.gas_burnt) : 0n;
for (const r of receipts) {
  const g = BigInt(r.outcome.gas_burnt);
  total += g;
  console.log(`  receipt ${r.id.slice(0, 8)}…      ${tg(g)} TGas  -> ${r.outcome.executor_id}`);
}
if (total > 0n) {
  console.log(`\n  TOTAL BURNT           ${tg(total)} TGas of ${TGAS} attached`);
  console.log(`  headroom              ${(100 - (Number(total) / 1e12 / Number(TGAS)) * 100).toFixed(1)}% unused`);
}

const after = BigInt(
  (await p.viewAccount({ accountId: CALLER, blockQuery: { finality: "final" } })).amount,
);
console.log(`  actually cost         ${near(before - after)} NEAR`);
console.log(`\n  reservation at ${TGAS} TGas: ${near(TGAS * 10n ** 12n * 10n ** 9n)} NEAR held at signing`);
console.log(`  (prepaid_gas * 1e9 — the MAX gas price, refunded a receipt later)\n`);
