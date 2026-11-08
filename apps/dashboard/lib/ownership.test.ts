/**
 * The adapter serves ONE vault and ignores who is asking, so connecting any
 * wallet rendered whatever vault it was pointed at with nothing saying whose
 * it was. These pin the condition that catches that.
 *
 * The bar is not "does it compare two strings". It is the three ways a naive
 * comparison hurts someone: locking an owner out of their own vault over
 * letter case, treating "I could not check" as "it is not yours", and firing
 * before a wallet is even connected.
 */
import { describe, it, expect } from "vitest";
import { ownershipVerdict } from "./ownership";

describe("ownershipVerdict", () => {
  it("shows the dashboard when the connected wallet owns the vault", () => {
    expect(
      ownershipVerdict({ connected: "work12.testnet", vaultOwner: "work12.testnet" }),
    ).toEqual({ show: true });
  });

  it("REFUSES when the vault belongs to someone else, and names who", () => {
    // The case that existed: a convincing screenful of someone else's money.
    const v = ownershipVerdict({
      connected: "alice.testnet",
      vaultOwner: "work12.testnet",
    });
    expect(v.show).toBe(false);
    // Both names must survive into the verdict — "not yours" without saying
    // whose leaves the reader unable to tell a misconfiguration from a bug.
    if (!v.show) {
      expect(v.connected).toBe("alice.testnet");
      expect(v.vaultOwner).toBe("work12.testnet");
    }
  });

  /**
   * UNKNOWN IS NOT A MISMATCH. Blocking on "could not check" would make every
   * adapter hiccup look like a theft warning, and a warning that cries wolf is
   * one people learn to click past — the same failure the stale-stamp and
   * scan-coverage guards were each built to avoid.
   */
  it("does not fire before a wallet is connected", () => {
    expect(ownershipVerdict({ connected: null, vaultOwner: "work12.testnet" })).toEqual({
      show: true,
    });
    expect(ownershipVerdict({ connected: "", vaultOwner: "work12.testnet" })).toEqual({
      show: true,
    });
  });

  it("does not fire when the adapter reported no owner", () => {
    expect(ownershipVerdict({ connected: "work12.testnet", vaultOwner: null })).toEqual({
      show: true,
    });
    expect(ownershipVerdict({ connected: "work12.testnet" })).toEqual({ show: true });
  });

  /**
   * THE WAY THIS WOULD HURT A REAL OWNER. NEAR ids are lowercase by protocol
   * rule, but a wallet or a pasted URL can hand back mixed case. Comparing raw
   * would lock someone out of their OWN vault — worse than the bug being
   * fixed, because it hits the person who did nothing wrong.
   */
  it("treats case differences as the same account, not a mismatch", () => {
    expect(
      ownershipVerdict({ connected: "Work12.Testnet", vaultOwner: "work12.testnet" }),
    ).toEqual({ show: true });
  });

  it("ignores surrounding whitespace, which a pasted value carries", () => {
    expect(
      ownershipVerdict({ connected: "  work12.testnet  ", vaultOwner: "work12.testnet" }),
    ).toEqual({ show: true });
  });

  /** Two genuinely different accounts that merely look similar must still trip it. */
  it("does not confuse similar account names", () => {
    expect(
      ownershipVerdict({ connected: "work12.testnet", vaultOwner: "work123.testnet" }).show,
    ).toBe(false);
    expect(
      ownershipVerdict({ connected: "work12.near", vaultOwner: "work12.testnet" }).show,
    ).toBe(false);
  });
});
