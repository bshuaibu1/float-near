/**
 * One place that decides how money is written on this dashboard.
 *
 * WHY THIS EXISTS
 *
 * The Overview page rendered `TOTAL SPENT $3.50` directly beside `AVG TX SIZE
 * $1.750`, and every sparkline label as `$0.000`. Two precisions for the same
 * currency, on one screen. Three decimals on a dollar reads as a tenth of a
 * cent, which is not a thing USDC has - and a user deciding whether a budget
 * is nearly spent should never have to work out which column lies.
 *
 * Nine `toFixed()` calls across three pages, each picking its own precision:
 * 2, 3, 4 and 6. None of them wrong on its own; collectively incoherent.
 *
 * TWO TYPES, AND THE DIFFERENCE MATTERS
 *
 *   usd()  - a DOLLAR VALUE. Always 2 decimals, trailing zeros kept, `$`
 *            prefix. "$1.75". Used wherever the `$` sign appears.
 *   usdc() - a TOKEN QUANTITY shown beside the symbol "USDC". Decimals are
 *            derived from what rounding would hide, then trailing zeros are
 *            trimmed, so "1.5 USDC" rather than "1.500000 USDC".
 *
 * They look similar and are not interchangeable: `$1.50` keeps its zero
 * because dollars always show cents; `1.5 USDC` drops it because a quantity
 * with trailing zeros is noise.
 *
 * NOTHING HERE TOUCHES MATH. Display only - every caller keeps its full
 * precision and formats at the edge.
 */

/** Rendered when a value is missing or not a number. Never "NaN", never a crash. */
export const NOT_AVAILABLE = "--";

/**
 * USDC's price, used to decide how many decimals a quantity needs.
 *
 * Hardcoded to 1 because it is a dollar stablecoin and this vault prices
 * everything in it. Named rather than inlined because a depeg makes this
 * wrong, and a future reader should find a decision here, not a magic 1.
 */
const USDC_PRICE_USD = 1;

type Context = "compact" | "detailed";

const isRenderable = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

/**
 * Round half AWAY FROM ZERO, which `toFixed` does not reliably do.
 *
 * `(1.005).toFixed(2)` is "1.00", because 1.005 is really 1.00499999... in
 * binary. And `Math.round(-2.5)` is -2 - half rounds toward +Infinity, so
 * negatives would round differently from their positive twins. Both produce
 * off-by-a-cent money.
 */
function round(n: number, dp: number): number {
  const factor = 10 ** dp;
  const scaled = n * factor;
  const nudged = Math.abs(scaled) * (1 + Number.EPSILON);
  return (Math.sign(scaled) * Math.round(nudged)) / factor;
}

/**
 * Thousands separators at a fixed precision, en-US.
 *
 * TAKES AN ALREADY-ROUNDED VALUE. It must, and the mutation suite is how I
 * found out: the first version passed `abs` straight in and let
 * `toLocaleString` round, which meant `round()` above was decorative on the
 * display path - only the tiny-marker check ever used it. Replacing the whole
 * rounding helper with a naive `toFixed` left every test green (M3 SURVIVED),
 * because Intl happened to round the way I wanted for the one value I tested.
 *
 * Relying on that is relying on an implementation detail of the platform's
 * number formatter to get money right. Callers now round explicitly, so the
 * rule lives in one readable place and a change to it actually fails a test.
 */
function group(rounded: number, dp: number): string {
  return Math.abs(rounded).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/**
 * K/M/B/T, one decimal, `.0` trimmed.
 *
 * Only for compact dollar values. A vault holding 1,250,000 USDC should read
 * "$1.3M" on a card; the exact figure belongs on the detail view.
 */
function abbreviate(abs: number): string | null {
  const UNITS: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of UNITS) {
    if (abs >= size) {
      const scaled = round(abs / size, 1);
      const text = scaled.toFixed(1).replace(/\.0$/, "");
      return `${text}${suffix}`;
    }
  }
  return null;
}

/**
 * A DOLLAR VALUE. `$` prefix, two decimals, always.
 *
 *   0        -> "$0.00"        zero is a real answer, not a blank
 *   0.004    -> "<$0.01"       it is NOT zero, and saying "$0.00" would lie
 *   1.75     -> "$1.75"
 *   1234.5   -> "$1,234.50"    detailed, or "$1.2K" compact
 *   null/NaN -> "--"
 *
 * The tiny marker is the rule that earns its keep: a spend of a third of a
 * cent displayed as "$0.00" tells the user nothing happened, when something
 * did.
 */
export function usd(
  value: number | null | undefined,
  ctx: Context = "detailed",
): string {
  if (!isRenderable(value)) return NOT_AVAILABLE;

  // Exact zero first, so it never reaches the tiny-marker branch below.
  if (value === 0) return "$0.00";

  const negative = value < 0;
  const abs = Math.abs(value);
  const sign = negative ? "-" : "";

  // Non-zero, but would print as $0.00. Say so rather than rounding the
  // fact away.
  if (round(abs, 2) === 0) return `${sign}<$0.01`;

  if (ctx === "compact" && abs >= 1000) {
    return `${sign}$${abbreviate(abs)}`;
  }

  return `${sign}$${group(round(abs, 2), 2)}`;
}

/**
 * A TOKEN QUANTITY, to be rendered beside the symbol.
 *
 * Decimals come from what rounding would hide, per the spec:
 *
 *     decimals = ceil(-log10(threshold / price))
 *
 * At USDC's $1 that is 2 for compact (hide less than a cent) and 4 for
 * detailed (hide less than a hundredth of a cent). Trailing zeros are then
 * trimmed, because "1.500000 USDC" is six characters of nothing.
 *
 * The formula is kept rather than collapsed to the constants it currently
 * produces: if this vault ever holds a token that is not a dollar, the right
 * behaviour should follow from the price, not from a rewrite.
 */
export function usdc(
  value: number | null | undefined,
  ctx: Context = "detailed",
): string {
  if (!isRenderable(value)) return NOT_AVAILABLE;
  if (value === 0) return "0";

  const threshold = ctx === "compact" ? 0.01 : 0.0001;
  const maxDecimals = ctx === "compact" ? 6 : 12;
  const decimals = Math.min(
    maxDecimals,
    Math.max(0, Math.ceil(-Math.log10(threshold / USDC_PRICE_USD))),
  );

  const negative = value < 0;
  const abs = Math.abs(value);
  const sign = negative ? "-" : "";
  const rounded = round(abs, decimals);

  // Rounds away to nothing, but is not nothing.
  if (rounded === 0) {
    return ctx === "compact" ? `${sign}<0.001` : `${sign}<${10 ** -decimals}`;
  }

  // Trim trailing zeros: a quantity does not owe you its cents.
  const text = group(rounded, decimals).replace(/\.?0+$/, "");
  return `${sign}${text}`;
}

/**
 * A PERCENTAGE. Two decimals by default, fewer as it grows.
 *
 * `<0.01%` matters for the same reason `<$0.01` does: a budget that is
 * 0.004% used is not an untouched budget.
 */
export function percent(
  value: number | null | undefined,
  opts: { decimals?: number } = {},
): string {
  if (!isRenderable(value)) return NOT_AVAILABLE;
  if (value === 0) return `${opts.decimals === 0 ? "0" : "0.00"}%`;

  const negative = value < 0;
  const abs = Math.abs(value);
  const sign = negative ? "-" : "";

  const dp =
    opts.decimals !== undefined ? opts.decimals : abs >= 1000 ? 0 : abs >= 100 ? 1 : 2;

  if (round(abs, dp) === 0) return `${sign}<${(10 ** -dp).toFixed(dp)}%`;
  return `${sign}${group(round(abs, dp), dp)}%`;
}
