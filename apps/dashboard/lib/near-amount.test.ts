/**
 * NEAR decimal strings to yoctoNEAR.
 *
 * THE FIRST VERSION OF THIS FILE JUSTIFIED ITSELF WRONGLY, and the real
 * reason is worse than the one it claimed.
 *
 * It said `BigInt(Number(n) * 1e24)` throws, because the product is not an
 * integer. It does not throw: every double above 2^52 IS an integer, and
 * for 0.06 — this component's default — the float route lands on exactly
 * the right answer. So the "obvious" implementation passes the one test
 * anyone would write first.
 *
 * Measured across realistic inputs it is wrong for 8 of 10, silently:
 *
 *   1     NEAR -> 999999999999999983222784   (16,777,216 yocto short)
 *   3.348 NEAR -> 3347999999999999924502528  (the create page's own figure)
 *   0.1   NEAR -> 100000000000000008388608
 *
 * A quiet wrong number attached to a transaction is precisely what a wallet
 * confirmation cannot catch, because the wallet renders what it was handed.
 * These tests compare against the float route directly, so the claim is
 * evidence rather than assertion.
 */
import { describe, it, expect } from "vitest";
import { nearToYocto } from "../components/bind-agent";

describe("nearToYocto", () => {
  /**
   * The component default, and the value that makes the float route look
   * fine. Pinned so nobody "simplifies" back to arithmetic on the strength
   * of this one passing.
   */
  it("converts the gas-funding minimum exactly", () => {
    expect(nearToYocto("0.06")).toBe("60000000000000000000000");
    // And here the float route agrees — which is the trap.
    expect(BigInt(0.06 * 1e24).toString()).toBe("60000000000000000000000");
  });

  /**
   * THE EVIDENCE, not the assertion. Each of these is a value the float
   * route gets wrong, compared against it directly so the test fails if
   * that ever stops being true rather than carrying a stale claim.
   */
  it("is exact where float arithmetic silently is not", () => {
    const wrongViaFloat: Array<[string, string]> = [
      ["1", "1000000000000000000000000"],
      ["3.348", "3348000000000000000000000"],
      ["0.1", "100000000000000000000000"],
      ["0.3", "300000000000000000000000"],
      ["2.5", "2500000000000000000000000"],
    ];
    for (const [near, exact] of wrongViaFloat) {
      expect(nearToYocto(near), `${near} NEAR`).toBe(exact);
      expect(
        BigInt(Number(near) * 1e24).toString(),
        `${near} is no longer a case float gets wrong; the premise has moved`,
      ).not.toBe(exact);
    }
  });

  it("handles whole numbers", () => {
    expect(nearToYocto("1")).toBe("1000000000000000000000000");
    expect(nearToYocto("0")).toBe("0");
    expect(nearToYocto("10")).toBe("10000000000000000000000000");
  });

  it("handles a leading dot and trailing zeros", () => {
    expect(nearToYocto("0.1")).toBe("100000000000000000000000");
    expect(nearToYocto("0.100")).toBe("100000000000000000000000");
    expect(nearToYocto("1.000000")).toBe("1000000000000000000000000");
  });

  /** 24 decimal places is exact; anything past it is truncated, not rounded
   *  up — erring toward funding slightly less than asked rather than more. */
  it("truncates past 24 decimals rather than overflowing", () => {
    // 30 decimal places in, 24 out — and under 1 NEAR, so nothing carried.
    const out = nearToYocto(`0.${"1".repeat(30)}`);
    expect(out).toBe("1".repeat(24));
    expect(BigInt(out) < BigInt(10) ** BigInt(24)).toBe(true);
  });

  it("is exact at values a double could not represent", () => {
    // 0.1 + 0.2 territory: three values that float arithmetic disagrees on.
    expect(nearToYocto("0.1")).toBe("100000000000000000000000");
    expect(nearToYocto("0.2")).toBe("200000000000000000000000");
    expect(nearToYocto("0.3")).toBe("300000000000000000000000");
  });

  it("tolerates surrounding whitespace, as a pasted value has", () => {
    expect(nearToYocto("  0.06  ")).toBe("60000000000000000000000");
  });
});
