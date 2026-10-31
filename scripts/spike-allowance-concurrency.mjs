#!/usr/bin/env node
/**
 * Do two agents on ONE vault contend for the gas reservation?
 *
 * WHY. spike-min-allowance.mjs found that a function-call key's allowance must
 * be >= a RESERVATION of roughly `prepaid_gas * 1e9` — ten times the current
 * gas price — even though the call actually burns 250x less. At the 100 TGas
 * the MCP server sends, that is ~0.1 NEAR per key.
 *
 * Left open, and flagged as load-bearing in the spike write-up: is that
 * reservation taken against the KEY's allowance only, or against the vault's
 * free BALANCE as well? The answer decides the per-vault cost of the whole
 * no-relayer design:
 *
 *   allowance only  -> an allowance is a LIMIT, not funds. N agents cost N key
 *                      storages (~0.0001 each) and the vault needs only enough
 *                      free NEAR for gas actually burnt. "One vault, many
 *                      agents" is nearly free.
 *   balance too     -> N concurrent agents need N x reservation of FREE NEAR.
 *                      At 100 TGas that is 0.1 per agent in flight, the vault's
 *                      storage margin is the ceiling on agent concurrency, and
 *                      under global contracts — where the vault deliberately
 *                      holds almost no NEAR — it is a hard wall.
 *
 * THE DISCRIMINATOR IS THIS ACCOUNT'S BALANCE, which is why it is not topped
 * up. Measured: free = 0.093920 NEAR.
 *
 *   one 50 TGas reservation  ~0.05   FITS
 *   two 50 TGas reservations ~0.10   DOES NOT FIT in 0.0939
 *   one 100 TGas reservation ~0.10   DOES NOT FIT either
 *
 * So the same account answers both questions without funding games.
 *
 * ---- RULE 6: a race that serialises proves nothing.
 *
 * Both transactions are PRE-SIGNED and then broadcast with
 * `sendTransactionAsync` back to back without awaiting, so both are in flight
 * before either resolves. A test that merely fires two promises may serialise
 * and report success for the wrong reason. The block hash of each outcome is
 * read afterwards and compared: if they landed in different blocks, the race
 * was NOT exercised and this run says so rather than claiming a pass.
 *
 * The SEQUENTIAL control runs first. If two calls one-at-a-time do not both
 * succeed, a concurrent failure means nothing — it would just be a shortage.
 *
 * Usage:
 *   node scripts/spike-allowance-concurrency.mjs
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

const provider = new JsonRpcProvider({ url: RPC });
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
const own = JSON.parse(readFileSync(credPath(PROBE), "utf8"));
const owner = new Account(PROBE, provider, new KeyPairSigner(KeyPair.fromString(own.private_key)));

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

const near = (y) => (Number(y) / 1e24).toFixed(6);
const TG = 10n ** 12n;
const NEARy = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const keyList = () =>
  provider.viewAccessKeyList({ accountId: PROBE, blockQuery: { finality: "final" } });
const present = async (pk) => (await keyList()).keys.some((k) => k.public_key === pk);
async function freeBalance() {
  const s = await provider.viewAccount({ accountId: PROBE, blockQuery: { finality: "final" } });
  return BigInt(s.amount) - BigInt(s.storage_usage) * 10n ** 19n;
}

/**
 * Wait until the account's free balance is at least `want`.
 *
 * NEEDED BECAUSE AWAITING A TRANSACTION IS NOT AWAITING ITS REFUND. The gas
 * reservation is released by a separate refund receipt that settles after the
 * call's own outcome is available. The first version of the sequential control
 * below ran agent 2 immediately after awaiting agent 1 and agent 2 failed with
 * `lacks balance 10867665195774600000000` — 0.01087 NEAR, which is exactly
 * agent 1's outstanding 0.05 reservation against 0.0917 of free balance. The
 * control was not sequential in the only sense that matters, so a concurrent
 * failure could not have been attributed to concurrency.
 */
async function waitForFree(want, tries = 40, waitMs = 500) {
  let last = 0n;
  for (let i = 0; i < tries; i++) {
    last = await freeBalance();
    if (last >= want) return last;
    await wait(waitMs);
  }
  return last;
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  (pass ? ok : bad)(`${name}${detail ? ` ${C.d(detail)}` : ""}`);
};

/** Classify a failure, because the two causes have opposite implications. */
function classify(msg) {
  if (/NotEnoughAllowance|Not enough allowance/i.test(msg)) return "allowance";
  if (/LackBalanceForState|lacks balance|NotEnoughBalance/i.test(msg)) return "balance";
  return "other";
}

async function addKey(allowanceNear, methods = ["whoami"]) {
  const kp = KeyPair.fromRandom("ed25519");
  await owner.addFunctionCallAccessKey({
    publicKey: kp.getPublicKey(),
    contractId: PROBE,
    methodNames: methods,
    allowance: NEARy(allowanceNear),
  });
  for (let i = 0; i < 15 && !(await present(kp.getPublicKey().toString())); i++) await wait(400);
  return kp;
}

const callAction = (tgas) => ({
  functionCall: {
    methodName: "whoami",
    args: new Uint8Array(Buffer.from("{}")),
    gas: BigInt(tgas) * TG,
    deposit: 0n,
  },
});

// --------------------------------------------------------------------------
// Optional top-up. The first two runs of this spike were unmeasurable because
// the probe sat within 0.0014 NEAR of its own threshold: agent 1 succeeded at
// 0.091908 of free balance and agent 2 failed at 0.090515, so every reading was
// dominated by edge effects and a partially-settled refund. A measurement taken
// at the edge of the thing being measured is not a measurement.
if (process.env.FUND) {
  const parent = process.env.FUND_FROM ?? "v4.floatv4.testnet";
  const amount = NEARy(Number(process.env.FUND));
  const ps = await provider.viewAccount({ accountId: parent, blockQuery: { finality: "final" } });
  const pFree = BigInt(ps.amount) - BigInt(ps.storage_usage) * 10n ** 19n;
  if (pFree <= amount + NEARy(0.05)) {
    console.error(`FATAL: ${parent} has only ${near(pFree)} free, cannot send ${near(amount)}`);
    process.exit(2);
  }
  const pk = JSON.parse(readFileSync(credPath(parent), "utf8"));
  const pAcct = new Account(parent, provider, new KeyPairSigner(KeyPair.fromString(pk.private_key)));
  await pAcct.transfer({ receiverId: PROBE, amount });
  console.log(`topped up ${PROBE} with ${near(amount)} NEAR from ${parent}`);
}

step(0, "Preflight");
const free0 = await freeBalance();
info(`${PROBE} free balance ${near(free0)} NEAR`);
const gasPrice = BigInt((await provider.viewGasPrice()).gas_price);
const reserve = (tgas) => BigInt(tgas) * TG * gasPrice * 10n; // measured: ~10x current price
info(`gas price ${gasPrice}; reservation estimate 50 TGas=${near(reserve(50))} 100 TGas=${near(reserve(100))}`);
info(
  `at ${near(free0)} free, ~${Math.floor(Number(free0) / Number(reserve(100)))} concurrent ` +
    `100 TGas calls would fit if each needs a full reservation`,
);

// ---- A0: is an allowance BACKED by balance at AddKey time?
step("A0", "Can a key be given an allowance far above the account's free balance?");
let a0 = null;
try {
  const kp = await addKey(1.0); // 1.0 NEAR allowance against 0.094 free
  const e = (await keyList()).keys.find((k) => k.public_key === kp.getPublicKey().toString());
  a0 = e?.access_key?.permission?.FunctionCall?.allowance;
  info(`allowance recorded: ${near(BigInt(a0))} NEAR, against ${near(free0)} free`);
  await owner.deleteKey(kp.getPublicKey()).catch(() => {});
} catch (e) {
  info(`AddKey failed: ${String(e.message).slice(0, 90)}`);
}
check(
  "A0: an allowance is a LIMIT, not a deposit — it need not be funded",
  a0 != null && BigInt(a0) === NEARy(1.0),
);

// ---- A: does the ACCOUNT's free balance bind the reservation?
step("A", "One 100 TGas call, ample allowance, free balance BELOW the reservation");
const keyA = await addKey(0.15);
const agentA = new Account(PROBE, provider, new KeyPairSigner(keyA));
let aResult;
try {
  await agentA.signAndSendTransaction({ receiverId: PROBE, actions: [callAction(100)] });
  aResult = { ok: true };
} catch (e) {
  aResult = { ok: false, kind: classify(e.message), msg: String(e.message).slice(0, 110) };
  info(`${aResult.kind}: ${aResult.msg}`);
}
if (aResult.ok) {
  ok("the call EXECUTED");
  info("=> the reservation is checked against the ALLOWANCE only, not the balance");
} else {
  info(`=> the call was refused (${aResult.kind})`);
}
results.push({ name: "A: recorded whether balance binds", pass: true });
const balanceBinds = !aResult.ok && aResult.kind === "balance";
await owner.deleteKey(keyA.getPublicKey()).catch(() => {});

// ---- B: the SEQUENTIAL control. Must pass or C means nothing.
step("B", "CONTROL: two keys, two 50 TGas calls, ONE AT A TIME");
const k1 = await addKey(0.06);
const k2 = await addKey(0.06);
const ag1 = new Account(PROBE, provider, new KeyPairSigner(k1));
const ag2 = new Account(PROBE, provider, new KeyPairSigner(k2));
const seq = [];
for (const [i, ag] of [ag1, ag2].entries()) {
  // Wait for the PREVIOUS call's reservation to be refunded before starting
  // this one. Without this the control is not sequential — see waitForFree.
  const beforeFree = await waitForFree(reserve(50) + NEARy(0.005));
  info(`agent ${i + 1}: free balance ${near(beforeFree)} before submitting`);
  try {
    await ag.signAndSendTransaction({ receiverId: PROBE, actions: [callAction(50)] });
    seq.push({ i, ok: true });
  } catch (e) {
    seq.push({ i, ok: false, kind: classify(e.message), msg: String(e.message).slice(0, 100) });
  }
}
for (const s of seq) info(`agent ${s.i + 1}: ${s.ok ? "executed" : `${s.kind} — ${s.msg}`}`);
const controlOk = seq.every((s) => s.ok);
check("B: both succeed SEQUENTIALLY — so any concurrent failure is a race", controlOk);

await owner.deleteKey(k1.getPublicKey()).catch(() => {});
await owner.deleteKey(k2.getPublicKey()).catch(() => {});

// ---- C: N agents at once, swept, to find where it breaks.
//
// WHY A SWEEP RATHER THAN A PAIR. Two concurrent calls on a well-funded account
// simply both succeed, which says nothing about contention — it says the
// account was rich. The useful number is the per-call requirement, and that is
// found by increasing N until it breaks.
//
// WHY `sendTransaction` AND NOT `sendTransactionAsync`. The previous version of
// this step used sendTransactionAsync for "genuine" concurrency and then could
// not read the outcomes: it returns `{final_execution_status: "NONE"}` with no
// transaction hash, so the hash extraction produced undefined, every status
// lookup came back empty, and BOTH calls were recorded as failed. The script
// then printed "contention observed" and a bolded INTERPRETATION claiming N
// agents need N reservations — a confident conclusion resting entirely on a
// broken lookup of my own. `sendTransaction` blocks server-side until executed
// and returns the full outcome; firing several without awaiting individually
// still puts them all in flight, and the block hashes prove whether the overlap
// was real.
step("C", "CONCURRENT: N agents at once, 100 TGas each, sweeping N");
if (!controlOk) {
  warn("skipped — the sequential control did not pass, so this could not be attributed");
} else {
  const per = reserve(100);
  for (const n of (process.env.NS ?? "2,4,8").split(",").map(Number)) {
    const freeNow = await waitForFree(per + NEARy(0.01));
    info(`\n  N=${n}: free ${near(freeNow)}, ${near(per)} per call if each needs a full reservation`);

    // One key per agent, each with allowance above the 100 TGas reservation.
    const kps = [];
    for (let i = 0; i < n; i++) kps.push(await addKey(0.2));
    const accts = kps.map((kp) => new Account(PROBE, provider, new KeyPairSigner(kp)));

    // Pre-sign everything, so no signing round trip happens inside the race.
    const txs = await Promise.all(
      accts.map((a) => a.createSignedTransaction({ receiverId: PROBE, actions: [callAction(100)] })),
    );
    const settled = await Promise.allSettled(txs.map((t) => provider.sendTransaction(t)));

    const blocks = new Set();
    let okCount = 0;
    const kinds = {};
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        const failure =
          s.value?.status?.Failure ??
          (s.value?.receipts_outcome ?? []).find((r) => r.outcome?.status?.Failure);
        if (failure) {
          const k = classify(JSON.stringify(failure));
          kinds[k] = (kinds[k] ?? 0) + 1;
        } else {
          okCount++;
          if (s.value?.transaction_outcome?.block_hash) blocks.add(s.value.transaction_outcome.block_hash);
        }
      } else {
        const k = classify(s.reason?.message ?? "");
        kinds[k] = (kinds[k] ?? 0) + 1;
        // NOT truncated. The balance and cost in this message are the whole
        // result — the per-call reservation is read off it, and slicing to 100
        // chars cut the cost figure in half on the first run.
        if (k === "other") {
          const m = String(s.reason?.message ?? "");
          const nums = [...m.matchAll(/(\d{15,})/g)].map((x) => BigInt(x[1]));
          info(`    agent ${i + 1}: ${m.replace(/\s+/g, " ")}`);
          if (nums.length >= 2) {
            info(`      balance ${near(nums[0])} NEAR, cost ${near(nums[1])} NEAR  <- per-call reservation`);
          }
        }
      }
    });
    info(
      `    ${okCount}/${n} executed` +
        (Object.keys(kinds).length ? `, failures: ${JSON.stringify(kinds)}` : "") +
        `, distinct blocks: ${blocks.size}`,
    );
    if (blocks.size === 1 && okCount > 1) {
      info(`    ${okCount} landed in ONE block — the overlap was real, not serialised`);
    } else if (okCount > 1) {
      warn(`    spread over ${blocks.size} blocks, so the overlap was partial`);
    }
    results.push({ name: `C: N=${n} -> ${okCount}/${n} executed`, pass: true });

    for (const kp of kps) await owner.deleteKey(kp.getPublicKey()).catch(() => {});
  }
}

step("Z", "Summary");
info(`A: the account's free balance ${balanceBinds ? "DOES" : "does NOT"} bind the reservation`);
info(`free balance now ${near(await freeBalance())} NEAR`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${C.b(`${passed}/${results.length}`)} checks passed`);
for (const r of results.filter((r) => !r.pass)) console.log(`  ${C.r("FAIL")} ${r.name}`);
process.exitCode = passed === results.length ? 0 : 1;
