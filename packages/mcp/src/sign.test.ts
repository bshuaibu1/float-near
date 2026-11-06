import { describe, it, expect } from "vitest";
import { buildRoute } from "./sign.js";

// `sendRequestPayment` needs a key and a node, so it is exercised against a
// live network rather than here. `buildRoute` is the part that can be silently
// wrong: it produces the exact JSON the contract deserialises, and a wrong
// field name would fail on-chain after every test here passed.

const FIELDS = {
  depositAddress: "one-time-abc.near",
  quoteDeadlineNs: "1700000000000000000",
  signature: Buffer.alloc(64, 3).toString("base64"),
};

describe("buildRoute", () => {
  it("emits the bare unit variant for the NEAR rail", () => {
    expect(buildRoute("near")).toBe("near_direct");
  });

  it("maps intents fields to the contract's snake_case names", () => {
    // Field names are the whole risk. A camelCase key would be dropped by
    // serde and the call would fail on-chain with a missing-field error.
    expect(buildRoute("intents", FIELDS)).toEqual({
      intents: {
        deposit_address: "one-time-abc.near",
        quote_deadline_ns: "1700000000000000000",
        signature: FIELDS.signature,
      },
    });
  });

  it("carries NO payload, amount or recipient", () => {
    // The security property as a test. Where value ends up is decided by the
    // allowlist and the SIGNED binding, never by fields a caller passes here.
    const r = buildRoute("intents", FIELDS) as { intents: Record<string, string> };
    const keys = Object.keys(r.intents).sort();
    expect(keys).toEqual(["deposit_address", "quote_deadline_ns", "signature"]);
    for (const banned of ["payload", "to", "data", "amount", "recipient", "value", "nonce"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("refuses rail=intents with no fields rather than sending a broken call", () => {
    // @ts-expect-error deliberately omitting the required argument
    expect(() => buildRoute("intents")).toThrow(/requires depositAddress/);
  });

  it("refuses an EMPTY deposit address", () => {
    // That is what a DRY quote returns. Paying one would transfer real funds
    // to "", which the token contract rejects only AFTER the vault has
    // reserved the budget — so the money is safe but the budget is spent.
    expect(() => buildRoute("intents", { ...FIELDS, depositAddress: "" })).toThrow(/dry quote/);
  });

  it("refuses a non-decimal deadline", () => {
    // U64 crosses the ABI as a decimal string; a JSON number loses precision
    // above 2^53 and a nanosecond deadline is far past that.
    for (const bad of ["0x10", "1.5", "", "-1", "1e9", " 1"]) {
      expect(
        () => buildRoute("intents", { ...FIELDS, quoteDeadlineNs: bad }),
        `accepted deadline=${JSON.stringify(bad)}`,
      ).toThrow(/decimal string/);
    }
  });
});
