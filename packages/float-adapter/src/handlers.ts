/**
 * The /v1 endpoints the existing Float dashboard already calls, served from
 * NEAR vault views.
 *
 * `view` is injected so every handler is testable without a chain — the
 * mapping and the shape of what the UI receives are exactly where a silent
 * wrong-but-plausible number would come from.
 */

import {
  blockedToPayment,
  lifetimeByNode,
  requestToPayment,
  REASONS,
  treeToApiAgents,
  type ApiAgent,
  type DayUsage,
  type Payment,
  type VaultNode,
  type VaultOutcome,
  type VaultRequest,
} from "./map.js";

export type ViewFn = <T>(method: string, args?: unknown) => Promise<T>;

/** What the relayer recorded about a Base delivery. */
export interface DeliveryRecord {
  mode: "vault" | "operator";
  baseTxHash: string;
  payee: string;
  amount: string;
  at: string;
}

export interface AdapterConfig {
  token: string;
  decimals: number;
  /**
   * Base deliveries, keyed by request id, as the relayer recorded them.
   *
   * OFF-CHAIN ON PURPOSE. The NEAR budget already moved when the vault signed;
   * delivery on Base is something an operator observed, not something the
   * contract can attest. Keeping it in a separate map means a missing or lying
   * ledger can only ever UNDERSTATE delivery — it can never invent budget or
   * contradict the chain.
   */
  deliveries?: Record<string, DeliveryRecord>;
  /** Bounded, in-memory. See `recordBlocked`. */
  blockedRing: Payment[];
  maxBlocked: number;
  /**
   * Refusals recovered FROM CHAIN by scripts/scan-blocked.mjs, keyed by
   * request id.
   *
   * The in-memory ring above only held refusals this process personally
   * witnessed, so the most important thing the vault does — refusing a payment
   * because a SHARED pool is empty — vanished on restart and was invisible for
   * any payment made by another client. A refused request is deliberately not
   * stored in contract state (that is the storage griefing vector of §2), but
   * the NEP-297 event survives in the receipt and can be read back. These rows
   * carry a tx hash and are therefore independently checkable. The ring's are
   * not.
   */
  chainBlocked?: Record<string, ChainBlocked>;
  /**
   * The block range the scanner has actually covered. Without it, "no
   * refusals happened" and "we have not looked there" render identically —
   * which is the confusion this feature exists to remove.
   */
  blockedScan?: {
    from: number;
    to: number;
    /** Spans inside from..to that were never read. Unknown, not empty. */
    holes?: Array<{ from: number; to: number }>;
  } | null;
}

/** One refusal, as recovered from a receipt outcome. */
export interface ChainBlocked {
  requestId: string;
  nodeId: number;
  reasonCode: string;
  agent: string;
  txHash: string;
  blockHeight: number;
  blockTimestampNs: string | number;
}

/**
 * Blocked attempts are NOT stored on-chain — the hot path returns them as a
 * value and emits an event, deliberately, so an agent cannot grow the vault's
 * storage bill by spamming rejects.
 *
 * So the adapter remembers the ones it SEES, in a bounded in-memory ring. That
 * covers blocks made through this product, which is what the dashboard is
 * showing. Blocks made by another client, or before this process started, are
 * not here and cannot be — the dashboard says so rather than implying none
 * happened.
 */
/**
 * Chain-recovered refusals as Payment rows.
 *
 * Deduped against the in-memory ring by request id, preferring the chain copy
 * — it is the one that carries a tx hash a reader can check for themselves.
 */
export function chainBlockedPayments(
  cfg: AdapterConfig,
  nodeLabels: Record<number, string>,
): Payment[] {
  const seen = new Set(cfg.blockedRing.map((p) => p.id));
  return Object.values(cfg.chainBlocked ?? {})
    .filter((b) => !seen.has(b.requestId))
    .map((b) => ({
      id: b.requestId,
      agentId: String(b.nodeId),
      agentName: nodeLabels[b.nodeId] ?? `node-${b.nodeId}`,
      // The amount is NOT in the event, and inventing one would be worse than
      // showing none: a refused payment moved nothing, and a plausible figure
      // would read as fact.
      amount: "0",
      currency: "USDC",
      recipientAddress: "",
      venue: "",
      rail: "policy",
      status: "blocked",
      txSignature: b.txHash,
      createdAt: new Date(Number(BigInt(b.blockTimestampNs) / 1_000_000n)).toISOString(),
      blockReason: b.reasonCode,
      blockMessage: REASONS[b.reasonCode] ?? b.reasonCode,
      prompt: null,
      resultUrl: null,
    }));
}

export function recordBlocked(cfg: AdapterConfig, p: Payment): void {
  cfg.blockedRing.unshift(p);
  if (cfg.blockedRing.length > cfg.maxBlocked) cfg.blockedRing.length = cfg.maxBlocked;
}

async function loadTreeAndUsage(
  view: ViewFn,
  cfg: AdapterConfig,
): Promise<{ tree: VaultNode[]; budgets: Map<number, DayUsage>; labels: Record<number, string> }> {
  const tree = await view<VaultNode[]>("get_tree", {});
  const budgets = new Map<number, DayUsage>();
  const labels: Record<number, string> = {};

  // CONCURRENT, not sequential. One view per node is bounded by MAX_NODES (64),
  // but issuing them in series costs a full testnet round-trip EACH: measured
  // at 30s for a five-node tree, which is not a dashboard, it is a progress
  // bar. Only `get_tree` is a real dependency; the per-node budgets depend on
  // nothing but it. Pinned by the concurrency test in handlers.test.ts.
  for (const n of tree) labels[n.id] = n.label;
  const fetched = await Promise.all(
    tree.map((n) =>
      view<{ executed: string; pending: string } | null>("get_node_budget", {
        node_id: n.id,
        token: cfg.token,
        day: null,
      }),
    ),
  );
  tree.forEach((n, i) => {
    const b = fetched[i];
    budgets.set(n.id, b ? { executed: b.executed, pending: b.pending } : { executed: "0", pending: "0" });
  });
  return { tree, budgets, labels };
}

/** Where this vault lives, so the UI never has to hardcode a chain. */
export interface VaultInfo {
  vaultId: string;
  tokenId: string;
  tokenDecimals: number;
  network: string;
  /** NEAR Explorer base for the network the vault is actually on. */
  explorerBase: string;
  owner: string;
  paused: boolean;
  clockMode: string;
  strictAllocation: boolean;
  /**
   * The vault's ACTUAL NEP-141 balance, base units.
   *
   * Deliberately separate from `treasury.amount` on /v1/dashboard, which is the
   * root node's remaining DAILY BUDGET. They are different quantities and the
   * funding page needs this one: fund 10,000 USDC against a 100/day root cap
   * and the budget figure still reads 40, which would look like the deposit
   * never arrived. Null when the token contract cannot be read.
   */
  vaultTokenBalance: string | null;
}

/**
 * `near` / `testnet` / anything else. Derived from the network the contract
 * reports rather than from an env var, so a UI pointed at testnet cannot link
 * to a mainnet explorer and show "not found".
 */
export function explorerBaseFor(network: string): string {
  return network === "mainnet" || network === "near"
    ? "https://nearblocks.io"
    : "https://testnet.nearblocks.io";
}

/** A view against an arbitrary contract — the token, not the vault. */
export type ViewOnFn = (
  contractId: string,
  method: string,
  args?: unknown,
) => Promise<string | null>;

export async function getVaultInfo(
  view: ViewFn,
  cfg: AdapterConfig,
  viewOn: ViewOnFn,
): Promise<VaultInfo> {
  // `get_base_config` used to be read here alongside `get_config`. The
  // MPC/Base rail and its config were removed from the contract on
  // 2026-10-28, so there is no method left to call and no rail to report.
  const c = await view<{
    owner: string;
    vault_id: string;
    network: string;
    paused: boolean;
    clock_mode: string;
    strict_allocation: boolean;
  }>("get_config", {});

  // Read off the TOKEN contract, not the vault — so it is the real balance and
  // not an echo of the vault's own bookkeeping. Null rather than "0" on
  // failure: zero would read as "the deposit is not here", which is a
  // different claim from "we could not look".
  const vaultTokenBalance = await viewOn(cfg.token, "ft_balance_of", {
    account_id: c.vault_id,
  }).catch(() => null);

  return {
    vaultId: c.vault_id,
    tokenId: cfg.token,
    tokenDecimals: cfg.decimals,
    network: c.network,
    explorerBase: explorerBaseFor(c.network),
    owner: c.owner,
    paused: c.paused,
    clockMode: c.clock_mode,
    strictAllocation: c.strict_allocation,
    vaultTokenBalance,
  };
}

export interface AgentKeyView {
  accountId: string;
  nodeId: number;
  label: string;
  frozen: boolean;
  keys: {
    publicKey: string;
    /** True only if the key really is a function-call key. */
    restricted: boolean;
    receiverId: string | null;
    methodNames: string[];
    allowanceYocto: string | null;
  }[];
  /** Set when the key list could not be read, so the UI can say so. */
  error?: string;
}

export type KeyFn = (accountId: string) => Promise<
  {
    public_key: string;
    access_key: {
      permission:
        | "FullAccess"
        | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
    };
  }[]
>;

/**
 * The bound agent accounts, with their access keys read FROM THE CHAIN.
 *
 * The restriction is the product's central security claim, so the page that
 * states it must not state it from a constant. A hardcoded "restricted to
 * request_payment" would keep rendering happily if someone added a full-access
 * key to an agent account — exactly the regression a reader of that page is
 * trying to rule out. `restricted` here is computed from the permission NEAR
 * reports, and a FullAccess key makes it false.
 */
export async function getAgentKeys(
  view: ViewFn,
  keys: KeyFn,
  _cfg: AdapterConfig,
): Promise<AgentKeyView[]> {
  const tree = await view<VaultNode[]>("get_tree", {});
  const bound = tree.filter((n) => n.account);

  return Promise.all(
    bound.map(async (n): Promise<AgentKeyView> => {
      const base = {
        accountId: n.account as string,
        nodeId: n.id,
        label: n.label,
        frozen: n.frozen,
      };
      try {
        const list = await keys(n.account as string);
        return {
          ...base,
          keys: list.map((k) => {
            const p = k.access_key.permission;
            const fc = typeof p === "object" && "FunctionCall" in p ? p.FunctionCall : null;
            return {
              publicKey: k.public_key,
              restricted: fc !== null,
              receiverId: fc?.receiver_id ?? null,
              methodNames: fc?.method_names ?? [],
              allowanceYocto: fc?.allowance ?? null,
            };
          }),
        };
      } catch (e) {
        // An unreadable key list is reported, never silently rendered as "no
        // keys" — that would read as "nothing is authorised here", the
        // opposite of unknown.
        return { ...base, keys: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

export async function getDashboard(view: ViewFn, cfg: AdapterConfig) {
  const { tree, budgets, labels } = await loadTreeAndUsage(view, cfg);

  // Also concurrent: neither depends on the other.
  const [requests, cfgView] = await Promise.all([
    view<VaultRequest[]>("list_requests", { from_index: 0, limit: 20 }),
    view<{ paused: boolean; owner: string; vault_id: string }>("get_config", {}),
  ]);
  const agents: ApiAgent[] = treeToApiAgents(tree, budgets, cfg.decimals, lifetimeByNode(requests));
  const onchain = requests.map((r) =>
    requestToPayment(r, labels, cfg.decimals, cfg.deliveries?.[r.request_id]),
  );
  const recent = [...chainBlockedPayments(cfg, labels), ...cfg.blockedRing, ...onchain]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 20);
  const root = tree.find((n) => n.parent === null);
  const rootUsage = root ? budgets.get(root.id) : undefined;

  return {
    owner: { authMethod: "wallet", walletAddress: cfgView.owner, displayName: cfgView.owner },
    treasury: {
      ownerId: cfgView.owner,
      walletAddress: cfgView.vault_id,
      createdAt: new Date(0).toISOString(),
      // The vault holds the tokens; the figure the dashboard cares about is
      // how much of the ROOT budget is still available today.
      amount: root?.limits[0]
        ? (BigInt(root.limits[0].daily_cap) -
            BigInt(rootUsage?.executed ?? "0") -
            BigInt(rootUsage?.pending ?? "0")).toString()
        : "0",
      currency: "USDC",
      decimals: cfg.decimals,
    },
    agents,
    // What the refusal history actually covers. A UI that shows "0 blocked"
    // without this cannot distinguish an honest zero from an unscanned range.
    blockedCoverage: cfg.blockedScan,
    transactionStats: {
      total: onchain.length + cfg.blockedRing.length + Object.keys(cfg.chainBlocked ?? {}).length,
      // The Base rail's terminal states count as approved. "success" alone was
      // written when NEAR was the only rail; once Base payments report
      // "signed"/"delivered" it rendered "4 transactions, 0 approved /
      // 0 blocked" — every payment the vault had authorized vanished from the
      // count. The UI's own list and this total disagreed on screen.
      approved: onchain.filter((p) =>
        ["success", "signed", "delivered"].includes(p.status),
      ).length,
      blocked: cfg.blockedRing.length + Object.keys(cfg.chainBlocked ?? {}).length,
      failed: onchain.filter((p) => p.status === "failed").length,
      other: onchain.filter((p) => p.status === "pending").length,
    },
    recentActivity: recent.map((p) => ({
      id: p.id,
      agent: p.agentName,
      venue: p.venue,
      amount: p.amount,
      rail: p.rail,
      time: p.createdAt,
      status: p.status,
    })),
    paused: cfgView.paused,
  };
}

export async function getSpendHistory(
  view: ViewFn,
  cfg: AdapterConfig,
  limit: number,
  offset: number,
): Promise<{ payments: Payment[] }> {
  const tree = await view<VaultNode[]>("get_tree", {});
  const labels: Record<number, string> = {};
  for (const n of tree) labels[n.id] = n.label;

  const requests = await view<VaultRequest[]>("list_requests", {
    from_index: offset,
    limit,
  });
  const onchain = requests.map((r) =>
    requestToPayment(r, labels, cfg.decimals, cfg.deliveries?.[r.request_id]),
  );

  // Blocked rows only belong on the FIRST page: they are not part of the
  // contract's paged list, so splicing them into later pages would duplicate
  // them as the UI scrolls.
  //
  // Sorted by time rather than concatenated, because chain-recovered refusals
  // can be older than the in-memory ones and a bare prepend would show them
  // above newer activity.
  const merged =
    offset === 0
      ? [...chainBlockedPayments(cfg, labels), ...cfg.blockedRing, ...onchain].sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : -1,
        )
      : onchain;
  return { payments: merged.slice(0, limit) };
}

/** Called by the pay endpoint so a block the product caused shows up as a row. */
export function paymentFromOutcome(
  cfg: AdapterConfig,
  outcome: VaultOutcome,
  labels: Record<number, string>,
  amountHuman: string,
  recipient: string,
): Payment | null {
  if (outcome.status !== "BLOCKED") return null;
  const p = blockedToPayment(outcome, labels, amountHuman, recipient, new Date().toISOString());
  recordBlocked(cfg, p);
  return p;
}
