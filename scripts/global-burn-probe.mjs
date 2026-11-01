#!/usr/bin/env node
/**
 * The measuring half of measure-global-burn.sh: record settled account state at
 * each step, then derive the per-byte global-contract rate differentially.
 *
 * SETTLING IS THE WHOLE DIFFICULTY, and this project has paid for it nine times
 * (see the memory note `near-balance-reads-lag-poll-to-an-expected-value`). A
 * `final`-finality balance read right after a write can be a whole transaction
 * behind, and the gas RESERVATION — prepaid x 1e9, refunded a receipt later —
 * makes a mid-settlement read look like a real, precise cost.
 *
 * That matters more here than usual: the quantity being measured IS a balance
 * drop, so a reservation still held would be indistinguishable from the burn
 * this script exists to price. A 60 TGas reservation is 0.0609 NEAR and the
 * burn being measured is ~0.1024. Reading one transaction early would corrupt
 * the result by more than half, and it would still look like a plausible
 * number.
 *
 * So each mark waits for QUIET consecutive identical reads spanning real block
 * progress, and both balance AND storage_usage must be unchanged.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// NETWORK is explicit and defaults to testnet, so a mainnet figure can never be
// produced by forgetting to set something. The marks file is per-network too:
// mixing a mainnet `before` with a testnet `after` would silently difference
// two chains and report a confident number.
const NETWORK = process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";
const RPC =
  NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com";
const STATE = resolve(
  import.meta.dirname,
  "..",
  ".demo",
  `global-burn-marks.${NETWORK}.json`,
);

const [account, cmd, ...rest] = process.argv.slice(2);
if (!account || !cmd) {
  console.error("usage: global-burn-probe.mjs <account> mark <label> | <account> report <small> <big>");
  process.exitCode = 2;
} else {
  const call = async (method, params) => {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
    return j.result;
  };
  const view = () =>
    call("query", { request_type: "view_account", finality: "final", account_id: account });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const near = (y) => (Number(y) / 1e24).toFixed(6);

  /** Settled = QUIET_READS identical reads spanning >= QUIET_BLOCKS of progress. */
  async function settled(tries = 60) {
    const QUIET_READS = 6;
    const QUIET_BLOCKS = 8n;
    let prev = null;
    let runStart = null;
    let run = 0;
    for (let i = 0; i < tries; i++) {
      const a = await view();
      const s = {
        amount: BigInt(a.amount),
        bytes: BigInt(a.storage_usage),
        height: BigInt(a.block_height),
      };
      if (prev && s.amount === prev.amount && s.bytes === prev.bytes) {
        run += 1;
        runStart ??= prev;
        if (run >= QUIET_READS && s.height - runStart.height >= QUIET_BLOCKS) return s;
      } else {
        run = 0;
        runStart = null;
      }
      prev = s;
      await wait(800);
    }
    throw new Error("the account never stopped moving — refusing to report a figure");
  }

  const marks = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};

  if (cmd === "mark") {
    const label = rest[0];
    const s = await settled();
    marks[label] = { amount: String(s.amount), bytes: String(s.bytes), height: String(s.height) };
    writeFileSync(STATE, JSON.stringify(marks, null, 2) + "\n");
    console.log(`    ${label}: ${near(s.amount)} NEAR, ${s.bytes} bytes, block ${s.height}`);
  } else if (cmd === "report") {
    // ACTUAL byte counts first, then the labels the marks were filed under
    // (which use the REQUESTED sizes). Keeping them separate is deliberate: the
    // rate must be divided by the real byte difference, not the one we asked
    // for, and pad-wasm's LEB128 length prefix makes those differ.
    const [small, big, smallLabel = small, bigLabel = big] = rest.map(Number);
    const need = ["before", `after${smallLabel}`, `after${bigLabel}`];
    const missing = need.filter((k) => !marks[k]);
    if (missing.length) {
      console.error(`FATAL: missing marks ${missing} — cannot report`);
      process.exitCode = 1;
    } else {
      const m = (k) => ({ amount: BigInt(marks[k].amount), bytes: BigInt(marks[k].bytes) });
      const b = m("before");
      const a1 = m(`after${smallLabel}`);
      const a2 = m(`after${bigLabel}`);
      const drop1 = b.amount - a1.amount;
      const drop2 = a1.amount - a2.amount;

      console.log("");
      console.log(`  ${small}-byte global: cost ${near(drop1)} NEAR   storage ${b.bytes} -> ${a1.bytes}`);
      console.log(`  ${big}-byte global: cost ${near(drop2)} NEAR   storage ${a1.bytes} -> ${a2.bytes}`);
      console.log("");

      // BURN OR STAKE? A balance drop alone cannot tell them apart. A stake
      // raises storage_usage; a burn does not.
      const grew = a2.bytes - b.bytes;
      console.log(`  deployer storage_usage grew by ${grew} bytes across BOTH publishes`);
      if (grew === 0n) {
        console.log(`  -> BURN confirmed: the tokens are gone, not staked. Nothing is recoverable.`);
      } else {
        console.log(`  -> NOT a pure burn: storage grew, so ${near(grew * 10n ** 19n)} NEAR of it is STAKED.`);
      }
      console.log("");

      // DIFFERENTIAL: cancels the unknown fixed action cost.
      const dBytes = BigInt(big - small);
      const dCost = drop2 - drop1;
      // Signed division, so a negative differential is reported rather than
      // silently floored toward zero into a plausible-looking rate.
      const rate = dCost / dBytes;
      console.log(`  differential: ${near(dCost)} NEAR over ${dBytes} bytes`);
      console.log(`  => rate ${rate} yocto/byte`);
      console.log("");
      const BASE = 10n ** 19n;
      console.log(`  normal storage rate   ${BASE} yocto/byte  (measured from the protocol config)`);
      console.log(`  claimed global rate   ${BASE * 10n} yocto/byte  (NEP-591, 10x)`);
      if (dCost <= 0n) {
        console.log(`  VERDICT: the bigger module cost no more. Something is wrong with this run.`);
      } else {
        const mult = Number(rate) / Number(BASE);
        console.log(`  OBSERVED multiplier   ${mult.toFixed(3)}x`);
        const near10 = Math.abs(mult - 10) < 0.5;
        const near1 = Math.abs(mult - 1) < 0.5;
        if (near10) console.log(`  VERDICT: the 10x claim HOLDS.`);
        else if (near1) console.log(`  VERDICT: NO multiplier — the NEP's 10x does NOT apply here.`);
        else console.log(`  VERDICT: neither 1x nor 10x. Investigate before trusting any published figure.`);

        // What it means for the decision that prompted this.
        const VAULT = 299620n;
        console.log("");
        console.log(`  publishing the 299,620-byte vault globally would cost`);
        console.log(`    ${near(rate * VAULT)} NEAR, burned, per version`);
        console.log(`  against a per-vault code stake today of ${near(VAULT * BASE)} NEAR (refundable)`);
        const breakEven = Number(rate) / Number(BASE);
        console.log(`  break-even ~${breakEven.toFixed(1)} vaults`);
      }
    }
  } else if (cmd === "predict") {
    // STATE THE EXPECTED VALUE BEFORE THE MEASUREMENT, not after. A burn is
    // irreversible, so there is no re-run to fall back on, and a figure
    // interpreted after the fact is one that can be talked into agreeing with
    // whatever came out. The two hypotheses are 10x apart, which is why a
    // SINGLE deploy is decisive here even though the testnet run needed a
    // differential to separate rate from fixed cost.
    const bytes = BigInt(rest[0]);
    const BASE = 10n ** 19n;
    console.log(`  module size          ${bytes} bytes`);
    console.log(`  if NO multiplier     ~${near(bytes * BASE)} NEAR  (1x, ${BASE}/byte)`);
    console.log(`  if the 10x holds     ~${near(bytes * BASE * 10n)} NEAR  (10x, measured on testnet)`);
    console.log(`  plus gas, order      ~0.00003 NEAR`);
    console.log(`  storage_usage must NOT change — a rise would mean stake, not burn`);
  } else if (cmd === "confirm") {
    const bytes = BigInt(rest[0]);
    const need = ["before", "after"];
    const missing = need.filter((k) => !marks[k]);
    if (missing.length) {
      console.error(`FATAL: missing marks ${missing} — cannot confirm`);
      process.exitCode = 1;
    } else {
      const b = { amount: BigInt(marks.before.amount), bytes: BigInt(marks.before.bytes) };
      const a = { amount: BigInt(marks.after.amount), bytes: BigInt(marks.after.bytes) };
      const drop = b.amount - a.amount;
      const BASE = 10n ** 19n;
      const p1 = bytes * BASE;
      const p10 = bytes * BASE * 10n;
      console.log("");
      console.log(`  observed drop        ${near(drop)} NEAR`);
      console.log(`  1x prediction        ${near(p1)}`);
      console.log(`  10x prediction       ${near(p10)}`);
      console.log(`  storage_usage        ${b.bytes} -> ${a.bytes}`);
      console.log("");
      if (a.bytes !== b.bytes) {
        const staked = (a.bytes - b.bytes) * BASE;
        console.log(`  NOT a pure burn: storage rose, ${near(staked)} NEAR of it is STAKED`);
      } else {
        console.log(`  BURN confirmed on ${NETWORK}: storage unchanged, tokens destroyed`);
      }
      // Tolerance is the gas, which is ~0.00003 — three orders below the
      // separation between the hypotheses, so the comparison is not close.
      const TOL = 2n * 10n ** 21n; // 0.002
      const near10 = drop > p10 - TOL && drop < p10 + TOL;
      const near1 = drop > p1 - TOL && drop < p1 + TOL;
      if (near10) console.log(`  VERDICT: 10x CONFIRMED on ${NETWORK}.`);
      else if (near1) console.log(`  VERDICT: 1x on ${NETWORK} — the 10x does NOT apply here.`);
      else console.log(`  VERDICT: matches NEITHER prediction. Do not publish anything until this is understood.`);
      const VAULT = 299620n;
      const impliedRate = drop / bytes;
      console.log("");
      console.log(`  implied rate         ${impliedRate} yocto/byte`);
      console.log(`  => publishing the 299,620-byte vault on ${NETWORK} would burn ${near(impliedRate * VAULT)} NEAR`);
    }
  } else {
    console.error(`unknown command ${cmd}`);
    process.exitCode = 2;
  }
}
