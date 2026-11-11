import { describe, expect, it, beforeEach } from "vitest";
import { clearTokenMetaCache, label, tokenMeta } from "./token-meta.js";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

describe("tokenMeta", () => {
  beforeEach(() => clearTokenMetaCache());

  it("returns the symbol and decimals the chain reports", async () => {
    const m = await tokenMeta("rpc", USDC, async () => ({ symbol: "USDC", decimals: 6 }));
    expect(m).toEqual({ symbol: "USDC", decimals: 6 });
  });

  it("caches, so a budget read does not re-fetch per node", async () => {
    let calls = 0;
    const view = async () => {
      calls++;
      return { symbol: "USDC", decimals: 6 };
    };
    await tokenMeta("rpc", USDC, view);
    await tokenMeta("rpc", USDC, view);
    expect(calls).toBe(1);
  });

  it("caches a FAILURE too, or one bad id becomes a storm", async () => {
    let calls = 0;
    const view = async () => {
      calls++;
      throw new Error("not a token");
    };
    expect(await tokenMeta("rpc", "nope.near", view)).toBeNull();
    expect(await tokenMeta("rpc", "nope.near", view)).toBeNull();
    expect(calls).toBe(1);
  });

  /**
   * BOTH FIELDS OR NEITHER. A symbol without decimals invites rendering with
   * the configured default, which is the wrong-exponent bug this module
   * exists to remove — a figure wrong by orders of magnitude that looks tidy.
   */
  it.each([
    ["decimals missing", { symbol: "USDC" }],
    ["symbol missing", { decimals: 6 }],
    ["decimals not an integer", { symbol: "USDC", decimals: 6.5 }],
    ["decimals absurd", { symbol: "USDC", decimals: 99 }],
    ["symbol empty", { symbol: "", decimals: 6 }],
    ["not an object", null],
  ])("refuses a partial or implausible answer: %s", async (_why, raw) => {
    expect(await tokenMeta("rpc", `t-${_why}`, async () => raw)).toBeNull();
  });
});

describe("label", () => {
  it("shows the symbol AND keeps the id, because a symbol is not unique", () => {
    // Anyone can deploy a token calling itself USDC. A budget naming only the
    // symbol cannot be checked against the one the user meant.
    expect(label(USDC, { symbol: "USDC", decimals: 6 })).toBe(`USDC (${USDC})`);
  });

  it("falls back to the bare id when metadata is unavailable", () => {
    expect(label("mystery.near", null)).toBe("mystery.near");
  });
});
