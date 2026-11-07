"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { CANVAS, CARD, DANGER, DANGER_BG, INK, LINE, MUTED, SUCCESS, SUCCESS_BG, WARN, WARN_BG } from "@/lib/colors";
import { useWallet } from "@/components/wallet-provider";
import AgentAvatar from "@/components/smoothui/agent-avatar";
import {
  getOwnerAuthHeaders,
  getOwnerQuery,
  hasOwnerSession,
  useOwnerSessionAvailable,
} from "@/lib/float-session";
import { usdc } from "@/lib/money";
import { agentHue, agentSeed } from "@/lib/agent-hue";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";
const FETCH_LIMIT = 200;
const PAGE_SIZE = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatExactTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function isSuccess(status: string): boolean {
  return ["approved", "confirmed", "success"].includes(status?.toLowerCase());
}

function isBlocked(status: string): boolean {
  return status?.toLowerCase() === "blocked";
}

/**
 * The cross-chain rail's terminal state.
 *
 * Deliberately NOT folded into isSuccess: the vault obtained a signature over
 * a Base transaction, which is not the same as the money arriving. Nothing
 * relays it, so the dashboard cannot know that it did.
 */
function isSigned(status: string): boolean {
  return status?.toLowerCase() === "signed";
}

/**
 * The Base payment actually landed — a relayer reported a Base transaction
 * hash for it.
 *
 * Still not folded into isSuccess, because the two are earned differently: a
 * NEAR "success" is attested by the contract, while this is an off-chain
 * observation the chain cannot verify. Same outcome, weaker evidence, and the
 * badge says so.
 */
function isDelivered(status: string): boolean {
  return status?.toLowerCase() === "delivered";
}

function resolveVenue(venue: string): string {
  const generateMatch = venue.match(/^Float generate:\s+.+?\s+([A-Za-z0-9]+)$/i);
  if (generateMatch) return `AI image generation · ${generateMatch[1]}`;
  const speechMatch = venue.match(/^Float speech:\s*(.+)?$/i);
  if (speechMatch) return `AI voice generation${speechMatch[1] ? ` · ${speechMatch[1]}` : ""}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(venue)) return "Custom Model";
  return venue;
}

/**
 * The rail, as the contract's own record reports it.
 *
 * The Solana-era version guessed a rail from the VENUE string — "Float
 * generate:" meant the float rail, "x402-solana" was folded into "x402". None
 * of that applies here: the adapter reads the rail off the stored request's
 * `route` field, so the value is already authoritative and guessing could only
 * contradict it.
 *
 * `policy` is the adapter's rail for a BLOCKED attempt (those are never stored
 * on-chain, so there is no route to read). It is displayed as "blocked"
 * because that is what it means to someone reading the table — a payment the
 * vault refused, not a third payment rail.
 */
function resolveRail(rail: string): string {
  const normalized = rail.toLowerCase();
  return normalized === "policy" ? "blocked" : normalized;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Payment = {
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
  /** Only present on blocked events (rail="policy", status="blocked") */
  blockReason?: string | null;
  blockMessage?: string | null;
};

type RailFilter = "all" | "near" | "base" | "blocked";
type StatusFilter = "all" | "success" | "failed" | "blocked";

const border = { border: `1px solid ${LINE}` };

// ---------------------------------------------------------------------------
// One payment: a table row on a desktop, a card on a phone
// ---------------------------------------------------------------------------
/**
 * One payment, as a table row on a desktop and as a card on a phone.
 *
 * The row is pinned to `minWidth: 48rem` (768px), so at 375px it ran 426px
 * past the viewport - 801px of row on a 375px screen. It scrolls, so nothing
 * was lost, but Status and the explorer link were the two columns furthest
 * off the right edge and the status of a payment is what the page is for.
 *
 * THE WHOLE ROW IS ALREADY A BUTTON that opens the detail dialog, which on a
 * phone is the best touch target available: the card is 343x~100px, against
 * a 44px floor. That is kept rather than redesigned.
 *
 * The explorer anchor stays nested inside it with its `stopPropagation`,
 * exactly as on the row - it is pre-existing nested-interactive markup, and
 * changing that is a separate question from this layout.
 */
function ActivityRow({ item, isLast, explorerBase, vaultId, onOpen }: {
  item: Payment;
  isLast: boolean;
  explorerBase: string | null;
  vaultId: string | null;
  onOpen: () => void;
}) {
  // Computed once; both layouts read these and neither recomputes.
  const blocked = isBlocked(item.status);
  const ok = isSuccess(item.status) || isDelivered(item.status);
  const amountColor = isSuccess(item.status) || isSigned(item.status) || isDelivered(item.status)
    ? INK
    : blocked ? WARN : DANGER;
  const badgeStyle = ok
    ? { background: SUCCESS_BG, color: SUCCESS }
    : isSigned(item.status)
      ? { background: "#EEF2F7", color: "#3B5A7A" }
      : blocked
        ? { background: WARN_BG, color: WARN }
        : { background: DANGER_BG, color: DANGER };

  const badge = (
    <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full" style={badgeStyle}>
      {isSuccess(item.status) ? "success" : item.status}
    </span>
  );

  const explorerIcon = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M1.5 8.5l7-7M8.5 1.5H2.5M8.5 1.5v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  const amount = (
    <>
      {blocked ? "–" : usdc(parseFloat(item.amount), "compact")}
      {!blocked && <span className="ml-1 text-[10px] text-faint">USDC</span>}
    </>
  );

  return (
    <>
      {/* DESKTOP: unchanged, verified against main element by element. */}
      <button
        onClick={onOpen}
        className="hidden md:grid w-full gap-4 items-center px-6 py-3.5 hover:bg-canvas transition-colors duration-100 text-left"
        style={{
          gridTemplateColumns: "5rem minmax(17rem, 1fr) 6rem 4rem 5.5rem 1.5rem",
          minWidth: "48rem",
          borderBottom: isLast ? "none" : `1px solid ${LINE}`,
        }}
      >
        <span className="text-[12px] font-mono tabular-nums text-muted" title={formatExactTime(item.createdAt)}>
          {formatTime(item.createdAt)}
        </span>

        <div className="flex items-center gap-2.5 min-w-0">
          <AgentAvatar seed={agentSeed(item.agentId)} hue={agentHue(item.agentId)} size={20} animated={false} />
          <div className="min-w-0">
            <p className="text-[12px] font-medium truncate leading-tight text-ink">{item.agentName}</p>
            {/* On a BLOCKED row the venue is near-useless — the payment never
                happened. What a reader needs is WHY, and for a parent-pool
                block that reason is the whole point of the product. Showing
                only a "BLOCKED" badge hid it behind a click. Not truncated,
                deliberately: the sentence is the content. */}
            {blocked && item.blockMessage ? (
              <p className="text-[11px] leading-snug" style={{ color: WARN }}>{item.blockMessage}</p>
            ) : (
              <p className="text-[11px] truncate leading-tight text-muted">{resolveVenue(item.venue)}</p>
            )}
          </div>
        </div>

        <span className="text-[12px] font-mono text-right tabular-nums" style={{ color: amountColor }}>
          {amount}
        </span>

        <span className="text-[10px] uppercase tracking-wider text-center font-medium" style={{ color: blocked ? WARN : MUTED }}>
          {resolveRail(item.rail)}
        </span>

        <div className="flex justify-end">{badge}</div>

        {/* Explorer link — inline, doesn't open modal.
            Points at the VAULT account, not a tx hash: the vault stores
            payments by request id and the adapter has no hash to link. The
            old Solscan anchor was unreachable for the same reason. */}
        <div className="flex justify-end">
          {explorerBase ? (
            <a
              href={`${explorerBase}/address/${vaultId}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center justify-center h-6 w-6 rounded-md transition-colors hover:bg-chip text-muted"
              title="View the vault on NEAR Explorer"
            >
              {explorerIcon}
            </a>
          ) : (
            <span className="h-6 w-6" />
          )}
        </div>
      </button>

      {/* PHONE */}
      <button
        onClick={onOpen}
        className="md:hidden w-full px-4 py-3.5 text-left transition-colors active:bg-canvas"
        style={{ borderBottom: isLast ? "none" : `1px solid ${LINE}` }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <AgentAvatar seed={agentSeed(item.agentId)} hue={agentHue(item.agentId)} size={20} animated={false} />
            <p className="text-[13px] font-medium truncate text-ink">{item.agentName}</p>
          </div>
          {/* The exact timestamp is a `title` on the row, which never fires
              on a touch screen. The relative time is what fits; the exact one
              is in the dialog this card opens, so it is one tap away rather
              than unreachable. */}
          <span className="shrink-0 text-[12px] font-mono tabular-nums text-muted">
            {formatTime(item.createdAt)}
          </span>
        </div>

        {/* WRAPS, where the column truncates. A block reason is a sentence
            and is the whole value of a blocked row. */}
        {blocked && item.blockMessage ? (
          <p className="mt-1.5 text-[12px] leading-snug" style={{ color: WARN }}>{item.blockMessage}</p>
        ) : (
          <p className="mt-1.5 text-[12px] leading-snug text-muted">{resolveVenue(item.venue)}</p>
        )}

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <span className="text-[13px] font-mono tabular-nums" style={{ color: amountColor }}>
            {amount}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: blocked ? WARN : MUTED }}>
              {resolveRail(item.rail)}
            </span>
            {badge}
            {explorerBase ? (
              // 44px, not the row's 24px. It sits beside the status badge, so
              // an under-sized target here is one a finger hits by accident
              // while trying to open the payment.
              <a
                href={`${explorerBase}/address/${vaultId}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label="View the vault on NEAR Explorer"
                className="-my-2 -mr-2 flex h-11 w-11 items-center justify-center rounded-md text-muted"
              >
                {explorerIcon}
              </a>
            ) : null}
          </div>
        </div>
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Filters, on a phone
// ---------------------------------------------------------------------------
/**
 * ONE CONTROL INSTEAD OF THREE STACKED ONES.
 *
 * Making the chips 44px fixed the touch targets and made the layout worse.
 * The desktop bar is one line: agent dropdown, then rail and status chips
 * separated by a hairline rule that implies the grouping. Stacked on a
 * phone it became three rows, ~180px - 22% of the viewport before a single
 * payment - and the rule is gone, so it reads as eight unlabelled buttons
 * containing two "All"s and two "Blocked"s with nothing to say which is
 * which.
 *
 * Bigger is not the same as better. The chips needed room for a LABEL more
 * than they needed height, and there is no room for one on a 375px row.
 *
 * So on a phone the whole bar collapses to a single 44px button carrying a
 * count of what is active, and the groups get their labels back inside a
 * sheet where there is space for them. Same sheet mechanics as the nav's
 * More: scrim is a real button, body scroll locked, Escape closes.
 */
function FilterSheet({
  open, onClose, agents, agentFilter, setAgentFilter,
  railFilter, setRailFilter, statusFilter, setStatusFilter, onReset,
}: {
  open: boolean;
  onClose: () => void;
  agents: { id: string; name: string }[];
  agentFilter: string;
  setAgentFilter: (v: string) => void;
  railFilter: RailFilter;
  setRailFilter: (v: RailFilter) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
  onReset: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [open, onClose]);

  if (!open) return null;

  const group = <T extends string>(
    label: string,
    values: readonly T[],
    current: T,
    set: (v: T) => void,
    cap: boolean,
  ) => (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted">{label}</p>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => (
          <button
            key={v}
            onClick={() => set(v)}
            className={`min-h-[2.75rem] rounded-lg px-4 text-[13px] font-medium transition-colors ${cap ? "capitalize" : "uppercase tracking-wider"}`}
            style={current === v
              ? { background: INK, color: CARD }
              : { background: CANVAS, color: MUTED, border: `1px solid ${LINE}` }}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button type="button" aria-label="Close filters" onClick={onClose} className="absolute inset-0 bg-ink/20" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filter payments"
        className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line bg-card pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-1">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted">Filters</p>
          <button onClick={onClose} aria-label="Close filters" className="-mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-muted">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="space-y-5 px-5 pt-2">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted">Agent</p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setAgentFilter("all")}
                className="min-h-[2.75rem] rounded-lg px-4 text-[13px] font-medium transition-colors"
                style={agentFilter === "all"
                  ? { background: INK, color: CARD }
                  : { background: CANVAS, color: MUTED, border: `1px solid ${LINE}` }}
              >
                All agents
              </button>
              {agents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setAgentFilter(a.id)}
                  className="flex min-h-[2.75rem] items-center gap-2 rounded-lg px-4 text-[13px] font-medium transition-colors"
                  style={agentFilter === a.id
                    ? { background: INK, color: CARD }
                    : { background: CANVAS, color: MUTED, border: `1px solid ${LINE}` }}
                >
                  <AgentAvatar seed={agentSeed(a.id)} hue={agentHue(a.id)} size={14} animated={false} />
                  {a.name}
                </button>
              ))}
            </div>
          </div>

          {group("Rail", ["all", "near", "base", "blocked"] as const, railFilter, setRailFilter, false)}
          {group("Status", ["all", "success", "failed", "blocked"] as const, statusFilter, setStatusFilter, true)}
        </div>

        <div className="mt-6 flex gap-2 px-5">
          <button
            onClick={onReset}
            className="h-12 flex-1 rounded-lg border border-line text-[14px] font-medium text-muted transition-colors active:bg-chip"
          >
            Reset
          </button>
          <button
            onClick={onClose}
            className="h-12 flex-[1.5] rounded-lg text-[14px] font-medium"
            style={{ background: INK, color: CARD }}
          >
            Show results
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail Modal
// ---------------------------------------------------------------------------
function PaymentDialog({ item, onClose }: { item: Payment; onClose: () => void }) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: CARD, ...border }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 pt-5 pb-4"
          style={{ borderBottom: `1px solid ${LINE}` }}
        >
          <div className="flex items-center gap-2.5">
            <AgentAvatar seed={agentSeed(item.agentId)} hue={agentHue(item.agentId)} size={24} animated={false} />
            <div>
              <p className="text-[13px] font-semibold text-ink">
                {item.agentName}
              </p>
              <p className="text-[11px] text-muted">{resolveVenue(item.venue)}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-chip text-muted"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-3">

          {/* Generated image preview */}
          {item.resultUrl && (
            <a
              href={item.resultUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full overflow-hidden rounded-lg relative group bg-chip"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.resultUrl}
                alt="Generated output"
                className="w-full object-cover"
                style={{ maxHeight: 220 }}
              />
              <div
                className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                style={{ background: "rgba(0,0,0,0.35)" }}
              >
                <span className="text-white text-[11px] font-medium flex items-center gap-1.5">
                  Open full image
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M1.5 8.5l7-7M8.5 1.5H2.5M8.5 1.5v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </div>
            </a>
          )}

          {/* Prompt */}
          {item.prompt && (
            <div className="rounded-lg px-4 py-3 bg-canvas">
              <p className="text-[10px] font-medium uppercase tracking-widest mb-1 text-muted">
                Prompt
              </p>
              <p className="text-[12px] leading-relaxed text-ink">
                {item.prompt}
              </p>
            </div>
          )}

          {/* Block reason message — for policy-blocked events */}
          {item.blockMessage && (
            <div className="rounded-lg px-4 py-3" style={{ background: "#FFF8F0", border: "1px solid #F5D9B8" }}>
              <p className="text-[10px] font-medium uppercase tracking-widest mb-1" style={{ color: WARN }}>
                Blocked by policy
              </p>
              <p className="text-[12px] leading-relaxed" style={{ color: "#5C3B10" }}>
                {item.blockMessage}
              </p>
            </div>
          )}

          {/* Time + Amount */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg px-4 py-3 bg-canvas">
              <p className="text-[10px] font-medium uppercase tracking-widest mb-1 text-muted">
                Time
              </p>
              <p className="text-[11px] font-mono leading-tight text-ink">
                {formatExactTime(item.createdAt)}
              </p>
            </div>
            <div className="rounded-lg px-4 py-3 bg-canvas">
              <p className="text-[10px] font-medium uppercase tracking-widest mb-1 text-muted">
                {isBlocked(item.status) ? "Attempted" : "Amount"}
              </p>
              <p
                className="text-[13px] font-mono font-semibold"
                style={{ color: isBlocked(item.status) ? WARN : INK }}
              >
                {usdc(parseFloat(item.amount))}{" "}
                <span className="text-[11px] font-normal text-muted">USDC</span>
              </p>
            </div>
          </div>

          {/* Status + Rail */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg px-4 py-3 bg-canvas">
              <p className="text-[10px] font-medium uppercase tracking-widest mb-2 text-muted">
                Status
              </p>
              <span
                className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={
                  isSuccess(item.status)
                    ? { background: SUCCESS_BG, color: SUCCESS }
                    : isBlocked(item.status)
                      ? { background: WARN_BG, color: WARN }
                      : { background: DANGER_BG, color: DANGER }
                }
              >
                {isSuccess(item.status) ? "success" : item.status}
              </span>
            </div>
            <div className="rounded-lg px-4 py-3 bg-canvas">
              <p className="text-[10px] font-medium uppercase tracking-widest mb-1 text-muted">
                Rail
              </p>
              <p className="text-[12px] font-mono uppercase text-ink">
                {resolveRail(item.rail)}
              </p>
            </div>
          </div>

          {/* Agent */}
          <div className="rounded-lg px-4 py-3 bg-canvas">
            <p className="text-[10px] font-medium uppercase tracking-widest mb-1 text-muted">
              Agent
            </p>
            <p className="text-[12px] font-medium text-ink">
              {item.agentName}
            </p>
            {item.agentId !== item.agentName && (
              <p className="text-[11px] font-mono mt-0.5 text-muted">
                {item.agentId}
              </p>
            )}
          </div>

          {/* Recipient — only show if we have an address */}
          {item.recipientAddress && (
            <div className="rounded-lg px-4 py-3 bg-canvas">
              <p className="text-[10px] font-medium uppercase tracking-widest mb-1 text-muted">
                Recipient address
              </p>
              <p className="text-[11px] font-mono break-all text-ink">
                {item.recipientAddress}
              </p>
            </div>
          )}

          {/* Request id — the contract's own key for this payment.
              Replaces a "Tx Signature" block that linked to Solscan and could
              never render: the adapter always sets txSignature to null, because
              the vault indexes payments by request id, not by tx hash. */}
          <div className="rounded-lg px-4 py-3 bg-canvas">
            <p className="text-[10px] font-medium uppercase tracking-widest mb-1 text-muted">
              Request ID
            </p>
            <p className="text-[11px] font-mono break-all text-ink">
              {item.id}
            </p>
            <p className="text-[10px] mt-1.5 text-muted">
              {isBlocked(item.status)
                ? "Blocked attempts are not stored on-chain — this row is held in the adapter's memory."
                : "Stored on-chain. Look it up with get_request on the vault."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function Activity() {
  const { walletAddress } = useWallet();
  const ownerSessionAvailable = useOwnerSessionAvailable();

  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading]   = useState(false);
  const [hasMore, setHasMore]   = useState(false);
  const [loadedOffset, setLoadedOffset] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [selected, setSelected] = useState<Payment | null>(null);

  // Filters
  const [agentFilter, setAgentFilter]   = useState<string>("all");
  const [railFilter, setRailFilter]     = useState<RailFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement>(null);

  // Which chain this vault is on, read from the adapter rather than hardcoded,
  // so a testnet vault cannot link to a mainnet explorer.
  const [explorerBase, setExplorerBase] = useState<string>("");
  const [vaultId, setVaultId] = useState<string>("");

  /**
   * WHAT THE REFUSAL HISTORY ACTUALLY COVERS.
   *
   * A refusal is never stored in contract state — the contract emits a NEP-297
   * event and keeps nothing, deliberately, so an agent cannot inflate the
   * vault's storage bill by spamming rejects. That makes the single most
   * important thing this product does invisible unless something read the
   * blocks.
   *
   * So "0 blocked" on this page is ambiguous by default: it means either "none
   * happened" or "nobody looked", and those are opposite facts. The adapter
   * has always computed the distinction and exposed it as `blockedCoverage`;
   * nothing rendered it, so this page implied completeness it never had. The
   * sentence is built adapter-side and tested there, not composed here.
   */
  const [coverage, setCoverage] = useState<{
    scanned: boolean;
    unreadBlocks: number;
    text: string;
  } | null>(null);
  useEffect(() => {
    fetch(`${API_BASE_URL}/v1/dashboard`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { blockedCoverageNote?: typeof coverage } | null) => {
        // A failed read leaves it null, which renders the "not scanned"
        // warning rather than silently nothing — the safe direction is always
        // to understate coverage.
        setCoverage(d?.blockedCoverageNote ?? null);
      })
      .catch(() => setCoverage(null));
  }, []);
  useEffect(() => {
    fetch(`${API_BASE_URL}/v1/vault-info`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { explorerBase?: string; vaultId?: string } | null) => {
        if (!d) return;
        setExplorerBase(d.explorerBase ?? "");
        setVaultId(d.vaultId ?? "");
      })
      .catch(() => {});
  }, []);

  // Close agent menu on outside click
  useEffect(() => {
    if (!agentMenuOpen) return;
    function handle(e: PointerEvent) {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handle);
    return () => document.removeEventListener("pointerdown", handle);
  }, [agentMenuOpen]);

  const fetchPayments = (ownerWallet: string | null, offset: number, replace: boolean) => {
    setLoading(true);
    const params = new URLSearchParams(getOwnerQuery(ownerWallet).replace(/^\?/, ""));
    params.set("limit", String(FETCH_LIMIT));
    params.set("offset", String(offset));
    fetch(`${API_BASE_URL}/v1/spend-history?${params}`, {
      cache: "no-store",
      headers: getOwnerAuthHeaders(),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "Unable to load activity.");
        return data;
      })
      .then((data: { payments?: Payment[] }) => {
        const rows = data.payments ?? [];
        setPayments(prev => replace ? rows : [...prev, ...rows]);
        setHasMore(rows.length === FETCH_LIMIT);
        setLoadedOffset(offset + rows.length);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    if (!walletAddress && !hasOwnerSession()) { setPayments([]); setHasMore(false); return; }
    if (walletAddress && !ownerSessionAvailable) { setLoading(true); return; }
    setAgentFilter("all");
    setRailFilter("all");
    setStatusFilter("all");
    setCurrentPage(1);
    fetchPayments(walletAddress, 0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerSessionAvailable, walletAddress]);

  // Unique agents derived from loaded payments (only agents with activity appear)
  const agents = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of payments) {
      if (!map.has(p.agentId)) map.set(p.agentId, p.agentName);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [payments]);

  /**
   * How many filters are narrowing the list.
   *
   * The collapsed button has to say whether anything is on, or hiding the
   * controls hides the fact that a list is filtered - and "no payments"
   * looks identical to "no payments matching a filter you forgot about".
   */
  const activeFilterCount =
    (agentFilter !== "all" ? 1 : 0) +
    (railFilter !== "all" ? 1 : 0) +
    (statusFilter !== "all" ? 1 : 0);

  const resetFilters = () => {
    setAgentFilter("all");
    setRailFilter("all");
    setStatusFilter("all");
    setCurrentPage(1);
  };

  // Client-side filter
  const rows = payments.filter(p => {
    if (agentFilter !== "all" && p.agentId !== agentFilter) return false;
    if (railFilter !== "all" && resolveRail(p.rail) !== railFilter) return false;
    if (statusFilter === "success" && !isSuccess(p.status)) return false;
    if (
      statusFilter === "failed" &&
      (isSuccess(p.status) ||
        isBlocked(p.status) ||
        isSigned(p.status) ||
        isDelivered(p.status))
    )
      return false;
    if (statusFilter === "blocked" && !isBlocked(p.status)) return false;
    return true;
  });

  useEffect(() => {
    setCurrentPage(1);
  }, [agentFilter, railFilter, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const activePage = Math.min(currentPage, totalPages);
  const pageStart = (activePage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  // Blocked events don't actually spend USDC — exclude from total
  const totalUsdc = rows
    .filter(p => !isBlocked(p.status))
    .reduce((s, p) => s + parseFloat(p.amount || "0"), 0);
  const blockedCount = rows.filter(p => isBlocked(p.status)).length;
  const selectedAgentName = agentFilter === "all"
    ? "All agents"
    : (agents.find(a => a.id === agentFilter)?.name ?? agentFilter);

  return (
    <>
      <div className="px-8 py-8 max-w-6xl mx-auto">

        {/* Page header */}
        <div className="flex items-end justify-between mb-8">
          <div>
            <p
              className="text-[11px] font-medium uppercase tracking-widest mb-1 text-muted"
            >
              Agent Console
            </p>
            <h2
              className="text-[22px] font-semibold tracking-tight text-ink"
            >
              Activity
            </h2>
          </div>
          {payments.length > 0 && (
            <p className="text-[12px] font-mono text-muted">
              {rows.length - blockedCount} payment{rows.length - blockedCount !== 1 ? "s" : ""}&nbsp;·&nbsp;
              {usdc(totalUsdc)} USDC
              {blockedCount > 0 && (
                <span style={{ color: WARN }}>&nbsp;·&nbsp;{blockedCount} blocked</span>
              )}
            </p>
          )}
        </div>

        {/* THE COVERAGE CAVEAT.
            Rendered whatever the blocked count is, because it qualifies BOTH
            readings: a zero that was never looked for, and a non-zero that is
            only part of the story. Amber when nothing has been scanned or
            blocks are unread, grey when the range is clean — the colour
            tracks whether a reader should doubt the number above. */}
        {coverage && (
          <div
            className="mb-4 rounded-lg px-3.5 py-2.5 text-[12px] leading-5"
            style={
              !coverage.scanned || coverage.unreadBlocks > 0
                ? { background: WARN_BG, border: "1px solid #F0E0B0", color: WARN }
                : { background: CANVAS, border: `1px solid ${LINE}`, color: MUTED }
            }
          >
            {coverage.text}
          </div>
        )}

        {/*
          PHONE: one button, and the three groups move into a sheet.
          See FilterSheet for why bigger chips alone made this worse.
        */}
        <button
          onClick={() => setFilterSheetOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={filterSheetOpen}
          className="mb-4 flex h-11 w-full items-center justify-between rounded-lg border border-line bg-card px-4 text-[13px] font-medium text-ink md:hidden"
        >
          <span className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path d="M1 3h12M3 7h8M5.5 11h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Filters
          </span>
          {activeFilterCount > 0 ? (
            <span
              className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold"
              style={{ background: INK, color: CARD }}
            >
              {activeFilterCount}
            </span>
          ) : (
            <span className="text-[12px] text-muted">All</span>
          )}
        </button>

        {/* Filter bar — DESKTOP. Unchanged; `max-md:hidden` leaves nothing
            declared above the breakpoint. */}
        <div className="flex items-center justify-between mb-4 gap-4 flex-wrap max-md:hidden">

          {/* Agent dropdown */}
          <div ref={agentMenuRef} className="relative">
            <button
              onClick={() => setAgentMenuOpen(o => !o)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors"
              style={{ ...border, background: CARD, color: INK }}
            >
              <AgentAvatar seed={agentFilter === "all" ? "float" : agentSeed(agentFilter)} hue={agentFilter === "all" ? undefined : agentHue(agentFilter)} size={14} animated={false} />
              <span>{selectedAgentName}</span>
              <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                <path d="M1 1l4 4 4-4" stroke={MUTED} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {agentMenuOpen && (
              <div
                className="absolute left-0 top-[calc(100%+6px)] z-20 w-52 rounded-lg overflow-hidden"
                style={{
                  ...border,
                  background: CARD,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
                }}
              >
                <button
                  onClick={() => { setAgentFilter("all"); setAgentMenuOpen(false); }}
                  className="flex items-center gap-2.5 w-full px-3 py-2.5 text-[12px] font-medium text-left hover:bg-canvas transition-colors text-ink"
                >
                  All agents
                </button>
                {agents.map(a => (
                  <button
                    key={a.id}
                    onClick={() => { setAgentFilter(a.id); setAgentMenuOpen(false); }}
                    className="flex items-center gap-2.5 w-full px-3 py-2.5 text-[12px] font-medium text-left hover:bg-canvas transition-colors"
                    style={{
                      borderTop: `1px solid ${LINE}`,
                      color: agentFilter === a.id ? INK : MUTED,
                    }}
                  >
                    <AgentAvatar seed={agentSeed(a.id)} hue={agentHue(a.id)} size={14} animated={false} />
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/*
            Rail + Status pills.

            EIGHT TARGETS AT 25px HIGH, in two groups separated by a 1px
            rule, in a row that ran 135px past a 375px viewport. The worst
            concentration of under-sized controls on the dashboard, and they
            are filters - things people poke at repeatedly, where a mis-tap
            costs a reload of the list and a second attempt.

            Below `md`: each chip reaches the 44px floor, the groups wrap
            instead of overflowing, and the hairline divider is dropped - a
            vertical rule between two rows that are no longer side by side
            separates nothing.

            `max-md:` RATHER THAN A `md:` RESET, and the diff is why. Written
            as `min-h-[2.75rem] md:min-h-0`, the desktop rule still DECLARES
            a min-height of 0 where there was none (`auto`), and splitting
            `gap-3` into `gap-x-3 gap-y-1` changes the row gap. Both are
            invisible at desktop - a 0 minimum never binds and a row gap does
            nothing on a single line - and both appeared as real differences
            against main, 9 of them. `max-md:` applies below the breakpoint
            and leaves nothing declared above it.
          */}
          <div className="flex items-center gap-3 max-md:flex-wrap max-md:gap-y-1">
            <div className="flex items-center gap-1 max-md:flex-wrap">
              {(["all", "near", "base", "blocked"] as RailFilter[]).map(v => (
                <button
                  key={v}
                  onClick={() => setRailFilter(v)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium uppercase tracking-wider transition-colors max-md:min-h-[2.75rem] max-md:px-3"
                  style={railFilter === v
                    ? { background: INK, color: CARD }
                    : { color: MUTED }}
                >
                  {v}
                </button>
              ))}
            </div>

            <div className="hidden md:block" style={{ width: 1, height: 16, background: LINE }} />

            <div className="flex items-center gap-1 max-md:flex-wrap">
              {(["all", "success", "failed", "blocked"] as StatusFilter[]).map(v => (
                <button
                  key={v}
                  onClick={() => setStatusFilter(v)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors max-md:min-h-[2.75rem] max-md:px-3"
                  style={statusFilter === v
                    ? { background: INK, color: CARD }
                    : { color: MUTED }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg overflow-x-auto" style={border}>

          {/* Column headers. Desktop only: below `md` the rows are cards
              that label themselves, and this `minWidth: 48rem` is half of
              what made the table 801px wide on a 375px screen. */}
          <div
            className="hidden md:grid gap-4 px-6 py-3 text-[11px] font-medium uppercase tracking-wider"
            style={{
              color: MUTED,
              borderBottom: `1px solid ${LINE}`,
              gridTemplateColumns: "5rem minmax(17rem, 1fr) 6rem 4rem 5.5rem 1.5rem",
              minWidth: "48rem",
            }}
          >
            <span>Time</span>
            <span>Agent / Venue</span>
            <span className="text-right">Amount</span>
            <span className="text-center">Rail</span>
            <span className="text-right">Status</span>
            <span />
          </div>

          {/* Empty / loading states */}
          {!walletAddress && !ownerSessionAvailable ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[13px] text-muted">
                Connect your wallet to view activity.
              </p>
            </div>
          ) : loading && payments.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[13px] text-muted">Loading activity...</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[13px] text-muted">
                {payments.length === 0
                  ? "No payment activity yet. Payments made by your agents will appear here."
                  : "No payments match the current filters."}
              </p>
            </div>
          ) : (
            <div>
              {pageRows.map((p, i) => (
                <ActivityRow
                  key={p.id}
                  item={p}
                  isLast={i >= pageRows.length - 1}
                  explorerBase={explorerBase}
                  vaultId={vaultId}
                  onOpen={() => setSelected(p)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between">
          <p className="text-[12px] text-muted">
            {rows.length > 0
              ? `Showing ${pageStart + 1}-${Math.min(pageStart + PAGE_SIZE, rows.length)} of ${rows.length}`
              : ""}
          </p>
          {rows.length > PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
                disabled={activePage === 1}
                className="text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors disabled:cursor-not-allowed"
                style={{
                  ...border,
                  color: activePage === 1 ? "#B0ADB8" : INK,
                  background: CARD,
                }}
              >
                Previous
              </button>
              <span className="text-[12px] font-mono text-muted">
                Page {activePage} of {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
                disabled={activePage === totalPages}
                className="text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors disabled:cursor-not-allowed"
                style={{
                  ...border,
                  color: activePage === totalPages ? "#B0ADB8" : INK,
                  background: CARD,
                }}
              >
                Next
              </button>
            </div>
          )}
          {hasMore && !loading && (walletAddress || ownerSessionAvailable) && (
            <button
              onClick={() => fetchPayments(walletAddress, loadedOffset, false)}
              className="text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors hover:bg-canvas"
              style={{ ...border, color: INK, background: CARD }}
            >
              Load older
            </button>
          )}
          {loading && payments.length > 0 && (
            <p className="text-[12px] text-muted">Loading...</p>
          )}
        </div>
      </div>

      <FilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        agents={agents}
        agentFilter={agentFilter}
        setAgentFilter={(v) => { setAgentFilter(v); setCurrentPage(1); }}
        railFilter={railFilter}
        setRailFilter={(v) => { setRailFilter(v); setCurrentPage(1); }}
        statusFilter={statusFilter}
        setStatusFilter={(v) => { setStatusFilter(v); setCurrentPage(1); }}
        onReset={resetFilters}
      />

      {selected && (
        <PaymentDialog item={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
