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
 *     deliver   0.050000 -> charged   0.052943   (5.89%)  <- see the caveat
 *     deliver   0.100000 -> charged   0.103458   (3.46%)  <- see the caveat
 *     deliver   0.250000 -> charged   0.255004   (2.00%)  <- exactly at the limit
 *     deliver   0.500000 -> charged   0.507579   (1.52%)
 *     deliver   1.000000 -> charged   1.012733   (1.27%)
 *     deliver   9.890000 -> charged   9.994343   (fits a 10 cap)
 *     deliver   9.900000 -> charged  10.004446   (does NOT)
 *     deliver  10.000000 -> charged  10.105478   (1.05%)
 *     deliver  50.000000 -> charged  50.517682
 *     deliver  60.000000 -> charged  60.620733
 *     deliver 100.000000 -> charged 101.032936   (1.03%)
 *
 * THE 2% ALONE DOES NOT COVER SMALL SIZES, and the cent-rounding in
 * xchainCap() is what does. An earlier version of this comment claimed 2% was
 * "above the measured worst case" on the strength of 0.50 being the smallest
 * size measured; extending the measurement downward showed the spread is not
 * asymptotic but climbs as the fixed part of a solver's cost dominates.
 *
 * Measured against the derived cap rather than the raw constant:
 *
 *     deliver  cap    effective headroom   spread   cap covers   bare 2% covers
 *       0.05   0.06          20.00%         5.89%       yes            NO
 *       0.10   0.11          10.00%         3.46%       yes            NO
 *       0.25   0.26           4.00%         2.00%       yes            NO
 *       0.50   0.51           2.00%         1.52%       yes            yes
 *       1.00   1.02           2.00%         1.27%       yes            yes
 *     100.00 102.00           2.00%         1.03%       yes            yes
 *
 * Rounding UP to the cent therefore contributes headroom that GROWS as the
 * amount shrinks, which is exactly the shape the spread needs. That makes the
 * rounding load-bearing rather than hygiene, and
 * "the derived cap covers small sizes too, which the bare 2% does NOT" in
 * test/xchain.test.mjs is what stops someone relaxing it to Math.round.
 *
 * Within the range where the constant does the work (0.50 and up) 2% is
 * deliberately above the worst case rather than near the converged figure:
 * under-reserving produces a refused payment, while over-reserving costs
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
