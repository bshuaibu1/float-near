import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryVerdict } from "../bin/delivery.mjs";

/**
 * Deciding whether a cross-chain payment actually arrived.
 *
 * THREE WAYS THIS HAS ALREADY GONE WRONG, all on real payments:
 *
 *   1. `eth_getLogs` over a wide range returns HTTP 429, and reading that as
 *      `.result ?? []` turned a failed query into "0 inbound transfers" — a
 *      false claim of non-delivery while the transfer sat inside the scanned
 *      range.
 *   2. Sampling the balance ONCE immediately after paying reported SHORT for a
 *      payment still in flight. The solver's own estimate was 22s.
 *   3. A balance DELTA is not evidence at all when anything else can touch the
 *      account. The payee moved 0.65 USDC out between two readings, so the
 *      delta read -0.65 for a payment that had delivered 0.10 exactly.
 *
 * So the transfer EVENT is authoritative and the balance delta is corroboration
 * at best. This function never converts a failed or missing observation into
 * "not delivered" — those are different states and they demand different
 * responses: wait, retry the query, or investigate.
 */

const ONE = { amount: 100_000n, tx: "0x9132", block: 53233149n };

test("an inbound transfer of the expected amount is DELIVERED", () => {
  const v = deliveryVerdict({ inbound: [ONE], expected: 100_000n, elapsedMs: 1000, etaMs: 90_000 });
  assert.equal(v.state, "delivered");
  assert.equal(v.delivered, 100_000n);
});

test("the EVENT wins over a contradictory balance delta", () => {
  // The real case: 0.10 delivered while the payee moved 0.65 out, so the delta
  // was -0.65. Trusting the delta reports a failure that did not happen.
  const v = deliveryVerdict({
    inbound: [ONE],
    expected: 100_000n,
    beforeBalance: 751_935n,
    afterBalance: 101_935n, // dropped: someone moved funds out
    elapsedMs: 1000,
    etaMs: 90_000,
  });
  assert.equal(v.state, "delivered");
  assert.match(v.note ?? "", /balance.*(disagree|moved|other)/i, "the discrepancy must be surfaced");
});

test("a delta that AGREES with the event needs no warning", () => {
  const v = deliveryVerdict({
    inbound: [ONE],
    expected: 100_000n,
    beforeBalance: 751_935n,
    afterBalance: 851_935n,
    elapsedMs: 1000,
    etaMs: 90_000,
  });
  assert.equal(v.state, "delivered");
  assert.equal(v.note, undefined);
});

test("no transfer yet, still inside the solver's eta, is PENDING — not short", () => {
  const v = deliveryVerdict({ inbound: [], expected: 100_000n, elapsedMs: 5_000, etaMs: 90_000 });
  assert.equal(v.state, "pending");
});

test("no transfer past the eta is NOT-SEEN, which is a prompt to investigate", () => {
  const v = deliveryVerdict({ inbound: [], expected: 100_000n, elapsedMs: 120_000, etaMs: 90_000 });
  assert.equal(v.state, "not-seen");
});

test("an UNREADABLE chain is never reported as non-delivery", () => {
  // The 429 lesson. `inbound: null` means the query failed, which is a
  // different thing from an empty result and must not collapse into it.
  const v = deliveryVerdict({ inbound: null, expected: 100_000n, elapsedMs: 120_000, etaMs: 90_000 });
  assert.equal(v.state, "unknown");
  assert.match(v.note ?? "", /not evidence/i);
});

test("an empty result and a failed query are DIFFERENT states", () => {
  const empty = deliveryVerdict({ inbound: [], expected: 100_000n, elapsedMs: 120_000, etaMs: 90_000 });
  const failed = deliveryVerdict({ inbound: null, expected: 100_000n, elapsedMs: 120_000, etaMs: 90_000 });
  assert.notEqual(empty.state, failed.state);
});

test("several inbound transfers are summed", () => {
  // A solver may split a fill.
  const v = deliveryVerdict({
    inbound: [{ amount: 60_000n }, { amount: 40_000n }],
    expected: 100_000n,
    elapsedMs: 1000,
    etaMs: 90_000,
  });
  assert.equal(v.state, "delivered");
  assert.equal(v.delivered, 100_000n);
});

test("a genuine SHORT fill is distinguished from pending", () => {
  // Arrived, but less than promised — the one case that really is a problem
  // with the fill rather than with the clock or the query.
  const v = deliveryVerdict({
    inbound: [{ amount: 40_000n }],
    expected: 100_000n,
    elapsedMs: 120_000,
    etaMs: 90_000,
  });
  assert.equal(v.state, "short");
  assert.equal(v.delivered, 40_000n);
});

test("a partial fill still inside the eta is pending, not short", () => {
  const v = deliveryVerdict({
    inbound: [{ amount: 40_000n }],
    expected: 100_000n,
    elapsedMs: 5_000,
    etaMs: 90_000,
  });
  assert.equal(v.state, "pending");
});

test("delivering MORE than expected is delivered, not an anomaly", () => {
  const v = deliveryVerdict({
    inbound: [{ amount: 110_000n }],
    expected: 100_000n,
    elapsedMs: 1000,
    etaMs: 90_000,
  });
  assert.equal(v.state, "delivered");
});
