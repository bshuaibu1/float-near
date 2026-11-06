import { test } from "node:test";
import assert from "node:assert/strict";
import { XCHAIN_HEADROOM, xchainCeiling, xchainCap } from "../bin/xchain.mjs";

/**
 * Charges from LIVE 1Click dry quotes, 2026-10-28, NEAR USDC -> Base USDC at
 * the default 100 bps slippage tolerance. Base units, 6dp.
 *
 * Pinned from the real API rather than computed from XCHAIN_HEADROOM, for the
 * same reason binding.test.mjs pins bytes emitted by the Rust struct: a
 * fixture derived from the thing under test only proves it agrees with itself.
 * If these came from `desired * 1.02` the suite would stay green no matter how
 * wrong the headroom became.
 */
/**
 * Small sizes, where the SPREAD exceeds the bare 2% constant.
 *
 * These are in the suite because they nearly caused a wrong "fix". The spread
 * is not asymptotic — it climbs sharply as the fixed part of a solver's cost
 * dominates (5.89% at 0.05, 3.46% at 0.10), so XCHAIN_HEADROOM alone does not
 * cover them. The conclusion that defaults were therefore unsafe was wrong:
 * xchainCap rounds UP TO THE CENT, which contributes effective headroom that
 * GROWS as the amount shrinks (20% at 0.05, 10% at 0.10, 4% at 0.25, 2% at and
 * above 0.50). The derived cap covers every size measured.
 *
 * So the rounding is load-bearing rather than hygiene, and the pair of tests
 * below says which part carries which: the cap covers all of these, and the
 * bare constant covers only the ones at 0.50 and up.
 */
const SMALL = [
  { desired: 0.05, charged: 52_943n },
  { desired: 0.1, charged: 103_458n },
  { desired: 0.25, charged: 255_004n },
];

const MEASURED = [
  // The MAINNET default tree's own amounts. This scale is the one that matters:
  // mainnet gets the SMALL tree (real money, "a total loss is a rounding
  // error"), and the spread is WORST at small sizes — so a flat 0.50 per-tx cap
  // cannot deliver 0.50 at all. Getting this backwards is easy: the generous
  // 100/10 tree is TESTNET's, where the rail is closed and the spread is moot.
  { desired: 0.5, charged: 507_579n },
  { desired: 1, charged: 1_012_733n },
  { desired: 1.5, charged: 1_517_884n },
  { desired: 2, charged: 2_023_038n },
  // Larger sizes, to pin the shape of the curve rather than one point — the
  // spread falls from 1.52% to 1.03% across this range, so a headroom tuned
  // only at one end would pass there and fail at the other.
  { desired: 10, charged: 10_105_478n },
  { desired: 50, charged: 50_517_682n },
  { desired: 60, charged: 60_620_733n },
  { desired: 100, charged: 101_032_936n },
];

const units = (human) => BigInt(Math.round(human * 1e6));

test("a derived cap covers what a live quote actually charged", () => {
  for (const { desired, charged } of MEASURED) {
    const cap = units(xchainCap(desired));
    assert.ok(
      cap >= charged,
      `cap for ${desired} is ${cap} but delivering it was charged ${charged}. ` +
        `The payment would be refused by PER_TX_LIMIT/DAILY_BUDGET — by the ` +
        `operator's own budget, with nothing in the error mentioning the rail.`,
    );
  }
});

test("the headroom is not so tight that the smallest size fails", () => {
  // The spread is WORST at small sizes (1.52% at 0.50 vs 1.03% at 100), so the
  // smallest row is the binding constraint. Asserted separately because an
  // average-based headroom would pass the large rows and fail only here, and
  // a loop that stopped at the first failure might not say which.
  const smallest = MEASURED[0];
  const cap = units(xchainCap(smallest.desired));
  const slack = cap - smallest.charged;
  assert.ok(slack >= 0n, `no slack at ${smallest.desired}: cap ${cap} < charged ${smallest.charged}`);
});

test("cap and ceiling round-trip: a cap sized for N delivers at least N", () => {
  // The property the wizard's printed sentence depends on. Guards the pair
  // against drifting apart — e.g. someone changing xchainCap's rounding to
  // Math.floor, which still looks reasonable in isolation.
  for (const { desired } of MEASURED) {
    assert.ok(
      xchainCeiling(xchainCap(desired)) >= desired,
      `a cap of ${xchainCap(desired)} advertises a ceiling of ` +
        `${xchainCeiling(xchainCap(desired))}, below the ${desired} it was sized for`,
    );
  }
});

test("xchainCap rounds UP, never down", () => {
  // 1 * 1.02 = 1.02 exactly; 0.01 * 1.02 = 0.0102 must not floor to 0.01,
  // which would hand back a cap equal to the desired amount and no headroom.
  assert.equal(xchainCap(1), 1.02);
  assert.equal(xchainCap(10), 10.2);
  assert.equal(xchainCap(100), 102);
  assert.ok(xchainCap(0.01) > 0.01, "a sub-cent headroom must still round up");
});

test("the BARE headroom clears the spread at 0.50 and above", () => {
  // A property, not a hardcoded 1.52%: if a re-measure shows a worse spread and
  // someone updates MEASURED without revisiting XCHAIN_HEADROOM, this notices.
  const worst = Math.max(
    ...MEASURED.map(({ desired, charged }) => Number(charged) / 1e6 / desired - 1),
  );
  assert.ok(
    XCHAIN_HEADROOM > worst,
    `headroom ${XCHAIN_HEADROOM} does not clear the worst spread in MEASURED ` +
      `(${worst.toFixed(4)}). Raise it, or payments at that size are refused.`,
  );
});

test("the derived cap covers small sizes too, which the bare 2% does NOT", () => {
  // The pair that shows ceil-to-cent is load-bearing. Change xchainCap's
  // rounding to Math.round or Math.floor and the first assertion breaks for
  // 0.05 and 0.10 — amounts the constant alone cannot cover.
  for (const { desired, charged } of SMALL) {
    const cap = BigInt(Math.round(xchainCap(desired) * 1e6));
    assert.ok(
      cap >= charged,
      `cap ${cap} for ${desired} does not cover the ${charged} charged — the ` +
        `cent-rounding that normally carries small sizes has been weakened`,
    );
    const bare = BigInt(Math.round(desired * (1 + XCHAIN_HEADROOM) * 1e6));
    assert.ok(
      bare < charged,
      `${desired} is listed as a size the bare ${XCHAIN_HEADROOM} cannot cover, but ` +
        `${bare} now covers ${charged}. The curve has flattened — re-measure, and ` +
        `move this row into MEASURED deliberately rather than by accident.`,
    );
  }
});
