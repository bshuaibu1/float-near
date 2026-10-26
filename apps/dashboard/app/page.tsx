"use client";

import { useState, useEffect } from "react";
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

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";
const APPROVED = ["approved", "confirmed", "success"];

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

type Period = "24h" | "7d" | "30d";

type ApiAgent = {
  agentId: string;
  /** The tree label with its depth prefix, e.g. "   └─ r1". */
  displayName?: string | null;
  walletAddress: string;
  createdAt: string;
  lifetimeSpent?: string;
  lifetimePayments?: number;
  dailySpent?: string;
  dailyBudgetUsedPercent?: number;
  walletBalance?: string | null;
  policy?: { dailyBudget?: string };
};
type ActivityItem = { id: string; agent: string; venue: string; modelName?: string; amount: string; rail: string; time: string; status: string; };
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
type DashboardData = { treasury: Treasury | null; agents: ApiAgent[]; transactionStats?: TransactionStats; recentActivity: ActivityItem[]; };

const card   = "bg-white rounded-lg p-6" as const;
const border = { border: "1px solid #EAEAEA" } as const;

function utilColor(pct: number) { return pct >= 80 ? "#9F2F2D" : pct >= 50 ? "#92400e" : "#346538"; }
function utilTrack(pct: number) { return pct >= 80 ? "#FDEBEC" : pct >= 50 ? "#FEF3C7" : "#EDF3EC"; }

export default function Overview() {
  const { walletAddress } = useWallet();
  const ownerSessionAvailable = useOwnerSessionAvailable();
  const dashboardAuthorized = Boolean(walletAddress) || ownerSessionAvailable;
  const [mounted, setMounted]   = useState(false);
  const [period, setPeriod]     = useState<Period>("24h");
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
  const avgTx          = txCount > 0 ? (totalSpent / txCount).toFixed(3) : "0.000";
  const txApproved     = txStats?.approved ?? activity.filter(r => APPROVED.includes(r.status?.toLowerCase())).length;
  const txBlocked      = txStats?.blocked ?? activity.filter(r => r.status?.toLowerCase() === "blocked").length;
  const txFailed       = txStats?.failed ?? activity.filter(r => r.status?.toLowerCase() === "failed").length;

  const dailyBuckets   = computeDailySpend(activity);
  const maxSpend       = Math.max(...dailyBuckets.map(b => b.spend), 0.0001);
  const bars           = dailyBuckets.map(b => ({ pct: Math.round((b.spend / maxSpend) * 100), ...b }));
  const totalBudget    = agents.reduce((s, a) => s + parseFloat(a.policy?.dailyBudget || "50"), 0);
  const dailyPct       = totalBudget > 0 ? Math.min((totalSpent / totalBudget) * 100, 100) : 0;

  const dash = (v: string | number) => loading ? "—" : v;

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">

      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-widest mb-1" style={{ color:"#787774" }}>Agent Console</p>
          <h2 className="text-[22px] font-semibold tracking-tight" style={{ color:"#111111" }}>Overview</h2>
        </div>
        <div className="flex items-center rounded-md overflow-hidden" style={{ border:"1px solid #EAEAEA" }}>
          {(["24h","7d","30d"] as Period[]).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className="px-3 py-1.5 text-[12px] font-medium transition-colors duration-150"
              style={period === p ? { background:"#111111", color:"#fff" } : { background:"#fff", color:"#787774" }}
            >{p}</button>
          ))}
        </div>
      </div>

      {loadError ? (
        <div className="mb-4 rounded-lg px-4 py-3 text-[13px]" style={{ border: "1px solid #F5C2C0", background: "#FDEBEC", color: "#9F2F2D" }}>
          {loadError}
        </div>
      ) : null}

      {/* 4 stat cards */}
      <div className="grid grid-cols-4 gap-3 mb-3">
        <div className={card} style={border}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color:"#787774" }}>Active Agents</p>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[28px] font-semibold tracking-tight leading-none" style={{ color:"#111111" }}>{dash(agents.length)}</span>
          </div>
          <p className="text-[12px]" style={{ color:"#787774" }}>{dashboardAuthorized ? "linked to this account" : "connect account"}</p>
        </div>

        <div className={card} style={border}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color:"#787774" }}>Total Spent</p>
          <div className="flex items-baseline gap-1 mb-1">
            <span className="text-[28px] font-semibold tracking-tight leading-none" style={{ color:"#111111" }}>{loading ? "—" : `$${totalSpent.toFixed(2)}`}</span>
          </div>
          <p className="text-[12px]" style={{ color:"#787774" }}>lifetime, all agents</p>
        </div>

        <div className={card} style={border}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color:"#787774" }}>Transactions</p>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[28px] font-semibold tracking-tight leading-none" style={{ color:"#111111" }}>{dash(txCount)}</span>
          </div>
          <p className="text-[12px]" style={{ color:"#787774" }}>
            {txCount > 0
              ? <><span style={{ color:"#346538" }}>{txApproved} approved</span> <span style={{ color:"#787774" }}>/</span> <span style={{ color:"#9F2F2D" }}>{txBlocked} blocked{txFailed > 0 ? ` / ${txFailed} failed` : ""}</span></>
              : "no activity yet"
            }
          </p>
        </div>

        <div className={card} style={border}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color:"#787774" }}>Avg TX Size</p>
          <div className="flex items-baseline gap-1 mb-1">
            <span className="text-[28px] font-semibold tracking-tight leading-none" style={{ color:"#111111" }}>{loading ? "—" : `$${avgTx}`}</span>
          </div>
          <p className="text-[12px]" style={{ color:"#787774" }}>per payment</p>
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
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-4" style={{ color:"#787774" }}>Root budget remaining today</p>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[36px] font-semibold tracking-tight leading-none" style={{ color:"#111111" }}>
              {loading ? "—" : balance.toLocaleString([], { minimumFractionDigits:2, maximumFractionDigits:2 })}
            </span>
            <span className="text-sm font-medium" style={{ color:"#787774" }}>USDC</span>
          </div>
          <p className="text-[12px] mb-6" style={{ color:"#787774" }}>
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
                    <div className="px-2 py-1 rounded-md text-[10px] font-mono whitespace-nowrap" style={{ background:"#111111", color:"#fff" }}>
                      {b.label}: ${b.spend.toFixed(3)}
                    </div>
                  </div>
                  <div
                    title={`${b.label}: $${b.spend.toFixed(3)} USDC`}
                    className="peer w-full rounded-[2px] cursor-default"
                    style={{
                      height: mounted ? `${Math.max(b.pct, hasSpend ? 4 : 0)}%` : "0%",
                      minHeight: mounted && hasSpend ? 3 : 0,
                      background: isToday
                        ? (hasSpend ? "#346538" : "#EAEAEA")
                        : (hasSpend ? "#346538CC" : "#EAEAEA"),
                      transition: `height 600ms cubic-bezier(0.16,1,0.3,1) ${i * 30}ms`,
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-2">
            <p className="text-[10px] font-mono" style={{ color:"#787774" }}>{bars[0]?.label}</p>
            <p className="text-[10px] font-mono" style={{ color:"#787774" }}>Today</p>
          </div>
        </div>

        <div className={`col-span-12 md:col-span-4 ${card}`} style={{ ...border, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest mb-4" style={{ color:"#787774" }}>Quick Actions</p>

            <div className="flex flex-col" style={{ gap: 8 }}>
              <Link href="/fund"
                className="flex items-center gap-3 px-4 py-3 rounded-lg transition-colors duration-150 hover:bg-[#FBFBFA] group"
                style={{ border:"1px solid #EAEAEA" }}
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-md shrink-0" style={{ background:"#EDF3EC" }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 2v10M2 7h10" stroke="#346538" strokeWidth="1.8" strokeLinecap="round"/>
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium" style={{ color:"#111111" }}>Fund the vault</p>
                  <p className="text-[11px]" style={{ color:"#787774" }}>Send NEP-141 USDC to the contract</p>
                </div>
                <ArrowRight size={12} className="ml-auto shrink-0" style={{ color:"#EAEAEA" }} />
              </Link>

              <Link href="/api-keys"
                className="flex items-center gap-3 px-4 py-3 rounded-lg transition-colors duration-150 hover:bg-[#FBFBFA]"
                style={{ border:"1px solid #EAEAEA" }}
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-md shrink-0" style={{ background:"#F5F5F4" }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="5.5" stroke="#111111" strokeWidth="1.5"/>
                    <path d="M7 4.5v5M4.5 7h5" stroke="#111111" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium" style={{ color:"#111111" }}>Agent keys</p>
                  <p className="text-[11px]" style={{ color:"#787774" }}>Restricted keys, read from the chain</p>
                </div>
                <ArrowRight size={12} className="ml-auto shrink-0" style={{ color:"#EAEAEA" }} />
              </Link>

              <Link href="/activity"
                className="flex items-center gap-3 px-4 py-3 rounded-lg transition-colors duration-150 hover:bg-[#FBFBFA]"
                style={{ border:"1px solid #EAEAEA" }}
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-md shrink-0" style={{ background:"#F5F5F4" }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <rect x="1.5" y="3.5" width="11" height="7" rx="1.5" stroke="#111111" strokeWidth="1.5"/>
                    <path d="M1.5 6h11" stroke="#111111" strokeWidth="1.5"/>
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium" style={{ color:"#111111" }}>View Activity</p>
                  <p className="text-[11px]" style={{ color:"#787774" }}>See all agent transactions</p>
                </div>
                <ArrowRight size={12} className="ml-auto shrink-0" style={{ color:"#EAEAEA" }} />
              </Link>
            </div>
          </div>

          {/* Low balance nudge */}
          {!loading && balance < 1 && (
            <div className="flex items-center gap-1.5 mt-4 px-3 py-2 rounded-md" style={{ background:"#FFF8E1", border:"1px solid #F5E4A0" }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1.5L10.5 10H1.5L6 1.5z" stroke="#B97B10" strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M6 5v2M6 8.5h.01" stroke="#B97B10" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              <p className="text-[11px] font-medium" style={{ color:"#7A5000" }}>Low balance — top up to keep agents running</p>
            </div>
          )}
        </div>
      </div>

      {/* Agent Overview */}
      <div className="bg-white rounded-lg overflow-hidden mb-6" style={border}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom:"1px solid #EAEAEA" }}>
          <p className="text-[13px] font-semibold" style={{ color:"#111111" }}>Agent Overview</p>
          <Link href="/agents" className="flex items-center gap-1 text-[12px] transition-colors duration-150" style={{ color:"#787774" }}>
            Manage agents <ArrowRight size={12}/>
          </Link>
        </div>
        <div className="grid grid-cols-[1fr_7rem_5rem_6rem_10rem] gap-4 px-6 py-2.5 text-[11px] font-medium uppercase tracking-wider" style={{ color:"#787774", borderBottom:"1px solid #EAEAEA" }}>
          <span>Agent</span><span>Wallet</span><span className="text-right">Balance</span><span className="text-right">Spent today</span><span className="text-center">Daily budget</span>
        </div>
        {!dashboardAuthorized ? (
          <div className="px-6 py-10 text-[13px]" style={{ color:"#787774" }}>Connect your account to view agents.</div>
        ) : loading ? (
          <div className="px-6 py-10 text-[13px]" style={{ color:"#787774" }}>Loading agents...</div>
        ) : agents.length === 0 ? (
          <div className="px-6 py-10 text-[13px]" style={{ color:"#787774" }}>No agents linked to this account yet.</div>
        ) : (
          <div>
            {agents.map((a, i) => {
              const spentToday = parseFloat(a.dailySpent || "0");
              const bal    = a.walletBalance != null ? parseFloat(a.walletBalance) : null;
              const pct    = Math.min(a.dailyBudgetUsedPercent ?? 0, 100);
              const col    = utilColor(pct);
              const trk    = utilTrack(pct);
              const lowBal = bal !== null && bal < 0.01;
              return (
                <div key={a.agentId}
                  className="grid grid-cols-[1fr_7rem_5rem_6rem_10rem] gap-4 items-center px-6 py-3 hover:bg-[#FBFBFA] transition-colors duration-100"
                  style={{ borderBottom: i < agents.length-1 ? "1px solid #EAEAEA" : "none" }}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="relative shrink-0">
                      <AgentAvatar seed={a.agentId} size={24} animated />
                      <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-white" style={{ background:"#346538" }}/>
                    </div>
                    {/* displayName, not agentId: the adapter puts the tree
                        label here with its depth prefix ("root", "└─ research",
                        "   └─ r1"). agentId is `node-<id>` for a team node,
                        which rendered as "node-1" and hid the hierarchy. */}
                    <span className="text-[13px] font-medium truncate" style={{ color:"#111111" }}>
                      {a.displayName ?? a.agentId}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono" style={{ color:"#787774" }}>{a.walletAddress.slice(0,6)}···</span>
                  <span
                    className="text-[12px] font-mono text-right tabular-nums"
                    style={{ color: lowBal ? "#9F2F2D" : "#111111" }}
                    title={lowBal ? "Low balance — agent may fail payments" : undefined}
                  >
                    {bal !== null ? bal.toFixed(2) : "—"}
                    <span className="text-[10px] ml-0.5" style={{ color: "#A0A09A" }}>USDC</span>
                  </span>
                  <span className="text-[12px] font-mono text-right tabular-nums" style={{ color:"#111111" }}>${spentToday.toFixed(2)}</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: trk }}>
                      <div className="h-full rounded-full transition-all duration-500" style={{ width:`${pct}%`, background: col }}/>
                    </div>
                    <span className="text-[11px] font-medium w-8 text-right shrink-0" style={{ color: col }}>{pct.toFixed(0)}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="bg-white rounded-lg overflow-hidden" style={border}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom:"1px solid #EAEAEA" }}>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background:"#346538" }}/>
            <p className="text-[13px] font-semibold" style={{ color:"#111111" }}>Recent Activity</p>
          </div>
          <Link href="/activity" className="flex items-center gap-1 text-[12px] transition-colors duration-150" style={{ color:"#787774" }}>
            View all <ArrowRight size={12}/>
          </Link>
        </div>
        <div className="grid grid-cols-[3.5rem_7rem_1fr_5rem_3rem_5.5rem] gap-4 px-6 py-2.5 text-[11px] font-medium uppercase tracking-wider" style={{ color:"#787774", borderBottom:"1px solid #EAEAEA" }}>
          <span>Time</span><span>Agent</span><span>Route</span><span className="text-right">Amount</span><span className="text-center">Rail</span><span className="text-right">Status</span>
        </div>
        {activity.length === 0 ? (
          <div className="px-6 py-10 text-[13px]" style={{ color:"#787774" }}>
            {dashboardAuthorized ? "No payment activity yet." : "Connect account to view activity."}
          </div>
        ) : (
          <div>
            {activity.slice(0, 6).map((r, i) => {
              const approved = ["approved","confirmed","success"].includes(r.status?.toLowerCase());
              return (
                <div key={r.id}
                  className="grid grid-cols-[3.5rem_7rem_1fr_5rem_3rem_5.5rem] gap-4 items-center px-6 py-3 transition-colors duration-100 hover:bg-[#FBFBFA]"
                  style={{ borderBottom: i < Math.min(activity.length,6)-1 ? "1px solid #EAEAEA" : "none", opacity: mounted ? 1 : 0, transition:`opacity 400ms cubic-bezier(0.16,1,0.3,1) ${200+i*60}ms` }}
                >
                  <span className="text-[12px] font-mono tabular-nums" style={{ color:"#787774" }}>{formatTime(r.time)}</span>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <AgentAvatar seed={r.agent} size={16} animated />
                    <span className="text-[12px] font-mono truncate" style={{ color:"#111111" }}>{r.agent.slice(0,8)}…</span>
                  </div>
                  <span className="text-[13px] font-medium truncate" style={{ color:"#111111" }}>{resolveVenue(r.venue, r.modelName)}</span>
                  <span className="text-[12px] font-mono text-right tabular-nums" style={{ color:"#111111" }}>{r.amount} <span style={{ color:"#787774" }}>USDC</span></span>
                  <span className="text-[11px] uppercase tracking-wider text-center font-medium" style={{ color:"#787774" }}>{resolveRail(r.rail)}</span>
                  <div className="flex justify-end">
                    <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
                      style={approved ? { background:"#EDF3EC", color:"#346538" } : { background:"#FDEBEC", color:"#9F2F2D" }}
                    >{r.status}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
