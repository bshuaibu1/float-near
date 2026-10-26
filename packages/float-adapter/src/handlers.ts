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
  treeToApiAgents,
  type ApiAgent,
  type DayUsage,
  type Payment,
  type VaultNode,
  type VaultOutcome,
  type VaultRequest,
} from "./map.js";

export type ViewFn = <T>(method: string, args?: unknown) => Promise<T>;

export interface AdapterConfig {
  token: string;
  decimals: number;
  /** Bounded, in-memory. See `recordBlocked`. */
  blockedRing: Payment[];
  maxBlocked: number;
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

export async function getDashboard(view: ViewFn, cfg: AdapterConfig) {
  const { tree, budgets, labels } = await loadTreeAndUsage(view, cfg);

  // Also concurrent: neither depends on the other.
  const [requests, cfgView] = await Promise.all([
    view<VaultRequest[]>("list_requests", { from_index: 0, limit: 20 }),
    view<{ paused: boolean; owner: string; vault_id: string }>("get_config", {}),
  ]);
  const agents: ApiAgent[] = treeToApiAgents(tree, budgets, cfg.decimals, lifetimeByNode(requests));
  const onchain = requests.map((r) => requestToPayment(r, labels, cfg.decimals));
  const recent = [...cfg.blockedRing, ...onchain]
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
    transactionStats: {
      total: onchain.length + cfg.blockedRing.length,
      approved: onchain.filter((p) => p.status === "success").length,
      blocked: cfg.blockedRing.length,
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
  const onchain = requests.map((r) => requestToPayment(r, labels, cfg.decimals));

  // Blocked rows only belong on the FIRST page: they live in memory, not in
  // the contract's paged list, so splicing them into later pages would
  // duplicate them as the UI scrolls.
  const merged = offset === 0 ? [...cfg.blockedRing, ...onchain] : onchain;
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
