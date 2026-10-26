import { describe, it, expect } from "vitest";
import {
  ONE_YOCTO,
  AGENT_ACCOUNT_STORAGE_YOCTO,
  MIN_AGENT_KEY_ALLOWANCE_YOCTO,
  OWNER_PLANNERS,
  planSetNodeCaps,
  planAddNode,
  planCreateAgentAccount,
  planFreezeNode,
  planPurgeSettled,
  planSetPaused,
  toCliCommand,
} from "./payloads.js";

const VAULT = "vault.testnet";
const TOK = "usdc.testnet";

describe("owner payloads", () => {
  it("targets the vault and the right method", () => {
    const p = planSetNodeCaps(VAULT, 3, [
      { token: TOK, dailyCap: "1000", perTxCap: "500", decimals: 6 },
    ]);
    expect(p.receiverId).toBe(VAULT);
    expect(p.methodName).toBe("set_node_caps");
  });

  it("converts human caps to base units as STRINGS in snake_case", () => {
    // The contract's TokenLimit is snake_case and its U128 fields arrive as
    // JSON strings. camelCase or a JSON number would both be rejected, and a
    // number would additionally lose precision above 2^53.
    const p = planSetNodeCaps(VAULT, 3, [
      { token: TOK, dailyCap: "1000", perTxCap: "500", decimals: 6 },
    ]);
    expect(p.args).toEqual({
      node_id: 3,
      limits: [{ token: TOK, daily_cap: "1000000000", per_tx_cap: "500000000" }],
    });
  });

  it("attaches exactly 1 yoctoNEAR to plain owner methods", () => {
    // Not cosmetic: assert_one_yocto rejects anything else, and the 1-yocto
    // requirement is what makes these methods unreachable from an agent's
    // function-call key.
    for (const p of [
      planFreezeNode(VAULT, 1, true),
      planPurgeSettled(VAULT, 100, 50),
      planSetPaused(VAULT, true),
      planSetNodeCaps(VAULT, 1, [{ token: TOK, dailyCap: "1", perTxCap: "1", decimals: 6 }]),
    ]) {
      expect(p.depositYocto).toBe(ONE_YOCTO);
    }
  });

  it("never emits a zero deposit for an owner method", () => {
    const made = [
      planFreezeNode(VAULT, 1, false),
      planPurgeSettled(VAULT, 1, 1),
      planSetPaused(VAULT, false),
      planAddNode(VAULT, null, "root", [{ token: TOK, dailyCap: "1", perTxCap: "1", decimals: 6 }], 0, [
        "bob.testnet",
      ]),
    ];
    for (const p of made) expect(BigInt(p.depositYocto)).toBeGreaterThan(0n);
  });
});

describe("summaries", () => {
  // The human approves on the strength of the summary. A summary that does not
  // move with the args is worse than none: it invites a signature for
  // something other than what was described.
  it("reflects the node id", () => {
    const a = planFreezeNode(VAULT, 1, true).summary;
    const b = planFreezeNode(VAULT, 7, true).summary;
    expect(a).not.toBe(b);
    expect(b).toContain("7");
  });

  it("reflects the direction of a boolean", () => {
    expect(planFreezeNode(VAULT, 1, true).summary).not.toBe(
      planFreezeNode(VAULT, 1, false).summary,
    );
    expect(planFreezeNode(VAULT, 1, true).summary.toLowerCase()).toContain("freeze");
    expect(planFreezeNode(VAULT, 1, false).summary.toLowerCase()).toContain("unfreeze");
  });

  it("states caps in HUMAN units, not base units", () => {
    // Showing 1000000000 where the human typed 1000 is how a 1000x mistake
    // gets waved through.
    const s = planSetNodeCaps(VAULT, 3, [
      { token: TOK, dailyCap: "1000", perTxCap: "500", decimals: 6 },
    ]).summary;
    expect(s).toContain("1000");
    expect(s).not.toContain("1000000000");
  });

  it("warns on the destructive operations", () => {
    expect(planPurgeSettled(VAULT, 1, 1).warnings.join(" ")).toMatch(/delete|irreversible/i);
    expect(planSetPaused(VAULT, true).warnings.join(" ")).toMatch(/halt|block|stop/i);
    expect(planFreezeNode(VAULT, 1, true).warnings.join(" ")).toMatch(/subtree|descendant|child/i);
  });

  it("does not warn when the operation is not destructive", () => {
    expect(planSetPaused(VAULT, false).warnings).toEqual([]);
    expect(planFreezeNode(VAULT, 1, false).warnings).toEqual([]);
  });
});

describe("create_agent_account", () => {
  it("funds the deposit as allowance + account storage", () => {
    const p = planCreateAgentAccount(VAULT, 2, "a0", "ed25519:aaa", "2");
    expect(p.depositYocto).toBe(
      (2n * 10n ** 24n + BigInt(AGENT_ACCOUNT_STORAGE_YOCTO)).toString(),
    );
  });

  it("rejects an allowance below the floor CLIENT-SIDE, before anything is signed", () => {
    // The contract rejects it too, but failing here costs no gas and no
    // wallet round-trip, and the error can explain why the floor exists.
    expect(() => planCreateAgentAccount(VAULT, 2, "a0", "ed25519:aaa", "0.01")).toThrow(
      /allowance/i,
    );
  });

  it("accepts exactly the floor", () => {
    const floorNear = (BigInt(MIN_AGENT_KEY_ALLOWANCE_YOCTO) / 10n ** 22n).toString();
    expect(() =>
      planCreateAgentAccount(VAULT, 2, "a0", "ed25519:aaa", `0.${floorNear.padStart(2, "0")}`),
    ).not.toThrow();
  });

  it("rejects a sub_label the contract would reject, before signing", () => {
    for (const bad of ["", "Agent", "a.b", "a".repeat(33), "a b", "a!"]) {
      expect(() => planCreateAgentAccount(VAULT, 2, bad, "ed25519:aaa", "2")).toThrow();
    }
  });

  it("shows the derived account id so the human can check it", () => {
    const p = planCreateAgentAccount(VAULT, 2, "a0", "ed25519:aaa", "2");
    expect(p.summary).toContain(`a0.${VAULT}`);
  });
});

describe("the planner surface", () => {
  // The test clock lets the owner shrink the budget window to 100ms. It is
  // gated behind a non-default cargo feature and the deploy script refuses to
  // ship it — the MCP must not offer a path to it either.
  it("exposes no clock or test-only method", () => {
    const methods = Object.values(OWNER_PLANNERS).map((m) => m.methodName);
    for (const m of methods) {
      expect(m).not.toMatch(/day_len|clock|test/i);
    }
  });

  it("exposes only methods the contract actually has", () => {
    const CONTRACT_OWNER_METHODS = new Set([
      "add_node",
      "set_node_caps",
      "bind_agent",
      "create_agent_account",
      "set_recipients",
      "set_cooldown",
      "freeze_node",
      "set_paused",
      "set_strict_allocation",
      "purge_settled",
    ]);
    for (const m of Object.values(OWNER_PLANNERS)) {
      expect(CONTRACT_OWNER_METHODS.has(m.methodName)).toBe(true);
    }
  });
});

describe("toCliCommand", () => {
  it("round-trips the args as valid JSON", () => {
    const p = planSetNodeCaps(VAULT, 3, [
      { token: TOK, dailyCap: "1000", perTxCap: "500", decimals: 6 },
    ]);
    const cmd = toCliCommand(p);
    const json = cmd.match(/json-args '(.*?)' prepaid-gas/)?.[1];
    expect(json).toBeDefined();
    expect(JSON.parse(json!)).toEqual(p.args);
  });

  it("names the method and the receiver", () => {
    const cmd = toCliCommand(planFreezeNode(VAULT, 1, true));
    expect(cmd).toContain(VAULT);
    expect(cmd).toContain("freeze_node");
  });
});
