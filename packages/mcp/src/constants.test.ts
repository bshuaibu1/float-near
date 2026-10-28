import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGENT_ACCOUNT_STORAGE_YOCTO,
  MIN_AGENT_KEY_ALLOWANCE_YOCTO,
  MAX_TOKENS,
  MAX_RECIPIENTS,
  MAX_LABEL_LEN,
  MAX_SUB_LABEL_LEN,
  MAX_COOLDOWN_SEC,
  MAX_PURGE_LIMIT,
  OWNER_PLANNERS,
  planPurgeSettled,
  planCreateAgentAccount,
  planAddNode,
  DEFAULT_GAS_TGAS,
} from "./payloads.js";

// This server validates locally so a bad call fails before it costs gas or a
// wallet round-trip. That means it duplicates the contract's bounds, which
// means it can drift from them silently. Both sides assert against one
// committed file; the Rust half lives in contracts/vault/src/tests.rs.
const C = JSON.parse(
  readFileSync(new URL("../../../shared/contract-constants.json", import.meta.url), "utf8"),
) as Record<string, number | string>;

describe("the MCP's mirrored constants match the contract", () => {
  it("agent account storage", () => {
    expect(AGENT_ACCOUNT_STORAGE_YOCTO).toBe(C.AGENT_ACCOUNT_STORAGE_YOCTO);
  });

  it("minimum agent key allowance", () => {
    expect(MIN_AGENT_KEY_ALLOWANCE_YOCTO).toBe(C.MIN_AGENT_KEY_ALLOWANCE_YOCTO);
  });

  it("every mirrored numeric bound", () => {
    // Compared directly, not only through behaviour: a behavioural test can
    // pass while the number itself has drifted, if the drift happens to sit
    // outside what the test exercises.
    expect(MAX_TOKENS).toBe(C.MAX_TOKENS);
    expect(MAX_RECIPIENTS).toBe(C.MAX_RECIPIENTS);
    expect(MAX_LABEL_LEN).toBe(C.MAX_LABEL_LEN);
    expect(MAX_SUB_LABEL_LEN).toBe(C.MAX_SUB_LABEL_LEN);
    expect(MAX_COOLDOWN_SEC).toBe(C.MAX_COOLDOWN_SEC);
    expect(MAX_PURGE_LIMIT).toBe(C.MAX_PURGE_LIMIT);
  });

  it("the only method an agent key may call", () => {
    // If the contract widened this, the MCP's security summary would be a lie.
    expect(C.AGENT_ALLOWED_METHOD).toBe("request_payment");
  });
});

describe("the MCP enforces the contract's bounds locally", () => {
  it("rejects a purge limit above MAX_PURGE_LIMIT", () => {
    const max = Number(C.MAX_PURGE_LIMIT);
    expect(() => planPurgeSettled("v.testnet", 1, max)).not.toThrow();
    expect(() => planPurgeSettled("v.testnet", 1, max + 1)).toThrow();
  });

  it("rejects a sub_label longer than MAX_SUB_LABEL_LEN", () => {
    const max = Number(C.MAX_SUB_LABEL_LEN);
    const ok = "a".repeat(max);
    const tooLong = "a".repeat(max + 1);
    expect(() => planCreateAgentAccount("v.testnet", 1, ok, "ed25519:aaa", "2")).not.toThrow();
    expect(() => planCreateAgentAccount("v.testnet", 1, tooLong, "ed25519:aaa", "2")).toThrow();
  });

  it("rejects a label longer than MAX_LABEL_LEN", () => {
    const max = Number(C.MAX_LABEL_LEN);
    const lim = [{ token: "t.testnet", dailyCap: "1", perTxCap: "1", decimals: 6 }];
    expect(() =>
      planAddNode("v.testnet", null, "a".repeat(max), lim, 0, ["b.testnet"]),
    ).not.toThrow();
    expect(() =>
      planAddNode("v.testnet", null, "a".repeat(max + 1), lim, 0, ["b.testnet"]),
    ).toThrow();
  });

  it("rejects more token limits than MAX_TOKENS", () => {
    const max = Number(C.MAX_TOKENS);
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        token: `t${i}.testnet`,
        dailyCap: "1",
        perTxCap: "1",
        decimals: 6,
      }));
    expect(() => planAddNode("v.testnet", null, "r", mk(max), 0, ["b.testnet"])).not.toThrow();
    expect(() => planAddNode("v.testnet", null, "r", mk(max + 1), 0, ["b.testnet"])).toThrow();
  });

  it("rejects more recipients than MAX_RECIPIENTS", () => {
    const max = Number(C.MAX_RECIPIENTS);
    const lim = [{ token: "t.testnet", dailyCap: "1", perTxCap: "1", decimals: 6 }];
    const mk = (n: number) => Array.from({ length: n }, (_, i) => `p${i}.testnet`);
    expect(() => planAddNode("v.testnet", null, "r", lim, 0, mk(max))).not.toThrow();
    expect(() => planAddNode("v.testnet", null, "r", lim, 0, mk(max + 1))).toThrow();
  });

  it("rejects a cooldown above MAX_COOLDOWN_SEC", () => {
    const max = Number(C.MAX_COOLDOWN_SEC);
    const lim = [{ token: "t.testnet", dailyCap: "1", perTxCap: "1", decimals: 6 }];
    expect(() => planAddNode("v.testnet", null, "r", lim, max, ["b.testnet"])).not.toThrow();
    expect(() => planAddNode("v.testnet", null, "r", lim, max + 1, ["b.testnet"])).toThrow();
  });
});

describe("the planner surface stays inside the contract's", () => {
  it("offers nothing the contract does not implement", () => {
    for (const p of Object.values(OWNER_PLANNERS)) {
      expect(typeof p.methodName).toBe("string");
      expect(p.methodName).not.toMatch(/day_len|clock/i);
    }
  });
});

describe("the dispatch gas floor", () => {
  it("attaches more than the contract's documented minimum", () => {
    // Asserted against the shared file, not a literal: the contract refuses a
    // payment below MIN_GAS_FOR_DISPATCH, so if that floor rises and the gas
    // we attach does not, EVERY payment fails with INSUFFICIENT_GAS.
    expect(DEFAULT_GAS_TGAS).toBeGreaterThanOrEqual(Number(C.MIN_GAS_FOR_DISPATCH_TGAS));
    // NEAR caps prepaid gas at 300 Tgas; asking for more is rejected outright.
    expect(DEFAULT_GAS_TGAS).toBeLessThanOrEqual(300);
  });
});
