#!/usr/bin/env node
/**
 * NEP-611 GAS KEYS: can an agent hold a key on the vault with its OWN gas
 * balance — no sub-account, no relayer, and recoverable?
 *
 * WHY THIS MATTERS MORE THAN THE LAST TWO SPIKES. Float has three ways to let
 * an agent pay, and all three had a defect:
 *
 *   (a) agent sub-account        0.55 NEAR each, and STRANDED: its only key is
 *                                function-call, which cannot sign DeleteAccount
 *                                (10.7752 NEAR already stuck across 18 agents).
 *   (b) plain fn-call key on the
 *       vault                    no sub-account, but gas comes from the VAULT's
 *                                free balance, so agents CONTEND — measured at
 *                                0.100919 NEAR per in-flight 100 TGas call, and
 *                                the vault's free balance becomes the ceiling
 *                                on simultaneous payments.
 *   (c) virtual agent + relayer  nothing per agent, but someone must run and
 *                                fund a relayer.
 *
 * A gas key looks like it fixes (a) and (b) at once: a key with its OWN NEAR
 * balance, fundable by anyone, WITHDRAWABLE back to the account, and carrying up
 * to 1024 independent nonce lanes. Live on mainnet at protocol version 86 —
 * which is the version this repo measured off mainnet on 2026-10-31.
 *
 * Five questions, each of which would change the architecture:
 *
 *   Q1  Can a FUNCTION-CALL gas key be added to an account, restricted to one
 *       method on itself?
 *   Q2  Does the GAS KEY's own balance pay for the call, rather than the
 *       account's? This is what removes the contention ceiling.
 *   Q3  Is `signer_account_pk()` still the agent's key, so the contract can
 *       tell agents apart? Everything depends on this; `predecessor` will be
 *       the vault.
 *   Q4  Is the balance WITHDRAWABLE? This is what removes the stranding.
 *   Q5  Do two gas keys on one account contend for the account's free balance?
 *
 * Driven against the 1,081-byte no_std probe from spike-self-fc-key.mjs, so
 * nothing sits between the measurement and the protocol.
 *
 * Usage:
 *   node scripts/spike-gas-key.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const PROBE = process.env.PROBE ?? "p1.floatv4.testnet";
if (/\.near$/.test(PROBE)) {
  console.error("FATAL: testnet only.");
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
const ok = (m) => console.log(`    ${C.g("ok")}   ${m}`);
const bad = (m) => console.log(`    ${C.r("FAIL")} ${m}`);
const warn = (m) => console.log(`    ${C.y("warn")} ${m}`);
const info = (m) => console.log(`    ${C.d(m)}`);

const provider = new JsonRpcProvider({ url: RPC });
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
const own = JSON.parse(readFileSync(credPath(PROBE), "utf8"));
const owner = new Account(PROBE, provider, new KeyPairSigner(KeyPair.fromString(own.private_key)));

const near = (y) => (Number(y) / 1e24).toFixed(6);
const TG = 10n ** 12n;
const TGAS = BigInt(process.env.TGAS ?? 30);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  (pass ? ok : bad)(`${name}${detail ? ` ${C.d(detail)}` : ""}`);
};

const keyList = () =>
  provider.viewAccessKeyList({ accountId: PROBE, blockQuery: { finality: "final" } });
const entryFor = async (pk) => (await keyList()).keys.find((k) => k.public_key === pk);
async function accountFree() {
  const s = await provider.viewAccount({ accountId: PROBE, blockQuery: { finality: "final" } });
  return BigInt(s.amount) - BigInt(s.storage_usage) * 10n ** 19n;
}
/**
 * A gas key's own balance.
 *
 * The field sits at the TOP level of the permission variant, not nested in a
 * `gas_key_info` object as near-api-js's TypeScript shape suggested:
 *
 *   {"GasKeyFunctionCall":{"allowance":null,"balance":"0",
 *     "method_names":["whoami"],"num_nonces":4,"receiver_id":"..."}}
 *
 * The first version of this function read `GasKeyFunctionCall.gas_key_info
 * .balance`, got undefined, and returned null — which the checks then rendered
 * as five FAILURES against the protocol. Four of the five were this function.
 * The giveaway was the permission dump printed beside them, which showed
 * `balance:"0"` plainly: the probe had the answer on screen and the parser
 * reported not finding it.
 */
function gasBalanceOf(entry) {
  const p = entry?.access_key?.permission;
  if (!p || typeof p !== "object") return null;
  const v = p.GasKeyFunctionCall ?? p.GasKeyFullAccess ?? p;
  return v?.balance !== undefined ? BigInt(v.balance) : null;
}
const parseSeen = (s) => {
  if (typeof s !== "string") return null;
  const [current, predecessor, signer, pkHex] = s.split("|");
  return { current, predecessor, signer, pkHex, raw: s };
};
const pkToHex = (publicKey) => "00" + Buffer.from(publicKey.data).toString("hex");

// --------------------------------------------------------------------------
step(0, "Preflight");
const proto = (await provider.viewNodeStatus()).protocol_version;
info(`protocol_version ${proto} (gas keys are NEP-611, live from 86)`);
check("the chain is new enough for gas keys", proto >= 86, `${proto} >= 86`);
info(`${PROBE} free ${near(await accountFree())} NEAR, prepaid ${TGAS} TGas`);

// ---- Q1
step("Q1", "Add a FUNCTION-CALL GAS KEY restricted to one method on this account");
const agent = KeyPair.fromRandom("ed25519");
const agentPk = agent.getPublicKey().toString();
let added = false;
try {
  await owner.addFunctionCallGasKey({
    publicKey: agent.getPublicKey(),
    contractId: PROBE,
    methodNames: ["whoami"],
    numNonces: 4, // more than one lane, to see the field populated
  });
  added = true;
} catch (e) {
  bad(`addFunctionCallGasKey rejected: ${String(e.message).slice(0, 200)}`);
}
check("Q1: the protocol accepts a function-call GAS key", added);
for (let i = 0; i < 15 && !(await entryFor(agentPk)); i++) await wait(400);
const e1 = await entryFor(agentPk);
info(`permission: ${JSON.stringify(e1?.access_key?.permission)}`);
const bal0 = gasBalanceOf(e1);
check("Q1: it is on the account", Boolean(e1));
check(
  "Q1: its own balance starts at ZERO, per the docs",
  bal0 === 0n,
  bal0 === null ? "balance field not found — see the permission dump above" : near(bal0),
);

// ---- Q4a: fund it
step("Q4a", "Fund the gas key's OWN balance with transferToGasKey");
const FUND = 15n * 10n ** 22n; // 0.15 NEAR — above the ~0.1009 reservation at 100 TGas
const freeBeforeFund = await accountFree();
let funded = false;
try {
  await owner.transferToGasKey(PROBE, agent.getPublicKey(), FUND);
  funded = true;
} catch (e) {
  bad(`transferToGasKey rejected: ${String(e.message).slice(0, 200)}`);
}
for (let i = 0; i < 20; i++) {
  const b = gasBalanceOf(await entryFor(agentPk));
  if (b && b > 0n) break;
  await wait(500);
}
const balFunded = gasBalanceOf(await entryFor(agentPk));
const freeAfterFund = await accountFree();
info(`gas key balance ${near(balFunded ?? 0n)}   account free ${near(freeBeforeFund)} -> ${near(freeAfterFund)}`);
check("Q4a: the gas key now holds its own balance", funded && balFunded === FUND, near(balFunded ?? 0n));
check(
  "Q4a: the NEAR came OUT of the account's balance",
  freeAfterFund < freeBeforeFund,
  `delta ${near(freeAfterFund - freeBeforeFund)}`,
);

// ---- Q2 + Q3
step("Q2/Q3", "Call with the gas key: whose balance pays, and what does the contract see?");
const agentAcct = new Account(PROBE, provider, new KeyPairSigner(agent));
const gasBefore = gasBalanceOf(await entryFor(agentPk));
const freeBeforeCall = await accountFree();
let seen = null;
try {
  seen = parseSeen(
    await agentAcct.callFunction({
      contractId: PROBE,
      methodName: "whoami",
      args: {},
      gas: TGAS * TG,
      deposit: 0n,
    }),
  );
  info(seen?.raw ?? "(no value)");
} catch (e) {
  bad(`call failed: ${String(e.message).slice(0, 200)}`);
}
check("Q2: a gas key can sign a call to its own account", seen != null);
check(
  "Q3: signer_account_pk IS the agent's key — agents stay distinguishable",
  seen?.pkHex === pkToHex(agent.getPublicKey()),
  `${seen?.pkHex} vs ${pkToHex(agent.getPublicKey())}`,
);
check("Q3: predecessor is still the vault itself", seen?.predecessor === PROBE);

for (let i = 0; i < 20; i++) {
  const b = gasBalanceOf(await entryFor(agentPk));
  if (b !== gasBefore) break;
  await wait(500);
}
const gasAfter = gasBalanceOf(await entryFor(agentPk));
const freeAfterCall = await accountFree();
info(`gas key   ${near(gasBefore ?? 0n)} -> ${near(gasAfter ?? 0n)}   (delta ${near((gasAfter ?? 0n) - (gasBefore ?? 0n))})`);
info(`acct free ${near(freeBeforeCall)} -> ${near(freeAfterCall)}   (delta ${near(freeAfterCall - freeBeforeCall)})`);
const gasKeyPaid = gasAfter !== null && gasBefore !== null && gasAfter < gasBefore;
const accountUntouched = freeAfterCall >= freeBeforeCall - 10n ** 20n; // within 0.0001
check("Q2: the GAS KEY's own balance paid for the call", gasKeyPaid);
check(
  "Q2: the ACCOUNT's free balance was not drawn down — no contention ceiling",
  gasKeyPaid && accountUntouched,
  `account delta ${near(freeAfterCall - freeBeforeCall)}`,
);

// ---- Q4b: withdraw it back
step("Q4b", "Withdraw the gas key's balance back to the account");
const gasPre = gasBalanceOf(await entryFor(agentPk)) ?? 0n;
const freePre = await accountFree();
let withdrew = false;
try {
  await owner.withdrawFromGasKey(agent.getPublicKey(), gasPre);
  withdrew = true;
} catch (e) {
  bad(`withdrawFromGasKey rejected: ${String(e.message).slice(0, 200)}`);
}
for (let i = 0; i < 20; i++) {
  const b = gasBalanceOf(await entryFor(agentPk));
  if (b !== gasPre) break;
  await wait(500);
}
const gasPost = gasBalanceOf(await entryFor(agentPk));
const freePost = await accountFree();
info(`gas key   ${near(gasPre)} -> ${near(gasPost ?? 0n)}`);
info(`acct free ${near(freePre)} -> ${near(freePost)}   (recovered ${near(freePost - freePre)})`);
check(
  "Q4b: RECOVERABLE — the float comes back, unlike a sub-account's 0.55",
  withdrew && gasPost === 0n && freePost > freePre,
  `recovered ${near(freePost - freePre)}`,
);

// ---- Q5: two gas keys, concurrently
step("Q5", "Two gas keys, an account too thin to cover even ONE reservation");
// THE DISCRIMINATOR, and the first version of this step did not have one: it
// fired two 30 TGas calls while the account held 0.230 free, which comfortably
// covers two 0.031 reservations. Both succeeding proved nothing.
//
// The fix is elegant because funding a gas key DRAINS the account: move most of
// the account's free balance into the two keys, and the account is left below a
// single reservation while both keys are fat. If both calls then execute, the
// gas keys paid — there is nowhere else the money could have come from.
const freeNow = await accountFree();
const perKey = (freeNow * 40n) / 100n; // 40% each, leaving ~20% in the account
const reservation30 = 30n * TG * 10n ** 9n;
info(`account free ${near(freeNow)}; funding each key ${near(perKey)}`);
info(`a 30 TGas reservation is ~${near(reservation30)}, so the account will be left unable to cover one`);
const pair = [];
for (let i = 0; i < 2; i++) {
  const kp = KeyPair.fromRandom("ed25519");
  await owner.addFunctionCallGasKey({
    publicKey: kp.getPublicKey(),
    contractId: PROBE,
    methodNames: ["whoami"],
    numNonces: 1,
  });
  for (let t = 0; t < 15 && !(await entryFor(kp.getPublicKey().toString())); t++) await wait(400);
  pair.push(kp);
}
for (const kp of pair) {
  await owner.transferToGasKey(PROBE, kp.getPublicKey(), perKey).catch((e) => {
    warn(`could not fund a gas key: ${String(e.message).slice(0, 90)}`);
  });
}
await wait(2000);
const freeThin = await accountFree();
info(`account free is now ${near(freeThin)}`);
check(
  "Q5 setup: the account genuinely cannot cover one 30 TGas reservation",
  freeThin < reservation30,
  `${near(freeThin)} < ${near(reservation30)}`,
);
for (const kp of pair) {
  const b = gasBalanceOf(await entryFor(kp.getPublicKey().toString()));
  info(`  gas key ${kp.getPublicKey().toString().slice(0, 20)}… holds ${near(b ?? 0n)}`);
}
const accts = pair.map((kp) => new Account(PROBE, provider, new KeyPairSigner(kp)));
const txs = await Promise.all(
  accts.map((a) =>
    a.createSignedTransaction({
      receiverId: PROBE,
      actions: [
        {
          functionCall: {
            methodName: "whoami",
            args: new Uint8Array(Buffer.from("{}")),
            gas: 30n * TG,
            deposit: 0n,
          },
        },
      ],
    }),
  ),
);
const settled = await Promise.allSettled(txs.map((t) => provider.sendTransaction(t)));
let okCount = 0;
const blocks = new Set();
settled.forEach((s, i) => {
  if (s.status === "fulfilled" && !s.value?.status?.Failure) {
    okCount++;
    if (s.value?.transaction_outcome?.block_hash) blocks.add(s.value.transaction_outcome.block_hash);
  } else {
    const m = s.status === "rejected" ? String(s.reason?.message) : JSON.stringify(s.value?.status);
    info(`  agent ${i + 1} failed: ${m.slice(0, 140)}`);
  }
});
info(`${okCount}/2 executed, distinct blocks ${blocks.size}`);
check(
  "Q5: both paid from their own gas balances despite a thin account",
  okCount === 2,
  okCount === 2 ? "no contention" : "contention observed",
);

for (const kp of pair) {
  const b = gasBalanceOf(await entryFor(kp.getPublicKey().toString()));
  if (b && b > 0n) await owner.withdrawFromGasKey(kp.getPublicKey(), b).catch(() => {});
  await owner.deleteKey(kp.getPublicKey()).catch(() => {});
}
await owner.deleteKey(agent.getPublicKey()).catch(() => {});

step("Z", "Summary");
const passed = results.filter((r) => r.pass).length;
console.log(`\n${C.b(`${passed}/${results.length}`)} checks passed`);
for (const r of results.filter((r) => !r.pass)) console.log(`  ${C.r("FAIL")} ${r.name}`);
info(`account free now ${near(await accountFree())}`);
process.exitCode = passed === results.length ? 0 : 1;
