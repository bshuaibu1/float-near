"use client";

import { useState, useEffect } from "react";
import { ownershipVerdict } from "@/lib/ownership";
import { CANVAS, CARD, DANGER, DANGER_BG, INK, LINE, MUTED, SUCCESS, SUCCESS_BG, SUCCESS_SOFT, WARN, WARN_BG } from "@/lib/colors";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import AgentAvatar from "@/components/smoothui/agent-avatar";
import { useWallet } from "@/components/wallet-provider";
import {
  getOwnerAuthHeaders,
  getOwnerQuery,
  hasOwnerSession,
  useOwnerSessionAvailable,
} from "@/lib/float-session";
import { usd, usdc, percent } from "@/lib/money";
import { agentHue, agentSeed, nodeIndexOf } from "@/lib/agent-hue";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";
// Includes the Base rail's two terminal states. "signed" means the vault
// authorized and signed the transfer; "delivered" means a relayer reported it
// landed. Both are approved payments — omitting them showed "4 transactions,
// 0 approved / 0 blocked", which reads as though none of them happened.
const APPROVED = ["approved", "confirmed", "success", "signed", "delivered"];

/** Aggregate spend by calendar day over the last 14 days. Returns [oldest…today]. */
function computeDailySpend(activity: ActivityItem[]): { spend: number; label: string }[] {
  const buckets: number[] = new Array(14).fill(0);
  const now = new Date();

  for (const item of activity) {
    if (!APPROVED.includes(item.status?.toLowerCase())) continue;
    const itemDate = new Date(item.time);
    const diffDays = Math.floor((now.getTime() - itemDate.getTime()) / 86_400_000);
    if (diffDays >= 0 && diffDays < 14) {
      buckets[13 - diffDays] += parseFloat(item.amount || "0");
    }
  }

  return buckets.map((spend, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (13 - i));
    const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return { spend, label };
  });
}


type ApiAgent = {
  agentId: string;
  /** The node's own label, e.g. "marketing". No tree glyphs, no indentation. */
  displayName?: string | null;
  /** Depth in the budget tree, root 0. A number, not characters. */
  depth?: number;
  walletAddress: string;
  /**
   * NULL - the contract stores no creation time for a node. The adapter used
   * to send epoch zero to satisfy a non-nullable type, so the first page to
   * render this would have confidently displayed "Jan 1, 1970".
   */
  createdAt: string | null;
  lifetimeSpent?: string;
  lifetimePayments?: number;
  dailySpent?: string;
  dailyBudgetUsedPercent?: number;
  policy?: { dailyBudget?: string };
};
type ActivityItem = {
  id: string;
  agent: string;
  /** The agent's stable id. The avatar seeds from this, never the name. */
  agentId?: string | null;
  /** memo || recipient, kept while /activity still reads it. */
  venue: string;
  /** WHO was paid. Always present on a real payment. */
  recipient?: string | null;
  /** WHY, if the agent said. Usually null: the MCP defaults memo to "". */
  memo?: string | null;
  modelName?: string;
  amount: string;
  rail: string;
  time: string;
  /**
   * WHY a payment was refused, straight from the contract's
   * `request_blocked` event. Null on a successful payment, and null on a
   * refusal whose block was never scanned.
   */
  blockReason?: string | null;
  blockMessage?: string | null;
  status: string;
};
type TransactionStats = { total: number; approved: number; blocked: number; failed: number; other: number; };

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

function resolveVenue(venue: string, modelName?: string): string {
  if (modelName && modelName !== venue) return modelName;
  const generateMatch = venue.match(/^Float generate:\s+.+?\s+([A-Za-z0-9]+)$/i);
  if (generateMatch) return `AI image generation · ${generateMatch[1]}`;
  const speechMatch = venue.match(/^Float speech:\s*(.+)?$/i);
  if (speechMatch) return `AI voice generation${speechMatch[1] ? ` · ${speechMatch[1]}` : ""}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(venue)) return "Custom Model";
  return venue;
}

/**
 * The rail as the contract recorded it.
 *
 * The Solana-era version guessed a rail from the VENUE string. Here the
 * adapter reads it off the stored request's `route`, so the value is already
 * authoritative. `policy` is the rail for a BLOCKED attempt and reads as
 * "blocked", which is what it means to someone looking at the row.
 */
function resolveRail(rail: string): string {
  const normalized = rail.toLowerCase();
  return normalized === "policy" ? "blocked" : normalized;
}
type Treasury = { walletAddress: string; amount: string; currency: string; decimals: number; };
type DashboardData = {
  /**
   * The vault's OWN owner, from its `get_config` — not the connected wallet.
   * The two being different is the case the mismatch guard exists for, and
   * the type has to carry it or the comparison cannot be written.
   */
  owner?: { walletAddress?: string | null } | null;
  treasury: Treasury | null; agents: ApiAgent[]; transactionStats?: TransactionStats; recentActivity: ActivityItem[]; };

const card   = "bg-white rounded-lg p-6" as const;
/**
 * The four figures at the top, which are NOT the same shape as a panel.
 *
 * `p-6` is 48px of horizontal padding. A quarter-width card on a 375px
 * screen is 69px wide, so the padding alone exceeded the card and left the
 * content box 21px. Measured in the browser: `$3.50` needs 74px at this
 * type size, so it rendered 54px past the card's own border — the user read
 * "$3.5", a different and smaller number, with the 0 lost under the card
 * beside it. Clipping a money figure is the one failure mode `lib/money.ts`
 * exists to prevent, and the layout was reintroducing it underneath.
 */
const statCard = "bg-white rounded-lg p-4 md:p-6" as const;
const border = { border: `1px solid ${LINE}` } as const;

function utilColor(pct: number) { return pct >= 80 ? DANGER : pct >= 50 ? WARN : SUCCESS; }
function utilTrack(pct: number) { return pct >= 80 ? DANGER_BG : pct >= 50 ? WARN_BG : SUCCESS_BG; }

/**
 * The exact figure, when an abbreviation is hiding something.
 *
 * THIS REPLACES A `title`, AND THE `title` WAS MY OWN MISTAKE. The stat
 * cards show `usd(x, "compact")` because compact is bounded at eight
 * characters and detailed is not — a 150px card can be designed against
 * eight. Abbreviating loses precision, so I put the exact number in a
 * `title` and called it recoverable.
 *
 * A `title` never fires on a touch screen. So the precision was recoverable
 * on a desktop, where the card is wide enough that nothing was abbreviated
 * in the first place, and gone on a phone, which is the only place the
 * abbreviation happens. Exactly backwards.
 *
 * RENDERED ONLY WHEN IT DIFFERS. Below $1,000 compact and detailed are the
 * same string, and a line repeating the figure above it is noise. So this
 * is nothing at all for today's `$3.50`, and `$1,250,000.00` under `$1.3M`
 * when there is something to say.
 */
function ExactFigure({ compact, exact, loading }: { compact: string; exact: string; loading: boolean }) {
  if (loading || compact === exact) return null;
  return <p className="mt-0.5 text-[11px] font-mono tabular-nums text-faint">{exact}</p>;
}

/**
 * THE TWO PANELS BELOW ARE FIXED-WIDTH GRIDS, AND ON A PHONE THAT HID THEM.
 *
 * `grid-cols-[1fr_7rem_10rem]` and `grid-cols-[3.5rem_7rem_1fr_5rem_3rem_5.5rem]`
 * name their columns in rem, so the columns do not yield as the viewport
 * narrows - the `1fr` collapses to nothing and everything after it is pushed
 * off the right edge. Measured at 375px: "Status" ended 161px past the
 * viewport, the status badge 146px past, a payment's note 281px past.
 *
 * And `documentElement.scrollWidth` was still 375, because the panel is
 * `overflow-hidden`. So there was no scrollbar, no fade, nothing. Seven
 * elements were simply absent from the page with no way for a user to learn
 * they existed. That is worse than an ugly layout: the status of a payment
 * is the single thing a person opens this page to check.
 *
 * WHY A ROW COMPONENT PER PANEL, WITH TWO LAYOUTS INSIDE IT.
 *
 * The desktop grid and the phone card are genuinely different shapes - the
 * card regroups six columns onto three lines and needs its own labels, since
 * the column headings it would have inherited are not on screen. Expressing
 * both from one piece of markup needs `display: contents` tricks and CSS
 * `order`, which is where a layout becomes something nobody can safely edit.
 *
 * So each row renders twice, `hidden md:grid` and `md:hidden`. The cost of
 * that is divergence, and it is paid down the only way that works: every
 * value is computed ONCE at the top of the component and both layouts read
 * the same constant. Neither branch recomputes anything.
 */

/**
 * One agent in "Today's spend by agent".
 *
 * `isLast` IS NOT A CONVENIENCE - it replaces a `last:border-b-0` that this
 * refactor silently broke. That variant compiles to `:last-child`, which is
 * relative to the PARENT, and each row is now a fragment of two divs. So the
 * desktop row stopped being the last child, kept a border it used to drop,
 * grew from 48px to 49px, and moved the whole Recent Activity panel below it
 * down by one pixel.
 *
 * Found by diffing computed styles against main, not by looking at it. One
 * pixel on the last row of one panel is not something anyone notices, and it
 * is exactly the drift that accumulates until a layout is quietly wrong
 * everywhere with no way to say when it started.
 */
function AgentSpendRow({ agent, isLast }: { agent: ApiAgent; isLast: boolean }) {
  // Computed once. Both layouts below read these and never recompute.
  const spentToday = parseFloat(agent.dailySpent || "0");
  const pct = Math.min(agent.dailyBudgetUsedPercent ?? 0, 100);
  const col = utilColor(pct);
  const trk = utilTrack(pct);
  const name = agent.displayName ?? agent.agentId;
  const indent = { paddingLeft: `${(agent.depth ?? 0) * 1.1}rem` };

  const identity = (
    <div className="flex items-center gap-2.5 min-w-0" style={indent}>
      <div className="relative shrink-0">
        <AgentAvatar seed={agentSeed(agent.agentId)} hue={agentHue(agent.agentId)} size={24} animated />
        <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-white" style={{ background: SUCCESS }} />
      </div>
      {/* displayName, not agentId: agentId is `node-<id>` for a team node,
          which rendered as "node-1" and hid who the row was. Depth arrives
          separately as a number and is drawn as padding. */}
      <span className="text-[13px] font-medium truncate text-ink">{name}</span>
    </div>
  );

  const meter = (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: trk }}>
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: col }} />
      </div>
      <span className="text-[11px] font-medium w-8 text-right shrink-0" style={{ color: col }}>
        {percent(pct, { decimals: 0 })}
      </span>
    </div>
  );

  return (
    <>
      {/*
        DESKTOP: unchanged, verified against main down to the pixel.

        The border is still CLASSES, with `border-b-0` applied explicitly
        instead of via `last:`. An inline `borderBottom: "none"` renders the
        same - zero width either way - but computes to `0px none` where the
        class computes to `0px solid rgb(234,234,234)`, and that showed up as
        the one remaining difference against main. Matching exactly is
        cheaper than keeping a note explaining why a difference is harmless.
      */}
      <div className={`hidden md:grid grid-cols-[1fr_7rem_10rem] gap-4 items-center px-6 py-3 border-b border-line hover:bg-canvas transition-colors duration-100 ${isLast ? "border-b-0" : ""}`}>
        {identity}
        <span className="text-[12px] font-mono text-right tabular-nums text-ink">{usd(spentToday)}</span>
        {meter}
      </div>

      {/* PHONE: the column headings are not on screen, so each figure says
          what it is. Without that the card is two numbers and a bar. */}
      <div className={`md:hidden px-4 py-3.5 border-b border-line ${isLast ? "border-b-0" : ""}`}>
        {identity}
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <span className="text-[12px] text-muted">Spent today</span>
          <span className="text-[13px] font-mono tabular-nums text-ink">{usd(spentToday)}</span>
        </div>
        <div className="mt-2.5">
          <span className="mb-1.5 block text-[12px] text-muted">Daily budget</span>
          {meter}
        </div>
      </div>
    </>
  );
}

/** One payment in "Recent Activity". */
function ActivityRow({ item, isLast, delayMs, mounted }: {
  item: ActivityItem;
  isLast: boolean;
  delayMs: number;
  mounted: boolean;
}) {
  // Computed once. Both layouts below read these and never recompute.
  const approved = APPROVED.includes(item.status?.toLowerCase());
  /**
   * `||`, NOT `??`. A blocked row carries `recipient: ""` — the adapter has no
   * recipient to report, because the contract's `request_blocked` event does
   * not carry one. `??` only falls through on null, so the empty string won
   * and the row rendered a dangling separator: "· Over this agent's own
   * per-payment cap." with nothing before the dot.
   */
  const who = item.recipient || resolveVenue(item.venue, item.modelName);
  const note = item.memo ? resolveVenue(item.memo, item.modelName) : null;
  const rail = resolveRail(item.rail);
  const isBlocked = (item.status ?? "").toLowerCase() === "blocked";
  /**
   * A REFUSED PAYMENT HAS NO AMOUNT, and "0 USDC" is not how you say that.
   *
   * The contract records a refusal as an event carrying only the request id,
   * the node and the reason code — storing more would be the storage-griefing
   * vector the design deliberately avoids. So the adapter sets `amount: "0"`
   * with a comment saying a plausible figure "would read as fact".
   *
   * It then rendered "0 USDC", which IS a figure and reads as "a zero-value
   * payment was refused". The one in the fixture was for 5. The Activity page
   * already shows a dash here; this row did not, and showing a number we do
   * not have is worse on the page people land on first.
   */
  const amountCell = isBlocked ? (
    <span className="text-muted" title="The chain does not record the amount of a refused payment">
      —
    </span>
  ) : (
    <>
      {item.amount} <span className="text-muted">USDC</span>
    </>
  );
  /**
   * The reason code, shown as the human sentence where the adapter has one.
   * `PARENT_DAILY_BUDGET` and `DAILY_BUDGET` have to read differently here:
   * one means a sibling spent your pool, the other means you did.
   */
  const whyBlocked = isBlocked ? (item.blockMessage ?? item.blockReason ?? null) : null;
  /**
   * A SEPARATOR NEEDS SOMETHING ON BOTH SIDES.
   *
   * A blocked row has no recipient and no memo — the contract's event carries
   * neither — so `who` and `note` are both empty and a hard-coded " · "
   * before the reason rendered as a dangling dot:
   *     · Over this agent's own per-payment cap.
   * Only separate when there is actually something to separate from.
   */
  const reasonNeedsSeparator = Boolean(who || note);
  const when = formatTime(item.time);
  const reveal = {
    opacity: mounted ? 1 : 0,
    transition: `opacity 400ms cubic-bezier(0.16,1,0.3,1) ${delayMs}ms`,
  } as const;

  const avatar = <AgentAvatar seed={agentSeed(item.agentId) || item.agent} hue={agentHue(item.agentId)} size={16} animated />;
  const badge = (
    <span
      className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
      style={approved ? { background: SUCCESS_BG, color: SUCCESS } : { background: DANGER_BG, color: DANGER }}
    >
      {item.status}
    </span>
  );

  return (
    <>
      {/* DESKTOP: unchanged, down to the class string. */}
      <div
        className="hidden md:grid grid-cols-[3.5rem_7rem_1fr_5rem_3rem_5.5rem] gap-4 items-center px-6 py-3 transition-colors duration-100 hover:bg-canvas"
        style={{ borderBottom: isLast ? "none" : `1px solid ${LINE}`, ...reveal }}
      >
        <span className="text-[12px] font-mono tabular-nums text-muted">{when}</span>
        <div className="flex items-center gap-1.5 min-w-0">
          {avatar}
          <span className="text-[12px] font-mono truncate text-ink">{item.agent.slice(0, 8)}…</span>
        </div>
        {/*
          ONE LINE, TWO FACTS, RECIPIENT ALWAYS FIRST.

          This column was `memo || recipient`, so one row showed an account
          and the next showed a sentence under the same heading, with no way
          to tell which you were looking at. Both of the live payments went
          to work12.testnet and the table made them look like different
          destinations.

          A second COLUMN was the obvious fix and is the wrong one: the MCP
          defaults memo to "" and nothing requires it, so it would be blank
          on most rows, and a mostly-empty column in a six-column table is
          dead width.

          TWO LINES was the next attempt, and it made the rows ragged -
          measured 45px without a note against 61px with one, which in a
          six-row summary card reads as a mistake rather than as a design.

          So: one line, fixed height. The recipient is always first, which is
          what disambiguates the two facts; the note follows in muted text
          after a separator, and truncates as a unit so the account survives
          a narrow column.
        */}
        {/* `title` stays on the DESKTOP row only. Here the line truncates, so
            the tooltip is the only way to read a long note — and a mouse is
            present to trigger it. The phone card below wraps the note in
            full instead, which is the better answer where hover does not
            exist at all. */}
        <div className="text-[13px] truncate min-w-0" title={whyBlocked ?? item.memo ?? undefined}>
          <span className="font-medium text-ink">{who}</span>
          {note ? <span className="text-muted">{" · "}{note}</span> : null}
          {whyBlocked ? (
            <span style={{ color: DANGER }}>
              {reasonNeedsSeparator ? " · " : ""}
              {whyBlocked}
            </span>
          ) : null}
        </div>
        <span className="text-[12px] font-mono text-right tabular-nums text-ink">
          {amountCell}
        </span>
        <span className="text-[11px] uppercase tracking-wider text-center font-medium text-muted">{rail}</span>
        <div className="flex justify-end">{badge}</div>
      </div>

      {/*
        PHONE: three lines, in the order the question is asked.

        "What happened" is who was paid and why, so that is the headline and
        it WRAPS rather than truncating - the desktop column truncates
        because it is 1fr of a six-column grid, which is not a constraint
        here, and a note cut to "· first payment from a vault c" was the
        single worst thing on the page at this width.

        The amount and the status sit on the last line together, because
        "how much" and "did it work" are read as one answer.
      */}
      <div
        className="md:hidden px-4 py-3.5"
        style={{ borderBottom: isLast ? "none" : `1px solid ${LINE}`, ...reveal }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 min-w-0">
            {avatar}
            <span className="text-[12px] font-mono truncate text-ink">{item.agent}</span>
          </div>
          <span className="shrink-0 text-[12px] font-mono tabular-nums text-muted">{when}</span>
        </div>
        <p className="mt-2 text-[13px] leading-5">
          <span className="font-medium text-ink">{who}</span>
          {note ? <span className="text-muted">{" · "}{note}</span> : null}
          {whyBlocked ? (
            <span style={{ color: DANGER }}>
              {reasonNeedsSeparator ? " · " : ""}
              {whyBlocked}
            </span>
          ) : null}
        </p>
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <span className="text-[13px] font-mono tabular-nums text-ink">
            {amountCell}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider font-medium text-muted">{rail}</span>
            {badge}
          </div>
        </div>
      </div>
    </>
  );
}

export default function Overview() {
  const { walletAddress } = useWallet();
  const ownerSessionAvailable = useOwnerSessionAvailable();
  const dashboardAuthorized = Boolean(walletAddress) || ownerSessionAvailable;
  const [mounted, setMounted]   = useState(false);
  const [data, setData]         = useState<DashboardData | null>(null);
  const [loading, setLoading]   = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => { setTimeout(() => setMounted(true), 50); }, []);

  useEffect(() => {
    if (!walletAddress && !hasOwnerSession()) { setData(null); setLoading(false); return; }
    if (walletAddress && !ownerSessionAvailable) { setLoading(true); return; }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch(`${API_BASE_URL}/v1/dashboard${getOwnerQuery(walletAddress)}`, {
      cache: "no-store",
      headers: getOwnerAuthHeaders(),
    })
      .then(async r => {
        const p = await r.json();
        if (!r.ok) throw new Error(p?.error ?? "Unable to load dashboard.");
        return p as DashboardData;
      })
      .then((p: DashboardData) => { if (!cancelled) { setData(p); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setData(null); setLoadError(err instanceof Error ? err.message : "Unable to load dashboard."); setLoading(false); } });
    return () => { cancelled = true; };
  }, [ownerSessionAvailable, walletAddress]);

  const agents         = data?.agents ?? [];
  const activity       = data?.recentActivity ?? [];
  const treasury       = data?.treasury ?? null;
  const balance        = treasury ? Number(treasury.amount) / 10 ** treasury.decimals : 0;

  // Lifetime totals from per-agent fields (accurate all-time)
  const totalSpent     = agents.reduce((s, a) => s + parseFloat(a.lifetimeSpent || "0"), 0);
  const txStats        = data?.transactionStats;
  const txCount        = txStats?.total ?? agents.reduce((s, a) => s + (a.lifetimePayments ?? 0), 0);
  const txApproved     = txStats?.approved ?? activity.filter(r => APPROVED.includes(r.status?.toLowerCase())).length;
  /**
   * DIVIDED BY PAYMENTS THAT HAPPENED, not by attempts.
   *
   * This used `txCount`, which includes refusals. A refused payment moved no
   * money and has no size, so counting it drags the mean toward zero — and
   * the label underneath says "per payment", which a refusal is not.
   *
   * Observed the moment the fixture's one refusal was scanned into view:
   * $1.42 became $1.06 with no money having moved. The number got worse
   * because the page learned something.
   */
  const avgTx          = txApproved > 0 ? totalSpent / txApproved : 0;
  const txBlocked      = txStats?.blocked ?? activity.filter(r => r.status?.toLowerCase() === "blocked").length;
  const txFailed       = txStats?.failed ?? activity.filter(r => r.status?.toLowerCase() === "failed").length;

  /**
   * ROOT IS NOT AN AGENT, and a panel headed "by agent" must not list it.
   *
   * /agents already draws this line and says why: rendering root as the first
   * row of an agent table "made it look like a peer that happened to be listed
   * first". This page did exactly that, so the two screens disagreed about
   * what root is.
   *
   * It is not true of the data either. Root has `account: null` and nothing
   * is bound to it - checked on the live vault, where the only agent key
   * resolves to node 1. Nothing can spend from root. It is the CEILING every
   * agent is checked against, which is a different kind of thing from a
   * spender and belongs above the list rather than inside it.
   *
   * By NODE ID, not by depth or label: node 0 is root by construction.
   */
  const root       = agents.find((a) => nodeIndexOf(a.agentId) === 0) ?? null;
  const fleet      = agents.filter((a) => nodeIndexOf(a.agentId) !== 0);
  const rootPct    = Math.min(root?.dailyBudgetUsedPercent ?? 0, 100);
  const rootCap    = parseFloat(root?.policy?.dailyBudget ?? "0");
  const rootSpent  = parseFloat(root?.dailySpent ?? "0");

  const dailyBuckets   = computeDailySpend(activity);
  const maxSpend       = Math.max(...dailyBuckets.map(b => b.spend), 0.0001);
  const bars           = dailyBuckets.map(b => ({ pct: Math.round((b.spend / maxSpend) * 100), ...b }));
  const totalBudget    = agents.reduce((s, a) => s + parseFloat(a.policy?.dailyBudget || "50"), 0);
  const dailyPct       = totalBudget > 0 ? Math.min((totalSpent / totalBudget) * 100, 100) : 0;

  const dash = (v: string | number) => loading ? "—" : v;

  /**
   * IS THIS VAULT EVEN YOURS?
   *
   * The adapter serves ONE vault, named by NEAR_VAULT_CONTRACT, and ignores
   * the `?owner=` the page sends. So connecting any wallet rendered whatever
   * vault the adapter happened to be pointed at, with nothing saying it
   * belonged to someone else. The numbers looked like yours.
   *
   * Nothing leaks — a vault's balance, tree and history are public on chain
   * and readable by anyone without a key. The damage is that a person acts on
   * figures that are not theirs: topping up a balance they do not own, or
   * concluding their agent overspent when it was somebody else's.
   *
   * So this compares the vault's OWN `get_config.owner`, which the adapter
   * already sends, against the connected wallet. Mismatch replaces the page
   * rather than annotating it: a banner above a screenful of convincing
   * numbers is read after the numbers, not before.
   *
   * Not a substitute for serving the right vault per wallet. That needs the
   * adapter to derive one per request, which turns it from a local tool into
   * a hosted service — a product decision, not a bug fix. This is the honest
   * interim: refuse to imply ownership that was never checked.
   */
  // The condition lives in lib/ownership.ts and is tested there. Inlining it
  // here would leave the tests covering a copy — which is the exact shape of
  // every published-vs-source gap this project has hit.
  const verdict = ownershipVerdict({
    connected: walletAddress,
    vaultOwner: data?.owner?.walletAddress,
  });

  if (!verdict.show) {
    return (
      <div className="px-8 py-8 max-w-6xl mx-auto">
        <div className="rounded-xl border bg-card p-6" style={{ borderColor: "#F0D2D2" }}>
          <p
            className="text-[11px] font-semibold uppercase tracking-widest"
            style={{ color: DANGER }}
          >
            Not your vault
          </p>
          <p className="mt-2 text-[14px] font-semibold text-ink">
            This dashboard is showing a vault owned by someone else.
          </p>
          <p className="mt-3 text-[13px] leading-6 text-muted">
            You are connected as{" "}
            <span className="font-mono text-ink">{verdict.connected}</span>, but the vault it is
            configured against is owned by{" "}
            <span className="font-mono text-ink">{verdict.vaultOwner}</span>. Every figure here would
            be theirs, not yours.
          </p>
          <p className="mt-3 text-[13px] leading-6 text-muted">
            Nothing is exposed by this — a vault&apos;s balance and history are public on
            chain either way, and nobody can spend from it without its agent key. The
            adapter serves one vault at a time, so point it at yours and restart it:
          </p>
          <code className="mt-3 block rounded-lg border border-line bg-chip px-3 py-2 font-mono text-[11.5px] leading-5 text-ink [overflow-wrap:anywhere]">
            NEAR_VAULT_CONTRACT=&lt;your-vault&gt; in scripts/restart-adapter.ps1
          </code>
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">

      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-widest mb-1 text-muted">Agent Console</p>
          <h2 className="text-[22px] font-semibold tracking-tight text-ink">Overview</h2>
        </div>
        {/* THE 24h/7d/30d TOGGLE IS GONE.
            `period` was read in exactly one place — deciding which button
            looked selected. It reached no fetch, no filter and no sum, so
            clicking it moved a highlight and nothing else.

            That made it worse than the dead columns beside it: those showed
            ABSENT data, this one implied the numbers had changed when they
            had not. Every figure on this page is the contract's per-UTC-day
            ledger, so the honest label is the one now in the heading.

            Real ranges are possible — the contract keeps a ledger per day —
            but that is adapter work, not a control to leave switched on in
            the meantime. */}
        <span className="rounded-md border border-line bg-card px-3 py-1.5 text-[12px] font-medium text-muted">
          Today · UTC
        </span>
      </div>

      {loadError ? (
        <div className="mb-4 rounded-lg px-4 py-3 text-[13px]" style={{ border: "1px solid #F5C2C0", background: DANGER_BG, color: DANGER }}>
          {loadError}
        </div>
      ) : null}

      {/*
        4 stat cards. TWO COLUMNS BEFORE `md`, four after.

        `grid-cols-4` was unconditional, and it was the only bare
        `grid-cols-*` on the page — the panel row below it has always been
        `col-span-12 md:col-span-8`, so responsiveness is the house style and
        this was the one place that missed it, not a decision to be
        desktop-only.

        The desktop layout is untouched: at `md` and above this resolves to
        the same four columns with the same `p-6`, which was verified by
        diffing computed styles and boxes for all 209 elements of the page at
        1180px, before and after. Zero differences.
      */}
      <div className="grid grid-cols-2 gap-3 mb-3 md:grid-cols-4">
        <div className={statCard} style={border}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-3 text-muted">Active Agents</p>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[28px] font-semibold tracking-tight tabular-nums leading-none text-ink">{dash(agents.length)}</span>
          </div>
          <p className="text-[12px] text-muted">{dashboardAuthorized ? "linked to this account" : "connect account"}</p>
        </div>

        <div className={statCard} style={border}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-3 text-muted">Total Spent</p>
          <div className="flex items-baseline gap-1 mb-1">
            {/*
              COMPACT, and the exact figure beneath it.

              Two columns gives this card 117px of content box on a phone,
              which is about eight characters at this size. `$12,345.60` is
              ten and would clip again — a narrower grid moves the cliff, it
              does not remove it. Compact is bounded instead: `$12.3K` is the
              widest an abbreviation gets, so the figure fits at EVERY width
              rather than up to whatever the next test value happened to be.

              THE EXACT FIGURE WAS A `title`, AND THAT WAS WRONG. A title
              never fires on a touch screen, so the precision this
              abbreviation gives up was recoverable on a desktop and gone on
              a phone — the one device the abbreviation exists for. It is now
              a second line, rendered only when it differs from what is
              already shown, so below $1,000 nothing is added and today's
              $3.50 looks exactly as it did.
            */}
            <span className="text-[28px] font-semibold tracking-tight tabular-nums leading-none text-ink">
              {loading ? "—" : usd(totalSpent, "compact")}
            </span>
          </div>
          <ExactFigure compact={usd(totalSpent, "compact")} exact={usd(totalSpent)} loading={loading} />
          <p className="text-[12px] text-muted">lifetime, all agents</p>
        </div>

        <div className={statCard} style={border}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-3 text-muted">Transactions</p>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[28px] font-semibold tracking-tight tabular-nums leading-none text-ink">{dash(txCount)}</span>
          </div>
          <p className="text-[12px] text-muted">
            {txCount > 0
              ? <><span style={{ color:SUCCESS }}>{txApproved} approved</span> <span className="text-muted">/</span> <span style={{ color:DANGER }}>{txBlocked} blocked{txFailed > 0 ? ` / ${txFailed} failed` : ""}</span></>
              : "no activity yet"
            }
          </p>
        </div>

        <div className={statCard} style={border}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-3 text-muted">Avg TX Size</p>
          <div className="flex items-baseline gap-1 mb-1">
            <span className="text-[28px] font-semibold tracking-tight tabular-nums leading-none text-ink">
              {loading ? "—" : usd(avgTx, "compact")}
            </span>
          </div>
          <ExactFigure compact={usd(avgTx, "compact")} exact={usd(avgTx)} loading={loading} />
          <p className="text-[12px] text-muted">per payment</p>
        </div>
      </div>

      {/* Balance + Daily Budget */}
      <div className="grid grid-cols-12 gap-3 mb-6">
        <div className={`col-span-12 md:col-span-8 ${card}`} style={border}>
          {/* This figure is root's REMAINING DAILY BUDGET, not the vault's
              token balance — /v1/dashboard computes it as
              daily_cap - executed - pending for the root node. Labelling it
              "USDC Balance" made a 100/day cap look like the whole treasury.
              The real balance is on the Fund page. */}
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-1.5 text-muted">How much can still be spent today</p>
          <p className="text-[12px] mb-4 text-faint">This is the shared limit for everyone. Agents draw from it.</p>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[36px] font-semibold tracking-tight tabular-nums leading-none text-ink">
              {loading ? "—" : usdc(balance)}
            </span>
            <span className="text-sm font-medium text-muted">USDC</span>
          </div>
          <p className="text-[12px] mb-6 text-muted">
            {treasury ? `Vault · ${treasury.walletAddress}` : "Vault adapter unreachable"}
          </p>
          <div className="flex items-end gap-[2px] h-10 group/chart">
            {bars.map((b, i) => {
              const isToday = i === bars.length - 1;
              const hasSpend = b.spend > 0;
              return (
                <div key={i} className="relative flex-1 flex flex-col justify-end">
                  {/* tooltip */}
                  <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 pointer-events-none opacity-0 group-hover/chart:opacity-0 peer-hover:opacity-100 z-10">
                    <div className="px-2 py-1 rounded-md text-[10px] font-mono whitespace-nowrap" style={{ background:INK, color:CARD }}>
                      {b.label}: {usd(b.spend)}
                    </div>
                  </div>
                  <div
                    title={`${b.label}: ${usd(b.spend)}`}
                    className="peer w-full rounded-[2px] cursor-default"
                    style={{
                      height: mounted ? `${Math.max(b.pct, hasSpend ? 4 : 0)}%` : "0%",
                      minHeight: mounted && hasSpend ? 3 : 0,
                      background: isToday
                        ? (hasSpend ? SUCCESS : LINE)
                        : (hasSpend ? SUCCESS_SOFT : LINE),
                      transition: `height 600ms cubic-bezier(0.16,1,0.3,1) ${i * 30}ms`,
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-2">
            <p className="text-[10px] font-mono text-muted">{bars[0]?.label}</p>
            <p className="text-[10px] font-mono text-muted">Today</p>
          </div>
        </div>

        <div className={`col-span-12 md:col-span-4 ${card}`} style={{ ...border, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest mb-4 text-muted">Quick Actions</p>

            <div className="flex flex-col" style={{ gap: 8 }}>
              <Link href="/fund"
                className="flex items-center gap-3 px-4 py-3 rounded-lg transition-colors duration-150 hover:bg-canvas group"
                style={{ border:`1px solid ${LINE}` }}
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-md shrink-0" style={{ background:SUCCESS_BG }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 2v10M2 7h10" stroke={SUCCESS} strokeWidth="1.8" strokeLinecap="round"/>
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink">Fund the vault</p>
                  <p className="text-[11px] text-muted">Send USDC to the vault address</p>
                </div>
                <ArrowRight size={12} className="ml-auto shrink-0 text-line" />
              </Link>

              <Link href="/api-keys"
                className="flex items-center gap-3 px-4 py-3 rounded-lg transition-colors duration-150 hover:bg-canvas"
                style={{ border:`1px solid ${LINE}` }}
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-md shrink-0 bg-chip">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="5.5" stroke={INK} strokeWidth="1.5"/>
                    <path d="M7 4.5v5M4.5 7h5" stroke={INK} strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink">Agent keys</p>
                  <p className="text-[11px] text-muted">Restricted keys, read from the chain</p>
                </div>
                <ArrowRight size={12} className="ml-auto shrink-0 text-line" />
              </Link>

              <Link href="/activity"
                className="flex items-center gap-3 px-4 py-3 rounded-lg transition-colors duration-150 hover:bg-canvas"
                style={{ border:`1px solid ${LINE}` }}
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-md shrink-0 bg-chip">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <rect x="1.5" y="3.5" width="11" height="7" rx="1.5" stroke={INK} strokeWidth="1.5"/>
                    <path d="M1.5 6h11" stroke={INK} strokeWidth="1.5"/>
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink">View Activity</p>
                  <p className="text-[11px] text-muted">See all agent transactions</p>
                </div>
                <ArrowRight size={12} className="ml-auto shrink-0 text-line" />
              </Link>
            </div>
          </div>

          {/* Low balance nudge */}
          {!loading && balance < 1 && (
            <div className="flex items-center gap-1.5 mt-4 px-3 py-2 rounded-md" style={{ background:"#FFF8E1", border:"1px solid #F5E4A0" }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1.5L10.5 10H1.5L6 1.5z" stroke={WARN} strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M6 5v2M6 8.5h.01" stroke={WARN} strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              <p className="text-[11px] font-medium" style={{ color:"#7A5000" }}>Low balance — top up to keep agents running</p>
            </div>
          )}
        </div>
      </div>

      {/* Agent Overview */}
      <div className="bg-white rounded-lg overflow-hidden mb-6" style={border}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom:`1px solid ${LINE}` }}>
          <p className="text-[13px] font-semibold text-ink">Today's spend by agent</p>
          <Link href="/agents" className="flex items-center gap-1 text-[12px] transition-colors duration-150 text-muted max-md:-my-2 max-md:min-h-11 max-md:px-2 max-md:-mr-2">
            Manage agents <ArrowRight size={12}/>
          </Link>
        </div>
        {/* WALLET AND BALANCE ARE GONE.
            Both were Solana-era columns, where every agent held its own
            wallet. On NEAR a virtual agent owns nothing: its key is a gas key
            ON THE VAULT, and the money is the vault's. The adapter has no
            code that populates `walletAddress` or `walletBalance` — they were
            rendering "···" and "— USDC" forever, which reads as a number
            that has not loaded yet rather than one that is never coming. */}
        {/*
          THE SENTENCE IS THE POINT.

          "Root" is a tree word, not a money word, and nothing on this page
          explained it. Someone reading a row labelled "root" beside one
          labelled "marketing" reasonably concludes they are two agents,
          then cannot work out why one of them has no key and never spends.

          So the band says what the RELATIONSHIP is, in the one place the
          numbers appear: a single shared limit, every agent draws from it,
          and exhausting it stops an agent whose own budget is untouched.
          That last clause is the behaviour people hit and do not expect.
        */}
        {root && (
          <div className="px-6 py-4" style={{ borderBottom: `1px solid ${LINE}`, background: CANVAS }}>
            <div className="flex items-baseline justify-between gap-4 mb-1">
              <p className="text-[12px] font-semibold text-ink">Shared daily limit</p>
              <p className="text-[12px] font-mono tabular-nums text-ink">
                {usd(rootSpent)} <span className="text-muted">of {usdc(rootCap)} USDC</span>
              </p>
            </div>
            <p className="text-[11.5px] leading-5 max-w-xl text-muted">
              Every agent below spends inside this. A payment is refused when it runs
              out, even if the agent&apos;s own budget is untouched.
            </p>
            <div className="flex items-center gap-2 mt-2.5">
              <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: utilTrack(rootPct) }}>
                <div className="h-full rounded-full transition-all duration-500"
                     style={{ width: `${rootPct}%`, background: utilColor(rootPct) }}/>
              </div>
              <span className="text-[11px] font-medium w-8 text-right shrink-0" style={{ color: utilColor(rootPct) }}>
                {percent(rootPct, { decimals: 0 })}
              </span>
            </div>
          </div>
        )}
        {/* The column headings belong to the grid. On a phone each card
            carries its own labels instead, so this would be three words
            describing a layout that is not there. */}
        <div className="hidden md:grid grid-cols-[1fr_7rem_10rem] gap-4 px-6 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted border-b border-line">
          <span>Agent</span><span className="text-right">Spent today</span><span className="text-center">Daily budget</span>
        </div>
        {!dashboardAuthorized ? (
          <div className="px-6 py-10 text-[13px] text-muted">Connect your account to view agents.</div>
        ) : loading ? (
          <div className="px-6 py-10 text-[13px] text-muted">Loading agents...</div>
        ) : agents.length === 0 ? (
          <div className="px-6 py-10 text-[13px] text-muted">No agents linked to this account yet.</div>
        ) : (
          <div>
            {fleet.length === 0 && (
              <div className="px-6 py-8 text-[13px] text-muted">
                No agents yet. The shared limit above is the whole vault&apos;s budget
                until you add one.
              </div>
            )}
            {fleet.map((a, i) => (
              <AgentSpendRow key={a.agentId} agent={a} isLast={i === fleet.length - 1} />
            ))}
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="bg-white rounded-lg overflow-hidden" style={border}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom:`1px solid ${LINE}` }}>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background:SUCCESS }}/>
            <p className="text-[13px] font-semibold text-ink">Recent Activity</p>
          </div>
          <Link href="/activity" className="flex items-center gap-1 text-[12px] transition-colors duration-150 text-muted max-md:-my-2 max-md:min-h-11 max-md:px-2 max-md:-mr-2">
            View all <ArrowRight size={12}/>
          </Link>
        </div>
        {/* Column headings, desktop only - the phone cards label themselves. */}
        <div className="hidden md:grid grid-cols-[3.5rem_7rem_1fr_5rem_3rem_5.5rem] gap-4 px-6 py-2.5 text-[11px] font-medium uppercase tracking-wider" style={{ color:MUTED, borderBottom:`1px solid ${LINE}` }}>
          <span>Time</span><span>Agent</span><span>To</span><span className="text-right">Amount</span><span className="text-center">Rail</span><span className="text-right">Status</span>
        </div>
        {activity.length === 0 ? (
          <div className="px-6 py-10 text-[13px] text-muted">
            {dashboardAuthorized ? "No payment activity yet." : "Connect account to view activity."}
          </div>
        ) : (
          <div>
            {activity.slice(0, 6).map((r, i) => (
              <ActivityRow
                key={r.id}
                item={r}
                isLast={i >= Math.min(activity.length, 6) - 1}
                delayMs={200 + i * 60}
                mounted={mounted}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
