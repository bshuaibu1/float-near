import { describe, it, expect } from "vitest";
import { nodeToApiAgent, requestToPayment, blockedToPayment, treeToApiAgents, railOf } from "./map.js";
import type { VaultNode, VaultRequest } from "./map.js";

// The Float dashboard renders unchanged against these shapes. Every field it
// reads is produced here, so a mis-mapping is invisible in the UI — it just
// shows a plausible wrong number.

const D = 6;

function node(over: Partial<VaultNode> = {}): VaultNode {
  return {
    id: 2,
    parent: 1,
    path: [0, 1],
    label: "r1",
    account: "r1.vault.testnet",
    limits: [{ token: "usdc.testnet", daily_cap: "300000000", per_tx_cap: "100000000" }],
    child_cap_sum: [],
    child_count: 0,
    cooldown_sec: 0,
    frozen: false,
    recipients: null,
    ...over,
  };
}

function req(over: Partial<VaultRequest> = {}): VaultRequest {
  return {
    request_id: "q1",
    node_id: 2,
    token: "usdc.testnet",
    amount: "12500000",
    recipient: "bob.testnet",
    memo: "api call",
    reserved_chain: [0, 1, 2],
    reserved_day: 20_400,
    status: "SETTLED",
    reason_code: "SETTLED",
    created_at_ns: "1761500000000000000",
    updated_at_ns: "1761500001000000000",
    ...over,
  };
}

describe("nodeToApiAgent", () => {
  /**
   * A MISSING VALUE MUST BE MISSING.
   *
   * The contract's `Node` has no timestamp - id, parent, path, label,
   * account, limits, cooldown, frozen, recipients, and that is all. Only a
   * payment request carries `created_at_ns`.
   *
   * This field used to be `new Date(0).toISOString()`, which satisfied a
   * non-nullable type by inventing epoch zero. Nothing rendered it, so it was
   * not a visible bug; it was a loaded one, waiting for the first page to show
   * an agent's age and announce "Jan 1, 1970" with total confidence.
   */
  it("reports NO creation time, rather than inventing epoch zero", () => {
    const a = nodeToApiAgent(node(), { executed: "0", pending: "0" }, D);
    expect(a.createdAt).toBeNull();
    expect(a.createdAt).not.toBe(new Date(0).toISOString());
    expect(String(a.createdAt)).not.toMatch(/1970/);
  });

  it("renders caps in HUMAN units", () => {
    // The dashboard prints policy.dailyBudget straight into the table. Base
    // units here would show 300000000 where the owner set 300.
    const a = nodeToApiAgent(node(), { executed: "45000000", pending: "0" }, D);
    expect(a.policy?.dailyBudget).toBe("300");
    expect(a.policy?.perTxLimit).toBe("100");
  });

  it("counts in-flight spend against the day, like the contract does", () => {
    // available = cap - (executed + pending). A dashboard that ignored pending
    // would show headroom the contract will refuse to honour.
    const a = nodeToApiAgent(node(), { executed: "100000000", pending: "50000000" }, D);
    expect(a.dailySpent).toBe("150");
  });

  it("maps frozen to the killed status the UI already understands", () => {
    expect(nodeToApiAgent(node({ frozen: true }), { executed: "0", pending: "0" }, D).status).toBe(
      "killed",
    );
    expect(nodeToApiAgent(node(), { executed: "0", pending: "0" }, D).status).toBe("active");
  });

  it("uses the bound sub-account as the wallet address", () => {
    expect(nodeToApiAgent(node(), { executed: "0", pending: "0" }, D).walletAddress).toBe(
      "r1.vault.testnet",
    );
  });

  it("shows an internal node with no bound account rather than hiding it", () => {
    // A team node holds a real budget. Dropping it would make the parent pool
    // invisible, which is the thing this product exists to show.
    const a = nodeToApiAgent(
      node({ id: 1, parent: 0, path: [0], label: "research", account: null, child_count: 2 }),
      { executed: "0", pending: "0" },
      D,
    );
    expect(a.walletAddress).toBe("");
    expect(a.agentId).toBe("node-1");
  });

  it("reports the cooldown the contract enforces", () => {
    const a = nodeToApiAgent(node({ cooldown_sec: 60 }), { executed: "0", pending: "0" }, D);
    expect(a.policy?.cooldownSeconds).toBe(60);
  });

  it("always reports blockUnknown, because the allowlist is not optional", () => {
    // On Solana this was a toggle. Here the payee allowlist is always enforced
    // on-chain, so reporting false would misdescribe the contract.
    const a = nodeToApiAgent(node(), { executed: "0", pending: "0" }, D);
    expect(a.policy?.blockUnknown).toBe(true);
  });

  it("omits the Solana-only policy toggles rather than inventing values", () => {
    const p = nodeToApiAgent(node(), { executed: "0", pending: "0" }, D).policy!;
    expect(p.allowX402).toBeUndefined();
    expect(p.allowMpp).toBeUndefined();
    expect(p.autoTopUp).toBeUndefined();
  });
});

describe("treeToApiAgents", () => {
  const tree: VaultNode[] = [
    node({ id: 0, parent: null, path: [], label: "root", account: null, child_count: 2, recipients: ["bob.testnet"] }),
    node({ id: 1, parent: 0, path: [0], label: "research", account: null, child_count: 2 }),
    node({ id: 2, parent: 1, path: [0, 1], label: "r1", account: "r1.vault.testnet" }),
    node({ id: 3, parent: 1, path: [0, 1], label: "r2", account: "r2.vault.testnet" }),
  ];
  const budgets = new Map(tree.map((n) => [n.id, { executed: "0", pending: "0" }]));

  it("keeps the tree order root-first so the hierarchy reads top-down", () => {
    const rows = treeToApiAgents(tree, budgets, D);
    expect(rows.map((r) => r.displayName)).toEqual(["root", "research", "r1", "r2"]);
  });

  /**
   * Depth is a NUMBER now.
   *
   * It used to be three U+00A0 per level baked into displayName, and the
   * test here asserted those characters. That format caused every
   * invisible-character bug in this project - a plain space typed in place
   * of the pad matched nothing and flattened the tree, silently, three
   * separate times. A number cannot be mistyped invisibly.
   */
  it("reports depth as a number, with root at 0", () => {
    const rows = treeToApiAgents(tree, budgets, D);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2]);
  });

  it("leaves the label clean - no glyphs, no padding, nothing invisible", () => {
    const rows = treeToApiAgents(tree, budgets, D);
    for (const r of rows) {
      expect(r.displayName).toBe(r.displayName.trim());
      // Anything outside printable ASCII would be a regression to the
      // old format; account labels are [a-z0-9] by contract rule.
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7e]*$/.test(r.displayName)).toBe(true);
    }
  });
  it("resolves the EFFECTIVE payee allowlist, not the raw node field", () => {
    // Children inherit root list on-chain. Reporting their raw null made the
    // UI badge them unrestricted, the opposite of what the contract enforces.
    const rows = treeToApiAgents(tree, budgets, D);
    for (const r of rows) {
      expect(r.policy?.allowedAddresses).toEqual(["bob.testnet"]);
    }
  });
});

describe("requestToPayment", () => {
  it("maps a settled payment to the UI's success shape", () => {
    const p = requestToPayment(req(), { 2: "r1" }, D);
    expect(p.status).toBe("success");
    expect(p.rail).toBe("near");
    expect(p.amount).toBe("12.5");
    expect(p.recipientAddress).toBe("bob.testnet");
    expect(p.agentName).toBe("r1");
  });

  it("maps a failed transfer to failed, and keeps its reason code", () => {
    const p = requestToPayment(req({ status: "TRANSFER_FAILED", reason_code: "TRANSFER_FAILED" }), {}, D);
    expect(p.status).toBe("failed");
    expect(p.blockReason).toBe("TRANSFER_FAILED");
  });

  it("maps an in-flight payment to pending rather than silently to success", () => {
    const p = requestToPayment(req({ status: "TRANSFER_PENDING", reason_code: "TRANSFER_PENDING" }), {}, D);
    expect(p.status).toBe("pending");
  });

  it("converts the nanosecond clock to an ISO timestamp the UI can sort", () => {
    const p = requestToPayment(req({ created_at_ns: "1761500000000000000" }), {}, D);
    // 1761500000 seconds since epoch, not 1761500000000000000 ms.
    expect(p.createdAt).toBe(new Date(1_761_500_000_000).toISOString());
  });

  /**
   * THE MEMO IS REDACTED ON THE PUBLIC SURFACE, as of 2026-11-11.
   *
   * This used to assert the opposite — `venue` was `memo || recipient` — and
   * that was right while the dashboard served one configured vault. It is
   * wrong now that the dashboard is keyless and multi-tenant: anyone can type
   * a vault name, and a memo is what a company paid FOR.
   *
   * NOT A PRIVACY CLAIM. The memo is on chain and one view call away. This
   * removes it from the surface that turned "know how to query a NEAR RPC"
   * into "type a name".
   */
  it("REDACTS the memo rather than showing it as the venue", () => {
    const p = requestToPayment(req({ memo: "openai.com/v1" }), {}, D);
    expect(p.venue).toBe("bob.testnet");
    expect(p.prompt).toBeNull();
  });

  it("looks identical whether a memo existed or not", () => {
    // A consumer must not be able to tell WHICH vaults have interesting memos.
    // A "redacted" marker on some rows and not others would advertise exactly
    // the thing being withheld.
    const withMemo = requestToPayment(req({ memo: "acquiring competitor" }), {}, D);
    const without = requestToPayment(req({ memo: "" }), {}, D);
    expect(withMemo.venue).toBe(without.venue);
    expect(withMemo.prompt).toBe(without.prompt);
  });
});

describe("blockedToPayment", () => {
  // The existing Float UI already renders blocked rows: rail "policy",
  // status "blocked", with blockReason/blockMessage. Feeding it is all that
  // is needed — no UI change.
  it("uses the rail and status the UI already filters on", () => {
    const p = blockedToPayment(
      {
        request_id: "q9",
        node_id: 3,
        status: "BLOCKED",
        reason_code: "PARENT_DAILY_BUDGET",
      },
      { 3: "r2" },
      "25",
      "bob.testnet",
      "2026-10-26T12:00:00.000Z",
    );
    expect(p.rail).toBe("policy");
    expect(p.status).toBe("blocked");
    expect(p.blockReason).toBe("PARENT_DAILY_BUDGET");
  });

  it("explains a parent-pool block differently from an own-budget block", () => {
    // These are the two codes the whole hierarchy exists to distinguish. If
    // the dashboard renders the same sentence for both, the product's point
    // is invisible to the person looking at it.
    const parent = blockedToPayment(
      { request_id: "a", node_id: 3, status: "BLOCKED", reason_code: "PARENT_DAILY_BUDGET" },
      {},
      "1",
      "x",
      "t",
    ).blockMessage!;
    const own = blockedToPayment(
      { request_id: "b", node_id: 3, status: "BLOCKED", reason_code: "DAILY_BUDGET" },
      {},
      "1",
      "x",
      "t",
    ).blockMessage!;
    expect(parent).not.toBe(own);
    expect(parent.toLowerCase()).toMatch(/shared|parent|pool/);
    expect(own.toLowerCase()).toMatch(/own|its own|agent/);
  });

  it("has a message for every reason code the hot path can return", () => {
    const codes = [
      "VAULT_PAUSED",
      "NODE_FROZEN",
      "NOT_AGENT",
      "DUPLICATE_REQUEST",
      "INVALID_REQUEST_ID",
      "INVALID_AMOUNT",
      "INVALID_MEMO",
      "TOKEN_NOT_ALLOWED",
      "RECIPIENT_NOT_ALLOWED",
      "COOLDOWN",
      "PER_TX_LIMIT",
      "PARENT_PER_TX_LIMIT",
      "DAILY_BUDGET",
      "PARENT_DAILY_BUDGET",
    ];
    for (const code of codes) {
      const m = blockedToPayment(
        { request_id: "x", node_id: 1, status: "BLOCKED", reason_code: code },
        {},
        "1",
        "y",
        "t",
      ).blockMessage;
      expect(m, `no message for ${code}`).toBeTruthy();
      // A fallback that just echoes the code is not an explanation.
      expect(m, `${code} fell through to the generic message`).not.toBe(code);
    }
  });
});

describe("railOf", () => {
  // A cross-chain payment shown as a NEAR one is the UI asserting something
  // false about where the money went — the same failure mode as the "Open
  // x402" badge, which also passed every test.
  it("reports base for a Base-routed payment", () => {
    const p = requestToPayment(
      req({ route: { base_usdc: { nonce: "0" } } }),
      { 2: "r1" },
      D,
    );
    expect(p.rail).toBe("base");
  });

  it("reports near for the NEAR rail", () => {
    expect(requestToPayment(req({ route: "near_direct" }), {}, D).rail).toBe("near");
  });

  it("reports near for a request stored before the Base rail existed", () => {
    // Pre-existing rows have no route field at all. Defaulting to "base" would
    // retroactively mislabel every historical NEAR payment.
    expect(railOf(undefined)).toBe("near");
    expect(railOf(null)).toBe("near");
  });
});

describe("a Base payment is not reported as success", () => {
  // The contract proved it obtained a SIGNATURE over a Base transaction. It
  // cannot observe whether that transaction landed, and nothing in this repo
  // relays it. "Success" would tell the reader the money arrived — the one
  // claim this design is careful never to make.
  it("maps a SIGNED base payment to 'signed', not 'success'", () => {
    const p = requestToPayment(
      req({ route: { base_usdc: { nonce: "0" } }, status: "SETTLED", reason_code: "SIGNED" }),
      {},
      D,
    );
    expect(p.status).toBe("signed");
    expect(p.rail).toBe("base");
  });

  it("still maps a NEAR-rail SETTLED payment to success", () => {
    // On the NEP-141 rail, SETTLED really does mean the tokens moved, so this
    // must not be collateral damage from the rule above.
    const p = requestToPayment(
      req({ route: "near_direct", status: "SETTLED", reason_code: "SETTLED" }),
      {},
      D,
    );
    expect(p.status).toBe("success");
    expect(p.rail).toBe("near");
  });

  it("maps a FAILED signature to failed, not signed", () => {
    const p = requestToPayment(
      req({
        route: { base_usdc: { nonce: "0" } },
        status: "TRANSFER_FAILED",
        reason_code: "SIGNATURE_FAILED",
      }),
      {},
      D,
    );
    expect(p.status).toBe("failed");
  });
});

describe("Base delivery is reported only on evidence", () => {
  const baseReq = () =>
    req({ route: { base_usdc: { nonce: "0" } }, status: "SETTLED", reason_code: "SIGNED" });

  it("stays 'signed' with no relayer record", () => {
    // The chain cannot attest Base settlement, so it is never inferred.
    const p = requestToPayment(baseReq(), {}, D);
    expect(p.status).toBe("signed");
    expect(p.txSignature).toBeNull();
  });

  it("becomes 'delivered' and carries the Base tx hash once a relayer reports one", () => {
    const p = requestToPayment(baseReq(), {}, D, {
      baseTxHash: "0xabc123",
      mode: "operator",
    });
    expect(p.status).toBe("delivered");
    expect(p.txSignature).toBe("0xabc123");
  });

  it("does not let a delivery record upgrade a BLOCKED payment", () => {
    // A blocked payment never reached the signer, so no honest relayer could
    // have a hash for it. If one appears anyway, the contract's word wins.
    const p = requestToPayment(
      req({ route: { base_usdc: {} }, status: "BLOCKED", reason_code: "PARENT_DAILY_BUDGET" }),
      {},
      D,
      { baseTxHash: "0xdeadbeef", mode: "operator" },
    );
    expect(p.status).toBe("blocked");
  });
});

describe("railOf after the MPC rail was retired", () => {
  it("labels a cross-chain payment as intents, not near", () => {
    // The whole reason railOf exists: a cross-chain payment rendered as a
    // local one is the UI stating something false about where money went.
    expect(railOf({ intents: { deposit_address: "x.near" } })).toBe("intents");
  });

  it("still labels LEGACY base_usdc requests as base", () => {
    // The variant is gone from the contract, but a vault deployed before the
    // change still has those requests in state and list_requests keeps
    // returning them. Falling through to "near" would relabel a cross-chain
    // payment as a local one — silently, and only on old data.
    expect(railOf({ base_usdc: { nonce: "0" } })).toBe("base");
  });

  it("reports near for an absent or unrecognised route", () => {
    expect(railOf(null)).toBe("near");
    expect(railOf(undefined)).toBe("near");
    expect(railOf("near_direct")).toBe("near");
  });
});

describe("own vs effective allowlist", () => {
  /**
   * THESE ARE DIFFERENT QUESTIONS AND AN EDITOR NEEDS BOTH.
   *
   * `allowedAddresses` answers "who can be paid from here" — the contract's
   * `effective_recipients`, which walks up to the nearest ancestor with a
   * list. `ownAllowedAddresses` answers "what is written on THIS node", and
   * is absent when the node inherits.
   *
   * Conflating them is not cosmetic. A child list REPLACES the inherited one
   * rather than extending it, so an editor shown only the effective list
   * would display the parent's addresses as if they were the child's — and
   * saving that form would detach the child from the parent while looking
   * like a no-op.
   */
  it("reports the inherited list as effective but not as own", () => {
    const tree: VaultNode[] = [
      { id: 0, parent: null, path: [], label: "root", account: null, limits: [], child_cap_sum: [], child_count: 1, cooldown_sec: 0, frozen: false, recipients: ["alice.testnet"] },
      { id: 1, parent: 0, path: [0], label: "marketing", account: null, limits: [], child_cap_sum: [], child_count: 0, cooldown_sec: 0, frozen: false, recipients: null },
    ];
    const [, child] = treeToApiAgents(tree, new Map(), 6);
    expect(child.policy?.allowedAddresses).toEqual(["alice.testnet"]);
    expect(child.policy?.ownAllowedAddresses, "an inheriting node has no own list").toBeUndefined();
  });

  it("reports a node's own list as both", () => {
    const tree: VaultNode[] = [
      { id: 0, parent: null, path: [], label: "root", account: null, limits: [], child_cap_sum: [], child_count: 1, cooldown_sec: 0, frozen: false, recipients: ["alice.testnet"] },
      { id: 1, parent: 0, path: [0], label: "marketing", account: null, limits: [], child_cap_sum: [], child_count: 0, cooldown_sec: 0, frozen: false, recipients: ["bob.testnet"] },
    ];
    const [, child] = treeToApiAgents(tree, new Map(), 6);
    expect(child.policy?.allowedAddresses).toEqual(["bob.testnet"]);
    expect(child.policy?.ownAllowedAddresses).toEqual(["bob.testnet"]);
  });

  /** A child list REPLACES rather than unions — the parent's is not merged in. */
  it("does not merge a child list with its parent's", () => {
    const tree: VaultNode[] = [
      { id: 0, parent: null, path: [], label: "root", account: null, limits: [], child_cap_sum: [], child_count: 1, cooldown_sec: 0, frozen: false, recipients: ["alice.testnet"] },
      { id: 1, parent: 0, path: [0], label: "marketing", account: null, limits: [], child_cap_sum: [], child_count: 0, cooldown_sec: 0, frozen: false, recipients: ["bob.testnet"] },
    ];
    const [, child] = treeToApiAgents(tree, new Map(), 6);
    expect(child.policy?.allowedAddresses).not.toContain("alice.testnet");
  });
});
