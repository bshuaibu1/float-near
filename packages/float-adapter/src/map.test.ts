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
    const NB = "\u00a0";
    const rows = treeToApiAgents(tree, budgets, D);
    expect(rows.map((r) => r.displayName)).toEqual([
      "root",
      "└─ research",
      NB.repeat(3) + "└─ r1",
      NB.repeat(3) + "└─ r2",
    ]);
  });

  /**
   * REGRESSION. The first version indented with PLAIN spaces. Every assertion
   * passed and the page rendered FLAT, because HTML collapses leading
   * whitespace - depth 2 looked identical to depth 1 and the hierarchy, the
   * entire point of the view, was invisible. Found by looking at the screen,
   * not by a test. So this asserts the actual character and explicitly
   * rejects the space that silently regresses it.
   */
  it("indents with NON-BREAKING spaces, which HTML will not collapse", () => {
    const rows = treeToApiAgents(tree, budgets, D);
    const deep = rows[2]!.displayName;
    expect(deep.startsWith("\u00a0")).toBe(true);
    expect(deep.startsWith(" ")).toBe(false);
  });

  it("gives each depth a visibly different prefix", () => {
    const rows = treeToApiAgents(tree, budgets, D);
    const pre = (s: string) => s.slice(0, s.indexOf("└"));
    expect(pre(rows[1]!.displayName)).toBe("");
    expect(pre(rows[2]!.displayName).length).toBe(3);
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

  it("uses the memo as the venue, since that is what the agent paid for", () => {
    expect(requestToPayment(req({ memo: "openai.com/v1" }), {}, D).venue).toBe("openai.com/v1");
  });

  it("falls back to the recipient when there is no memo", () => {
    expect(requestToPayment(req({ memo: "" }), {}, D).venue).toBe("bob.testnet");
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
