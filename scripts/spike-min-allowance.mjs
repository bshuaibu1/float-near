#!/usr/bin/env node
/**
 * What is the MINIMUM allowance a function-call key needs to make one call?
 *
 * WHY IT IS NOT "the cost of the call". spike-allowance-rate.mjs measured the
 * steady-state drain at 0.000124 NEAR per call — exactly `tokens_burnt` — but
 * also caught a transient of ~0.030919 appearing and then being refunded (call
 * 5 of that run shows the allowance going UP by 0.030671). So the protocol
 * RESERVES far more than it spends, and the reservation is the binding
 * constraint on how small an allowance can be.
 *
 * This matters for the product, not just for curiosity. If the reservation is
 * ~0.031, then:
 *   - an allowance must be >= the reservation, not >= the expected spend;
 *   - "0.05 NEAR buys 400 calls" is true for the SPEND and false for the
 *     SIZING, because the key needs the reservation available every time;
 *   - a key cannot be topped up in tiny increments.
 *
 * Getting this wrong by a factor of 250 would mean shipping a wizard that
 * provisions agent keys which refuse to pay. So it is measured by bisection
 * rather than reasoned about: add a key at an allowance, try one call, record
 * whether it executes.
 *
 * Usage:
 *   node scripts/spike-min-allowance.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const PROBE = process.env.PROBE ?? "p1.floatv4.testnet";
const TGAS = BigInt(process.env.TGAS ?? 30);
if (/\.near$/.test(PROBE)) {
  console.error("FATAL: testnet only.");
  process.exit(2);
}

const provider = new JsonRpcProvider({ url: RPC });
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
const own = JSON.parse(readFileSync(credPath(PROBE), "utf8"));
const owner = new Account(PROBE, provider, new KeyPairSigner(KeyPair.fromString(own.private_key)));

const near = (y) => (Number(y) / 1e24).toFixed(6);
const TG = 10n ** 12n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const keyPresent = async (pk) =>
  (await provider.viewAccessKeyList({ accountId: PROBE, blockQuery: { finality: "final" } })).keys.some(
    (k) => k.public_key === pk,
  );

const gasPrice = BigInt((await provider.viewGasPrice()).gas_price);
console.log(`prepaid ${TGAS} TGas, gas price ${gasPrice}`);
console.log(`measured steady-state cost per call: 0.000124 NEAR`);
console.log(`measured transient reservation:      ~0.030919 NEAR\n`);
console.log("allowance   | one call | note");
console.log("------------|----------|---------------------------------------------");

/** Provision a key at `allowance`, attempt exactly one call, report. */
async function tryAt(allowance) {
  const kp = KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();
  try {
    await owner.addFunctionCallAccessKey({
      publicKey: kp.getPublicKey(),
      contractId: PROBE,
      methodNames: ["whoami"],
      allowance,
    });
  } catch (e) {
    return { ok: false, note: `AddKey refused: ${String(e.message).slice(0, 50)}` };
  }
  for (let i = 0; i < 15 && !(await keyPresent(pk)); i++) await wait(400);

  const agent = new Account(PROBE, provider, new KeyPairSigner(kp));
  let out;
  try {
    await agent.signAndSendTransaction({
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
    out = { ok: true, note: "executed" };
  } catch (e) {
    const m = String(e.message);
    out = {
      ok: false,
      note: /NotEnoughAllowance/i.test(m) ? "NotEnoughAllowance" : m.slice(0, 60),
    };
  }
  // Delete only if it survived; a key exhausted by a call may already be gone.
  await owner.deleteKey(kp.getPublicKey()).catch(() => {});
  return out;
}

// Spread around the two measured figures: well below the reservation, just
// below, just above, and comfortably above.
const LEVELS = (process.env.LEVELS ?? "0.001,0.01,0.025,0.031,0.04,0.05").split(",");
for (const near_ of LEVELS) {
  const a = BigInt(Math.round(Number(near_) * 1e6)) * 10n ** 18n;
  const r = await tryAt(a);
  console.log(`${near_.padStart(11)} | ${(r.ok ? "  YES   " : "   no   ")} | ${r.note}`);
}

console.log(`
READ IT LIKE THIS
  If small allowances WORK, the ~0.031 transient is a reservation against the
  account, not against the key, and an agent key can be provisioned for
  fractions of a cent — the per-agent cost really is ~0.001 NEAR, not 0.55.

  If they fail with NotEnoughAllowance, the MINIMUM viable allowance is the
  reservation (~0.031 at ${TGAS} TGas), the wizard must provision at least that
  much per agent, and lowering prepaid gas is the lever that lowers it.`);
