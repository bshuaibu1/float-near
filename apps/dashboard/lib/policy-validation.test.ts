/**
 * Every assertion here is checked against a specific line of
 * contracts/vault/src/lib.rs. A test that agrees with the UI but not the
 * contract is worse than no test: it certifies the wrong rule.
 *
 * The tree used throughout is the product's documented shape,
 * "root -> team -> agent -> sub-agent" (MAX_DEPTH = 4):
 *
 *     root      id 0   cap 100
 *      team     id 1   cap  40   parent 0
 *       agent   id 2   cap  30   parent 1
 *      other    id 3   cap  20   parent 0
 *       solo    id 4   cap  15   parent 3
 *
 * TWO branches each with a depth-2 child, deliberately. With only one, a
 * lookup by DEPTH and a lookup by PARENT return the same set, and a mutation
 * swapping one for the other survives the suite.
 */
import { describe, it, expect } from "vitest";
import { validatePolicyDraft, childrenOf, type PolicyNode } from "./policy-validation";

const node = (
  agentId: string,
  id: number,
  parent: number | null,
  depth: number,
  daily: string,
): PolicyNode & { id: number } => ({
  agentId,
  id,
  parent,
  depth,
  policy: { dailyBudget: daily },
});

const ROOT = node("root", 0, null, 0, "100");
const TEAM = node("team", 1, 0, 1, "40");
const AGENT = node("agent", 2, 1, 2, "30");
const OTHER = node("other", 3, 0, 1, "20");
const SOLO = node("solo", 4, 3, 2, "15");
const TREE = [ROOT, TEAM, AGENT, OTHER, SOLO];
const nodeIdOf = (n: PolicyNode) => (n as unknown as { id: number }).id;

const run = (over: Partial<Parameters<typeof validatePolicyDraft>[0]> = {}) =>
  validatePolicyDraft({
    dailyCap: "100",
    perTxCap: "10",
    base: { daily: "999", perTx: "999" }, // differs, so caps count as touched
    selected: ROOT,
    all: TREE,
    recipients: [],
    strictAllocation: false,
    vaultId: "vault.testnet",
    nodeIdOf,
    ...over,
  });

describe("childrenOf", () => {
  it("finds children by PARENT, not by depth", () => {
    expect(childrenOf(ROOT, TREE, nodeIdOf).map((n) => n.agentId)).toEqual(["team", "other"]);
    // THE CASE DEPTH-FILTERING GETS WRONG. `agent` and `solo` are both
    // depth 2, under different parents. A depth filter hands BOTH to each
    // level-1 node, inflating every allocation sum it computes.
    expect(childrenOf(TEAM, TREE, nodeIdOf).map((n) => n.agentId)).toEqual(["agent"]);
    expect(childrenOf(OTHER, TREE, nodeIdOf).map((n) => n.agentId)).toEqual(["solo"]);
    expect(childrenOf(AGENT, TREE, nodeIdOf)).toEqual([]);
  });
});

describe("validate_limits (lib.rs:2307, 2310)", () => {
  it("rejects a zero or negative cap", () => {
    expect(run({ dailyCap: "0" }).errs.join(" ")).toMatch(/Daily limit must be greater than zero/);
    expect(run({ perTxCap: "0" }).errs.join(" ")).toMatch(/Per payment must be greater than zero/);
  });

  it("rejects per-payment ABOVE daily", () => {
    const r = run({ dailyCap: "100", perTxCap: "500" });
    expect(r.errs.join(" ")).toMatch(/cannot exceed the daily limit/);
  });

  /**
   * THE BOUNDARY. lib.rs:2310 is `per_tx_cap > daily_cap`, strictly greater.
   * An equal pair is legal, and a `>=` here would block a valid edit.
   */
  it("ALLOWS per-payment exactly equal to daily", () => {
    expect(run({ dailyCap: "100", perTxCap: "100" }).errs).toEqual([]);
  });

  it("says nothing when the caps were not touched", () => {
    // base matches the draft, so a pre-existing odd state is not nagged about
    expect(run({ dailyCap: "0", perTxCap: "0", base: { daily: "0", perTx: "0" } }).errs).toEqual([]);
  });
});

describe("strict allocation, downward (lib.rs:854)", () => {
  /**
   * THE BUG THIS MODULE WAS EXTRACTED TO FIX.
   *
   * `team` has one child, `agent`, holding 30. Shrinking team to 10 is below
   * that sum, and the contract fails with "cap is below the sum already
   * allocated to children". The old code only ran this check when depth === 0,
   * so it passed, the owner signed, and the transaction reverted.
   */
  it("catches a MID-TREE cap shrunk below its children", () => {
    const r = run({ selected: TEAM, dailyCap: "10", strictAllocation: true });
    expect(r.errs.join(" ")).toMatch(/already allocated to the budgets beneath "team"/);
  });

  it("still catches it at the root", () => {
    // root's children are team (40) + other (20) = 60
    const r = run({ selected: ROOT, dailyCap: "50", strictAllocation: true });
    expect(r.errs.join(" ")).toMatch(/already allocated to the budgets beneath the master/);
  });

  /**
   * Rule-level proof of the same thing. `team`'s real children hold 30. If
   * children were found by depth, `solo` (15, under `other`) would be
   * counted too, making the sum 45 and rejecting a perfectly legal cap of 35.
   */
  it("counts only its OWN children, not every node at the next depth", () => {
    const r = run({ selected: TEAM, dailyCap: "35", strictAllocation: true });
    expect(r.errs.filter((e) => /beneath/.test(e))).toEqual([]);
  });

  it("allows a cap exactly equal to the children's sum", () => {
    // lib.rs:854 is `<`, so equal is fine
    const r = run({ selected: TEAM, dailyCap: "30", strictAllocation: true });
    expect(r.errs.filter((e) => /beneath/.test(e))).toEqual([]);
  });

  it("says nothing for a leaf, which has no children to undercut", () => {
    const r = run({ selected: AGENT, dailyCap: "1", strictAllocation: true });
    expect(r.errs.filter((e) => /beneath/.test(e))).toEqual([]);
  });

  it("is silent when strict allocation is OFF, as the contract is", () => {
    const r = run({ selected: TEAM, dailyCap: "10", strictAllocation: false });
    expect(r.errs).toEqual([]);
  });
});

describe("strict allocation, upward (lib.rs:869-878)", () => {
  it("catches a cap that would overflow the parent with its siblings", () => {
    // under root: other holds 20, so team may take at most 80
    const r = run({ selected: TEAM, dailyCap: "90", strictAllocation: true });
    expect(r.errs.join(" ")).toMatch(/above that budget's 100/);
  });

  it("allows the exact remaining headroom", () => {
    // 20 (other) + 80 (team) = 100 = root's cap. `>` not `>=`, so this is legal.
    const r = run({ selected: TEAM, dailyCap: "80", strictAllocation: true });
    expect(r.errs.filter((e) => /above that budget/.test(e))).toEqual([]);
  });

  /** Now works at depth 2, where the old code had no upward check at all. */
  it("applies at depth 2, under a non-root parent", () => {
    const r = run({ selected: AGENT, dailyCap: "50", strictAllocation: true });
    expect(r.errs.join(" ")).toMatch(/above that budget's 40/);
  });

  it("says nothing at the root, which has no parent", () => {
    const r = run({ selected: ROOT, dailyCap: "100", strictAllocation: true });
    expect(r.errs.filter((e) => /above that budget/.test(e))).toEqual([]);
  });
});

describe("recipients (lib.rs:2318)", () => {
  it("rejects a duplicate payee", () => {
    expect(run({ recipients: ["a.near", "a.near"] }).errs.join(" ")).toMatch(/Duplicate payee/);
  });

  it("refuses to let a vault pay itself", () => {
    expect(run({ recipients: ["vault.testnet"] }).errs.join(" ")).toMatch(/cannot pay itself/);
  });

  it("rejects more than 32", () => {
    const many = Array.from({ length: 33 }, (_, i) => `a${i}.near`);
    expect(run({ recipients: many }).errs.join(" ")).toMatch(/At most 32 payees/);
  });

  it("allows exactly 32", () => {
    const many = Array.from({ length: 32 }, (_, i) => `a${i}.near`);
    expect(run({ recipients: many }).errs.filter((e) => /32 payees/.test(e))).toEqual([]);
  });
});
