/**
 * The cases are taken from the formatting spec's examples table, plus the
 * ones this dashboard actually got wrong.
 *
 * The bug that started it is the first test: `$1.750` and `$0.000` rendered
 * on the Overview page beside `$3.50`.
 */
import { describe, it, expect } from "vitest";
import { usd, usdc, percent, NOT_AVAILABLE } from "./money";

describe("usd - a dollar value", () => {
  /**
   * THE REGRESSION. Three decimals on a dollar reads as a tenth of a cent.
   * These exact strings were on screen.
   */
  it("always shows exactly two decimals, whatever the input precision", () => {
    expect(usd(1.75)).toBe("$1.75");
    expect(usd(3.5)).toBe("$3.50");
    expect(usd(2.5)).toBe("$2.50");
    expect(usd(1)).toBe("$1.00");
  });

  it("renders zero as a real number, not a blank", () => {
    expect(usd(0)).toBe("$0.00");
  });

  /**
   * A third of a cent is not zero. Printing "$0.00" would tell the user no
   * money moved, when some did - the one error a spend display must not make.
   */
  it("marks a value that is NOT zero but rounds to it", () => {
    expect(usd(0.004)).toBe("<$0.01");
    expect(usd(-0.004)).toBe("-<$0.01");
    expect(usd(0.0000001)).toBe("<$0.01");
  });

  it("separates thousands when showing the full value", () => {
    expect(usd(1234.5)).toBe("$1,234.50");
    expect(usd(1234567.89)).toBe("$1,234,567.89");
  });

  it("abbreviates only in compact context", () => {
    expect(usd(1234.5, "compact")).toBe("$1.2K");
    expect(usd(1250000, "compact")).toBe("$1.3M");
    expect(usd(1.52e12, "compact")).toBe("$1.5T");
    expect(usd(1234.5, "detailed")).toBe("$1,234.50");
  });

  it("trims a bare .0 off an abbreviation", () => {
    expect(usd(2000, "compact")).toBe("$2K");
  });

  /**
   * WHY COMPACT IS THE ONE THE CARDS USE: it is BOUNDED, and detailed is not.
   *
   * The Overview's four stat cards are a quarter of the page wide. Measured
   * in the browser at 375px, a card was 69px across with 48px of its own
   * padding, so `$3.50` — which needs 74px at 28px semibold — rendered 54px
   * past the card's border and the user read "$3.5". A smaller number.
   *
   * Widening the grid moves that cliff; it does not remove it. The property
   * that removes it is this one: across the whole realistic range of a USDC
   * vault, from a third of a cent to a trillion dollars, compact never
   * exceeds EIGHT characters. Detailed reaches sixteen for the same inputs.
   * A layout can be designed against eight. It cannot be designed against
   * "however long the next value turns out to be".
   */
  it("keeps a compact dollar figure to 8 characters or fewer", () => {
    const CEILING = 8;
    const values = [
      0, 0.004, 0.01, 1, 9.99, 10, 99.99, 100, 999.99, 1000, 1234.5, 9999,
      12345.6, 99999, 999999, 1e6, 1250000, 9.99e6, 1e9, 999.9e9, 1e11, 999.4e9,
    ];
    const worst: Array<{ input: number; out: string }> = [];
    for (const v of values) {
      for (const n of [v, -v]) {
        const out = usd(n, "compact");
        if (out.length > CEILING) worst.push({ input: n, out });
      }
    }
    expect(worst).toEqual([]);

    // POSITIVE CONTROL. A ceiling no output can breach proves nothing, so
    // confirm the same sweep DOES breach it in detailed, which is exactly
    // why the cards may not use detailed.
    const detailedOverflows = values
      .map((v) => usd(v, "detailed"))
      .filter((s) => s.length > CEILING);
    expect(detailedOverflows.length).toBeGreaterThan(0);
    expect(usd(999.9e9, "detailed")).toBe("$999,900,000,000.00"); // 19 characters
  });

  /**
   * AND THE EDGE WHERE THE BOUND STOPS HOLDING, stated rather than left to
   * be discovered. `abbreviate` has no unit above T, so past a thousand
   * trillion it grows without limit again. No USDC vault reaches it — the
   * token's entire supply is around $6e10 — but a reader who trusts the
   * eight-character bound should know where it ends.
   *
   * Note the digits run together: `$1000T`, not `$1,000T`. `abbreviate`
   * formats with `toFixed`, which does not group, where every other path
   * through `usd` goes via `group()` and does. Both of those were guessed
   * wrong when this test was first written and corrected from the output,
   * which is the whole reason the exact strings are pinned here.
   */
  it("has no unit above T, so it is unbounded past a quadrillion", () => {
    expect(usd(1e15, "compact")).toBe("$1000T");
    expect(usd(1e18, "compact")).toBe("$1000000T");
  });

  it("puts the sign outside the dollar sign", () => {
    expect(usd(-42.5)).toBe("-$42.50");
  });

  /**
   * Rule 4 of the spec, and the reason this is not just `toFixed(2)`:
   * 1.005 is 1.00499999... in binary, so `(1.005).toFixed(2)` is "$1.00" -
   * a cent, silently lost.
   */
  it("rounds half AWAY FROM ZERO, which toFixed does not", () => {
    expect(usd(1.005)).toBe("$1.01");
    expect(usd(-1.005)).toBe("-$1.01");
    expect(usd(2.675)).toBe("$2.68");
  });

  it("never renders NaN, Infinity, null or undefined", () => {
    expect(usd(null)).toBe(NOT_AVAILABLE);
    expect(usd(undefined)).toBe(NOT_AVAILABLE);
    expect(usd(NaN)).toBe(NOT_AVAILABLE);
    expect(usd(Infinity)).toBe(NOT_AVAILABLE);
    expect(usd(-Infinity)).toBe(NOT_AVAILABLE);
  });

  /** Signed zero is forbidden: -0 must not print as "-$0.00". */
  it("refuses to render a negative zero", () => {
    expect(usd(-0)).toBe("$0.00");
    expect(usd(0)).not.toContain("-");
  });
});

describe("usdc - a token quantity", () => {
  /** `1.500000 USDC` was on the payment detail view. */
  it("trims trailing zeros, because a quantity does not owe you cents", () => {
    expect(usdc(1.5)).toBe("1.5");
    expect(usdc(2)).toBe("2");
    expect(usdc(1.25)).toBe("1.25");
  });

  it("renders zero as a bare 0, not 0.00", () => {
    expect(usdc(0)).toBe("0");
  });

  it("uses fewer decimals in a table than on a detail view", () => {
    // compact hides below a cent, detailed below a hundredth of one
    expect(usdc(1.23456, "compact")).toBe("1.23");
    expect(usdc(1.23456, "detailed")).toBe("1.2346");
  });

  it("marks a quantity that rounds away to nothing", () => {
    expect(usdc(0.000001, "compact")).toBe("<0.001");
    expect(usdc(0.000001, "detailed")).toBe("<0.0001");
  });

  it("separates thousands", () => {
    expect(usdc(125234.5)).toBe("125,234.5");
  });

  it("never renders NaN, Infinity, null or undefined", () => {
    expect(usdc(null)).toBe(NOT_AVAILABLE);
    expect(usdc(NaN)).toBe(NOT_AVAILABLE);
    expect(usdc(Infinity)).toBe(NOT_AVAILABLE);
  });

  /**
   * usd() and usdc() are NOT interchangeable, and the difference is visible
   * on exactly the values that look most alike.
   */
  it("differs from usd() on the same input, deliberately", () => {
    expect(usd(1.5)).toBe("$1.50");
    expect(usdc(1.5)).toBe("1.5");
    expect(usd(2)).toBe("$2.00");
    expect(usdc(2)).toBe("2");
  });
});

describe("percent", () => {
  it("defaults to two decimals", () => {
    expect(percent(12.345)).toBe("12.35%");
  });

  it("sheds decimals as the magnitude grows", () => {
    expect(percent(123.456)).toBe("123.5%");
    expect(percent(10250.4)).toBe("10,250%");
  });

  it("marks a non-zero that rounds to zero", () => {
    expect(percent(0.004)).toBe("<0.01%");
  });

  it("honours an explicit decimal count, for progress bars", () => {
    expect(percent(0, { decimals: 0 })).toBe("0%");
    expect(percent(42.6, { decimals: 0 })).toBe("43%");
  });

  it("never renders NaN or null", () => {
    expect(percent(null)).toBe(NOT_AVAILABLE);
    expect(percent(NaN)).toBe(NOT_AVAILABLE);
  });
});
