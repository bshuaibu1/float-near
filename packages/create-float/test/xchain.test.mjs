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
const MEASURED = [
  { desired: 0.5, charged: 507_579n },
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

test("the headroom exceeds the worst measured spread", () => {
  // Stated as a property rather than hardcoding 1.52%: if a future measurement
  // shows a worse spread and someone updates MEASURED without revisiting
  // XCHAIN_HEADROOM, this is what notices.
  const worst = Math.max(
    ...MEASURED.map(({ desired, charged }) => Number(charged) / 1e6 / desired - 1),
  );
  assert.ok(
    XCHAIN_HEADROOM > worst,
    `headroom ${XCHAIN_HEADROOM} does not clear the worst measured spread ` +
      `${worst.toFixed(4)}. Raise it, or the largest payments at that size are refused.`,
  );
});
