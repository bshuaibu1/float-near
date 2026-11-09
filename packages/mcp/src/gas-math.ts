/**
 * Gas-key arithmetic, mirrored from `create-float`'s `bin/gas-key.mjs`.
 *
 * WHY A MIRROR AND NOT AN IMPORT. `@floatonnear/create-float` does not depend
 * on `@floatonnear/mcp` and vice versa — they are siblings, published
 * separately, and installed independently by users. Adding a dependency in
 * either direction to share four lines of arithmetic would couple two release
 * cycles, and this repo has already lost an afternoon to a workspace range
 * that silently resolved to a PUBLISHED sibling instead of the local one.
 *
 * So it is duplicated DELIBERATELY, following the pattern already used for
 * `shared/contract-constants.json`: mirror the values, then make drift fail a
 * check. `scripts/check-gas-math.mjs` compares these constants against
 * create-float's and fails the gate if they diverge. A silent divergence here
 * would quote a user one number and charge them another.
 *
 * Every figure is a measurement; see gas-key.mjs for the provenance.
 */

/**
 * What NEAR holds for one in-flight call: `prepaid_gas x 1e9`, refunded a
 * receipt later. It is ~350x the real burn, so a key funded by expected cost
 * alone fails every call with NotEnoughBalance.
 */
export const gasReservation = (tgas: number): bigint => BigInt(tgas) * 10n ** 12n * 10n ** 9n;

/** The real cost of one `request_payment`, rounded up from measurement. */
export const PAYMENT_BURN = 12n * 10n ** 20n;

/** The vault's MIN_GAS_FOR_DISPATCH. Below it a call is refused before anything happens. */
export const MIN_TGAS = 50;

/**
 * What to ADD so the key can make `payments` MORE calls.
 *
 * The reservation is charged once for the key's life, not once per top-up, so
 * this is NOT reservation + burn x payments — that would overcharge by a full
 * reservation every time. A depleted key (below the reservation, unable to
 * transact at all) is lifted back over that line first.
 */
export function topUpFor({
  balance = 0n,
  tgas = 60,
  payments = 50,
}: { balance?: bigint; tgas?: number; payments?: number } = {}): bigint {
  if (tgas < MIN_TGAS) throw new Error(`tgas must be at least ${MIN_TGAS}`);
  if (payments < 0) throw new Error("payments cannot be negative");
  const have = BigInt(balance);
  const reservation = gasReservation(tgas);
  const shortfall = have >= reservation ? 0n : reservation - have;
  return shortfall + PAYMENT_BURN * BigInt(payments);
}

/**
 * The inverse: TOTAL payments possible once `amount` is added.
 *
 * ZERO IS A REAL ANSWER. A key that still cannot cover one reservation makes
 * NO calls, not "a few" — every call fails NotEnoughBalance, which reads as a
 * broken agent rather than an underfunded one.
 */
export function paymentsAfterTopUp({
  balance = 0n,
  tgas = 60,
  amount = 0n,
}: { balance?: bigint; tgas?: number; amount?: bigint } = {}): number {
  if (tgas < MIN_TGAS) throw new Error(`tgas must be at least ${MIN_TGAS}`);
  const spendable = BigInt(balance) + BigInt(amount) - gasReservation(tgas);
  if (spendable <= 0n) return 0;
  return Number(spendable / PAYMENT_BURN);
}
