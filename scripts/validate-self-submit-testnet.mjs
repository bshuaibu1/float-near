#!/usr/bin/env node
/**
 * Validate the SELF-SUBMIT path on a real node.
 *
 * WHY THIS EXISTS. The sandbox tier that would normally cover this cannot run
 * on Windows (`near-workspaces` ships no Windows `neard`) and WSL here has no
 * rust toolchain, so `contracts/integration-tests/tests/self_submit.rs` is
 * written but UNRUN. This recovers most of what it would have proven, against
 * an actual chain instead of a mocked VM.
 *
 * The unit tier cannot see any of this: `signer_account_pk` in near-sdk's test
 * VM is whatever `VMContextBuilder` was handed. Whether a real node LETS a key
 * on the vault call `request_payment` — the access-key check, the predecessor,
 * the signer key — is entirely protocol-side.
 *
 * Target: approve.floatv4.testnet, upgraded to the exact artifact
 * `packages/create-float/res/vault.wasm` (sha256 11eb2d0d…, byte-identical,
 * verified by reading the deployed code back).
 *
 * Usage:
 *   node scripts/validate-self-submit-testnet.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

// ---- MAINNET MODE.
//
// Parameterised rather than copied into a second file, deliberately: this code
// path passed 11/11 on testnet, and a mainnet run should exercise the PROVEN
// one. A fork would be free to drift, and the drift would only ever be
// discovered with real money in flight.
//
// `ALLOW_MAINNET=1` is required, on top of a `.near` suffix check, so a
// mis-set VAULT cannot silently reach production.
const MAINNET = process.env.ALLOW_MAINNET === "1";
const NET = MAINNET ? "mainnet" : "testnet";
const RPC =
  process.env.NEAR_VAULT_RPC_URL ??
  (MAINNET ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
const VAULT = process.env.VAULT ?? (MAINNET ? "float.test015.near" : "approve.floatv4.testnet");
const OWNER = process.env.OWNER ?? (MAINNET ? "test015.near" : "floatv4.testnet");
const TOKEN =
  process.env.TOKEN ??
  (MAINNET
    ? "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
    : "ft.floatv4.testnet");
// The payee is the OWNER on mainnet, because root allowlists it — so the real
// USDC moved by this test lands back in Bashir's own account rather than
// anywhere it has to be chased from.
const PAYEE = process.env.PAYEE ?? (MAINNET ? "test015.near" : "floatv4.testnet");
const NODE = Number(process.env.NODE ?? (MAINNET ? 3 : 1));
// Amounts in BASE units. 0.01 USDC on mainnet against a 0.51 per-tx cap.
const AMT_A = BigInt(process.env.AMT_A ?? (MAINNET ? 10_000 : 1_000_000));
const AMT_C = BigInt(process.env.AMT_C ?? (MAINNET ? 10_000 : 2_000_000));
// 60 TGas, not the 100 the MCP server sends. The reservation is prepaid x 1e9,
// so 60 reserves ~0.061 instead of ~0.101 — and the mainnet vault's margin
// after the upgrade is 0.233, which 100 TGas would make uncomfortably tight
// once a gas key is also funded out of it. 60 clears MIN_GAS_FOR_DISPATCH (50).
const TGAS_A = Number(process.env.TGAS_A ?? (MAINNET ? 60 : 100));
const TGAS_C = Number(process.env.TGAS_C ?? 60);
// Skip the plain-function-call-key leg. On mainnet the gas key IS the target
// architecture and every extra leg is real money and another reservation
// against a thin margin.
const ONLY_GAS_KEY = process.env.ONLY_GAS_KEY === "1";

if (/\.near$/.test(VAULT) && !MAINNET) {
  console.error(`FATAL: ${VAULT} looks like mainnet but ALLOW_MAINNET is not set.`);
  process.exit(2);
}
if (MAINNET && !/\.near$/.test(VAULT)) {
  console.error(`FATAL: ALLOW_MAINNET=1 but ${VAULT} is not a mainnet account.`);
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
const credPath = (a) => join(homedir(), ".near-credentials", NET, `${a}.json`);
const signerFor = (a) => {
  const k = JSON.parse(readFileSync(credPath(a), "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
};
const owner = new Account(OWNER, provider, signerFor(OWNER));

const GAS = (tg) => BigInt(tg) * 10n ** 12n;
const YOCTO = 1n;
const near6 = (y) => (Number(y) / 1e24).toFixed(6);
const ft = (n) => (Number(n) / 1e6).toFixed(2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = { finality: "final" };
const OPT = { finality: "optimistic" };

/**
 * One unique suffix per run, shared by every request id in it.
 *
 * The first version derived the id from the payee balance mod 100000, which is
 * 0 for any round balance — so a second run reused the first's id and the
 * contract correctly answered DUPLICATE_REQUEST. The contract was right; the
 * generator was not.
 */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  (pass ? ok : bad)(`${name}${detail ? ` ${C.d(detail)}` : ""}`);
};

const view = (id, method, args = {}) =>
  provider.callFunction({ contractId: id, method, args, blockQuery: OPT });
const payeeBalance = async () => BigInt(await view(TOKEN, "ft_balance_of", { account_id: PAYEE }));
const keyList = () => provider.viewAccessKeyList({ accountId: VAULT, blockQuery: FINAL });
async function vaultState() {
  const s = await provider.viewAccount({ accountId: VAULT, blockQuery: FINAL });
  const bytes = BigInt(s.storage_usage);
  return { balance: BigInt(s.amount), bytes, free: BigInt(s.amount) - bytes * 10n ** 19n };
}
const vaultFree = async () => (await vaultState()).free;

/**
 * A vault state that has STOPPED MOVING — two consecutive identical reads of
 * both the balance and the storage usage.
 *
 * Needed for the BASELINE of any before/after measurement, and that is the
 * subtle part. Polling the END of a window to an expected value cannot repair a
 * baseline captured too early: once a stray refund lands INSIDE the window, the
 * difference is permanently off by that amount and no amount of further waiting
 * brings it back.
 *
 * Measured: with step A skipped, step C's `unexplained` came out at exactly
 * -0.000317 on two separate runs — identical, which is what finally ruled out a
 * random settling artifact. Step A's own duration had been acting as an
 * accidental quiet period, so removing it let a refund from step B's AddKey
 * land after `free0` was read. The end-state poll then ran its full 32 seconds
 * without budging, because there was nothing left to settle: the error was
 * already baked into the baseline.
 */
async function settledVaultState(tries = 40) {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    const s = await vaultState();
    if (prev && s.balance === prev.balance && s.bytes === prev.bytes) return s;
    prev = s;
    await wait(800);
  }
  warn("the vault state never stopped moving; the deltas below are unsafe");
  return await vaultState();
}
async function gasBalanceOf(pk) {
  const e = (await keyList()).keys.find((k) => k.public_key === pk);
  const p = e?.access_key?.permission;
  const v = typeof p === "object" ? (p.GasKeyFunctionCall ?? p.GasKeyFullAccess) : null;
  return v?.balance !== undefined ? BigInt(v.balance) : null;
}
/** Poll to an EXPECTED value, never to "it changed" — a stale read has already
 *  changed. See the project memory note on lagging balance reads. */
async function pollUntil(fn, tries = 25, ms = 800) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await wait(ms);
  }
  return false;
}

/** The whole point: an Account whose id is the VAULT, signing with an agent key. */
const asVault = (kp) => new Account(VAULT, provider, new KeyPairSigner(kp));

async function bind(pk) {
  await owner.callFunction({
    contractId: VAULT,
    methodName: "bind_virtual_agent",
    args: { node_id: NODE, public_key: pk },
    gas: GAS(60),
    deposit: YOCTO,
  });
}
async function unbind(pk) {
  await owner
    .callFunction({
      contractId: VAULT,
      methodName: "unbind_virtual_agent",
      args: { public_key: pk },
      gas: GAS(60),
      deposit: YOCTO,
    })
    .catch(() => {});
}

const vaultAcct = new Account(VAULT, provider, signerFor(VAULT));
const made = [];

async function payAsVault(kp, requestId, amount, tgas) {
  return asVault(kp).callFunction({
    contractId: VAULT,
    methodName: "request_payment",
    args: {
      request_id: requestId,
      token: TOKEN,
      amount: String(amount),
      recipient: PAYEE,
      memo: "self-submit validation",
      route: null,
    },
    gas: GAS(tgas),
    deposit: 0n,
  });
}

try {
  step(0, "Preflight");
  const code = Buffer.from((await provider.viewContractCode({ contractId: VAULT })).code_base64, "base64");
  const local = readFileSync("packages/create-float/res/vault.wasm");
  info(`deployed ${code.length} bytes, local ${local.length}`);
  check("the vault runs the EXACT artifact create-float ships", code.equals(local));
  check("the deployed code contains signer_account_pk", code.includes(Buffer.from("signer_account_pk")));
  info(`vault free ${near6(await vaultFree())} NEAR`);

  // ---- A: a plain function-call key on the vault, bound
  //
  // Skippable with ONLY_GAS_KEY=1. On mainnet the gas key IS the architecture
  // being shipped, and every extra leg is real USDC plus another reservation
  // against a thin margin.
  if (ONLY_GAS_KEY) info("A: skipped (ONLY_GAS_KEY=1 — the gas key leg is the one that matters)");
  if (!ONLY_GAS_KEY) {
  step("A", "A BOUND function-call key ON THE VAULT pays (gas from the vault)");
  const kpA = KeyPair.fromRandom("ed25519");
  const pkA = kpA.getPublicKey().toString();
  await bind(pkA);
  made.push({ pk: pkA, kp: kpA, gas: false });
  await vaultAcct.addFunctionCallAccessKey({
    publicKey: kpA.getPublicKey(),
    contractId: VAULT,
    methodNames: ["request_payment"],
    allowance: 200_000_000_000_000_000_000_000n, // 0.2
  });
  await pollUntil(async () => (await keyList()).keys.some((k) => k.public_key === pkA));
  info(`key ${pkA.slice(0, 26)}… bound to node ${NODE} and installed on the vault`);

  const before = await payeeBalance();
  const idA = `ss-a-${RUN}`;
  let outA = null;
  try {
    outA = await payAsVault(kpA, idA, AMT_A, TGAS_A);
    info(`outcome ${JSON.stringify(outA)}`);
  } catch (e) {
    bad(`call failed: ${String(e.message).slice(0, 220)}`);
  }
  check("the self-submitted payment SETTLED", outA?.status === "SETTLED", `status ${outA?.status}`);
  const grew = await pollUntil(async () => (await payeeBalance()) > before);
  const after = await payeeBalance();
  info(`payee ${ft(before)} -> ${ft(after)}`);
  check("the payee was ACTUALLY paid — a real ft_transfer", grew && after - before === AMT_A, `+${ft(after - before)}`);

  const req = await view(VAULT, "get_request", { request_id: idA }).catch(() => null);
  check("it is recorded in the request ledger", req?.status === "SETTLED", `node ${req?.node_id}`);
  check("attributed to the node the KEY is bound to", req?.node_id === NODE, `got ${req?.node_id}`);

  }

  // ---- B: installed but NOT bound
  step("B", "An INSTALLED but UNBOUND key is refused");
  const kpB = KeyPair.fromRandom("ed25519");
  const pkB = kpB.getPublicKey().toString();
  made.push({ pk: pkB, kp: kpB, gas: false });
  await vaultAcct.addFunctionCallAccessKey({
    publicKey: kpB.getPublicKey(),
    contractId: VAULT,
    methodNames: ["request_payment"],
    allowance: 200_000_000_000_000_000_000_000n,
  });
  await pollUntil(async () => (await keyList()).keys.some((k) => k.public_key === pkB));
  let msgB = "";
  try {
    await payAsVault(kpB, `ss-b-${RUN}`, AMT_A, TGAS_A);
    bad("an unbound key spent");
    results.push({ name: "B: unbound key refused", pass: false });
  } catch (e) {
    msgB = String(e.message);
    info(msgB.slice(0, 160));
    check("B: refused with NOT_VIRTUAL_AGENT", /NOT_VIRTUAL_AGENT/.test(msgB));
  }

  // ---- C: a NEP-611 GAS KEY on the vault
  step("C", "A bound GAS KEY pays from ITS OWN balance, not the vault's");
  const kpC = KeyPair.fromRandom("ed25519");
  const pkC = kpC.getPublicKey().toString();
  await bind(pkC);
  made.push({ pk: pkC, kp: kpC, gas: true });
  await vaultAcct.addFunctionCallGasKey({
    publicKey: kpC.getPublicKey(),
    contractId: VAULT,
    methodNames: ["request_payment"],
    numNonces: 1,
  });
  await pollUntil(async () => (await gasBalanceOf(pkC)) !== null);
  // Derived, not a literal: the reservation is prepaid x 1e9 (the MAX gas
  // price, ten times the current one), plus 0.01 of headroom for the exec cost.
  // A literal would silently under-fund the key if TGAS_C ever changed.
  const FUND = BigInt(TGAS_C) * 10n ** 12n * 10n ** 9n + 10n ** 22n;
  const freeBeforeFund = await vaultFree();
  await vaultAcct.transferToGasKey(VAULT, kpC.getPublicKey(), FUND);

  // POLL **BOTH** SIDES TO AN EXPECTED VALUE, and the second one is the point.
  //
  // The first version polled only the GAS KEY until it reached FUND, then took a
  // single `final`-finality read of the VAULT. The gas balance had settled; the
  // vault's had not, so st0 captured a PRE-transfer vault balance and the 0.08
  // reappeared afterwards as 0.080058 of "unexplained" cost — which read as the
  // vault paying gas, i.e. as this whole design failing.
  //
  // This is the SIXTH instance of the same bug class in this project (see the
  // memory note `near-balance-reads-lag-poll-to-an-expected-value`), and it
  // happened in a script that already carried a comment warning about it. The
  // warning was applied to one read and not the other.
  await pollUntil(async () => {
    const b = await gasBalanceOf(pkC);
    return b !== null && b >= FUND;
  });
  const funded = await pollUntil(async () => (await vaultFree()) <= freeBeforeFund - FUND + 10n ** 21n);
  if (!funded) warn("the vault balance never reflected the gas-key funding; the deltas below are unsafe");

  const gas0 = await gasBalanceOf(pkC);
  // The BASELINE must be quiet, not merely current. See settledVaultState.
  const st0 = await settledVaultState();
  const free0 = st0.free;
  info(`vault free ${near6(freeBeforeFund)} -> ${near6(free0)} after funding ${near6(FUND)}`);
  info(`gas key ${near6(gas0 ?? 0n)}   storage ${st0.bytes}B`);

  const beforeC = await payeeBalance();
  let outC = null;
  try {
    outC = await payAsVault(kpC, `ss-c-${RUN}`, AMT_C, TGAS_C);
    info(`outcome ${JSON.stringify(outC)}`);
  } catch (e) {
    bad(`gas-key call failed: ${String(e.message).slice(0, 220)}`);
  }
  check("C: the GAS-KEY-signed payment SETTLED", outC?.status === "SETTLED", `status ${outC?.status}`);
  const grewC = await pollUntil(async () => (await payeeBalance()) > beforeC);
  check("C: the payee was paid again", grewC, `+${ft((await payeeBalance()) - beforeC)}`);

  // WAIT FOR THE SETTLED VALUE, AND SAY WHAT "SETTLED" MEANS.
  //
  // The reservation is held and then returned, so a mid-settlement read reports
  // the whole reservation as spent — 358x wrong, measured on mainnet. Knowing
  // that was not enough; the predicate has to encode the DESTINATION.
  //
  // The previous predicate was `b > FUND - reservation - 0.001`, which with a
  // 0.07 fund and a 0.06 reservation meant "> 0.009" — satisfied by a reading
  // of 0.040912 taken while the reservation was still partly held. It then
  // reported "spent 0.029088" when the real burn was 0.000801, the figure the
  // cleanup's withdraw revealed moments later.
  //
  // A settled gas balance is close to FUND, because the burn is ~0.001 and the
  // reservation comes back. So the destination is FUND minus a little, and
  // STABILITY across two reads is required on top, because approaching the
  // destination is not the same as having arrived.
  let prevGas = null;
  const gasSettled = await pollUntil(async () => {
    const b = await gasBalanceOf(pkC);
    if (b === null) return false;
    const close = b > FUND - 5n * 10n ** 21n; // within 0.005 of the funded amount
    const stable = prevGas !== null && b === prevGas;
    prevGas = b;
    return close && stable;
  }, 40);
  if (!gasSettled) warn("the gas balance never settled; the cost below is a reservation, not a burn");
  const gas1 = await gasBalanceOf(pkC);
  info(`gas key ${near6(gas0 ?? 0n)} -> ${near6(gas1 ?? 0n)}   BURN ${near6((gas0 ?? 0n) - (gas1 ?? 0n))}`);
  check("C: the GAS KEY's own balance paid", (gas1 ?? 0n) < (gas0 ?? 0n));

  // THE PRECISE CLAIM, and the first version of this check got it wrong.
  //
  // It asserted the vault's free balance "was not drawn down" with 0.002 of
  // slack, and failed by 0.000443 — because the vault's free balance DID drop,
  // by exactly 0.002443, which is exactly 244 bytes at 1e19/byte: the storage
  // for ONE request-ledger record. Every payment writes one, on every path,
  // including agent accounts. That is storage, not gas, and lumping the two
  // together made a correct implementation look wrong.
  //
  // So the claim is now: the ENTIRE drop in the vault's free balance is
  // explained by storage growth. Anything left over would be gas the vault
  // paid, which is what this path exists to avoid.
  //
  // AND POLL THE *DERIVED QUANTITY* TO ITS EXPECTED VALUE, not the raw balance.
  // The second version sampled free/storage once and asserted |unexplained| <
  // 0.0001. It failed at -0.000317: the vault's balance had gone UP relative to
  // storage, because refunds from the earlier AddKey and transferToGasKey were
  // still landing. The quantity under test is a DIFFERENCE of two settling
  // numbers, so it has to be polled like one. A SIGNED tolerance is deliberate
  // — a negative residual is a refund arriving, a positive one is gas the vault
  // paid, and only the second is a defect. Both must settle to zero, because an
  // unsettled negative today is an unexplained positive tomorrow.
  const TOL = 10n ** 20n; // 0.0001
  let unexplained = 0n;
  let storageCost = 0n;
  // Two consecutive in-tolerance reads, not one. A value still moving can pass
  // THROUGH zero on its way somewhere else, and a single sample cannot tell
  // "arrived" from "passing by".
  let okRuns = 0;
  const settled = await pollUntil(async () => {
    const s = await vaultState();
    storageCost = (s.bytes - st0.bytes) * 10n ** 19n;
    unexplained = free0 - s.free - storageCost;
    okRuns = unexplained < TOL && unexplained > -TOL ? okRuns + 1 : 0;
    return okRuns >= 2;
  }, 40);
  const stEnd = await vaultState();
  info(`vault   ${near6(free0)} -> ${near6(stEnd.free)}   storage ${st0.bytes}B -> ${stEnd.bytes}B`);
  info(`drop ${near6(free0 - stEnd.free)} = storage ${near6(storageCost)} + unexplained ${near6(unexplained)}`);
  check(
    "C: the vault paid STORAGE only — no gas",
    settled,
    `unexplained ${near6(unexplained)} (tolerance 0.0001)`,
  );
} catch (e) {
  bad(`unexpected: ${String(e.message).slice(0, 240)}`);
  results.push({ name: "run completed", pass: false });
} finally {
  step("Z", "Cleanup — unbind, withdraw, remove every key created");
  for (const k of made) {
    await unbind(k.pk);
    if (k.gas) {
      const b = await gasBalanceOf(k.pk).catch(() => null);
      if (b && b > 0n) {
        await vaultAcct
          .withdrawFromGasKey(k.kp.getPublicKey(), b)
          .then(() => ok(`withdrew ${near6(b)} from the gas key`))
          .catch(() => bad(`withdraw failed — ${near6(b)} left in ${k.pk}`));
        await wait(2500);
      }
    }
    await vaultAcct
      .deleteKey(k.kp.getPublicKey())
      .then(() => ok(`removed ${k.pk.slice(0, 26)}…`))
      .catch(() => warn(`could not remove ${k.pk}`));
  }
  const keys = (await keyList().catch(() => ({ keys: [] }))).keys;
  info(`${VAULT} now has ${keys.length} key(s), free ${near6(await vaultFree().catch(() => 0n))}`);

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${C.b(`${pass}/${results.length}`)} checks passed`);
  for (const r of results.filter((r) => !r.pass)) console.log(`  ${C.r("FAIL")} ${r.name}`);
  process.exitCode = pass === results.length ? 0 : 1;
}
