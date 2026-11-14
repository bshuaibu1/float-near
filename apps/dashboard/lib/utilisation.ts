/**
 * How full a budget is — for a bar a person reads, not for arithmetic.
 *
 * WHY THIS EXISTS. The API sends `dailyBudgetUsedPercent` already rounded to
 * an integer, so a real payment of 0.02 USDC against a 25 USDC master budget
 * arrives as **0**. The page then rendered "0%" beside an empty track while
 * the line above it said "0.02 spent today" — the same card contradicting
 * itself, and the user reasonably read the bar as broken.
 *
 * It is the worst possible place for that. The master bar exists to show the
 * ONE thing that makes this product different: a payment is charged at every
 * level of the tree, so a leaf agent's spend moves the vault-wide pool too. At
 * realistic amounts — a tenth of a cent against a 25 USDC ceiling — that proof
 * renders as nothing at all.
 *
 * TWO SEPARATE NUMBERS, deliberately. The *label* must never overstate: a
 * budget that is 0.08% used is not 1% used, and rounding up to make the bar
 * agree would be a lie in the other direction. So the label says `<1%` and the
 * BAR gets a minimum visible width. The bar is a signal that something moved;
 * the label is the fact.
 *
 * Computed from the raw `spent` and `cap` strings the page already receives,
 * rather than from the rounded percentage — precision the API threw away
 * cannot be recovered downstream, and both values were there all along.
 */

/** A minimum width, in %, so a non-zero spend is visible rather than implied. */
const MIN_VISIBLE_WIDTH = 1.5;

export interface Utilisation {
  /** The true percentage, clamped to 0..100. Unrounded. */
  pct: number;
  /** What to set the bar's width to. Never 0 when anything has been spent. */
  barWidth: number;
  /** What to print. Never "0%" when money has actually moved. */
  label: string;
}

/**
 * `spent` and `cap` are human-unit decimal strings ("0.02", "25"), the same
 * form the page prints. `fallbackPct` is the API's rounded value, used only
 * when the strings are missing or unparseable.
 */
export function utilisation(
  spent: string | undefined,
  cap: string | undefined,
  fallbackPct?: number,
): Utilisation {
  const s = Number(spent);
  const c = Number(cap);

  /**
   * A ZERO CAP IS NOT 0% USED, and it is not 100% either — it is a node that
   * cannot spend at all. Falling through to a division would produce NaN or
   * Infinity and render a bar of garbage width, so it is handled before the
   * arithmetic rather than patched after it.
   */
  const usable = Number.isFinite(s) && Number.isFinite(c) && c > 0 && s >= 0;
  const raw = usable ? (s / c) * 100 : Math.max(0, Math.min(fallbackPct ?? 0, 100));
  const pct = Math.max(0, Math.min(raw, 100));

  // Nothing spent is genuinely nothing: an empty bar is correct here.
  if (pct === 0) return { pct: 0, barWidth: 0, label: "0%" };

  return {
    pct,
    barWidth: Math.max(pct, MIN_VISIBLE_WIDTH),
    // Below 1% the honest label is "<1%" — "0%" contradicts the spend shown
    // beside it, and "1%" overstates. Above it, a whole number is what people
    // read a bar as anyway.
    label: pct < 1 ? "<1%" : `${Math.round(pct)}%`,
  };
}
