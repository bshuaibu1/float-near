import { describe, it, expect } from "vitest";
import { encodeArgs, decodeViewResult, requireAgentKey, newRequestId } from "./rpc.js";

describe("encodeArgs", () => {
  it("base64-encodes the JSON body", () => {
    const b64 = encodeArgs({ node_id: 3 });
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))).toEqual({ node_id: 3 });
  });

  it("survives non-ascii in a memo", () => {
    // A memo is free text and goes on-chain. Latin-1 truncation here would
    // corrupt it silently.
    const memo = "café — 日本語";
    const b64 = encodeArgs({ memo });
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf8")).memo).toBe(memo);
  });
});

describe("decodeViewResult", () => {
  it("decodes NEAR's byte-array result into JSON", () => {
    // A view result arrives as an array of byte values, not a string.
    const bytes = Array.from(Buffer.from(JSON.stringify({ ok: true }), "utf8"));
    expect(decodeViewResult({ result: bytes })).toEqual({ ok: true });
  });

  it("decodes a null result", () => {
    const bytes = Array.from(Buffer.from("null", "utf8"));
    expect(decodeViewResult({ result: bytes })).toBeNull();
  });

  it("surfaces a contract panic rather than returning undefined", () => {
    // The dangerous case: an error shape that decodes to nothing and reads as
    // "no data" instead of "the call failed".
    expect(() => decodeViewResult({ error: "UNKNOWN_NODE: no such node" })).toThrow(
      /UNKNOWN_NODE/,
    );
  });

  it("rejects a response with neither result nor error", () => {
    expect(() => decodeViewResult({} as never)).toThrow(/unexpected/i);
  });

  it("surfaces a JSON-RPC level error", () => {
    expect(() =>
      decodeViewResult({ error: { message: "server error", data: "ACCOUNT_DOES_NOT_EXIST" } }),
    ).toThrow(/ACCOUNT_DOES_NOT_EXIST|server error/);
  });
});

describe("requireAgentKey", () => {
  // The server must be useful with NO secrets configured: reads and payload
  // planning need no key. Only `vault_pay` does, and when it is missing the
  // message has to say what to set rather than throwing a TypeError later.
  it("names BOTH variables when both are missing", () => {
    // Reporting only the first would buy a second failed attempt.
    const e = (() => {
      try {
        requireAgentKey({});
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(e).toMatch(/NEAR_VAULT_AGENT_ID/);
    expect(e).toMatch(/NEAR_VAULT_AGENT_KEY/);
  });

  it("names the one that is missing", () => {
    expect(() => requireAgentKey({ agentId: "a0.v.testnet" })).toThrow(/NEAR_VAULT_AGENT_KEY/);
    expect(() => requireAgentKey({ agentKey: "ed25519:x" })).toThrow(/NEAR_VAULT_AGENT_ID/);
  });

  it("warns against a full-access key in the missing-key message", () => {
    expect(() => requireAgentKey({ agentId: "a0.v.testnet" })).toThrow(/full-access/i);
  });

  it("returns both when configured", () => {
    expect(requireAgentKey({ agentId: "a0.v.testnet", agentKey: "ed25519:x" })).toEqual({
      agentId: "a0.v.testnet",
      agentKey: "ed25519:x",
    });
  });
});

describe("newRequestId", () => {
  it("matches the contract's accepted character set", () => {
    // is_valid_request_id: 1..=64 of [A-Za-z0-9._:-]. A UUID with braces or a
    // timestamp with a space would be rejected on-chain, after signing.
    const ok = /^[A-Za-z0-9._:-]{1,64}$/;
    for (let i = 0; i < 200; i++) expect(newRequestId()).toMatch(ok);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newRequestId()));
    expect(seen.size).toBe(500);
  });
});
