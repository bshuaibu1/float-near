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

/**
 * The contract speaks BASE UNITS; a person reading a budget does not.
 *
 * `get_tree` returns `daily_cap: "25000000"` for a 25 USDC cap, while
 * `vault_budget` — reading the same number through `get_node_budget` — returns
 * `"25"`. Two tools, one vault, one figure, two formats, and nothing said
 * which was which. In a demo that reads as a bug even when both are correct,
 * and `"25000000"` next to a `per_tx_cap` of `"10000000"` invites someone to
 * conclude the caps are enormous.
 *
 * CONVERTED ONLY WHERE THE DECIMALS ARE KNOWN. Caps are stored PER TOKEN and a
 * vault may hold limits for several, but this server knows the decimals of
 * exactly one — `NEAR_VAULT_TOKEN_DECIMALS`, which describes
 * `NEAR_VAULT_TOKEN`. Scaling some other token by 6 would print a number that
 * is wrong by orders of magnitude while looking tidy, which is strictly worse
 * than the raw figure it replaced. So a token we cannot vouch for keeps its
 * base units and says so, rather than being guessed at.
 *
 * `decimals` is echoed on every converted entry so the base figure stays
 * derivable; nothing is lost, it is only no longer the default reading.
 */
export interface TreeLimit {
  token: string;
  daily_cap: string;
  per_tx_cap: string;
}
export interface TreeNode {
  limits?: TreeLimit[];
  child_cap_sum?: [string, string][];
  [k: string]: unknown;
}

export function humaniseTreeNode(
  node: TreeNode,
  cfg: { token?: string; decimals: number },
): TreeNode {
  if (!node || typeof node !== "object") return node;
  const known = (token: string) => !!cfg.token && token === cfg.token;
  const human = (v: string) => {
    // EXPLICIT SHAPE CHECK, because `BigInt("")` is `0n` rather than a throw —
    // and `BigInt("  ")` is too. A try/catch alone therefore converted an
    // empty or whitespace cap into "0", which is not a parse failure the
    // reader can see: "0" is a meaningful budget, and the wrong one. Caught by
    // its own test, which is the only reason this is not shipping.
    if (typeof v !== "string" || !/^\d+$/.test(v)) return v;
    try {
      return fromBaseUnits(BigInt(v), cfg.decimals);
    } catch {
      // Still guarded: fromBaseUnits rejects decimals outside its own range,
      // and a figure the contract produced is a fact worth surfacing
      // unchanged rather than an exception to swallow.
      return v;
    }
  };

  const limits = node.limits?.map((l) =>
    known(l.token)
      ? { ...l, daily_cap: human(l.daily_cap), per_tx_cap: human(l.per_tx_cap), decimals: cfg.decimals }
      : { ...l, decimals: null, units: "base" as const },
  );

  const childCapSum = node.child_cap_sum?.map(
    ([token, amount]) =>
      (known(token) ? [token, human(amount)] : [token, amount]) as [string, string],
  );

  return {
    ...node,
    ...(limits ? { limits } : {}),
    ...(childCapSum ? { child_cap_sum: childCapSum } : {}),
  };
}

