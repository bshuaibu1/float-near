#!/usr/bin/env node
/**
 * SPIKE: can an agent hold a function-call key on the VAULT ITSELF, pay its own
 * gas from the key's allowance, and still be identifiable by the contract?
 *
 * WHY. A design proposed 2026-10-31 would delete the relayer from Float's
 * architecture. Instead of `request_payment_signed` + a relayer that fronts gas
 * and must be reimbursed, the agent gets an access key ON THE VAULT, restricted
 * to `request_payment`, carrying a NEAR `allowance`. Then:
 *
 *   - the agent submits its own transactions and pays its own gas, METERED BY
 *     THE PROTOCOL, so nobody has to build fee accounting;
 *   - `allowance` is a hard protocol-level ceiling — a second budget for free;
 *   - no agent sub-account: 0.55 NEAR becomes ~0.05 of allowance;
 *   - no nonce, no deadline, no ed25519_verify — the protocol authenticated it.
 *
 * It also avoids the trap in the obvious alternative: reimbursing a relayer
 * from the vault BEFORE the budget tree is evaluated reintroduces F2 ("an agent
 * could drain the vault's NEAR, which no cap governed"), because `NEAR_BUDGET`
 * is enforced inside that tree.
 *
 * The design rests on three protocol facts this repo had never tested:
 *
 *   Q1  Does NEAR accept an AddKey whose FunctionCall `receiver_id` IS the
 *       account the key is added to?
 *   Q2  Can that key sign a call, and does the gas come from its ALLOWANCE
 *       rather than the account's balance?
 *   Q3  What does the contract see? `predecessor_account_id()` will be the
 *       vault itself, so the ONLY thing that can tell one agent from another is
 *       `signer_account_pk()`. If that is not the signing key, the design dies.
 *
 * Q3 is load-bearing and cannot be settled by reading the spec with
 * confidence. Float already maps pubkey -> node (`pubkey_to_node`, built for
 * virtual agents), so if `signer_account_pk()` IS the signing key, the lookup
 * already exists.
 *
 * Deliberately against a THROWAWAY PROBE CONTRACT, not a vault. The question is
 * about the protocol, so a 90 KB probe answers it without deploying to a vault
 * or touching budget logic. Testnet only; it refuses to run on mainnet.
 *
 * Idempotent: every step checks whether it is already done.
 *
 * Usage:
 *   node scripts/spike-self-fc-key.mjs
 *   PARENT=approve.floatv4.testnet PROBE=p1.approve.floatv4.testnet node scripts/...
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
// floatv4.testnet, not a vault. The vault accounts here look rich and are not:
// approve.floatv4.testnet holds 3.298 NEAR of which 3.085 is LOCKED as storage
// stake, so 0.212 is actually movable, and the first run of this spike died on
// LackBalanceForState trying to fund a sub-account from it. The probe is 993
// bytes — 0.00993 NEAR of stake — so the small change is plenty.
const PARENT = process.env.PARENT ?? "floatv4.testnet";
const PROBE = process.env.PROBE ?? "p1.floatv4.testnet";
const WASM =
  process.env.WASM ?? "contracts/signer-probe/target/wasm32-unknown-unknown/release/signer_probe.wasm";

if (/\.near$/.test(PROBE) || /\.near$/.test(PARENT)) {
  console.error("FATAL: this spike adds access keys. Testnet accounts only.");
  process.exit(2);
}

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const ok = (m) => console.log(`    ${C.g("ok")}   ${m}`);
const bad = (m) => console.log(`    ${C.r("FAIL")} ${m}`);
const info = (m) => console.log(`    ${C.d(m)}`);
const skip = (m) => console.log(`    ${C.d(`skip ${m}`)}`);

const provider = new JsonRpcProvider({ url: RPC });
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
function signerFor(account) {
  const p = credPath(account);
  if (!existsSync(p)) throw new Error(`no testnet key for ${account} at ${p}`);
  const k = JSON.parse(readFileSync(p, "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
}
const acct = (id) => new Account(id, provider, signerFor(id));

const GAS = 30n * 10n ** 12n;
const NEAR = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
const near5 = (y) => (Number(y) / 1e24).toFixed(5);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  (pass ? ok : bad)(`${name}${detail ? ` ${C.d(detail)}` : ""}`);
};

/** A view against OPTIMISTIC finality: `final` lags, and a read right after a
 *  write sees the state before it. That raced in the approval demo. */
const keyList = (id) =>
  provider.viewAccessKeyList({ accountId: id, blockQuery: { finality: "optimistic" } });

async function until(fn, tries = 10, waitMs = 500) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return false;
}

/**
 * The probe returns `"current|predecessor|signer|<pk hex>"`. Parsed here rather
 * than in the contract, because a JSON object encoder is the one thing that
 * would meaningfully grow a 993-byte binary.
 */
function parseSeen(s) {
  if (typeof s !== "string") return null;
  const [current, predecessor, signer, pkHex] = s.split("|");
  return { current, predecessor, signer, pkHex, raw: s };
}

/**
 * An ed25519 PublicKey as the host reports it: a curve-type prefix byte (0)
 * followed by the 32-byte key, hex-encoded. Derived from the keypair we
 * generated, so the comparison is against a value we chose rather than against
 * whatever the chain happened to echo back.
 */
function pkToHex(publicKey) {
  const data = publicKey.data ?? publicKey.ed25519Key?.data;
  return "00" + Buffer.from(data).toString("hex");
}

// --------------------------------------------------------------------------
step(0, "Preflight");
if (!existsSync(WASM)) throw new Error(`no probe wasm at ${WASM} — build contracts/signer-probe`);
const code = readFileSync(WASM);
info(`probe ${(code.length / 1024).toFixed(1)} KB, code stake ${near5(BigInt(code.length) * 10n ** 19n)} NEAR`);
const pState = await provider.viewAccount({ accountId: PARENT });
info(`${PARENT} holds ${near5(pState.amount)} NEAR`);

step(1, "Probe account");
let exists = true;
try {
  await provider.viewAccount({ accountId: PROBE });
} catch {
  exists = false;
}
if (exists) {
  skip(`${PROBE} already exists`);
} else {
  const key = KeyPair.fromRandom("ed25519");
  // Derived, not guessed: the code stake plus room for the key, the allowance
  // and gas. The whole point of the no_std probe is that this is small.
  const fund = BigInt(code.length) * 10n ** 19n + NEAR(0.1);
  info(`funding ${PROBE} with ${near5(fund)} NEAR (stake ${near5(BigInt(code.length) * 10n ** 19n)} + 0.1)`);
  await acct(PARENT).createSubAccount({
    accountOrPrefix: PROBE,
    publicKey: key.getPublicKey(),
    nearToTransfer: fund,
  });
  mkdirSync(dirname(credPath(PROBE)), { recursive: true });
  writeFileSync(
    credPath(PROBE),
    JSON.stringify(
      { account_id: PROBE, public_key: key.getPublicKey().toString(), private_key: key.toString() },
      null,
      2,
    ),
  );
  ok(`${PROBE} created with 1.5 NEAR`);
}

step(2, "Deploy the probe");
const deployed = await provider.viewContractCode({ contractId: PROBE }).catch(() => null);
if (deployed && Buffer.from(deployed.code_base64, "base64").equals(code)) {
  skip("the deployed code is already byte-identical");
} else {
  await acct(PROBE).deployContract(code);
  ok("deployed");
}

// ---- CONTROL. Establishes what the three env values look like for an ordinary
// full-access self-signed call, so the FC-key numbers below have something to
// be compared against rather than merely asserted about.
step(3, "CONTROL: whoami signed by the probe's own FULL-ACCESS key");
const ownCred = JSON.parse(readFileSync(credPath(PROBE), "utf8"));
const ownPkHex = pkToHex(KeyPair.fromString(ownCred.private_key).getPublicKey());
const control = parseSeen(
  await acct(PROBE).callFunction({
    contractId: PROBE,
    methodName: "whoami",
    args: {},
    gas: GAS,
    deposit: 0n,
  }),
);
info(control?.raw ?? "(no value returned)");
check("control: current_account_id is the probe", control?.current === PROBE, control?.current);
check("control: predecessor is the contract itself", control?.predecessor === PROBE, control?.predecessor);
check(
  "control: signer_account_pk is the FULL-ACCESS key that signed",
  control?.pkHex === ownPkHex,
  `${control?.pkHex} vs ${ownPkHex}`,
);

// ---- Q1
step(4, "Q1: AddKey whose FunctionCall receiver_id IS its own account");
const agent = KeyPair.fromRandom("ed25519");
const agentPk = agent.getPublicKey().toString();
const ALLOWANCE = NEAR(0.05);
let q1 = false;
try {
  await acct(PROBE).addFunctionCallAccessKey({
    publicKey: agent.getPublicKey(),
    // THE QUESTION: contractId === the account the key is being added to.
    contractId: PROBE,
    methodNames: ["whoami", "burn"],
    allowance: ALLOWANCE,
  });
  q1 = true;
} catch (e) {
  bad(`AddKey rejected: ${String(e.message).slice(0, 160)}`);
}
check("Q1: the protocol ACCEPTS a self-referencing function-call key", q1);

const present = await until(async () => (await keyList(PROBE)).keys.some((k) => k.public_key === agentPk));
check("Q1: the key is on the account", present);
const entry = (await keyList(PROBE)).keys.find((k) => k.public_key === agentPk);
info(`permission: ${JSON.stringify(entry?.access_key?.permission)}`);
const fc = entry?.access_key?.permission?.FunctionCall;
check("Q1: receiver_id is the account itself", fc?.receiver_id === PROBE, fc?.receiver_id);
check(
  "Q1: method_names is exactly what was asked for",
  JSON.stringify(fc?.method_names) === JSON.stringify(["whoami", "burn"]),
  JSON.stringify(fc?.method_names),
);

// ---- Q2 + Q3
step(5, "Q2/Q3: call signed BY THAT KEY");
const agentAcct = new Account(PROBE, provider, new KeyPairSigner(agent));
const agentPkHex = pkToHex(agent.getPublicKey());
let seen = null;
try {
  seen = parseSeen(
    await agentAcct.callFunction({
      contractId: PROBE,
      methodName: "whoami",
      args: {},
      gas: GAS,
      deposit: 0n,
    }),
  );
  info(seen?.raw ?? "(no value returned)");
} catch (e) {
  bad(`call rejected: ${String(e.message).slice(0, 200)}`);
}
check("Q2: the restricted key CAN sign a call to its own account", seen != null);
check("Q3: predecessor is the vault/contract itself, NOT the agent", seen?.predecessor === PROBE);
check("Q3: signer_account_id is also the contract", seen?.signer === PROBE);
check(
  "Q3: signer_account_pk IS the agent's key — the whole design rests on this",
  seen?.pkHex === agentPkHex,
  `${seen?.pkHex} vs ${agentPkHex}`,
);
check(
  "Q3: and it DIFFERS from the full-access key, so agents are distinguishable",
  seen != null && seen.pkHex !== ownPkHex,
);

// ---- Q2, the money half
step(6, "Q2: does the gas come out of the KEY's allowance?");
const allowBefore = BigInt((await keyList(PROBE)).keys.find((k) => k.public_key === agentPk).access_key.permission.FunctionCall.allowance);
const balBefore = BigInt((await provider.viewAccount({ accountId: PROBE })).amount);
await agentAcct.callFunction({ contractId: PROBE, methodName: "burn", args: {}, gas: GAS, deposit: 0n });
await until(async () => {
  const a = BigInt((await keyList(PROBE)).keys.find((k) => k.public_key === agentPk).access_key.permission.FunctionCall.allowance);
  return a !== allowBefore;
});
const allowAfter = BigInt((await keyList(PROBE)).keys.find((k) => k.public_key === agentPk).access_key.permission.FunctionCall.allowance);
const balAfter = BigInt((await provider.viewAccount({ accountId: PROBE })).amount);
info(`allowance ${near5(allowBefore)} -> ${near5(allowAfter)}   (spent ${near5(allowBefore - allowAfter)})`);
info(`balance   ${near5(balBefore)} -> ${near5(balAfter)}   (delta ${near5(balAfter - balBefore)})`);
check("Q2: the allowance DECREASED — the key paid", allowAfter < allowBefore);
info(
  `a 0.05 allowance buys ~${Math.floor(Number(ALLOWANCE) / Number(allowBefore - allowAfter))} calls of this size`,
);

// ---- the restrictions must actually hold, or the key is not a budget
step(7, "The restriction is real, not decorative");
let depositRejected = false;
try {
  await agentAcct.callFunction({ contractId: PROBE, methodName: "whoami", args: {}, gas: GAS, deposit: 1n });
} catch (e) {
  depositRejected = /deposit|NotEnoughAllowance|RequiresFullAccess/i.test(e.message);
  info(`deposit attempt: ${String(e.message).slice(0, 120)}`);
}
check("a function-call key cannot attach a deposit", depositRejected);

let otherReceiverRejected = false;
try {
  await agentAcct.callFunction({
    contractId: "ft.floatv4.testnet",
    methodName: "whoami",
    args: {},
    gas: GAS,
    deposit: 0n,
  });
} catch (e) {
  otherReceiverRejected = /receiver|InvalidAccessKeyError|not allowed/i.test(e.message);
  info(`other-receiver attempt: ${String(e.message).slice(0, 120)}`);
}
check("the key cannot call a DIFFERENT contract", otherReceiverRejected);

let otherMethodRejected = false;
try {
  await agentAcct.callFunction({ contractId: PROBE, methodName: "get_calls", args: {}, gas: GAS, deposit: 0n });
} catch (e) {
  otherMethodRejected = /method|MethodNameMismatch|not allowed/i.test(e.message);
  info(`unlisted-method attempt: ${String(e.message).slice(0, 120)}`);
}
check("the key cannot call a method outside method_names", otherMethodRejected);

// --------------------------------------------------------------------------
const passed = results.filter((r) => r.pass).length;
console.log(`\n${C.b(`${passed}/${results.length}`)} checks passed`);
for (const r of results.filter((r) => !r.pass)) console.log(`  ${C.r("FAIL")} ${r.name}`);
process.exitCode = passed === results.length ? 0 : 1;
