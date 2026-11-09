import { describe, it, expect } from "vitest";
import { networkForOwner } from "./network-for-owner";

/**
 * Routing a wallet to the wrong chain is the shape of bug this repo produced
 * three times in one day: an unknown or a failure became a confident answer.
 *
 * Here the stakes are concrete. `usefloat.near` was verified live, and MCP
 * 0.6.0 still told users it did not exist — because it asked the TESTNET RPC
 * about a mainnet account. The chain you ask is not a detail.
 */
describe("networkForOwner", () => {
  it("places a mainnet wallet on mainnet", () => {
    expect(networkForOwner("demo.near")).toBe("mainnet");
    expect(networkForOwner("bashir.near")).toBe("mainnet");
    // Sub-accounts are still mainnet; a vault IS one of these.
    expect(networkForOwner("demo-near.usefloat.near")).toBe("mainnet");
  });

  it("places a testnet wallet on testnet", () => {
    expect(networkForOwner("work12.testnet")).toBe("testnet");
    expect(networkForOwner("flatdata6673-testnet.fac.floatv4.testnet")).toBe("testnet");
  });

  it("the two suffixes cannot shadow each other", () => {
    // `.testnet` does not end with `.near`, so neither rule can swallow the
    // other. Pinned because a careless `endsWith(".net")` would break it.
    expect(networkForOwner("a.testnet")).not.toBe(networkForOwner("a.near"));
  });

  it("refuses an IMPLICIT account rather than guessing", () => {
    // 64 hex, no suffix. It cannot have a vault under any factory, so there
    // is nothing to route — and picking a chain for it would be invention.
    expect(networkForOwner("a".repeat(64))).toBeNull();
    expect(networkForOwner("0123456789abcdef".repeat(4))).toBeNull();
  });

  it("returns null rather than defaulting to testnet for anything it cannot place", () => {
    // THE WHOLE POINT. A default here would route a wallet to a chain it does
    // not live on and report the resulting emptiness as fact.
    for (const bad of ["", "   ", "near", "testnet", "alice.sweat", "alice", "alice.near.evil"]) {
      expect(networkForOwner(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(networkForOwner(null)).toBeNull();
    expect(networkForOwner(undefined)).toBeNull();
  });

  it("is case- and whitespace-insensitive, because a URL is not a protocol", () => {
    // NEAR ids are lowercase by rule, but a query string is typed by humans
    // and pasted by wallets.
    expect(networkForOwner("  Demo.NEAR  ")).toBe("mainnet");
    expect(networkForOwner("WORK12.Testnet")).toBe("testnet");
  });
});
