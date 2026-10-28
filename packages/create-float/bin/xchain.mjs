/**
 * Cross-chain cap sizing, extracted so it can be tested.
 *
 * It lives here rather than inside create-float.mjs because that file calls
 * `main()` unconditionally at the bottom, so importing it from a test would
 * launch the wizard. The alternative — guarding main with an
 * `import.meta.url === process.argv[1]` check — is riskier than it looks:
 * `npx @near-vault/create-float` runs through a bin shim where argv[1] can be
 * a symlink that does not match import.meta.url, and the failure mode is the
 * wizard silently doing NOTHING for installed users while still working from a
 * clone. A separate module costs one import and cannot break the entry point.
 *
 * WHY A CAP IS NOT WHAT IT LOOKS LIKE ON THE INTENTS RAIL. 1Click quotes
 * EXACT_OUTPUT: the `amount` requested is what the PAYEE receives, and the
 * vault is charged the quote's `amountIn` — solver fee plus a slippage
 * reserve. The budget tree is charged that larger figure, which is correct,
 * because a cap exists to bound what actually leaves. The consequence is that
 * a per-tx cap of 10 does NOT permit delivering 10 cross-chain, and the
 * refusal arrives as PER_TX_LIMIT from the operator's own budget with nothing
 * in it mentioning a solver.
 *
 * MEASURED against the live API on 2026-10-28, dry quotes, NEAR USDC -> Base
 * USDC. The spread converges to ~1.03% and is WORST at small sizes, because
 * most of it is the 100 bps slippageTolerance held as headroom rather than fee:
 *
 *     deliver   0.500000 -> charged   0.507579   (1.52%)
 *     deliver   9.890000 -> charged   9.994343   (fits a 10 cap)
 *     deliver   9.900000 -> charged  10.004446   (does NOT)
 *     deliver  10.000000 -> charged  10.105478   (1.05%)
 *     deliver  50.000000 -> charged  50.517682
 *     deliver  60.000000 -> charged  60.620733
 *     deliver 100.000000 -> charged 101.032936   (1.03%)
 *
 * 2% is deliberately ABOVE that worst case rather than near the converged
 * figure. Under-reserving produces a refused payment; over-reserving costs
 * nothing unless a payment is actually that large.
 *
 * NOT A PROTOCOL CONSTANT. Nothing validates against it, no contract reads it,
 * and the contract is already correct — it charges amountIn either way. This
 * only decides what default caps the wizard suggests and what it prints.
 * Slippage tolerance and market depth both move the real number, which is why
 * it is not compiled into anything. Re-measure with
 * `node --experimental-strip-types scripts/oneclick-probe.mjs`.
 */
export const XCHAIN_HEADROOM = 0.02;

/** The most a given cap can actually deliver cross-chain, conservatively. */
export const xchainCeiling = (cap) => cap / (1 + XCHAIN_HEADROOM);

/**
 * The inverse: a cap that lets `desired` be DELIVERED cross-chain.
 *
 * Rounded UP to the cent. Rounding down would shave the headroom back off and
 * reintroduce the refusal this exists to avoid; at 6dp the extra fraction of a
 * cent is free, and since a cap is a ceiling, erring high is the harmless
 * direction for the amount it is sized to permit.
 */
export const xchainCap = (desired) =>
  Math.ceil(desired * (1 + XCHAIN_HEADROOM) * 100) / 100;
