import { describe, it, expect } from "vitest";
import { buildRoute } from "./sign.js";

// `sendRequestPayment` itself needs a key and a node, so it is exercised
// against live testnet rather than here. `buildRoute` is the part that can be
// silently wrong: it produces the exact JSON the contract deserialises, and a
// wrong field name would fail on-chain after every test here passed. The
// on-chain half of that claim is pinned by
// integration-tests/tests/chain_signatures.rs ::
// the_mcp_near_rail_wire_format_deserialises.

describe("buildRoute", () => {
  it("emits the bare unit variant for the NEAR rail", () => {
    expect(buildRoute("near")).toBe("near_direct");
  });

  it("ignores base fields when the rail is near", () => {
    const r = buildRoute("near", {
      nonce: "1",
      maxFeePerGas: "2",
      maxPriorityFeePerGas: "3",
      gasLimit: "4",
    });
    expect(r).toBe("near_direct");
  });

  it("maps base fields to the contract's snake_case names", () => {
    // Field names are the whole risk here. A camelCase key would be dropped by
    // serde and the call would fail on-chain with a missing-field error.
    expect(
      buildRoute("base", {
        nonce: "7",
        maxFeePerGas: "20000000",
        maxPriorityFeePerGas: "1000000",
        gasLimit: "100000",
      }),
    ).toEqual({
      base_usdc: {
        nonce: "7",
        max_priority_fee_per_gas: "1000000",
        max_fee_per_gas: "20000000",
        gas_limit: "100000",
      },
    });
  });

  it("carries NO payload, destination or amount", () => {
    // The security property, as a test. The contract builds the calldata and
    // the transaction from what it authorized; if this object ever grows a
    // payload field, a caller could choose what gets signed and the budget
    // tree would become decorative.
    const r = buildRoute("base", {
      nonce: "0",
      maxFeePerGas: "1",
      maxPriorityFeePerGas: "1",
      gasLimit: "1",
    }) as { base_usdc: Record<string, string> };
    const keys = Object.keys(r.base_usdc).sort();
    expect(keys).toEqual(["gas_limit", "max_fee_per_gas", "max_priority_fee_per_gas", "nonce"]);
    for (const banned of ["payload", "to", "data", "amount", "recipient", "value"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("refuses rail=base with no base fields rather than sending a broken call", () => {
    expect(() => buildRoute("base")).toThrow(/requires nonce/);
  });

  it("refuses non-decimal numeric fields", () => {
    // U128/U64 cross the ABI as decimal strings. Hex, or a float, would be
    // rejected on-chain; catching it here costs nothing.
    for (const bad of ["0x10", "1.5", "", "-1", "1e9", " 1"]) {
      expect(
        () =>
          buildRoute("base", {
            nonce: bad,
            maxFeePerGas: "1",
            maxPriorityFeePerGas: "1",
            gasLimit: "1",
          }),
        `accepted nonce=${JSON.stringify(bad)}`,
      ).toThrow(/decimal string/);
    }
  });
});
