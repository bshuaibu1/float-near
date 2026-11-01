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

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const VAULT = process.env.VAULT ?? "approve.floatv4.testnet";
const OWNER = process.env.OWNER ?? "floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";
const PAYEE = process.env.PAYEE ?? "floatv4.testnet";
const NODE = Number(process.env.NODE ?? 1);
if (/\.near$/.test(VAULT)) {
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
  // A UNIQUE id per run. The first version derived it from the payee balance
  // mod 100000, which is 0 for any round balance — so the second run reused the
  // first run's id and the contract correctly answered DUPLICATE_REQUEST. The
  // contract was right; the id generator was not.
  const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const idA = `ss-a-${RUN}`;
  let outA = null;
  try {
    outA = await payAsVault(kpA, idA, 1_000_000, 100);
    info(`outcome ${JSON.stringify(outA)}`);
  } catch (e) {
    bad(`call failed: ${String(e.message).slice(0, 220)}`);
  }
  check("the self-submitted payment SETTLED", outA?.status === "SETTLED", `status ${outA?.status}`);
  const grew = await pollUntil(async () => (await payeeBalance()) > before);
  const after = await payeeBalance();
  info(`payee ${ft(before)} -> ${ft(after)}`);
  check("the payee was ACTUALLY paid — a real ft_transfer", grew && after - before === 1_000_000n, `+${ft(after - before)}`);

  const req = await view(VAULT, "get_request", { request_id: idA }).catch(() => null);
  check("it is recorded in the request ledger", req?.status === "SETTLED", `node ${req?.node_id}`);
  check("attributed to the node the KEY is bound to", req?.node_id === NODE, `got ${req?.node_id}`);

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
    await payAsVault(kpB, `ss-b-${Date.now() % 100000}`, 1_000_000, 100);
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
  const FUND = 80_000_000_000_000_000_000_000n; // 0.08 > the 60 TGas reservation of ~0.061
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
  const st0 = await vaultState();
  const free0 = st0.free;
  info(`vault free ${near6(freeBeforeFund)} -> ${near6(free0)} after funding ${near6(FUND)}`);
  info(`gas key ${near6(gas0 ?? 0n)}   storage ${st0.bytes}B`);

  const beforeC = await payeeBalance();
  let outC = null;
  try {
    outC = await payAsVault(kpC, `ss-c-${Date.now() % 100000}`, 2_000_000, 60);
    info(`outcome ${JSON.stringify(outC)}`);
  } catch (e) {
    bad(`gas-key call failed: ${String(e.message).slice(0, 220)}`);
  }
  check("C: the GAS-KEY-signed payment SETTLED", outC?.status === "SETTLED", `status ${outC?.status}`);
  const grewC = await pollUntil(async () => (await payeeBalance()) > beforeC);
  check("C: the payee was paid again", grewC, `+${ft((await payeeBalance()) - beforeC)}`);

  // Wait for the gas refund to settle before quoting a cost — the reservation
  // is held then returned, and reading mid-settlement reports the whole
  // reservation as spent (358x wrong, measured on mainnet).
  const settledFloor = FUND - 61_000_000_000_000_000_000_000n;
  await pollUntil(async () => {
    const b = await gasBalanceOf(pkC);
    return b !== null && b > settledFloor;
  });
  const gas1 = await gasBalanceOf(pkC);
  const st1 = await vaultState();
  const free1 = st1.free;
  info(`gas key ${near6(gas0 ?? 0n)} -> ${near6(gas1 ?? 0n)}   spent ${near6((gas0 ?? 0n) - (gas1 ?? 0n))}`);
  info(`vault   ${near6(free0)} -> ${near6(free1)}   delta ${near6(free1 - free0)}`);
  info(`storage ${st0.bytes}B -> ${st1.bytes}B   grew ${st1.bytes - st0.bytes}B`);
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
  const storageCost = (st1.bytes - st0.bytes) * 10n ** 19n;
  const unexplained = free0 - free1 - storageCost;
  info(`drop ${near6(free0 - free1)} = storage ${near6(storageCost)} + unexplained ${near6(unexplained)}`);
  check(
    "C: the vault paid STORAGE only — no gas",
    unexplained < 10n ** 20n && unexplained > -(10n ** 20n),
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
