import { describe, it, expect } from "vitest";
import {
  coverageNote,
  explorerBaseFor,
  getAgentKeys,
  getVaultInfo,
  getDashboard,
  getSpendHistory,
  paymentFromOutcome,
  recordBlocked,
  chainBlockedPayments,
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
// Plain strings now: depth left displayName entirely, so there is no
      // invisible character to build or to get wrong.
      expect(d.agents.map((a) => a.displayName)).toEqual(["root", "research", "r1"]);
      expect(d.agents.map((a) => a.depth)).toEqual([0, 1, 2]);
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

describe("dashboard RPC concurrency", () => {
  // Measured against live testnet: issuing the per-node budget views in series
  // took 30s for a five-node tree. Only get_tree is a real dependency. This
  // pins the fix — a future refactor that reintroduces `await` inside the loop
  // would still be CORRECT and would still pass every other test, which is
  // exactly how a 30-second dashboard ships.
  it("issues the per-node budget views concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const view: ViewFn = async <T>(m: string) => {
      if (m === "get_node_budget") {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { executed: "0", pending: "0" } as T;
      }
      if (m === "get_tree") return TREE as T;
      if (m === "list_requests") return [] as T;
      return { paused: false, owner: "a.testnet", vault_id: "v.testnet" } as T;
    };

    await getDashboard(view, cfg());
    expect(peak).toBe(TREE.length);
  });

  it("does not serialise list_requests behind get_config", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = new Set(["list_requests", "get_config"]);
    const view: ViewFn = async <T>(m: string) => {
      if (slow.has(m)) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
      }
      if (m === "get_tree") return TREE as T;
      if (m === "get_node_budget") return { executed: "0", pending: "0" } as T;
      if (m === "list_requests") return [] as T;
      return { paused: false, owner: "a.testnet", vault_id: "v.testnet" } as T;
    };

    await getDashboard(view, cfg());
    expect(peak).toBe(2);
  });
});

describe("getVaultInfo", () => {
  // The Fund page reads the chain and the explorer from here. A wrong value is
  // not a crash — it is a page that confidently links somewhere useless.
  const cfgView = {
    owner: "alice.testnet",
    vault_id: "v3.testnet",
    network: "testnet",
    paused: false,
    clock_mode: "production",
    strict_allocation: false,
  };

  function view(over: Record<string, unknown> = {}): ViewFn {
    const table: Record<string, unknown> = {
      get_config: cfgView,
      ...over,
    };
    return async <T>(m: string) => table[m] as T;
  }

  it("reports the vault's REAL token balance, not its budget", async () => {
    // These are different quantities and the funding page needs this one: fund
    // 10,000 against a 100/day cap and the budget figure still reads 40, which
    // looks like the deposit never arrived.
    const info = await getVaultInfo(view(), cfg(), async () => "100000000000");
    expect(info.vaultTokenBalance).toBe("100000000000");
  });

  it("reads the balance off the TOKEN contract, for the VAULT account", async () => {
    // Asking the vault about its own balance would be an echo of its
    // bookkeeping; the token contract is the authority.
    const calls: { contract: string; method: string; args: unknown }[] = [];
    await getVaultInfo(view(), cfg(), async (contract, method, args) => {
      calls.push({ contract, method, args });
      return "7";
    });
    expect(calls).toEqual([
      { contract: TOK, method: "ft_balance_of", args: { account_id: "v3.testnet" } },
    ]);
  });

  it("reports null, not zero, when the balance cannot be read", async () => {
    // Zero reads as "the deposit is not here", which is a different claim from
    // "we could not look".
    const info = await getVaultInfo(view(), cfg(), async () => {
      throw new Error("token contract unreachable");
    });
    expect(info.vaultTokenBalance).toBeNull();
  });

  // The two base-rail tests that stood here are gone with the rail: the
  // contract no longer has `get_base_config`, so there is nothing to map and
  // no "closed" state to report. Replaced by the assertion that we no longer
  // ASK — a stale call would be a wasted RPC round-trip on every dashboard
  // load, and silently swallowed by the old `.catch(() => null)`.
  it("does not call the removed get_base_config", async () => {
    const asked: string[] = [];
    const v: ViewFn = async <T>(m: string) => {
      asked.push(m);
      return cfgView as T;
    };
    await getVaultInfo(v, cfg(), async () => "0");
    expect(asked).toEqual(["get_config"]);
  });
});

describe("explorerBaseFor", () => {
  it("points a testnet vault at the TESTNET explorer", () => {
    // A testnet vault linked to the mainnet explorer shows "not found", which
    // reads as "this contract does not exist".
    expect(explorerBaseFor("testnet")).toContain("testnet.nearblocks.io");
    expect(explorerBaseFor("sandbox")).toContain("testnet.nearblocks.io");
  });

  it("points mainnet at the mainnet explorer", () => {
    expect(explorerBaseFor("mainnet")).toBe("https://nearblocks.io");
    expect(explorerBaseFor("near")).toBe("https://nearblocks.io");
  });
});

describe("getAgentKeys", () => {
  const tree: VaultNode[] = [
    { ...TREE[0] },
    { ...TREE[1] },
    { ...TREE[2], account: "r1.v.testnet" },
  ];
  const view: ViewFn = async <T>() => tree as T;

  it("lists only nodes with a bound account", async () => {
    const rows = await getAgentKeys(view, async () => [], cfg());
    expect(rows.map((r) => r.accountId)).toEqual(["r1.v.testnet"]);
  });

  it("reports a function-call key as RESTRICTED, with its real method list", async () => {
    const rows = await getAgentKeys(
      view,
      async () => [
        {
          public_key: "ed25519:abc",
          access_key: {
            permission: {
              FunctionCall: {
                allowance: "500000000000000000000000",
                receiver_id: "v.testnet",
                method_names: ["request_payment"],
              },
            },
          },
        },
      ],
      cfg(),
    );
    expect(rows[0]!.keys[0]).toEqual({
      publicKey: "ed25519:abc",
      restricted: true,
      receiverId: "v.testnet",
      methodNames: ["request_payment"],
      allowanceYocto: "500000000000000000000000",
      // null here, not absent: this is a plain function-call key, and only a
      // NEP-611 gas key carries a balance.
      gasBalanceYocto: null,
    });
  });

  it("reports a FULL-ACCESS key as unrestricted", async () => {
    // THE point of reading this from the chain. A page that rendered
    // "restricted to request_payment" from a constant would keep saying so
    // while an agent account had a full-access key on it — which is exactly
    // the regression a reader of that page is trying to rule out.
    const rows = await getAgentKeys(
      view,
      async () => [{ public_key: "ed25519:zzz", access_key: { permission: "FullAccess" } }],
      cfg(),
    );
    expect(rows[0]!.keys[0]!.restricted).toBe(false);
    expect(rows[0]!.keys[0]!.methodNames).toEqual([]);
  });

  it("surfaces an unreadable key list instead of rendering it as no keys", async () => {
    // An empty list reads as "nothing is authorised here", the opposite of
    // unknown.
    const rows = await getAgentKeys(
      view,
      async () => {
        throw new Error("RPC down");
      },
      cfg(),
    );
    expect(rows[0]!.keys).toEqual([]);
    expect(rows[0]!.error).toContain("RPC down");
  });
});

describe("transactionStats counts the Base rail", () => {
  const baseReq = (id: string, over: Partial<VaultRequest> = {}): VaultRequest => ({
    ...REQ,
    request_id: id,
    route: { base_usdc: { nonce: "0" } },
    reason_code: "SIGNED",
    ...over,
  });

  it("counts signed and delivered payments as approved", async () => {
    // Regression: filtering on "success" alone meant a dashboard showing two
    // Base payments reported "0 approved" — the summary contradicted the list
    // rendered directly beneath it.
    const d = await getDashboard(
      stubView({ list_requests: [baseReq("a"), baseReq("b")] }),
      cfg({ deliveries: { b: { mode: "operator", baseTxHash: "0xabc", payee: "0x42", amount: "3", at: "" } } }),
    );
    expect(d.transactionStats.total).toBe(2);
    expect(d.transactionStats.approved).toBe(2);
    expect(d.transactionStats.failed).toBe(0);
  });

  it("still does not count a failed payment as approved", async () => {
    // The guard above must not become "count everything".
    const d = await getDashboard(
      stubView({
        list_requests: [baseReq("a"), baseReq("c", { status: "TRANSFER_FAILED", reason_code: "SIGNATURE_FAILED" })],
      }),
      cfg(),
    );
    expect(d.transactionStats.approved).toBe(1);
    expect(d.transactionStats.failed).toBe(1);
  });
});

describe("refusals recovered from chain", () => {
  const cb = (over: Record<string, unknown> = {}) => ({
    requestId: "r-1",
    nodeId: 2,
    reasonCode: "PARENT_DAILY_BUDGET",
    agent: "s0.v.testnet",
    txHash: "9Swer4H7",
    blockHeight: 274988232,
    blockTimestampNs: "1793097140000000000",
    ...over,
  });

  it("renders a chain refusal with its tx hash, so a reader can check it", async () => {
    // The whole point: a row the dashboard did not witness, carrying evidence
    // anyone can verify against the chain independently.
    const d = await getDashboard(stubView(), cfg({ chainBlocked: { "r-1": cb() } }));
    const row = d.recentActivity.find((r) => r.id === "r-1");
    expect(row).toBeDefined();
    expect(row!.status).toBe("blocked");
    expect(d.transactionStats.blocked).toBe(1);
  });

  it("reports the scanned block range, so zero refusals is distinguishable from never looking", async () => {
    const scanned = await getDashboard(
      stubView(),
      cfg({ chainBlocked: {}, blockedScan: { from: 100, to: 200 } }),
    );
    expect(scanned.blockedCoverage).toEqual({ from: 100, to: 200 });

    const never = await getDashboard(stubView(), cfg({ chainBlocked: {} }));
    expect(never.blockedCoverage ?? null).toBeNull();
  });

  it("does not double-count a refusal the ring already holds", async () => {
    // The in-memory ring and the chain scan can both see the same refusal.
    // Counting it twice would overstate how often the pool bound.
    const ringRow = {
      id: "r-1", agentId: "2", agentName: "r1", amount: "1", currency: "USDC",
      recipientAddress: "", venue: "", rail: "policy", status: "blocked",
      txSignature: null, createdAt: "2026-10-27T00:00:00.000Z",
      blockReason: "PARENT_DAILY_BUDGET", blockMessage: "x", prompt: null, resultUrl: null,
    };
    const merged = chainBlockedPayments(
      cfg({ blockedRing: [ringRow as never], chainBlocked: { "r-1": cb() } }),
      {},
    );
    expect(merged).toHaveLength(0);
  });
});

describe("getAgentKeys finds VIRTUAL agents", () => {
  /**
   * Sub-accounts are retired, so `n.account` is null on every node of every
   * vault created from now on — and this function filtered on exactly that.
   * The result was an agent-keys page that rendered an empty list for a
   * correctly configured vault, which reads as "nothing is authorised here":
   * the opposite of the truth, and the same failure the `error` field exists
   * to prevent for unreadable key lists.
   *
   * A virtual agent is a gas key ON THE VAULT bound with `bind_virtual_agent`.
   * The contract leaves `node.account` as None deliberately — that field means
   * "a real sub-account is bound here" and a virtual agent is the absence of
   * one — so the only way to enumerate them is the vault's own access keys,
   * each asked `get_virtual_agent_node`.
   */
  const VAULT = "v.testnet";
  const GAS_PK = "ed25519:gas";
  const OWNER_PK = "ed25519:owner";

  const viewFor =
    (bound: Record<string, number | null>): ViewFn =>
    async <T>(method: string, args?: unknown) => {
      if (method === "get_tree") return TREE as T;
      if (method === "get_virtual_agent_node") {
        const pk = (args as { public_key: string }).public_key;
        return (bound[pk] ?? null) as T;
      }
      throw new Error(`unexpected view ${method}`);
    };

  // Dispatch on the account id. A stub that returns the same keys for every
  // account is not a stand-in for the chain — it made the account-bound node
  // in the shared TREE fixture appear to hold the vault's keys, and a test
  // then failed for a reason that had nothing to do with the code.
  const keysFor = (vk: unknown) => async (id: string) => (id === VAULT ? (vk as never) : ([] as never));

  const vaultKeys = [
    // A gas key. NOTE the variant: GasKeyFunctionCall, not FunctionCall.
    {
      public_key: GAS_PK,
      access_key: {
        permission: {
          GasKeyFunctionCall: {
            allowance: null,
            balance: "119297352510720700000000",
            receiver_id: VAULT,
            method_names: ["request_payment"],
            num_nonces: 1,
          },
        },
      },
    },
    // The owner's key, which the factory installs. Not an agent.
    { public_key: OWNER_PK, access_key: { permission: "FullAccess" as const } },
  ];

  it("lists a bound gas key as an agent on its node", async () => {
    const rows = await getAgentKeys(
      viewFor({ [GAS_PK]: 0 }),
      keysFor(vaultKeys),
      cfg({ vault: VAULT }),
    );
    const virt = rows.filter((r) => r.virtual);
    expect(virt).toHaveLength(1);
    expect(virt[0]!.nodeId).toBe(0);
    expect(virt[0]!.accountId).toBe(VAULT);
    expect(virt[0]!.keys.map((k) => k.publicKey)).toEqual([GAS_PK]);
  });

  /**
   * A gas key IS restricted — it names one method on one contract. Reading
   * `perm.FunctionCall` finds nothing on a `GasKeyFunctionCall` and would
   * report the key as unrestricted, which is the single most misleading thing
   * this page could say about an agent.
   */
  it("reports a gas key as restricted, with its method list and balance", async () => {
    const rows = await getAgentKeys(
      viewFor({ [GAS_PK]: 0 }),
      keysFor(vaultKeys),
      cfg({ vault: VAULT }),
    );
    const k = rows.find((r) => r.virtual)!.keys[0]!;
    expect(k.restricted).toBe(true);
    expect(k.methodNames).toEqual(["request_payment"]);
    expect(k.receiverId).toBe(VAULT);
    // For a gas key the BALANCE is the cap; allowance is null by design.
    expect(k.allowanceYocto).toBeNull();
    expect(k.gasBalanceYocto).toBe("119297352510720700000000");
  });

  /** The owner's full-access key is not an agent and must not be listed. */
  it("does not treat the owner's full-access key as an agent", async () => {
    const rows = await getAgentKeys(
      viewFor({ [GAS_PK]: 0 }),
      keysFor(vaultKeys),
      cfg({ vault: VAULT }),
    );
    const pks = rows.flatMap((r) => r.keys.map((k) => k.publicKey));
    expect(pks).not.toContain(OWNER_PK);
  });

  /** An unbound key on the vault is not an agent either. */
  it("ignores a key on the vault that is not bound to a node", async () => {
    const rows = await getAgentKeys(
      viewFor({}), // nothing bound
      keysFor(vaultKeys),
      cfg({ vault: VAULT }),
    );
    expect(rows.filter((r) => r.virtual)).toEqual([]);
  });

  /**
   * Both rails at once. `bind_agent` is kept — it binds an account that
   * already exists and strands nothing — so a vault can legitimately have
   * both, and neither may hide the other.
   */
  it("lists account-bound and virtual agents together", async () => {
    const mixed: VaultNode[] = [{ ...TREE[0]! }, { ...TREE[1]! }, { ...TREE[2]!, account: "r1.v.testnet" }];
    const view: ViewFn = async <T>(method: string, args?: unknown) => {
      if (method === "get_tree") return mixed as T;
      if (method === "get_virtual_agent_node") {
        return ((args as { public_key: string }).public_key === GAS_PK ? 0 : null) as T;
      }
      throw new Error(`unexpected view ${method}`);
    };
    const rows = await getAgentKeys(
      view,
      async (id: string) => (id === VAULT ? (vaultKeys as never) : ([] as never)),
      cfg({ vault: VAULT }),
    );
    expect(rows.filter((r) => !r.virtual).map((r) => r.accountId)).toEqual(["r1.v.testnet"]);
    expect(rows.filter((r) => r.virtual).map((r) => r.nodeId)).toEqual([0]);
  });

  /**
   * A FAILED BINDING LOOKUP IS NOT "NOT AN AGENT".
   *
   * The first version of this used `.catch(() => null)`, which gives an RPC
   * error and a genuine "this key is not bound" the same value — so a
   * rate-limited chain rendered "no virtual agents" for a vault that has one.
   * Caught live: two adapters against one RPC produced HTTP 429 and the list
   * came back empty rather than unknown. Same absent-versus-unreadable
   * inversion the `error` field exists to prevent for key lists.
   */
  it("reports an unreadable binding lookup instead of rendering it as no agents", async () => {
    const view: ViewFn = async <T>(method: string) => {
      if (method === "get_tree") return TREE as T;
      throw new Error("RPC https://test.rpc.fastnear.com returned HTTP 429");
    };
    const rows = await getAgentKeys(view, keysFor(vaultKeys), cfg({ vault: VAULT }));
    const virt = rows.filter((r) => r.virtual);
    expect(virt).toHaveLength(1);
    expect(virt[0]!.error).toContain("429");
    expect(virt[0]!.keys).toEqual([]);
  });

  /** With no vault configured it must not invent one or crash. */
  it("degrades to account-only when the vault id is unknown", async () => {
    const rows = await getAgentKeys(viewFor({ [GAS_PK]: 0 }), async () => [] as never, cfg());
    expect(rows.every((r) => !r.virtual)).toBe(true);
  });
});

describe("coverageNote states what the refusal history actually covers", () => {
  /**
   * `blockedCoverage` was already on /v1/dashboard, computed behind a comment
   * reading "A UI that shows 0 blocked without this cannot distinguish an
   * honest zero from an unscanned range" — and NO page rendered it. So the
   * activity page showed four payments and zero refusals with nothing saying
   * that 95% of the vault's blocks had never been read.
   *
   * The sentence is built HERE rather than in the page because this module
   * owns the distinction, has the tests, and is the thing that knows a hole
   * from an honest zero. A formatter duplicated in JSX is one that drifts, and
   * the direction it drifts is always toward claiming more coverage than
   * exists.
   */
  it("says refusals are UNKNOWN when nothing has been scanned", () => {
    for (const c of [null, undefined]) {
      const note = coverageNote(c);
      expect(note.scanned).toBe(false);
      expect(note.text).toMatch(/not been scanned|unknown/i);
      // The word that must never appear: it would turn "we did not look" into
      // "nothing happened".
      expect(note.text).not.toMatch(/\bnone\b|\bno refusals\b/i);
    }
  });

  it("reports the scanned range and block count", () => {
    const note = coverageNote({ from: 275882255, to: 275883754, holes: [] });
    expect(note.scanned).toBe(true);
    expect(note.text).toContain("275882255");
    expect(note.text).toContain("275883754");
    expect(note.text).toContain("1,500");
  });

  /** Outside the range is unknown, and the sentence has to say so. */
  it("says refusals outside the range are unknown", () => {
    const note = coverageNote({ from: 100, to: 200, holes: [] });
    expect(note.text).toMatch(/outside/i);
    expect(note.text).toMatch(/unknown/i);
  });

  /**
   * A hole is the case this whole subsystem exists for: blocks INSIDE the
   * claimed range that were never actually read. Reporting the range without
   * them overstates coverage.
   */
  it("counts unread blocks inside the range", () => {
    const note = coverageNote({
      from: 1000,
      to: 2000,
      holes: [
        { from: 1100, to: 1109 },
        { from: 1500, to: 1500 },
      ],
    });
    expect(note.unreadBlocks).toBe(11);
    expect(note.text).toMatch(/11 block/);
    expect(note.text).toMatch(/unread|not read/i);
  });

  it("does not mention holes when there are none", () => {
    const note = coverageNote({ from: 1, to: 10, holes: [] });
    expect(note.unreadBlocks).toBe(0);
    expect(note.text).not.toMatch(/unread/i);
  });

  /**
   * THE SHORT FORM, which exists because `text` is a three-sentence amber
   * paragraph and on a 375px screen it was the largest thing on the activity
   * page — bigger than the payments it qualifies.
   *
   * The obvious fix was for the page to shorten it, and that is precisely
   * what this module exists to prevent. A formatter in JSX drifts, and the
   * direction it drifts is toward claiming more coverage than exists. So the
   * short form is built here and tested here, to the SAME standard: these
   * assertions are the long form's assertions, re-run against fewer words.
   *
   * What may be dropped is the block HEIGHTS — those are for checking the
   * claim, and the full sentence is one tap away. What may never be dropped
   * is the distinction between "we did not look" and "nothing happened".
   */
  describe("the one-line form carries the same caveat", () => {
    it("never turns an unscanned range into an empty one", () => {
      for (const c of [null, undefined]) {
        const note = coverageNote(c);
        expect(note.short).toMatch(/unknown|not scanned/i);
        // The same forbidden words as the long form. "No refusals" would
        // convert "we did not look" into "nothing happened".
        expect(note.short).not.toMatch(/\bnone\b|\bno refusals\b/i);
      }
    });

    /**
     * THE LOAD-BEARING HALF. "1,500 blocks read" on its own is a boast; it
     * invites a reader to treat a quiet list as a complete one. The clause
     * that stops that is the one about everything outside the range, and it
     * is the first thing a well-meaning edit would cut for length.
     */
    it("says that outside the scanned range refusals are unknown", () => {
      const note = coverageNote({ from: 275882255, to: 275883754, holes: [] });
      expect(note.short).toMatch(/unknown/i);
      expect(note.short).toContain("1,500");
    });

    it("still reports unread blocks inside the range", () => {
      const note = coverageNote({
        from: 1000,
        to: 2000,
        holes: [{ from: 1100, to: 1109 }, { from: 1500, to: 1500 }],
      });
      expect(note.short).toMatch(/11/);
      expect(note.short).toMatch(/unread/i);
    });

    it("says nothing about holes when there are none", () => {
      expect(coverageNote({ from: 1, to: 10, holes: [] }).short).not.toMatch(/unread/i);
    });

    /**
     * It has to actually BE short, or it is the long form with extra steps.
     *
     * 72 characters is roughly two lines at the size this renders on a
     * 375px screen. The worst realistic case is a scan with holes, which is
     * the one measured here. The long form is ~230 characters for the same
     * input, which is what made it the biggest thing on the page.
     */
    it("fits on a phone, where the long form did not", () => {
      const worst = coverageNote({
        from: 275882255,
        to: 275883754,
        holes: [{ from: 275882300, to: 275882308 }],
      });
      expect(worst.short.length, `too long to be the short form: ${worst.short}`).toBeLessThanOrEqual(72);
      // Positive control: the thing it replaces genuinely does not fit, so
      // this bound is not one that any string would pass.
      expect(worst.text.length).toBeGreaterThan(150);
    });
  });
});
