import { describe, it, expect } from "vitest";
import { toBaseUnits, fromBaseUnits, humaniseTreeNode } from "./amounts.js";

// The contract speaks base units (USDC has 6 decimals); a human says "12.50".
// Every mis-scaling bug in this class is silent and off by a factor of ten, so
// the boundaries get a table rather than a spot check.

describe("toBaseUnits", () => {
  it("scales a whole number", () => {
    expect(toBaseUnits("12", 6)).toBe(12_000_000n);
  });

  it("scales a fractional number", () => {
    expect(toBaseUnits("12.5", 6)).toBe(12_500_000n);
  });

  it("pads a short fraction rather than left-shifting it", () => {
    // "0.1" with 6 decimals is 100000, NOT 1. Getting this wrong understates
    // every amount by a power of ten, which a cap check would happily allow.
    expect(toBaseUnits("0.1", 6)).toBe(100_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
  });

  it("accepts exactly `decimals` fractional digits", () => {
    expect(toBaseUnits("1.123456", 6)).toBe(1_123_456n);
  });

  // THE important one. Truncating here would silently send a different amount
  // than the human typed, and it would pass every on-chain check because the
  // contract never sees the original string.
  it("REJECTS more fractional digits than the token has, never truncates", () => {
    expect(() => toBaseUnits("1.1234567", 6)).toThrow(/too many decimal places/i);
  });

  it("keeps full precision on values far beyond Number.MAX_SAFE_INTEGER", () => {
    // 1e15 USDC in base units is ~1e21, which a float cannot represent. If
    // this path ever goes through Number, the low digits turn into zeroes.
    expect(toBaseUnits("123456789012345.123456", 6)).toBe(123_456_789_012_345_123_456n);
  });

  it("handles a zero", () => {
    expect(toBaseUnits("0", 6)).toBe(0n);
    expect(toBaseUnits("0.0", 6)).toBe(0n);
  });

  it("works for a 24-decimal token (NEAR)", () => {
    expect(toBaseUnits("1", 24)).toBe(10n ** 24n);
    expect(toBaseUnits("0.5", 24)).toBe(5n * 10n ** 23n);
  });

  it("works for a 0-decimal token", () => {
    expect(toBaseUnits("7", 0)).toBe(7n);
    expect(() => toBaseUnits("7.1", 0)).toThrow(/too many decimal places/i);
  });

  for (const bad of [
    "",
    " ",
    "-1",
    "-0.5",
    "abc",
    "1.2.3",
    "1,5",
    "1e6", // exponential would parse as a Number and lose the plot
    "Infinity",
    "NaN",
    ".5", // require a digit before the point, so the intent is unambiguous
    "1.",
    "+1",
    "0x10",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => toBaseUnits(bad, 6)).toThrow();
    });
  }
});

describe("fromBaseUnits", () => {
  it("round-trips", () => {
    for (const v of ["0", "1", "12.5", "0.000001", "123456789012345.123456"]) {
      expect(fromBaseUnits(toBaseUnits(v, 6), 6)).toBe(
        // round-trip is canonical, so "0.0" normalises to "0" and "12.50" to "12.5"
        v === "0" ? "0" : v,
      );
    }
  });

  it("does not print a trailing point for whole values", () => {
    expect(fromBaseUnits(12_000_000n, 6)).toBe("12");
  });

  it("pads the fraction so it is not misread", () => {
    // 1n with 6 decimals is 0.000001, not 0.1.
    expect(fromBaseUnits(1n, 6)).toBe("0.000001");
  });

  it("handles a 0-decimal token", () => {
    expect(fromBaseUnits(7n, 0)).toBe("7");
  });
});

/**
 * `vault_tree` MUST agree with `vault_budget` about what a cap is.
 *
 * `get_tree` returns base units. `get_node_budget` is converted. So the same
 * 25 USDC cap read through two tools rendered as "25000000" and "25", and
 * nothing said which was which — in a demo that reads as a bug even though
 * both were correct, and "25000000" invites the conclusion that the cap is
 * enormous.
 */
describe("humaniseTreeNode", () => {
  const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const cfg = { token: USDC, decimals: 6 };
  const node = (limits: unknown[], sums?: [string, string][]) =>
    ({ id: 0, label: "root", limits, ...(sums ? { child_cap_sum: sums } : {}) }) as never;

  it("converts the configured token's caps to human units", () => {
    const out = humaniseTreeNode(
      node([{ token: USDC, daily_cap: "25000000", per_tx_cap: "10000000" }]),
      cfg,
    );
    expect(out.limits![0]!.daily_cap).toBe("25");
    expect(out.limits![0]!.per_tx_cap).toBe("10");
    // Echoed so the base figure stays derivable — nothing is lost.
    expect((out.limits![0] as { decimals?: number }).decimals).toBe(6);
  });

  it("converts child_cap_sum too, or the allocation line disagrees with the caps", () => {
    const out = humaniseTreeNode(node([], [[USDC, "25000000"]]), cfg);
    expect(out.child_cap_sum![0]![1]).toBe("25");
  });

  /**
   * THE SAFETY PROPERTY. Caps are stored per token and this server knows the
   * decimals of exactly one. Scaling an unknown token by 6 would print a
   * number wrong by orders of magnitude while looking tidy — strictly worse
   * than the raw figure it replaced.
   */
  it("leaves an UNKNOWN token in base units and says so", () => {
    const out = humaniseTreeNode(
      node([{ token: "wrap.near", daily_cap: "25000000", per_tx_cap: "10000000" }]),
      cfg,
    );
    expect(out.limits![0]!.daily_cap).toBe("25000000");
    const l = out.limits![0] as { decimals?: number | null; units?: string };
    expect(l.decimals).toBeNull();
    expect(l.units).toBe("base");
  });

  it("converts nothing when no token is configured", () => {
    const out = humaniseTreeNode(
      node([{ token: USDC, daily_cap: "25000000", per_tx_cap: "10000000" }]),
      { decimals: 6 },
    );
    expect(out.limits![0]!.daily_cap).toBe("25000000");
  });

  it("passes an unparseable value through rather than blanking it", () => {
    // A figure the contract produced that will not parse is a fact worth
    // surfacing, not an exception to swallow into an empty string.
    const out = humaniseTreeNode(node([{ token: USDC, daily_cap: "", per_tx_cap: "10000000" }]), cfg);
    expect(out.limits![0]!.daily_cap).toBe("");
    expect(out.limits![0]!.per_tx_cap).toBe("10");
  });
});
