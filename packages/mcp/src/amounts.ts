/**
 * Human decimal strings <-> integer base units.
 *
 * Everything here goes through BigInt and string manipulation, never `Number`.
 * A 6-decimal token amount above ~9 billion already exceeds
 * Number.MAX_SAFE_INTEGER in base units, and the failure mode of a float path
 * is silent: the low digits become zeroes, the contract receives a different
 * amount than the human typed, and every on-chain cap check passes because the
 * contract never saw the original string.
 */

/** `123` or `123.456`. No sign, no exponent, no separators, no bare point. */
const DECIMAL = /^\d+(\.\d+)?$/;

const MAX_DECIMALS = 38;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(`decimals must be an integer in 0..=${MAX_DECIMALS}, got ${decimals}`);
  }
}

/**
 * Parse a human amount into base units.
 *
 * Throws rather than truncating when the input carries more fractional digits
 * than the token supports. Truncating would send an amount the human did not
 * ask for, and nothing downstream could detect it.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (typeof amount !== "string") {
    throw new Error("amount must be a string, so no float precision is lost before parsing");
  }
  if (!DECIMAL.test(amount)) {
    throw new Error(
      `invalid amount ${JSON.stringify(amount)}: expected digits with an optional ` +
        `single decimal point, e.g. "12" or "12.50" (no sign, exponent, or separators)`,
    );
  }

  const [whole = "", frac = ""] = amount.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `too many decimal places in ${JSON.stringify(amount)}: the token has ${decimals}, ` +
        `the amount has ${frac.length}. Refusing to truncate — round it yourself and resend.`,
    );
  }

  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Render base units as a canonical human string: no trailing point, no trailing zeroes. */
export function fromBaseUnits(units: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (units < 0n) throw new Error("base units must not be negative");
  if (decimals === 0) return units.toString();

  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  // padStart matters: 1n at 6 decimals is 0.000001, and an unpadded remainder
  // would render it as 0.1.
  const frac = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
