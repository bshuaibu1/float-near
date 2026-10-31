#!/usr/bin/env node
/**
 * At what rate does a function-call key's ALLOWANCE actually drain?
 *
 * WHY THIS IS A SEPARATE MEASUREMENT. The first spike proved the design works
 * (16/16) and then printed a number that did not fit the story: one `burn` call
 * cost 0.031 NEAR of allowance while the account's BALANCE went UP by 0.030.
 * If the allowance is charged for PREPAID gas and the unused-gas refund is
 * returned to the account balance rather than to the key, then a 0.05 NEAR
 * allowance buys a couple of calls, not hundreds — and the cost argument for
 * this design collapses from "0.05 instead of 0.55" to "0.05 per handful".
 *
 * That is the difference between a recommendation and a retraction, so it is
 * measured.
 *
 * ---- WHY THE FIRST VERSION OF THIS FILE WAS WRONG.
 *
 * It created a FRESH key per data point and deleted the previous one, inside
 * the same window as the balance readings. AddKey costs storage, DeleteKey
 * refunds it, and both landed between `b0` and `b1`. Two of four rows came back
 * clean (allowance spent == tokens_burnt, ratio 1.00) and two were garbage
 * (ratio 88), and the garbage was my instrument, not the protocol.
 *
 * So this version uses ONE key and makes N identical calls back to back, with
 * no account mutation in between. Nothing moves except the call being measured.
 *
 * Reading it:
 *   spent == tokens_burnt per call  -> the allowance tracks REAL usage. Sizing
 *                                      it is straightforward and the design's
 *                                      cost story holds.
 *   spent ~= prepaid * gas_price    -> charged up front, refund goes to the
 *                                      BALANCE, and prepaid gas must be tuned
 *                                      per call or the allowance evaporates.
 *
 * Usage:
 *   node scripts/spike-allowance-rate.mjs
 *   CALLS=6 TGAS=30 node scripts/spike-allowance-rate.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const PROBE = process.env.PROBE ?? "p1.floatv4.testnet";
const CALLS = Number(process.env.CALLS ?? 5);
const TGAS = BigInt(process.env.TGAS ?? 30);
if (/\.near$/.test(PROBE)) {
  console.error("FATAL: testnet only.");
  process.exit(2);
}

const provider = new JsonRpcProvider({ url: RPC });
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
const own = JSON.parse(readFileSync(credPath(PROBE), "utf8"));
const ownerAcct = new Account(PROBE, provider, new KeyPairSigner(KeyPair.fromString(own.private_key)));

const near = (y) => (Number(y) / 1e24).toFixed(6);
const TG = 10n ** 12n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const keys = () =>
  // FINAL, not optimistic. Optimistic reads caught an un-settled intermediate
  // state: the first call of a run reported 0.030919 of allowance spent against
  // 0.000124 actually burnt, and the same 0.030919 then showed up in the
  // BALANCE delta three calls later. The figure was sloshing between two reads
  // of a chain that had not settled, not being spent.
  provider.viewAccessKeyList({ accountId: PROBE, blockQuery: { finality: "final" } });
async function allowanceOf(pk) {
  const k = (await keys()).keys.find((x) => x.public_key === pk);
  const fc = k?.access_key?.permission?.FunctionCall;
  return fc ? BigInt(fc.allowance) : null;
}
const balance = async () =>
  BigInt(
    (await provider.viewAccount({ accountId: PROBE, blockQuery: { finality: "final" } })).amount,
  );

const gasPrice = BigInt((await provider.viewGasPrice()).gas_price);
console.log(`probe        ${PROBE}`);
console.log(`gas price    ${gasPrice} yocto/gas`);
console.log(`prepaid      ${TGAS} TGas  ->  worth ${near(TGAS * TG * gasPrice)} NEAR if charged up front`);
console.log(`balance      ${near(await balance())} NEAR`);

// Tidy up keys left by the earlier, contaminated version of this script, so the
// account is not carrying storage for abandoned data points.
const stale = (await keys()).keys.filter(
  (k) => k.access_key?.permission?.FunctionCall && k.public_key !== own.public_key,
);
if (stale.length) {
  console.log(`\ncleaning up ${stale.length} leftover function-call key(s)`);
  for (const k of stale) {
    await ownerAcct.deleteKey(k.public_key).catch((e) => console.log(`  skip ${k.public_key}: ${e.message.slice(0, 60)}`));
  }
}

// ONE key. Added before any measurement, deleted after all of them.
const kp = KeyPair.fromRandom("ed25519");
const pk = kp.getPublicKey().toString();
const START = 15n * 10n ** 22n; // 0.15 NEAR
await ownerAcct.addFunctionCallAccessKey({
  publicKey: kp.getPublicKey(),
  contractId: PROBE,
  methodNames: ["whoami"],
  allowance: START,
});
for (let i = 0; i < 15 && (await allowanceOf(pk)) === null; i++) await wait(400);
console.log(`\none key, allowance ${near(await allowanceOf(pk))} NEAR, ${CALLS} identical calls\n`);

const agent = new Account(PROBE, provider, new KeyPairSigner(kp));
console.log("call | allowance after | spent this call |      tokens_burnt | balance delta | spent/burnt");
console.log("-----|-----------------|-----------------|-------------------|---------------|------------");

let prev = await allowanceOf(pk);
const rows = [];
for (let i = 1; i <= CALLS; i++) {
  const b0 = await balance();
  const res = await agent.signAndSendTransaction({
    receiverId: PROBE,
    actions: [
      {
        functionCall: {
          methodName: "whoami",
          args: new Uint8Array(Buffer.from("{}")),
          gas: TGAS * TG,
          deposit: 0n,
        },
      },
    ],
  });
  const burnt =
    BigInt(res.transaction_outcome?.outcome?.tokens_burnt ?? 0) +
    (res.receipts_outcome ?? []).reduce((s, r) => s + BigInt(r.outcome?.tokens_burnt ?? 0), 0n);

  for (let t = 0; t < 15; t++) {
    const a = await allowanceOf(pk);
    if (a !== prev) break;
    await wait(400);
  }
  const now = await allowanceOf(pk);
  const b1 = await balance();
  const spent = prev - now;
  rows.push({ spent, burnt });
  console.log(
    `${String(i).padStart(4)} | ${near(now).padStart(15)} | ${near(spent).padStart(15)} | ${near(burnt).padStart(17)} | ${near(b1 - b0).padStart(13)} | ${(burnt > 0n ? (Number(spent) / Number(burnt)).toFixed(2) : "n/a").padStart(10)}`,
  );
  prev = now;
}

// MEDIAN, not mean. The mean is what made the previous version of this script
// print the wrong verdict: one transient outlier of 0.030919 against four
// identical rows of 0.000124 dragged the mean to 0.006283, which cleared the
// "prepaid" threshold and reported PREPAID GAS — a conclusion four fifths of
// the data contradicted. A summary statistic that one bad read can flip is not
// a measurement.
const median = (xs) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)];
};
const perCall = median(rows.map((r) => r.spent));
const perBurnt = median(rows.map((r) => r.burnt));
const prepaidWorth = TGAS * TG * gasPrice;
const spread = rows.map((r) => near(r.spent)).join(", ");
console.log(`\nallowance spent per call      : ${spread}`);
console.log(`MEDIAN allowance spent        : ${near(perCall)} NEAR`);
console.log(`MEDIAN tokens_burnt           : ${near(perBurnt)} NEAR`);
console.log(`prepaid gas was worth         : ${near(prepaidWorth)} NEAR`);

const tracksUsage = perBurnt > 0n && perCall <= (perBurnt * 12n) / 10n;
console.log(
  `\nVERDICT: the allowance is charged for ${tracksUsage ? "GAS ACTUALLY USED" : "PREPAID GAS"}.`,
);
if (perCall > 0n) {
  console.log(`         a 0.05 NEAR allowance buys ~${Math.floor(5e22 / Number(perCall))} calls of this shape.`);
}

await ownerAcct.deleteKey(kp.getPublicKey()).catch(() => {});
console.log("         (measurement key deleted)");
