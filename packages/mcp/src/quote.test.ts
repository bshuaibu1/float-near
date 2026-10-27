import { describe, it, expect } from "vitest";
import { encodeBinding, signBinding, publicKeyOf, intentsRoute, type QuoteBinding } from "./quote.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * The binding this service signs is verified by the Rust contract. If the two
 * borsh encodings differ by one byte, NO signature ever verifies — and the
 * failure is silent and total, indistinguishable from a wrong key. So the
 * identical vector is asserted on both sides.
 */
const VECTOR: QuoteBinding = {
  vault: "v.testnet",
  requestId: "req-1",
  token: "usdc.testnet",
  amount: 5_000_000n,
  payee: "0xabc",
  depositAddress: "dep.near",
  deadlineNs: 1_700_000_000_000_000_000n,
};

/** Produced by `quote_binding_borsh_vector` in contracts/vault/src/tests.rs. */
const RUST_BYTES =
  "09000000762e746573746e6574050000007265712d310c000000757364632e746573746e6574404b4c00000000000000000000000000050000003078616263080000006465702e6e65617200002a36fe9c9717";

describe("the signed binding matches the contract byte for byte", () => {
  it("encodes the shared vector exactly as Rust does", () => {
    expect(hex(encodeBinding(VECTOR))).toBe(RUST_BYTES);
  });

  it("length-prefixes strings, so adjacent fields cannot be confused", () => {
    // Without the prefix, ("alic","ebob") and ("alice","bob") would encode
    // identically and each could sign the other's quote.
    const a = encodeBinding({ ...VECTOR, payee: "alic", depositAddress: "ebob.near" });
    const b = encodeBinding({ ...VECTOR, payee: "alice", depositAddress: "bob.near" });
    expect(hex(a)).not.toBe(hex(b));
  });

  it("changes when ANY field changes", () => {
    // Every field is load-bearing: one left out of the encoding is one an
    // attacker can alter freely after the quote is signed.
    const base = hex(encodeBinding(VECTOR));
    const variants: Array<[string, QuoteBinding]> = [
      ["vault", { ...VECTOR, vault: "other.testnet" }],
      ["requestId", { ...VECTOR, requestId: "req-2" }],
      ["token", { ...VECTOR, token: "dai.testnet" }],
      ["amount", { ...VECTOR, amount: 5_000_001n }],
      ["payee", { ...VECTOR, payee: "0xabd" }],
      ["depositAddress", { ...VECTOR, depositAddress: "other.near" }],
      ["deadlineNs", { ...VECTOR, deadlineNs: VECTOR.deadlineNs + 1n }],
    ];
    for (const [field, v] of variants) {
      expect(hex(encodeBinding(v)), `${field} is not covered by the signature`).not.toBe(base);
    }
  });

  it("encodes u128 amounts above 2^64 without truncating", () => {
    // A u128 written as two little-endian halves is easy to get backwards,
    // and the mistake is invisible below 2^64.
    const big = { ...VECTOR, amount: (1n << 100n) + 7n };
    const enc = hex(encodeBinding(big));
    expect(enc).not.toBe(hex(encodeBinding({ ...VECTOR, amount: 7n })));
    expect(enc).toHaveLength(hex(encodeBinding(VECTOR)).length);
  });
});

describe("signing", () => {
  const sk = new Uint8Array(32).fill(7);

  it("produces a 64-byte signature a 32-byte key can be derived from", () => {
    expect(signBinding(VECTOR, sk)).toHaveLength(64);
    expect(publicKeyOf(sk)).toHaveLength(32);
  });

  it("signs the ENCODING, so a tampered field invalidates it", () => {
    const honest = hex(signBinding(VECTOR, sk));
    const swapped = hex(signBinding({ ...VECTOR, depositAddress: "attacker.near" }, sk));
    expect(swapped).not.toBe(honest);
  });

  it("refuses a key of the wrong length rather than signing garbage", () => {
    expect(() => signBinding(VECTOR, new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

describe("the route argument", () => {
  it("uses the contract's snake_case names and base64 signature", () => {
    const r = intentsRoute("dep.near", 123n, new Uint8Array(64).fill(1));
    expect(Object.keys(r.intents).sort()).toEqual([
      "deposit_address",
      "quote_deadline_ns",
      "signature",
    ]);
    // U64 crosses the ABI as a decimal string; a JSON number loses precision
    // above 2^53 and a nanosecond deadline is far past that.
    expect(typeof r.intents.quote_deadline_ns).toBe("string");
    expect(r.intents.signature).toBe(Buffer.alloc(64, 1).toString("base64"));
  });
});
