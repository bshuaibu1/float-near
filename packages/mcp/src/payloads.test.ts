import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ONE_YOCTO,
  OWNER_PLANNERS,
  planSetNodeCaps,
  planAddNode,
  planFreezeNode,
  planPurgeSettled,
  planSetPaused,
  planSetApprovalThreshold,
  planWithdraw,
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

// The `create_agent_account` describe block lived here — FIVE tests pinning
// the deposit arithmetic, the allowance floor, the sub_label charset and the
// derived account id.
//
// All five guarded a method that funded an account nobody could ever empty:
// its only key was a function-call key, which cannot sign `DeleteAccount`,
// and NEAR requires `actor_id == account_id` so no parent could do it either.
// 10.7752 NEAR is stranded that way across 18 testnet agents, plus 0.54434 on
// mainnet. The method is gone, so its tests went with it.
//
// Worth recording how they behaved once the function was deleted: FOUR went
// red, and the fifth — `rejects a sub_label the contract would reject` —
// stayed GREEN. It asserted `.toThrow()`, and calling a function that no
// longer exists throws, so it passed against a feature that had ceased to
// exist. A test whose assertion is satisfied by the absence of the thing it
// tests is not evidence of anything.
//
// `virtual-agent.test.ts` covers what replaced it.


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

  /**
   * READ FROM THE CONTRACT, not from a list kept by hand.
   *
   * This compared against a hardcoded Set, which only asserted that the
   * planners match a list someone remembered to update — so the way to make
   * it pass was always to edit the list, and a planner naming a method the
   * contract had REMOVED would have survived that edit untouched. A guard
   * whose failure mode is "add it to the list" is not a guard.
   *
   * The failure it exists to prevent is expensive and silent: an owner is
   * handed a payload, signs it in their wallet, pays gas, gets
   * MethodNotFound.
   */
  it("exposes only methods the contract actually has", () => {
    const LIB = resolve(
      import.meta.dirname, "..", "..", "..", "contracts", "vault", "src", "lib.rs",
    );
    if (!existsSync(LIB)) {
      console.warn(`SKIPPED: ${LIB} not present, cannot check planners against the contract`);
      return;
    }
    const src = readFileSync(LIB, "utf8");
    const methods = new Set([...src.matchAll(/pub fn (\w+)\s*\(/g)].map((m) => m[1]));

    // POSITIVE CONTROL. A regex that matched nothing would make every planner
    // valid by vacuity, and the test would pass hardest exactly when it had
    // stopped working.
    expect(methods.has("add_node"), "the extractor found no known method").toBe(true);
    expect(methods.size).toBeGreaterThan(10);

    for (const m of Object.values(OWNER_PLANNERS)) {
      expect(methods.has(m.methodName), `${m.methodName} is not a pub fn on the vault`).toBe(true);
    }
  });
});

describe("planWithdraw", () => {
  /**
   * THE STEP THAT DECIDES WHETHER MONEY SURVIVES A TEARDOWN.
   *
   * Deleting a NEAR account does NOT return fungible tokens — the ledger
   * keeps a row keyed to an account nobody can sign for again. So the
   * Danger Zone's first step is not hygiene, and a bug here burns a balance
   * rather than inconveniencing someone.
   */
  it("passes the amount through in BASE units, untouched", () => {
    const p = planWithdraw(VAULT, TOK, "12500000", "alice.testnet", 6);
    expect(p.methodName).toBe("withdraw");
    expect(p.receiverId).toBe(VAULT);
    expect(p.args).toEqual({
      token: TOK,
      amount: "12500000",
      receiver_id: "alice.testnet",
    });
    // #[payable] + assert_owner() -> assert_one_yocto()
    expect(p.depositYocto).toBe("1");
  });

  it("says the HUMAN figure in the summary, because that is what a wallet shows", () => {
    expect(planWithdraw(VAULT, TOK, "12500000", "alice.testnet", 6).summary).toContain("12.5");
    // Trailing zeros trimmed; a quantity does not owe you its cents.
    expect(planWithdraw(VAULT, TOK, "2000000", "alice.testnet", 6).summary).toContain("2 ");
  });

  /**
   * NOT `Number()`, and this is the case that proves why.
   *
   * 2^53 is about 9.007e15, which a 6-decimal token reaches at 9,007
   * tokens — a figure a real vault can hold. Via Number() the base amount
   * loses precision and the wallet shows a confirmation that disagrees with
   * the transaction. String surgery has no such cliff.
   */
  it("is exact past 2^53, where floating point stops being", () => {
    const base = "9007199254740993"; // 2^53 + 1, exactly
    expect(Number(base).toString()).not.toBe(base); // the cliff is real
    const p = planWithdraw(VAULT, TOK, base, "alice.testnet", 6);
    expect(p.args).toMatchObject({ amount: base });
    expect(p.summary).toContain("9007199254.740993");
  });

  /** The contract fails a zero amount, so this must not send the owner to a
   *  wallet to sign something that reverts and charges gas to learn. */
  it("refuses zero and negative, as the contract does", () => {
    for (const bad of ["0", "-1", "-12500000"]) {
      expect(() => planWithdraw(VAULT, TOK, bad, "alice.testnet", 6)).toThrow(/positive/i);
    }
  });

  it("refuses an amount that is not an integer in base units", () => {
    for (const bad of ["12.5", "", "lots", "1e6"]) {
      expect(() => planWithdraw(VAULT, TOK, bad, "alice.testnet", 6)).toThrow();
    }
  });

  it("refuses an empty receiver rather than sending tokens nowhere", () => {
    expect(() => planWithdraw(VAULT, TOK, "1", "", 6)).toThrow(/receiver/i);
  });

  /** The warning a user needs before signing, not after. */
  it("warns that the receiver keeps the tokens", () => {
    const w = planWithdraw(VAULT, TOK, "1", "alice.testnet", 6).warnings ?? [];
    expect(w.join(" ")).toMatch(/cannot pull them back|keeps them/i);
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

// ---- the approval threshold takes HUMAN units, like every tool beside it
//
// THE BUG THIS PINS, found 2026-10-31 by walking the real schemas rather than
// reading the docs. `vault_plan_set_approval_threshold` was the ONLY tool in the
// set that took BASE units, and it is the one that configures a safety gate:
//
//   vault_pay.amount                   human  "12.50"
//   vault_plan_set_caps.dailyCap       human  (schema even says so)
//   vault_plan_set_approval_threshold  BASE   <- the odd one out
//
// It FAILS OPEN, which is why this is not cosmetic. An owner thinking in human
// units who passes a figure at or above the per-tx cap in base units gets a
// threshold ABOVE the caps, so the gate never fires and silently does nothing —
// on the one control whose entire purpose is to not fail open.
//
// Measured against the live mainnet vault, whose per-tx cap is 510000 base
// (0.51 USDC): "1000000" meaning "a million" yields a 1.0 USDC threshold, which
// is above every cap in the tree. Nothing is ever held. The owner sees a
// successful transaction and believes the gate is on.
//
// Breaking change to a tool published the same day with no users — the cheapest
// time this fix will ever be available.
describe("planSetApprovalThreshold", () => {
  it("converts human units to base, like its neighbours", () => {
    const p = planSetApprovalThreshold(VAULT, 2, "0.25", 6);
    expect(p.args).toEqual({ node_id: 2, amount: "250000" });
  });

  it("a whole number is not read as base units", () => {
    // The fail-open direction. "1" must mean 1 USDC = 1000000 base, never
    // 1 base unit (0.000001) and never a bare "1" passed through.
    const p = planSetApprovalThreshold(VAULT, 0, "1", 6);
    expect(p.args.amount).toBe("1000000");
  });

  it("honours the token's decimals rather than assuming six", () => {
    expect(planSetApprovalThreshold(VAULT, 0, "1", 18).args.amount).toBe("1000000000000000000");
    expect(planSetApprovalThreshold(VAULT, 0, "7", 0).args.amount).toBe("7");
  });

  it("refuses to truncate more precision than the token has", () => {
    // Inherited from toBaseUnits, and it matters here: silently truncating
    // 0.1234567 to 0.123456 would set a threshold the owner did not choose.
    expect(() => planSetApprovalThreshold(VAULT, 0, "0.1234567", 6)).toThrow(/decimal places/i);
  });

  it("rejects a base-unit-looking string with no decimal point ONLY by value, not by shape", () => {
    // "250000" is a legitimate human amount (250 thousand USDC). It must not be
    // special-cased — the fix is a consistent convention, not a heuristic that
    // guesses which units the caller meant.
    expect(planSetApprovalThreshold(VAULT, 0, "250000", 6).args.amount).toBe("250000000000");
  });

  it("null removes the threshold and says what that means", () => {
    const p = planSetApprovalThreshold(VAULT, 2, null, 6);
    expect(p.args).toEqual({ node_id: 2, amount: null });
    expect(p.warnings.join(" ")).toMatch(/only the caps apply/i);
  });

  it("the summary quotes HUMAN units, because that is what the owner typed", () => {
    // The old summary read "Payments above 1000000 (base units)", which is
    // unreadable in exactly the moment the owner is checking the plan before
    // signing it.
    const s = planSetApprovalThreshold(VAULT, 2, "0.25", 6).summary;
    expect(s).toContain("0.25");
    expect(s).not.toContain("250000");
    expect(s).not.toMatch(/base units/i);
  });

  it("MOVES MONEY is not claimed — setting a threshold spends nothing", () => {
    const p = planSetApprovalThreshold(VAULT, 2, "0.25", 6);
    expect(p.depositYocto).toBe(ONE_YOCTO);
    expect(p.methodName).toBe("set_approval_threshold");
    expect(p.receiverId).toBe(VAULT);
  });
});
