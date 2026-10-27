/**
 * Maps NEAR vault views onto the shapes the EXISTING Float dashboard already
 * reads, so that UI runs against the NEAR hierarchical vault unchanged — same
 * components, same logo, same styles, same screens.
 *
 * Nothing here invents a field. Where Solana-era Float had a concept the NEAR
 * vault does not (x402 rails, per-agent token balances, auto-top-up), the
 * field is OMITTED rather than filled with a plausible default: every one of
 * those is optional in the UI's types, and a made-up value would render as
 * fact.
 */

import { fromBaseUnits } from "@near-vault/mcp/amounts";

export interface VaultTokenLimit {
  token: string;
  daily_cap: string;
  per_tx_cap: string;
}

export interface VaultNode {
  id: number;
  parent: number | null;
  path: number[];
  label: string;
  account: string | null;
  limits: VaultTokenLimit[];
  child_cap_sum: [string, string][];
  child_count: number;
  cooldown_sec: number;
  frozen: boolean;
  recipients: string[] | null;
}

export interface VaultRequest {
  request_id: string;
  node_id: number;
  token: string;
  amount: string;
  recipient: string;
  memo: string;
  reserved_chain: number[];
  reserved_day: number;
  /**
   * Absent on requests stored before routes existed.
   *
   * `base_usdc` is retired along with the MPC rail, but it is still listed
   * here: a vault deployed before the change has those requests in its
   * state, and `list_requests` will keep returning them for as long as they
   * are not purged. Dropping it from the type would make `railOf` report
   * those as NEAR — quietly relabelling a cross-chain payment as a local one.
   */
  route?: "near_direct" | { base_usdc: unknown } | { intents: unknown } | null;
  status: string;
  reason_code: string;
  created_at_ns: string;
  updated_at_ns: string;
}

export interface VaultOutcome {
  request_id: string;
  node_id: number;
  status: string;
  reason_code: string;
}

export interface DayUsage {
  executed: string;
  pending: string;
}

/** The dashboard's ApiAgent, plus the two fields it reads off the policy. */
export interface ApiAgent {
  agentId: string;
  walletAddress: string;
  createdAt: string;
  status: "active" | "killed";
  displayName: string;
  lifetimeSpent?: string;
  lifetimePayments?: number;
  walletBalance?: string | null;
  dailySpent?: string;
  dailyBudgetUsedPercent?: number;
  policy: {
    dailyBudget?: string;
    perTxLimit?: string;
    cooldownSeconds?: number;
    blockUnknown?: boolean;
    allowedAddresses?: string[];
  } | null;
}

export interface Payment {
  id: string;
  agentId: string;
  agentName: string;
  amount: string;
  currency: string;
  recipientAddress: string | null;
  venue: string;
  rail: string;
  status: string;
  txSignature: string | null;
  createdAt: string;
  prompt: string | null;
  resultUrl: string | null;
  blockReason?: string | null;
  blockMessage?: string | null;
}

export function nodeToApiAgent(n: VaultNode, usage: DayUsage, decimals: number): ApiAgent {
  const lim = n.limits[0];
  const cap = lim ? BigInt(lim.daily_cap) : 0n;
  // executed + pending, exactly as the contract computes `available`. A
  // dashboard that ignored in-flight spend would advertise headroom the
  // contract is about to refuse.
  const used = BigInt(usage.executed) + BigInt(usage.pending);

  return {
    // An internal (team) node has no account, but it does hold a real budget,
    // so it still gets a row. Dropping it would hide the parent pool, which is
    // the thing this product exists to make visible.
    agentId: n.account ?? `node-${n.id}`,
    walletAddress: n.account ?? "",
    createdAt: new Date(0).toISOString(),
    status: n.frozen ? "killed" : "active",
    displayName: n.label,
    dailySpent: fromBaseUnits(used, decimals),
    dailyBudgetUsedPercent: cap > 0n ? Number((used * 100n) / cap) : 0,
    walletBalance: null, // the VAULT holds the tokens; an agent account holds none
    policy: {
      dailyBudget: lim ? fromBaseUnits(cap, decimals) : undefined,
      perTxLimit: lim ? fromBaseUnits(BigInt(lim.per_tx_cap), decimals) : undefined,
      cooldownSeconds: n.cooldown_sec,
      // Not a toggle here: the payee allowlist is always enforced on-chain, so
      // reporting false would misdescribe the contract.
      blockUnknown: true,
      allowedAddresses: n.recipients ?? undefined,
    },
  };
}

/**
 * Tree order, root-first, with the depth drawn into the display name.
 *
 * The Float agents table is flat. Indenting the label is the minimal way to
 * show root -> team -> agent in it without redesigning the screen.
 */
export function treeToApiAgents(
  tree: VaultNode[],
  budgets: Map<number, DayUsage>,
  decimals: number,
  lifetime: Map<number, { spent: bigint; count: number }> = new Map(),
): ApiAgent[] {
  const byId = new Map(tree.map((n) => [n.id, n]));
  return tree.map((n) => {
    const a = nodeToApiAgent(n, budgets.get(n.id) ?? { executed: "0", pending: "0" }, decimals);
    a.displayName = indent(n.path.length, n.label);

    // The EFFECTIVE allowlist, resolved the way the contract resolves it.
    // Reporting the raw `recipients` field made every inheriting node look
    // unrestricted in the UI ("Open x402"), which is the opposite of true:
    // they inherit the root's allowlist and the contract enforces it.
    a.policy = { ...a.policy, allowedAddresses: effectiveRecipients(n, byId) };

    const lt = lifetime.get(n.id);
    if (lt) {
      a.lifetimeSpent = fromBaseUnits(lt.spent, decimals);
      a.lifetimePayments = lt.count;
    }
    return a;
  });
}

/**
 * Depth prefix using NON-BREAKING spaces.
 *
 * Plain spaces look right in a test assertion and vanish on screen: HTML
 * collapses leading whitespace, so depth-2 rendered identically to depth-1 and
 * the hierarchy — the entire point of the view — was invisible. The unit test
 * was green while the screen was wrong, which is why this is asserted against
 * the rendered character and not a trimmed string.
 */
export function indent(depth: number, label: string): string {
  if (depth === 0) return label;
  return `${"\u00a0".repeat(3 * (depth - 1))}└─ ${label}`;
}

/** Mirrors the contract's `effective_recipients`: nearest ancestor with a list. */
export function effectiveRecipients(
  n: VaultNode,
  byId: Map<number, VaultNode>,
): string[] | undefined {
  const chain = [...n.path, n.id].reverse(); // self first, then upward
  for (const id of chain) {
    const node = byId.get(id);
    if (node?.recipients && node.recipients.length) return node.recipients;
  }
  return undefined;
}

/** Settled spend per node, within RETAINED history (purge_settled removes rows). */
export function lifetimeByNode(
  requests: VaultRequest[],
): Map<number, { spent: bigint; count: number }> {
  const m = new Map<number, { spent: bigint; count: number }>();
  for (const r of requests) {
    if (r.status !== "SETTLED") continue;
    const cur = m.get(r.node_id) ?? { spent: 0n, count: 0 };
    m.set(r.node_id, { spent: cur.spent + BigInt(r.amount), count: cur.count + 1 });
  }
  return m;
}

function nsToIso(ns: string): string {
  // Nanoseconds. Dividing by 1e6 for milliseconds, via BigInt so a 19-digit
  // value does not lose its low digits on the way through a float.
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

/**
 * Which rail the dashboard shows.
 *
 * NOT hardcoded to "near": a cross-chain payment rendered as a NEAR one is the
 * same class of bug as the "Open x402" badge — the UI stating something false
 * about where the money went, while every test passes. An unrecognised or
 * absent route reports "near", because requests stored before routes existed
 * have no route field and were all NEAR.
 */
export function railOf(route: VaultRequest["route"]): string {
  if (route && typeof route === "object") {
    if ("intents" in route) return "intents";
    // Retired rail, still present in older stored requests. Reporting these
    // as "near" would say a cross-chain payment settled locally.
    if ("base_usdc" in route) return "base";
  }
  return "near";
}

const STATUS: Record<string, string> = {
  SETTLED: "success",
  TRANSFER_FAILED: "failed",
  TRANSFER_PENDING: "pending",
  BLOCKED: "blocked",
};

/** A Base delivery the relayer observed and recorded off-chain. */
export interface Delivery {
  baseTxHash: string;
  mode: "vault" | "operator";
}

export function requestToPayment(
  r: VaultRequest,
  nodeLabels: Record<number, string>,
  decimals: number,
  delivery?: Delivery,
): Payment {
  return {
    id: r.request_id,
    agentId: String(r.node_id),
    agentName: nodeLabels[r.node_id] ?? `node-${r.node_id}`,
    amount: fromBaseUnits(BigInt(r.amount), decimals),
    currency: "USDC",
    recipientAddress: r.recipient,
    // What the agent paid FOR, which is what the memo carries. The recipient
    // is already its own column, so echoing it adds nothing.
    venue: r.memo || r.recipient,
    rail: railOf(r.route),
    // A Base payment is NOT "success". The contract proved it obtained a
    // signature; it cannot see whether the transaction landed, and nothing in
    // this repo relays it. Rendering SETTLED as "success" for that rail would
    // tell the reader the money arrived, which is the one claim the whole
    // design is careful never to make. The NEAR rail is unaffected: there,
    // SETTLED really does mean the tokens moved.
    // signed -> delivered, but ONLY on evidence. A Base payment is "signed"
    // when the vault proved it authorized the transfer, and "delivered" only
    // once a relayer reports a Base transaction hash for it. The chain cannot
    // attest the second step, so it is never inferred — no hash, no claim.
    status:
      railOf(r.route) === "base" && r.reason_code === "SIGNED"
        ? delivery
          ? "delivered"
          : "signed"
        : STATUS[r.status] ?? r.status.toLowerCase(),
    // The BASE transaction hash, when one exists. Null on the NEAR rail and on
    // anything undelivered.
    txSignature: delivery?.baseTxHash ?? null,
    createdAt: nsToIso(r.created_at_ns),
    prompt: r.memo || null,
    resultUrl: null,
    // Carried for terminal failures too, so a failed row can say WHY.
    blockReason: r.status === "SETTLED" ? null : r.reason_code,
    blockMessage: r.status === "SETTLED" ? null : REASONS[r.reason_code] ?? null,
  };
}

/**
 * Plain-English for every reason code the hot path can return.
 *
 * `PARENT_DAILY_BUDGET` and `DAILY_BUDGET` get deliberately DIFFERENT
 * sentences. Those two codes are the entire point of the hierarchy — one says
 * the agent is out of budget, the other says the pool it shares is — and
 * rendering the same text for both would make the product's distinguishing
 * behaviour invisible to the person looking at the screen.
 */
export const REASONS: Record<string, string> = {
  VAULT_PAUSED: "The vault is paused, so no agent can pay.",
  NODE_FROZEN: "This agent, or a team above it, is frozen.",
  NOT_AGENT: "That account is not bound to any budget node.",
  DUPLICATE_REQUEST: "A payment with this request id already exists.",
  INVALID_REQUEST_ID: "The request id is empty or uses characters the vault rejects.",
  INVALID_AMOUNT: "The amount must be greater than zero.",
  INVALID_MEMO: "The memo is too long or contains control characters.",
  TOKEN_NOT_ALLOWED: "This node has no limit set for that token.",
  RECIPIENT_NOT_ALLOWED: "That payee is not on this node's allowlist.",
  COOLDOWN: "Too soon after the last payment from this agent.",
  PER_TX_LIMIT: "Over this agent's own per-payment cap.",
  PARENT_PER_TX_LIMIT: "Over a per-payment cap set higher up the tree.",
  DAILY_BUDGET: "This agent has spent its own daily budget.",
  PARENT_DAILY_BUDGET:
    "The shared pool is empty. This agent still has its own limit left, but the team " +
    "or root budget it draws from does not.",
  TRANSFER_FAILED: "The token transfer failed, so the reservation was released.",
  INSUFFICIENT_GAS: "Not enough gas was attached to dispatch the transfer.",
};

export function blockedToPayment(
  o: VaultOutcome,
  nodeLabels: Record<number, string>,
  amountHuman: string,
  recipient: string,
  createdAtIso: string,
): Payment {
  return {
    id: o.request_id,
    agentId: String(o.node_id),
    agentName: nodeLabels[o.node_id] ?? `node-${o.node_id}`,
    amount: amountHuman,
    currency: "USDC",
    recipientAddress: recipient,
    venue: recipient,
    // The rail and status the existing Float UI already filters blocked rows
    // on — no UI change needed to render these.
    rail: "policy",
    status: "blocked",
    txSignature: null,
    createdAt: createdAtIso,
    prompt: null,
    resultUrl: null,
    blockReason: o.reason_code,
    blockMessage: REASONS[o.reason_code] ?? `Blocked by vault policy (${o.reason_code}).`,
  };
}
