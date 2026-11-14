import { describe, expect, it } from "vitest";
import { utilisation } from "./utilisation";

describe("utilisation", () => {
  /**
   * THE REPORTED BUG, with the real figures off mainnet: 0.02 USDC spent
   * against the 25 USDC master budget. The API rounds that to 0, so the card
   * printed "0.02 spent today" next to "0%" and an empty bar — contradicting
   * itself on the one panel whose job is to show that a leaf agent's payment
   * charges the vault-wide pool.
   */
  it("a real spend never renders as 0% or an empty bar", () => {
    const u = utilisation("0.02", "25", 0);
    expect(u.label).toBe("<1%");
    expect(u.label).not.toBe("0%");
    expect(u.barWidth).toBeGreaterThan(0);
    // And the underlying number is still the truth, not rounded up.
    expect(u.pct).toBeCloseTo(0.08, 5);
  });

  it("the three live nodes each render honestly", () => {
    // root 0.02/25, news 0.02/3, headlines 0.02/0.5 — measured on mainnet.
    expect(utilisation("0.02", "25").label).toBe("<1%");
    expect(utilisation("0.02", "3").label).toBe("<1%");
    expect(utilisation("0.02", "0.5").label).toBe("4%");
  });

  /** Nothing spent is genuinely nothing; an empty bar is correct there. */
  it("zero spend is zero, with no sliver", () => {
    const u = utilisation("0", "25");
    expect(u.label).toBe("0%");
    expect(u.barWidth).toBe(0);
  });

  /**
   * The label must never overstate. Rounding 0.08 up to 1% to make the bar
   * agree would be a lie in the other direction.
   */
  it("never rounds a sub-1% figure up to 1%", () => {
    expect(utilisation("0.0001", "25").label).toBe("<1%");
    expect(utilisation("0.9", "100").label).toBe("<1%");
    // Exactly 1% is reported as 1%, not "<1%".
    expect(utilisation("1", "100").label).toBe("1%");
  });

  it("clamps a blown budget to 100 rather than overflowing the track", () => {
    const u = utilisation("40", "25");
    expect(u.pct).toBe(100);
    expect(u.barWidth).toBe(100);
    expect(u.label).toBe("100%");
  });

  /**
   * A ZERO CAP is not 0% used and not 100% — it is a node that cannot spend.
   * Dividing would yield NaN or Infinity and render a bar of garbage width.
   */
  it("survives a zero or missing cap without producing NaN", () => {
    for (const u of [
      utilisation("0.02", "0"),
      utilisation("0.02", undefined),
      utilisation(undefined, "25"),
      utilisation("abc", "25"),
    ]) {
      expect(Number.isFinite(u.pct), `pct was ${u.pct}`).toBe(true);
      expect(Number.isFinite(u.barWidth), `barWidth was ${u.barWidth}`).toBe(true);
      expect(u.barWidth).toBeGreaterThanOrEqual(0);
      expect(u.barWidth).toBeLessThanOrEqual(100);
    }
  });

  /** With no usable strings it falls back to the API's rounded figure. */
  it("falls back to the API percentage when the raw values are unusable", () => {
    expect(utilisation(undefined, undefined, 42).label).toBe("42%");
    expect(utilisation(undefined, undefined, 0).label).toBe("0%");
    // And a nonsense fallback is still clamped.
    expect(utilisation(undefined, undefined, 500).pct).toBe(100);
    expect(utilisation(undefined, undefined, -5).pct).toBe(0);
  });
});
