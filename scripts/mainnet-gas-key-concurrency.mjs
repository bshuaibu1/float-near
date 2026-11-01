#!/usr/bin/env node
/**
 * MAINNET: do two gas keys on one account contend for the account's balance?
 *
 * The last gap. `SPIKE-gas-keys-2026-10-31.md` proved on MAINNET that a gas
 * key's own balance pays and the account's does not move — but with a SINGLE
 * key. The no-contention result (two keys paying from their own pots while the
 * account cannot cover even one reservation) is from testnet only. If that does
 * not transfer, the vault's free balance is still the ceiling on simultaneous
 * agent payments, and "one vault, many agents" needs re-costing.
 *
 * ---- WHY A NODE SCRIPT AND NOT near-cli.
 *
 * Two reasons, both learned today.
 *
 * 1. CONCURRENCY. Sequential CLI invocations cannot put two transactions in
 *    flight at once. Both are pre-signed here and then broadcast together, and
 *    the distinct block count is reported so "concurrent" is a measured fact
 *    rather than a hope.
 * 2. SECRETS. The single-key mainnet run used
 *    `sign-with-plaintext-private-key` and near-cli echoed a "console command
 *    if you need to re-run" line CONTAINING THE FULL PRIVATE KEY, into a shell
 *    scrollback and a chat transcript. A node script never prints its keys.
 *
 * ---- THE DISCRIMINATOR, and why 60 TGas.
 *
 * To prove no contention the account must be unable to cover even ONE
 * reservation while both keys can. Reservation is `prepaid_gas * 1e9`, so with
 * `free` available: fund two keys at R each, leaving free-2R, and require
 * free-2R < R, i.e. R > free/3.
 *
 * Measured free on test015.near is 0.17856, so R > 0.05952, so prepaid > ~59
 * TGas. At 60 TGas: R = 0.06092, two keys cost 0.12984, the account is left
 * with 0.04772 — below one reservation. 100 TGas would need 0.20984 and does
 * not fit; 70 works but leaves only 0.02772 for the withdraw transactions.
 *
 * 60 is also a realistic figure rather than a contrivance: the contract's
 * `MIN_GAS_FOR_DISPATCH` floor is 50 TGas.
 *
 * The script ASSERTS the discriminator holds before firing and aborts if it
 * does not. Two testnet runs of the equivalent test proved nothing because the
 * account was comfortably able to cover both calls, and one of them printed a
 * confident wrong conclusion anyway.
 *
 * ---- WHAT IT CANNOT TOUCH.
 *
 * Signer is test015.near, the OWNER. The live vault float.test015.near is never
 * a signer. Both gas keys are function-call restricted to ONE read-only view
 * method on the vault, so neither can move tokens, transfer NEAR, add keys or
 * deploy — and a function-call key cannot carry a deposit at all.
 *
 * Exposure is the ~0.13 parked in the two keys, and only if the withdraw fails.
 * Withdraw is proven on mainnet (0.049836 recovered on 2026-10-31). If one does
 * fail, the exact recovery command is printed.
 *
 * Usage, from anywhere:
 *   CONFIRM_MAINNET=1 node scripts/mainnet-gas-key-concurrency.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const ACCOUNT = process.env.ACCOUNT ?? "test015.near";
const VAULT = process.env.VAULT ?? "float.test015.near";
const METHOD = "get_config";
const TGAS = BigInt(process.env.TGAS ?? 60);
const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://free.rpc.fastnear.com";
const STATE = ".demo/gaskey-concurrency-keys.json";

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
const near = (y) => (Number(y) / 1e24).toFixed(5);
const TG = 10n ** 12n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- guards, cheapest first
if (process.env.CONFIRM_MAINNET !== "1") {
  console.error("FATAL: this sends REAL MAINNET transactions. Re-run with CONFIRM_MAINNET=1.");
  process.exit(2);
}
if (!/\.near$/.test(ACCOUNT)) {
  console.error(`FATAL: ${ACCOUNT} is not a mainnet account.`);
  process.exit(2);
}
if (ACCOUNT === VAULT) {
  console.error("FATAL: refusing to make the vault the signer.");
  process.exit(2);
}
const credPath = join(homedir(), ".near-credentials", "mainnet", `${ACCOUNT}.json`);
if (!existsSync(credPath)) {
  console.error(`FATAL: no mainnet credentials at ${credPath}`);
  process.exit(2);
}

const provider = new JsonRpcProvider({ url: RPC });
const cred = JSON.parse(readFileSync(credPath, "utf8"));
const owner = new Account(
  ACCOUNT,
  provider,
  new KeyPairSigner(KeyPair.fromString(cred.private_key ?? cred.secret_key)),
);

const FINAL = { finality: "final" };
const keyList = () => provider.viewAccessKeyList({ accountId: ACCOUNT, blockQuery: FINAL });
async function freeBalance() {
  const s = await provider.viewAccount({ accountId: ACCOUNT, blockQuery: FINAL });
  return BigInt(s.amount) - BigInt(s.storage_usage) * 10n ** 19n;
}
/** Gas balance. Top level of the permission variant, NOT nested in
 *  `gas_key_info` where near-api-js's types put it — that misreading produced
 *  five false failures in the testnet spike. */
async function gasBalance(pk) {
  const e = (await keyList()).keys.find((k) => k.public_key === pk);
  const p = e?.access_key?.permission;
  const v = typeof p === "object" ? (p.GasKeyFunctionCall ?? p.GasKeyFullAccess) : null;
  return v?.balance !== undefined ? BigInt(v.balance) : null;
}

// Keypairs persisted BEFORE anything goes on chain, so a crash still leaves
// cleanup able to find them.
mkdirSync(".demo", { recursive: true });
let keys;
if (existsSync(STATE)) {
  keys = JSON.parse(readFileSync(STATE, "utf8")).map((k) => KeyPair.fromString(k));
  info(`resuming with the two keypairs already in ${STATE}`);
} else {
  keys = [KeyPair.fromRandom("ed25519"), KeyPair.fromRandom("ed25519")];
  writeFileSync(STATE, JSON.stringify(keys.map((k) => k.toString()), null, 2));
}
const pks = keys.map((k) => k.getPublicKey().toString());

const RESERVATION = TGAS * TG * 10n ** 9n + 919_000_000_000_000_000_000n;
const FUND = RESERVATION + 4n * 10n ** 21n; // reservation + 0.004 headroom

let exitCode = 0;
try {
  step(0, `Plan — ${ACCOUNT}, ${TGAS} TGas, two gas keys`);
  const free0 = await freeBalance();
  info(`free now            ${near(free0)}`);
  info(`reservation @${TGAS}TG   ${near(RESERVATION)}`);
  info(`fund each key       ${near(FUND)}  (reservation + 0.004)`);
  const projected = free0 - 2n * FUND - 10n ** 21n;
  info(`account left ~      ${near(projected)}`);

  if (projected >= RESERVATION) {
    bad("the account would still cover a reservation — this test cannot discriminate.");
    info(`raise TGAS so the reservation exceeds ${near(projected)}, or the result proves nothing.`);
    process.exit(1);
  }
  if (projected < 5n * 10n ** 21n) {
    bad("the account would be left under 0.005 — too thin to pay for the withdrawals.");
    process.exit(1);
  }
  ok(`discriminating: ${near(projected)} left < ${near(RESERVATION)} reservation`);

  step(1, "Add two function-call GAS KEYS, restricted to one view method");
  for (const [i, kp] of keys.entries()) {
    if (await gasBalance(pks[i]) !== null) {
      info(`key ${i + 1} already present`);
      continue;
    }
    await owner.addFunctionCallGasKey({
      publicKey: kp.getPublicKey(),
      contractId: VAULT,
      methodNames: [METHOD],
      numNonces: 1,
    });
    ok(`key ${i + 1} added  ${pks[i].slice(0, 26)}…`);
  }
  for (let t = 0; t < 20; t++) {
    if ((await Promise.all(pks.map(gasBalance))).every((b) => b !== null)) break;
    await wait(1000);
  }

  step(2, `Fund each key's OWN balance with ${near(FUND)}`);
  for (const [i, kp] of keys.entries()) {
    const b = await gasBalance(pks[i]);
    if (b !== null && b >= RESERVATION) {
      info(`key ${i + 1} already funded (${near(b)})`);
      continue;
    }
    await owner.transferToGasKey(ACCOUNT, kp.getPublicKey(), FUND);
    ok(`key ${i + 1} funded`);
  }
  for (let t = 0; t < 25; t++) {
    const bs = await Promise.all(pks.map(gasBalance));
    if (bs.every((b) => b !== null && b >= RESERVATION)) break;
    await wait(1000);
  }

  // ---- WAIT FOR THE ACCOUNT BALANCE TO SETTLE TO ITS EXPECTED VALUE.
  //
  // The first mainnet run aborted here on a STALE read. It polled the two GAS
  // balances until both were funded — and then read the ACCOUNT balance exactly
  // once, immediately. The gas balances had settled; the account's had not:
  //
  //   projected after two funds   0.04772
  //   what step 3 read            0.10900   <- one fund behind
  //
  // so the guard concluded "the account can still cover a reservation" and
  // refused to fire. The guard was right about what it saw and wrong about the
  // world. Proven afterwards from the end state: the account finished at
  // 0.17595 having spent only 0.00261, which is only possible if BOTH transfers
  // landed and both withdrawals returned.
  //
  // AND NOTE WHY "POLL UNTIL IT CHANGES" WOULD NOT HAVE SAVED THIS. 0.10900 had
  // already changed from 0.17856. The predicate has to be a POSITIVE ASSERTION
  // about where the value should land, not merely that it moved.
  const expectMax = free0 - 2n * FUND + 3n * 10n ** 21n; // + 0.003 slack for gas
  let freeThin = await freeBalance();
  for (let t = 0; t < 30 && freeThin > expectMax; t++) {
    await wait(1000);
    freeThin = await freeBalance();
  }
  if (freeThin > expectMax) {
    bad(`the account balance never settled: ${near(freeThin)} still above ${near(expectMax)}`);
    info("the two funding transfers may not both have landed. Cleaning up and stopping.");
    exitCode = 1;
    throw new Error("unsettled");
  }

  step(3, "Verify the discriminator ON CHAIN before firing");
  const bals = await Promise.all(pks.map(gasBalance));
  info(`account free        ${near(freeThin)}`);
  bals.forEach((b, i) => info(`key ${i + 1} gas balance   ${near(b ?? 0n)}`));
  const accountCannot = freeThin < RESERVATION;
  const keysCan = bals.every((b) => b !== null && b >= RESERVATION);
  if (!accountCannot) {
    bad(`the account can still cover a reservation (${near(freeThin)} >= ${near(RESERVATION)})`);
    info("aborting rather than running a test whose result would prove nothing.");
    exitCode = 1;
    throw new Error("non-discriminating");
  }
  if (!keysCan) {
    bad("at least one gas key is under the reservation — it cannot pay at all");
    exitCode = 1;
    throw new Error("underfunded");
  }
  ok(`account CANNOT cover one reservation; both keys CAN`);

  step(4, "Fire both at once — pre-signed, broadcast together");
  const action = {
    functionCall: {
      methodName: METHOD,
      args: new Uint8Array(Buffer.from("{}")),
      gas: TGAS * TG,
      deposit: 0n,
    },
  };
  const accts = keys.map((kp) => new Account(ACCOUNT, provider, new KeyPairSigner(kp)));
  const txs = await Promise.all(
    accts.map((a) => a.createSignedTransaction({ receiverId: VAULT, actions: [action] })),
  );
  info("both signed; broadcasting without awaiting either");
  const settled = await Promise.allSettled(txs.map((t) => provider.sendTransaction(t)));

  let okCount = 0;
  const blocks = new Set();
  settled.forEach((s, i) => {
    if (s.status === "fulfilled" && !s.value?.status?.Failure) {
      okCount++;
      const b = s.value?.transaction_outcome?.block_hash;
      if (b) blocks.add(b);
      info(`key ${i + 1}: EXECUTED  block ${String(b).slice(0, 12)}…`);
    } else {
      const m = s.status === "rejected" ? String(s.reason?.message) : JSON.stringify(s.value?.status);
      bad(`key ${i + 1}: ${m.slice(0, 160)}`);
    }
  });

  step(5, "Verdict");
  const freeAfter = await freeBalance();
  const balsAfter = await Promise.all(pks.map(gasBalance));
  info(`account free ${near(freeThin)} -> ${near(freeAfter)}`);
  balsAfter.forEach((b, i) => info(`key ${i + 1} gas  ${near(bals[i] ?? 0n)} -> ${near(b ?? 0n)}`));
  info(`${okCount}/2 executed, distinct blocks ${blocks.size}`);

  if (okCount === 2) {
    ok("BOTH executed while the account could not cover even one reservation");
    ok("=> gas keys do NOT contend on mainnet. One vault can host many agents.");
    if (blocks.size === 1) ok("both landed in ONE block — the overlap was real, not serialised");
    else warn(`spread over ${blocks.size} blocks, so the overlap was partial`);
  } else {
    bad("not both executed — gas keys may contend on mainnet after all");
    info("=> re-cost 'one vault, many agents' before relying on it.");
    exitCode = 1;
  }
} catch (e) {
  if (!["non-discriminating", "underfunded", "unsettled"].includes(e.message)) {
    bad(`unexpected: ${String(e.message).slice(0, 200)}`);
    exitCode = 1;
  }
} finally {
  // ---- cleanup on every path. The float must not be stranded.
  step("Z", "Cleanup — withdraw and remove both keys");
  let stuck = [];
  for (const [i, kp] of keys.entries()) {
    const pk = pks[i];
    let b = null;
    try {
      b = await gasBalance(pk);
    } catch {
      /* read failed; try the withdraw anyway below */
    }
    if (b !== null && b > 0n) {
      try {
        await owner.withdrawFromGasKey(kp.getPublicKey(), b);
        ok(`key ${i + 1}: withdrew ${near(b)}`);
      } catch (e) {
        bad(`key ${i + 1}: withdraw failed — ${near(b)} still in the gas key`);
        stuck.push({ pk, b });
        continue;
      }
      await wait(2000);
    } else {
      info(`key ${i + 1}: nothing to withdraw (${b === null ? "not a gas key" : near(b)})`);
    }
    try {
      await owner.deleteKey(kp.getPublicKey());
      ok(`key ${i + 1}: deleted`);
    } catch {
      warn(`key ${i + 1}: could not delete ${pk}`);
      stuck.push({ pk, b: 0n });
    }
  }
  if (stuck.length === 0) {
    rmSync(STATE, { force: true });
    info(`removed ${STATE}`);
  } else {
    warn(`${STATE} kept — ${stuck.length} key(s) need manual attention:`);
    for (const s of stuck) {
      if (s.b > 0n) {
        console.log(
          `    near account withdraw-from-gas-key ${ACCOUNT} ${s.pk} '${s.b} yoctonear' network-config mainnet sign-with-legacy-keychain send`,
        );
      }
      console.log(
        `    near account delete-keys ${ACCOUNT} public-keys ${s.pk} network-config mainnet sign-with-legacy-keychain send`,
      );
    }
  }
  try {
    info(`${ACCOUNT} free is now ${near(await freeBalance())}, ${(await keyList()).keys.length} key(s)`);
  } catch {
    /* best effort */
  }
  process.exitCode = exitCode;
}
