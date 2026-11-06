import { describe, it, expect } from "vitest";
import { computeChanges, type DraftState, type ChainState } from "./policy-changes";

const CHAIN: ChainState = {
  daily: "100",
  perTx: "2",
  cooldown: 0,
  ownRecipients: ["alice.near"],
};

const draft = (over: Partial<DraftState> = {}): DraftState => ({
  dailyCap: "100",
  perTxCap: "2",
  cooldown: 0,
  recipients: ["alice.near"],
  ...over,
});

describe("computeChanges", () => {
  it("reports nothing when the draft matches the chain", () => {
    expect(computeChanges(draft(), CHAIN, true)).toEqual([]);
  });

  it("reports nothing when no agent is selected", () => {
    expect(computeChanges(draft({ dailyCap: "999" }), CHAIN, false)).toEqual([]);
  });

  /**
   * The two caps are arguments of ONE set_node_caps call, so they must share a
   * group. If they split, the review panel implies two signatures where there
   * is one - the exact confusion the old per-row buttons caused.
   */
  it("puts both caps in the SAME group, because one call carries both", () => {
    const out = computeChanges(draft({ dailyCap: "150", perTxCap: "5" }), CHAIN, true);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.group))).toEqual(new Set(["caps"]));
  });

  it("shows the real previous value, not a blank", () => {
    const [c] = computeChanges(draft({ dailyCap: "50" }), CHAIN, true);
    expect(c.from).toBe("100 USDC");
    expect(c.to).toBe("50 USDC");
    // the failure mode worth naming: "unset -> 50" would read as filling in a
    // blank, when it is actually halving a limit
    expect(c.from).not.toBe("unset");
  });

  it("says 'unset' only when the chain really holds nothing", () => {
    const empty: ChainState = { ...CHAIN, daily: "" };
    const [c] = computeChanges(draft({ dailyCap: "50" }), empty, true);
    expect(c.from).toBe("unset");
  });

  it("renders an emptied field as 0, not as an empty string", () => {
    const [c] = computeChanges(draft({ dailyCap: "" }), CHAIN, true);
    expect(c.to).toBe("0 USDC");
  });

  it("describes a cooldown in words, not seconds", () => {
    const [c] = computeChanges(draft({ cooldown: 60 }), CHAIN, true);
    expect(c.group).toBe("cooldown");
    expect(c.from).not.toMatch(/^\d+$/);
    expect(c.to).not.toMatch(/^\d+$/);
  });

  /**
   * Clearing the box means INHERIT, not "allow nobody". The contract rejects
   * an empty list outright (validate_recipients, "1..=32 recipients, or None
   * to inherit"), so a line reading "none" would describe a state that cannot
   * exist and scare the owner off a legitimate edit.
   */
  it("calls an emptied payee list inheritance, not a lockout", () => {
    const [c] = computeChanges(draft({ recipients: [] }), CHAIN, true);
    expect(c.to).toBe("inherit from above");
    expect(c.to).not.toMatch(/none|nobody|empty/i);
  });

  it("describes a node that was already inheriting", () => {
    const inheriting: ChainState = { ...CHAIN, ownRecipients: [] };
    const [c] = computeChanges(draft({ recipients: ["bob.near"] }), inheriting, true);
    expect(c.from).toBe("inherited from above");
  });

  /** The contract stores a list; reordering it is a real transaction. */
  it("treats a reorder as a change", () => {
    const chain: ChainState = { ...CHAIN, ownRecipients: ["a.near", "b.near"] };
    const out = computeChanges(draft({ recipients: ["b.near", "a.near"] }), chain, true);
    expect(out).toHaveLength(1);
    expect(out[0].group).toBe("recipients");
  });

  it("collects several independent edits at once", () => {
    const out = computeChanges(
      draft({ dailyCap: "150", cooldown: 30, recipients: ["z.near"] }),
      CHAIN,
      true,
    );
    expect(out.map((c) => c.group)).toEqual(["caps", "cooldown", "recipients"]);
  });
});
