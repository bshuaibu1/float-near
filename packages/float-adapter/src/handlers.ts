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
   * The vault account. Needed to enumerate VIRTUAL agents, whose keys live on
   * the vault itself. Optional so a caller that only wants account-bound
   * agents still works rather than being forced to supply it.
   */
  vault?: string;
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
    /** True if the key names specific methods — a function-call OR gas key. */
    restricted: boolean;
    receiverId: string | null;
    methodNames: string[];
    allowanceYocto: string | null;
    /** NEP-611 gas keys only. For these the balance IS the spending cap. */
    gasBalanceYocto: string | null;
  }[];
  /**
   * True for a VIRTUAL agent: a gas key on the vault rather than a bound
   * account. `accountId` is then the vault itself, which is what "virtual"
   * means — there is no separate account.
   */
  virtual?: boolean;
  /** Set when the key list could not be read, so the UI can say so. */
  error?: string;
}

export type KeyFn = (accountId: string) => Promise<
  {
    public_key: string;
    access_key: {
      permission:
        | "FullAccess"
        | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } }
        // NEP-611. A DISTINCT variant, not a FunctionCall with extra fields —
        // reading `perm.FunctionCall` finds nothing here and reports a
        // restricted key as unrestricted, the most misleading thing this page
        // could say. `allowance` is null by design: the BALANCE is the cap.
        | {
            GasKeyFunctionCall: {
              allowance: string | null;
              balance: string;
              receiver_id: string;
              method_names: string[];
              num_nonces?: number;
            };
          };
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
/** What `coverageNote` returns, so a UI renders a fact rather than composing one. */
export interface CoverageNote {
  /** False when no scan has ever run. NOT the same as "no refusals". */
  scanned: boolean;
  /** Blocks inside the claimed range that were never actually read. */
  unreadBlocks: number;
  /** A sentence safe to render verbatim. */
  text: string;
}

/**
 * State what the refusal history actually covers, in words.
 *
 * `blockedCoverage` has been on /v1/dashboard for a while, computed behind a
 * comment reading "A UI that shows 0 blocked without this cannot distinguish
 * an honest zero from an unscanned range" — and no page rendered it. So the
 * activity page showed four payments and zero refusals with nothing saying
 * that 95% of the vault's blocks had never been read.
 *
 * The sentence is built HERE, not in JSX, because this module owns the
 * distinction and has the tests. A formatter duplicated in a component is one
 * that drifts, and the direction it drifts is always toward claiming more
 * coverage than exists.
 *
 * Deliberately NOT expressed as a percentage. That would need the vault's
 * creation height and the chain head, neither of which this handler has, and
 * an invented denominator is exactly the plausible-wrong-number this file
 * warns about. The range and the block count are facts; a ratio would not be.
 */
export function coverageNote(
  scan: AdapterConfig["blockedScan"] | null | undefined,
): CoverageNote {
  if (!scan) {
    return {
      scanned: false,
      unreadBlocks: 0,
      text:
        "Refusal history has not been scanned for this vault, so refusals are " +
        "UNKNOWN rather than absent. A refusal is never stored on chain — only " +
        "emitted as an event — so nothing can show them until " +
        "scripts/scan-blocked.mjs has read the blocks.",
    };
  }

  const unreadBlocks = (scan.holes ?? []).reduce((n, h) => n + (h.to - h.from + 1), 0);
  const span = scan.to - scan.from + 1;
  const n = (x: number) => x.toLocaleString("en-US");

  // HEIGHTS ARE NOT FORMATTED. A block height is an identifier, not a
  // quantity: "275,882,255" cannot be pasted into an explorer or an RPC call,
  // and a reader checking the claim is exactly who this sentence is for. The
  // COUNT is a quantity, so it keeps its separators.
  let text =
    `Refusals have been read from blocks ${scan.from}–${scan.to} ` +
    `(${n(span)} blocks). Outside that range they are UNKNOWN, not absent.`;
  if (unreadBlocks > 0) {
    text +=
      ` ${n(unreadBlocks)} block${unreadBlocks === 1 ? "" : "s"} inside that range ` +
      `could not be read and remain unread.`;
  }
  return { scanned: true, unreadBlocks, text };
}

/** One access key, flattened, whichever permission variant NEAR reported. */
function describeKey(k: Awaited<ReturnType<KeyFn>>[number]): AgentKeyView["keys"][number] {
  const p = k.access_key.permission;
  const obj = typeof p === "object" ? p : null;
  // BOTH variants. A gas key is a `GasKeyFunctionCall`, NOT a `FunctionCall`
  // with extra fields, so a check for the latter alone finds nothing on it and
  // falls through to `restricted: false` — reporting a key that can call one
  // method on one contract as if it could do anything.
  const fc = obj && "FunctionCall" in obj ? obj.FunctionCall : null;
  const gk = obj && "GasKeyFunctionCall" in obj ? obj.GasKeyFunctionCall : null;
  const named = fc ?? gk;
  return {
    publicKey: k.public_key,
    restricted: named !== null,
    receiverId: named?.receiver_id ?? null,
    methodNames: named?.method_names ?? [],
    allowanceYocto: named?.allowance ?? null,
    gasBalanceYocto: gk?.balance ?? null,
  };
}

/**
 * Every agent that may spend, with its keys read FROM THE CHAIN.
 *
 * The restriction is the product's central security claim, so the page that
 * states it must not state it from a constant. A hardcoded "restricted to
 * request_payment" would keep rendering happily if someone added a full-access
 * key to an agent — exactly the regression a reader of that page is trying to
 * rule out. `restricted` is computed from the permission NEAR reports.
 *
 * TWO RAILS, and this used to see only one:
 *
 *   ACCOUNT  `bind_agent` sets `node.account`, and the keys live on that
 *            account. Kept: it binds an account that already exists and whose
 *            owner already controls it, so it strands nothing.
 *
 *   VIRTUAL  `bind_virtual_agent` maps a public key to a node and leaves
 *            `node.account` as None — deliberately, because that field means
 *            "a real sub-account is bound here" and a virtual agent is the
 *            absence of one. The key is a NEP-611 gas key ON THE VAULT.
 *
 * This filtered on `n.account` alone. Once sub-accounts were retired that is
 * null on every node of every new vault, so the page rendered an EMPTY LIST
 * for a correctly configured vault — which reads as "nothing is authorised
 * here", the exact inversion the `error` field exists to prevent elsewhere.
 *
 * There is no view that lists bound keys, only `get_virtual_agent_node(pk)`.
 * So the enumeration runs the other way: take the vault's own access keys and
 * ask the contract which of them are bound. That also means the owner's
 * full-access key — which the factory now installs — is correctly excluded,
 * because it is not bound to any node.
 */
export async function getAgentKeys(
  view: ViewFn,
  keys: KeyFn,
  cfg: AdapterConfig,
): Promise<AgentKeyView[]> {
  const tree = await view<VaultNode[]>("get_tree", {});
  const byId = new Map(tree.map((n) => [n.id, n]));

  const accountRows = await Promise.all(
    tree
      .filter((n) => n.account)
      .map(async (n): Promise<AgentKeyView> => {
        const base = { accountId: n.account as string, nodeId: n.id, label: n.label, frozen: n.frozen };
        try {
          return { ...base, keys: (await keys(n.account as string)).map(describeKey) };
        } catch (e) {
          // An unreadable key list is reported, never silently rendered as "no
          // keys" — that would read as "nothing is authorised here", the
          // opposite of unknown.
          return { ...base, keys: [], error: e instanceof Error ? e.message : String(e) };
        }
      }),
  );

  // Without a vault id there is nothing to enumerate. Degrade to account-only
  // rather than guessing an account name.
  if (!cfg.vault) return accountRows;

  let onVault: Awaited<ReturnType<KeyFn>>;
  try {
    onVault = await keys(cfg.vault);
  } catch (e) {
    return [
      ...accountRows,
      {
        accountId: cfg.vault,
        nodeId: -1,
        label: "virtual agents",
        frozen: false,
        keys: [],
        virtual: true,
        error: e instanceof Error ? e.message : String(e),
      },
    ];
  }

  // Ask the contract which keys are bound. Concurrent: independent lookups.
  const bindings = await Promise.all(
    onVault.map(async (k) => {
      try {
        return {
          key: k,
          nodeId: await view<number | null>("get_virtual_agent_node", { public_key: k.public_key }),
          error: null as string | null,
        };
      } catch (e) {
        return { key: k, nodeId: null, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  // A FAILED LOOKUP IS NOT "NOT AN AGENT". This first used
  // `.catch(() => null)`, collapsing an RPC error into the same value as a
  // genuine "not bound" — so a rate-limited chain renders "no virtual agents"
  // for a vault that has them. That is the exact absent-versus-unreadable
  // inversion the `error` field above exists to prevent, reintroduced while
  // fixing the same class of bug. Surface it instead.
  const unreadable = bindings.filter((b) => b.error !== null);
  const lookupError = unreadable.length
    ? `${unreadable.length} of ${bindings.length} key bindings could not be read: ${unreadable[0]!.error}`
    : null;

  // Group by node: MANY-TO-ONE is the point of virtual agents — several keys
  // may share one node, so a swarm draws on a shared budget instead of
  // consuming one of the 64 MAX_NODES per member.
  const byNode = new Map<number, Awaited<ReturnType<KeyFn>>>();
  for (const b of bindings) {
    if (b.nodeId === null || b.nodeId === undefined) continue;
    const list = byNode.get(b.nodeId) ?? [];
    list.push(b.key);
    byNode.set(b.nodeId, list);
  }

  const virtualRows: AgentKeyView[] = [...byNode.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([nodeId, list]) => ({
      accountId: cfg.vault as string,
      nodeId,
      label: byId.get(nodeId)?.label ?? `node ${nodeId}`,
      frozen: byId.get(nodeId)?.frozen ?? false,
      keys: list.map(describeKey),
      virtual: true,
    }));

  // If some bindings were unreadable, say so as its own row rather than
  // letting a short list imply a complete one.
  if (lookupError) {
    virtualRows.push({
      accountId: cfg.vault,
      nodeId: -1,
      label: "virtual agents",
      frozen: false,
      keys: [],
      virtual: true,
      error: lookupError,
    });
  }

  return [...accountRows, ...virtualRows];
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
    // The same fact as a sentence. Shipped alongside the raw range because the
    // raw range sat here unrendered for weeks — a component had to compose the
    // caveat itself, and none did. Giving it ready-made removes the excuse.
    blockedCoverageNote: coverageNote(cfg.blockedScan),
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
