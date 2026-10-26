import { describe, it, expect } from "vitest";
import {
  getDashboard,
  getSpendHistory,
  paymentFromOutcome,
  recordBlocked,
  type AdapterConfig,
  type ViewFn,
} from "./handlers.js";
import type { Payment, VaultNode, VaultRequest } from "./map.js";

// Handlers are driven with a stubbed `view`, because the thing that can be
// silently wrong here is the SHAPE the Float UI receives — a plausible wrong
// number renders as fact.

const TOK = "usdc.testnet";

function cfg(over: Partial<AdapterConfig> = {}): AdapterConfig {
  return { token: TOK, decimals: 6, blockedRing: [], maxBlocked: 20, ...over };
}

const TREE: VaultNode[] = [
  {
    id: 0, parent: null, path: [], label: "root", account: null,
    limits: [{ token: TOK, daily_cap: "100000000", per_tx_cap: "100000000" }],
    child_cap_sum: [], child_count: 1, cooldown_sec: 0, frozen: false, recipients: ["bob.testnet"],
  },
  {
    id: 1, parent: 0, path: [0], label: "research", account: null,
    limits: [{ token: TOK, daily_cap: "100000000", per_tx_cap: "100000000" }],
    child_cap_sum: [], child_count: 1, cooldown_sec: 0, frozen: false, recipients: null,
  },
  {
    id: 2, parent: 1, path: [0, 1], label: "r1", account: "r1.v.testnet",
    limits: [{ token: TOK, daily_cap: "100000000", per_tx_cap: "50000000" }],
    child_cap_sum: [], child_count: 0, cooldown_sec: 0, frozen: false, recipients: null,
  },
];

const REQ: VaultRequest = {
  request_id: "q1", node_id: 2, token: TOK, amount: "25000000",
  recipient: "bob.testnet", memo: "openai", reserved_chain: [0, 1, 2], reserved_day: 20400,
  status: "SETTLED", reason_code: "SETTLED",
  created_at_ns: "1761500000000000000", updated_at_ns: "1761500001000000000",
};

function stubView(over: Record<string, unknown> = {}): ViewFn {
  const table: Record<string, unknown> = {
    get_tree: TREE,
    get_node_budget: { executed: "25000000", pending: "0" },
    list_requests: [REQ],
    get_config: { paused: false, owner: "alice.testnet", vault_id: "v.testnet" },
    ...over,
  };
  return async <T>(m: string) => table[m] as T;
}

describe("getDashboard", () => {
  it("returns a row per node, root-first, with the hierarchy drawn in", () => {
    // Teams are rows too: they hold the shared pool, which is the thing this
    // product exists to show.
    return getDashboard(stubView(), cfg()).then((d) => {
      expect(d.agents.map((a) => a.displayName)).toEqual(["root", "└─ research", "   └─ r1"]);
    });
  });

  it("reports spend in human units", async () => {
    const d = await getDashboard(stubView(), cfg());
    expect(d.agents[2]!.dailySpent).toBe("25");
    expect(d.agents[2]!.policy?.dailyBudget).toBe("100");
    expect(d.agents[2]!.policy?.perTxLimit).toBe("50");
  });

  it("reports treasury as the ROOT budget still available today", async () => {
    // cap 100 - executed 25 - pending 0 = 75 USDC, in base units.
    const d = await getDashboard(stubView(), cfg());
    expect(d.treasury.amount).toBe("75000000");
  });

  it("counts stats by outcome", async () => {
    const d = await getDashboard(stubView(), cfg());
    expect(d.transactionStats).toMatchObject({ total: 1, approved: 1, blocked: 0, failed: 0 });
  });

  it("merges in-memory blocked rows and sorts newest first", async () => {
    const c = cfg();
    recordBlocked(c, {
      id: "b1", agentId: "2", agentName: "r1", amount: "5", currency: "USDC",
      recipientAddress: "bob.testnet", venue: "bob.testnet", rail: "policy", status: "blocked",
      txSignature: null, createdAt: "2099-01-01T00:00:00.000Z", prompt: null, resultUrl: null,
      blockReason: "PARENT_DAILY_BUDGET", blockMessage: "pool exhausted",
    });
    const d = await getDashboard(stubView(), c);
    expect(d.recentActivity[0]!.id).toBe("b1");
    expect(d.recentActivity[0]!.status).toBe("blocked");
    expect(d.transactionStats.blocked).toBe(1);
  });

  it("survives a node with no limit for the configured token", async () => {
    const d = await getDashboard(stubView({ get_node_budget: null }), cfg());
    expect(d.agents[0]!.dailySpent).toBe("0");
  });
});

describe("getSpendHistory", () => {
  it("returns the UI's payments shape", async () => {
    const { payments } = await getSpendHistory(stubView(), cfg(), 20, 0);
    expect(payments[0]).toMatchObject({
      id: "q1", agentName: "r1", amount: "25", rail: "near", status: "success",
      recipientAddress: "bob.testnet",
    });
  });

  it("puts in-memory blocked rows on the FIRST page only", async () => {
    // They are not in the contract's paged list, so splicing them into later
    // pages would duplicate them as the UI scrolls.
    const c = cfg();
    const blocked: Payment = {
      id: "b1", agentId: "2", agentName: "r1", amount: "5", currency: "USDC",
      recipientAddress: "x", venue: "x", rail: "policy", status: "blocked",
      txSignature: null, createdAt: "2026-01-01T00:00:00.000Z", prompt: null, resultUrl: null,
      blockReason: "COOLDOWN", blockMessage: "too soon",
    };
    recordBlocked(c, blocked);

    const first = await getSpendHistory(stubView(), c, 20, 0);
    expect(first.payments.some((p) => p.id === "b1")).toBe(true);

    const second = await getSpendHistory(stubView(), c, 20, 20);
    expect(second.payments.some((p) => p.id === "b1")).toBe(false);
  });

  it("never returns more than the requested limit", async () => {
    const c = cfg();
    for (let i = 0; i < 30; i++) {
      recordBlocked(c, {
        id: `b${i}`, agentId: "2", agentName: "r1", amount: "1", currency: "USDC",
        recipientAddress: "x", venue: "x", rail: "policy", status: "blocked",
        txSignature: null, createdAt: "2026-01-01T00:00:00.000Z", prompt: null, resultUrl: null,
      });
    }
    const { payments } = await getSpendHistory(stubView(), c, 5, 0);
    expect(payments).toHaveLength(5);
  });
});

describe("recordBlocked", () => {
  it("bounds the ring so a long-lived process cannot grow without limit", () => {
    const c = cfg({ maxBlocked: 3 });
    for (let i = 0; i < 10; i++) {
      recordBlocked(c, {
        id: `b${i}`, agentId: "1", agentName: "x", amount: "1", currency: "USDC",
        recipientAddress: null, venue: "x", rail: "policy", status: "blocked",
        txSignature: null, createdAt: "t", prompt: null, resultUrl: null,
      });
    }
    expect(c.blockedRing).toHaveLength(3);
    expect(c.blockedRing[0]!.id).toBe("b9"); // newest first
  });
});

describe("paymentFromOutcome", () => {
  it("records a BLOCKED outcome and returns a renderable row", () => {
    const c = cfg();
    const p = paymentFromOutcome(
      c,
      { request_id: "q9", node_id: 2, status: "BLOCKED", reason_code: "PARENT_DAILY_BUDGET" },
      { 2: "r1" },
      "25",
      "bob.testnet",
    );
    expect(p?.blockReason).toBe("PARENT_DAILY_BUDGET");
    expect(p?.blockMessage).toMatch(/shared|pool/i);
    expect(c.blockedRing).toHaveLength(1);
  });

  it("records nothing for a payment that was not blocked", () => {
    const c = cfg();
    const p = paymentFromOutcome(
      c,
      { request_id: "q1", node_id: 2, status: "SETTLED", reason_code: "SETTLED" },
      {},
      "1",
      "x",
    );
    expect(p).toBeNull();
    expect(c.blockedRing).toHaveLength(0);
  });
});
