"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, Check, DollarSign, Loader, Pencil, Zap, X } from "lucide-react";
import AgentAvatar from "@/components/smoothui/agent-avatar";
import { useWallet } from "@/components/wallet-provider";
import {
  getOwnerAuthHeaders,
  getOwnerQuery,
  getOwnerWalletForBody,
  hasOwnerSession,
  useOwnerSessionAvailable,
} from "@/lib/float-session";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";
const border = { border: "1px solid #EAEAEA" };
const ROLES = ["General", "Web Research", "ETL", "Marketing", "Engineering", "Support", "Market Making", "Custom"];

function formatTime(iso: string): string {
  if (!iso || iso === "—") return "—";
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "—";
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

type ApiAgent = {
  agentId: string;
  walletAddress: string;
  createdAt: string;
  status?: "active" | "killed";
  displayName?: string | null;
  lifetimeSpent?: string;
  lifetimePayments?: number;
  walletBalance?: string | null;
  policy?: {
    dailyBudget?: string;
    perTxLimit?: string;
    killOnBudget?: boolean;
    blockUnknown?: boolean;
    allowedAddresses?: string[];
    allowX402?: boolean;
    allowMpp?: boolean;
    autoTopUp?: boolean;
    autoTopUpThreshold?: string;
    autoTopUpAmount?: string;
  } | null;
};

type ActivityItem = {
  id: string;
  agent: string;
  venue: string;
  amount: string;
  rail: string;
  time: string;
  status: string;
};

type DashboardResponse = {
  agents?: ApiAgent[];
  recentActivity?: ActivityItem[];
};

type CreateAgentResponse = {
  agent: ApiAgent;
};

type Agent = {
  id: string;
  displayName: string;
  wallet: string;
  role: string;
  status: "active" | "killed";
  budget: number;
  spent: number;
  payments: number;
  lastActive: string;
  autoTopUp: boolean;
  blockUnknown: boolean;
  allowX402: boolean;
  hasAddressAllowlist: boolean;
  walletBalance: number | null;
};

type AllocateModal = {
  agentId: string;
  amount: string;
  loading: boolean;
  error: string | null;
};

function deriveRole(agentId: string): string {
  const id = agentId.toLowerCase();
  if (id.includes("research") || id.includes("search")) return "Web Research";
  if (id.includes("etl") || id.includes("pipeline") || id.includes("data")) return "ETL";
  if (id.includes("market") || id.includes("content") || id.includes("social")) return "Marketing";
  if (id.includes("engineer") || id.includes("code") || id.includes("dev")) return "Engineering";
  if (id.includes("support") || id.includes("help")) return "Support";
  return "General";
}

function slugifyAgentId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mapApiAgentToAgent(agent: ApiAgent, recentActivity: ActivityItem[]): Agent {
  const lastActive = recentActivity.find((item) => item.agent === agent.agentId)?.time || "—";
  return {
    id: agent.agentId,
    displayName: agent.displayName || agent.agentId,
    wallet: agent.walletAddress,
    role: deriveRole(agent.agentId),
    status: agent.status ?? "active",
    budget: parseFloat(agent.policy?.dailyBudget || "50"),
    spent: parseFloat(agent.lifetimeSpent || "0"),
    payments: agent.lifetimePayments ?? 0,
    lastActive,
    autoTopUp: agent.policy?.autoTopUp ?? false,
    blockUnknown: agent.policy?.blockUnknown ?? false,
    allowX402: agent.policy?.allowX402 ?? true,
    hasAddressAllowlist: (agent.policy?.allowedAddresses?.length ?? 0) > 0,
    walletBalance: agent.walletBalance != null ? parseFloat(agent.walletBalance) : null,
  };
}

export default function AgentsPage() {
  const { walletAddress } = useWallet();
  const ownerSessionAvailable = useOwnerSessionAvailable();
  const dashboardAuthorized = Boolean(walletAddress) || ownerSessionAvailable;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("General");
  const [budget, setBudget] = useState("50");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [sweeping, setSweeping] = useState<Set<string>>(new Set());
  const [toppingUp, setToppingUp] = useState<Set<string>>(new Set());
  const [actionFeedback, setActionFeedback] = useState<Record<string, { type: "success" | "error"; message: string }>>({});
  const [allocate, setAllocate] = useState<AllocateModal | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  async function loadAgents(currentWalletAddress: string | null) {
    setLoading(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/v1/dashboard${getOwnerQuery(currentWalletAddress)}`,
        { cache: "no-store", headers: getOwnerAuthHeaders() },
      );
      const payload = (await response.json()) as DashboardResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load agents.");
      }

      const mapped = (payload.agents ?? []).map((agent) =>
        mapApiAgentToAgent(agent, payload.recentActivity ?? []),
      );
      setAgents(mapped);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!walletAddress && !hasOwnerSession()) {
      setAgents([]);
      setLoading(false);
      return;
    }

    void loadAgents(walletAddress).catch(() => {
      setLoading(false);
    });
  }, [walletAddress]);

  useEffect(() => {
    if (renaming) {
      const timer = setTimeout(() => renameRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [renaming]);

  const agentCountLabel = useMemo(
    () => `${agents.length} agent${agents.length === 1 ? "" : "s"} provisioned`,
    [agents.length],
  );

  const toggle = async (id: string, current: "active" | "killed") => {
    if (!walletAddress && !hasOwnerSession()) return;
    setToggling((previous) => new Set(previous).add(id));
    const action = current === "active" ? "kill" : "resume";

    try {
      const response = await fetch(
        `${API_BASE_URL}/v1/agents/${encodeURIComponent(id)}/${action}${getOwnerQuery(walletAddress)}`,
        { method: "POST", headers: getOwnerAuthHeaders() },
      );
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Failed to update agent status.");
      }

      setAgents((previous) =>
        previous.map((agent) =>
          agent.id === id
            ? { ...agent, status: current === "active" ? "killed" : "active" }
            : agent,
        ),
      );
    } finally {
      setToggling((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };

  const clearFeedback = (agentId: string) => {
    setTimeout(() => {
      setActionFeedback((prev) => {
        const next = { ...prev };
        delete next[agentId];
        return next;
      });
    }, 4000);
  };

  const sweep = async (agentId: string) => {
    if (!walletAddress && !hasOwnerSession()) return;
    setSweeping((prev) => new Set(prev).add(agentId));
    try {
      const res = await fetch(
        `${API_BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/sweep${getOwnerQuery(walletAddress)}`,
        { method: "POST", headers: getOwnerAuthHeaders() },
      );
      const payload = (await res.json()) as { swept?: boolean; amount?: string; reason?: string; error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Sweep failed.");
      if (payload.swept) {
        setActionFeedback((prev) => ({ ...prev, [agentId]: { type: "success", message: `Swept $${payload.amount} USDC to treasury.` } }));
      } else {
        const reasonMap: Record<string, string> = {
          no_ata: "No wallet found on-chain.",
          zero_balance: "Nothing to sweep — balance is zero.",
          dust: "Balance too small to sweep.",
        };
        setActionFeedback((prev) => ({ ...prev, [agentId]: { type: "success", message: reasonMap[payload.reason ?? ""] ?? "Nothing to sweep." } }));
      }
    } catch (err) {
      setActionFeedback((prev) => ({ ...prev, [agentId]: { type: "error", message: err instanceof Error ? err.message : "Sweep failed." } }));
    } finally {
      setSweeping((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
      clearFeedback(agentId);
    }
  };

  const topUp = async (agentId: string) => {
    if (!walletAddress && !hasOwnerSession()) return;
    setToppingUp((prev) => new Set(prev).add(agentId));
    try {
      const res = await fetch(
        `${API_BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/top-up${getOwnerQuery(walletAddress)}`,
        { method: "POST", headers: getOwnerAuthHeaders() },
      );
      const payload = (await res.json()) as { toppedUp?: boolean; amount?: string; error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Top-up failed.");
      setActionFeedback((prev) => ({ ...prev, [agentId]: { type: "success", message: `Topped up $${payload.amount} USDC from treasury.` } }));
    } catch (err) {
      setActionFeedback((prev) => ({ ...prev, [agentId]: { type: "error", message: err instanceof Error ? err.message : "Top-up failed." } }));
    } finally {
      setToppingUp((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
      clearFeedback(agentId);
    }
  };

  const startRename = (agent: Agent) => {
    setRenaming(agent.id);
    setRenameVal(agent.displayName);
  };

  const commitRename = async (agentId: string) => {
    const ownerWallet = getOwnerWalletForBody(walletAddress);
    if ((!walletAddress && !hasOwnerSession()) || !renameVal.trim()) {
      setRenaming(null);
      return;
    }

    setRenameSaving(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/rename${getOwnerQuery(walletAddress)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getOwnerAuthHeaders() },
          body: JSON.stringify({
            ...(ownerWallet ? { ownerWallet } : {}),
            displayName: renameVal.trim(),
          }),
        },
      );

      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to rename agent.");
      }

      setAgents((previous) =>
        previous.map((agent) =>
          agent.id === agentId ? { ...agent, displayName: renameVal.trim() } : agent,
        ),
      );
      setRenaming(null);
    } finally {
      setRenameSaving(false);
    }
  };

  const doAllocate = async () => {
    const ownerWallet = getOwnerWalletForBody(walletAddress);
    if ((!walletAddress && !hasOwnerSession()) || !allocate) return;
    const amount = allocate.amount.trim();
    if (!amount || Number.isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return;

    setAllocate((previous) => (previous ? { ...previous, loading: true, error: null } : previous));
    try {
      const response = await fetch(
        `${API_BASE_URL}/v1/agents/${encodeURIComponent(allocate.agentId)}/allocate${getOwnerQuery(walletAddress)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getOwnerAuthHeaders() },
          body: JSON.stringify({
            ...(ownerWallet ? { ownerWallet } : {}),
            amount,
            currency: "USDC",
          }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Allocation failed.");
      }

      setAllocate(null);
    } catch (error) {
      setAllocate((previous) =>
        previous
          ? {
              ...previous,
              loading: false,
              error: error instanceof Error ? error.message : "Allocation failed.",
            }
          : previous,
      );
    }
  };

  const create = async () => {
    if ((!walletAddress && !hasOwnerSession()) || !name.trim()) return;

    const agentId = slugifyAgentId(name);
    if (!agentId) {
      setCreateError("Enter a valid agent name.");
      return;
    }

    setCreating(true);
    setCreateError(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/v1/agents${getOwnerQuery(walletAddress)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getOwnerAuthHeaders() },
          body: JSON.stringify({
            agentId,
            displayName: name.trim(),
            dailyBudget: budget.trim() || "50",
          }),
        },
      );

      const payload = (await response.json()) as CreateAgentResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to create agent.");
      }

      setAgents((previous) => [...previous, mapApiAgentToAgent(payload.agent, [])]);
      setName("");
      setRole("General");
      setBudget("50");
      setShowModal(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Failed to create agent.");
    } finally {
      setCreating(false);
    }
  };

  // Agents with the L3 backstop disabled — i.e. blockUnknown:false. These can
  // pay any address, which means a prompt injection can drain them. We surface
  // a loud warning so users know to lock down via the Policies page.
  const openSpendingAgents = agents.filter((a) => !a.blockUnknown && a.status === "active");

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">
      <div className="flex items-end justify-between mb-8">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-widest mb-1" style={{ color: "#787774" }}>
            Agent Console
          </p>
          <h2 className="text-[22px] font-semibold tracking-tight" style={{ color: "#111111" }}>
            Agents
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-[12px]" style={{ color: "#787774" }}>{agentCountLabel}</p>
          <Link
            href="/agents/deploy"
            className="px-4 py-1.5 rounded-md text-[12px] font-semibold tracking-wide transition-all duration-150 active:scale-[0.97]"
            style={{ background: "#111111", color: "#fff" }}
          >
            New agent
          </Link>
        </div>
      </div>

      {openSpendingAgents.length > 0 && (
        <div
          className="rounded-lg p-4 mb-6"
          style={{
            background: "#FEF3C7",
            border: "1px solid #F59E0B",
          }}
        >
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 shrink-0 inline-flex items-center justify-center rounded-full w-5 h-5 text-[11px] font-bold"
              style={{ background: "#B45309", color: "#FFFFFF" }}
              aria-hidden
            >
              !
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold" style={{ color: "#78350F" }}>
                {openSpendingAgents.length === 1
                  ? `1 agent has open spending`
                  : `${openSpendingAgents.length} agents have open spending`}
              </p>
              <p className="text-[12px] mt-1" style={{ color: "#92400E" }}>
                {openSpendingAgents.map((a) => a.displayName).join(", ")}{" "}
                {openSpendingAgents.length === 1 ? "can" : "can each"} pay{" "}
                <strong>any Solana address</strong> — Float&apos;s server-side whitelist enforcement
                is OFF (<span className="font-mono">blockUnknown: false</span>). A prompt-injection
                attack on your AI agent could drain {openSpendingAgents.length === 1 ? "it" : "them"} to a
                wallet you didn&apos;t approve.
              </p>
              <p className="text-[12px] mt-2" style={{ color: "#92400E" }}>
                <Link
                  href="/policies"
                  className="font-semibold underline"
                  style={{ color: "#78350F" }}
                >
                  Lock down via Policies
                </Link>{" "}
                — turn on <span className="font-mono">blockUnknown</span> and add only the addresses
                this agent should ever pay.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg overflow-hidden" style={border}>
        <div
          className="grid grid-cols-[1fr_6.5rem_5.5rem_5.5rem_6.5rem_4rem_4.5rem_11rem] gap-4 px-6 py-3 text-[11px] font-medium uppercase tracking-wider"
          style={{ color: "#787774", borderBottom: "1px solid #EAEAEA" }}
        >
          <span>Agent</span>
          <span>Role</span>
          <span className="text-right">Daily Limit</span>
          <span className="text-right">Balance</span>
          <span className="text-right">Lifetime Spent</span>
          <span className="text-center">Payments</span>
          <span className="text-center">Last Active</span>
          <span className="text-center">Actions</span>
        </div>

        {!dashboardAuthorized ? (
          <div className="px-6 py-16 text-center">
            <p className="text-[13px] font-medium mb-1" style={{ color: "#111111" }}>No wallet connected</p>
            <p className="text-[12px]" style={{ color: "#787774" }}>
              Connect the wallet you used during Float onboarding.
            </p>
          </div>
        ) : loading ? (
          <div className="px-6 py-16 text-center">
            <p className="text-[13px]" style={{ color: "#787774" }}>Loading agents...</p>
          </div>
        ) : agents.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="text-[13px] font-medium mb-1" style={{ color: "#111111" }}>No agents provisioned</p>
            <p className="text-[12px]" style={{ color: "#787774" }}>
              Run <span className="font-mono">npx @usefloat/cli install</span> to create your first agent.
            </p>
          </div>
        ) : (
          <div>
            {agents.map((agent, index) => {
              const isToggling = toggling.has(agent.id);
              const isRenaming = renaming === agent.id;

              return (
                <div
                  key={agent.id}
                  style={{ borderBottom: index < agents.length - 1 ? "1px solid #EAEAEA" : "none" }}
                >
                <div
                  className="grid grid-cols-[1fr_6.5rem_5.5rem_5.5rem_6.5rem_4rem_4.5rem_11rem] gap-4 items-center px-6 py-4 hover:bg-[#FBFBFA] transition-colors duration-100"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative shrink-0">
                      <AgentAvatar seed={agent.id} size={32} animated={agent.status === "active"} />
                      <div
                        className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white"
                        style={{ background: agent.status === "active" ? "#346538" : "#9F2F2D" }}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      {isRenaming ? (
                        <div className="flex items-center gap-1">
                          <input
                            ref={renameRef}
                            value={renameVal}
                            onChange={(event) => setRenameVal(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void commitRename(agent.id);
                              if (event.key === "Escape") setRenaming(null);
                            }}
                            className="text-[13px] font-medium outline-none rounded px-1.5 py-0.5 w-full"
                            style={{ border: "1px solid #111111", color: "#111111", background: "#fff" }}
                          />
                          <button
                            onClick={() => void commitRename(agent.id)}
                            disabled={renameSaving}
                            className="p-1 shrink-0 rounded"
                            style={{ color: "#346538" }}
                          >
                            <Check size={12} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 group">
                          <p
                            className="text-[13px] font-medium truncate"
                            style={{ color: agent.status === "killed" ? "#787774" : "#111111" }}
                          >
                            {agent.displayName}
                          </p>
                          <button
                            onClick={() => startRename(agent)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded"
                            style={{ color: "#AEADA8" }}
                          >
                            <Pencil size={10} />
                          </button>
                        </div>
                      )}
                      <p className="text-[11px] font-mono truncate" style={{ color: "#787774" }}>
                        {agent.wallet.slice(0, 8)}···{agent.wallet.slice(-6)}
                      </p>
                      {(agent.autoTopUp || agent.blockUnknown || (agent.allowX402 && !agent.hasAddressAllowlist)) && (
                        <div className="flex items-center gap-1 mt-0.5">
                          {agent.autoTopUp && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                              style={{ background:"#EDF3EC", color:"#346538" }}
                              title="Auto top-up enabled"
                            >
                              Auto ↑
                            </span>
                          )}
                          {agent.blockUnknown && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                              style={{ background:"#F5F5F4", color:"#787774" }}
                              title="Block unknown destinations"
                            >
                              Guarded
                            </span>
                          )}
                          {agent.allowX402 && !agent.hasAddressAllowlist && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                              style={{ background:"#FEF9EE", color:"#A16207" }}
                              title="x402 payments are open — this agent can pay any public address. Set blockUnknown: true with an allowedAddresses list, or disable x402 in Policies."
                            >
                              Open x402
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <span className="text-[12px]" style={{ color: "#787774" }}>{agent.role}</span>

                  <p className="text-[13px] font-medium text-right" style={{ color: "#111111" }}>
                    {agent.budget}
                    <span className="text-[11px] font-normal ml-1" style={{ color: "#787774" }}>USDC</span>
                  </p>

                  <p
                    className="text-[13px] font-mono text-right tabular-nums"
                    style={{ color: agent.walletBalance !== null && agent.walletBalance < 0.01 ? "#9F2F2D" : "#111111" }}
                    title={agent.walletBalance !== null && agent.walletBalance < 0.01 ? "Low balance — fund this agent" : undefined}
                  >
                    {agent.walletBalance !== null ? agent.walletBalance.toFixed(2) : "—"}
                    <span className="text-[11px] ml-1" style={{ color: "#787774" }}>USDC</span>
                  </p>

                  <p className="text-[13px] font-mono text-right" style={{ color: "#111111" }}>
                    {agent.spent.toFixed(2)}
                    <span className="text-[11px] ml-1" style={{ color: "#787774" }}>USDC</span>
                  </p>

                  <p className="text-[13px] font-medium text-center" style={{ color: "#787774" }}>
                    {agent.payments}
                  </p>

                  <p className="text-[12px] text-center" style={{ color: agent.status === "killed" ? "#9F2F2D" : "#787774" }}>
                    {agent.status === "killed" ? "killed" : formatTime(agent.lastActive)}
                  </p>

                  <div className="flex items-center justify-center gap-1.5">
                    <button
                      onClick={() => setAllocate({ agentId: agent.id, amount: "", loading: false, error: null })}
                      title="Allocate USDC from treasury"
                      className="p-1.5 rounded-md transition-all duration-150 active:scale-[0.97]"
                      style={{ background: "#F7F6F3", color: "#787774", border: "1px solid #EAEAEA" }}
                    >
                      <DollarSign size={12} />
                    </button>
                    <button
                      onClick={() => void sweep(agent.id)}
                      disabled={sweeping.has(agent.id)}
                      title="Sweep USDC back to treasury"
                      className="p-1.5 rounded-md transition-all duration-150 active:scale-[0.97] disabled:opacity-50"
                      style={{ background: "#F7F6F3", color: "#787774", border: "1px solid #EAEAEA" }}
                    >
                      {sweeping.has(agent.id) ? <Loader size={12} className="animate-spin" /> : <ArrowDownToLine size={12} />}
                    </button>
                    <button
                      onClick={() => void topUp(agent.id)}
                      disabled={toppingUp.has(agent.id)}
                      title="Top up to daily budget"
                      className="p-1.5 rounded-md transition-all duration-150 active:scale-[0.97] disabled:opacity-50"
                      style={{ background: "#F7F6F3", color: "#787774", border: "1px solid #EAEAEA" }}
                    >
                      {toppingUp.has(agent.id) ? <Loader size={12} className="animate-spin" /> : <Zap size={12} />}
                    </button>
                    <button
                      onClick={() => void toggle(agent.id, agent.status)}
                      disabled={isToggling}
                      className="text-[12px] font-medium px-3 py-1 rounded-md transition-all duration-150 active:scale-[0.97] disabled:opacity-50"
                      style={
                        agent.status === "active"
                          ? { background: "#FDEBEC", color: "#9F2F2D", border: "1px solid #FDEBEC" }
                          : { background: "#EDF3EC", color: "#346538", border: "1px solid #EDF3EC" }
                      }
                    >
                      {isToggling ? "..." : agent.status === "active" ? "Kill" : "Resume"}
                    </button>
                  </div>
                </div>
                {actionFeedback[agent.id] && (
                  <div
                    className="px-6 pb-3 text-[11px] font-medium"
                    style={{ color: actionFeedback[agent.id].type === "success" ? "#346538" : "#9F2F2D" }}
                  >
                    {actionFeedback[agent.id].message}
                  </div>
                )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.25)" }}
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-white rounded-xl w-full max-w-sm mx-4 overflow-hidden shadow-xl"
            style={border}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #EAEAEA" }}>
              <p className="text-[13px] font-semibold" style={{ color: "#111111" }}>New agent</p>
              <button onClick={() => setShowModal(false)} className="p-1 rounded transition-colors duration-150" style={{ color: "#787774" }}>
                <X size={14} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wider mb-1.5" style={{ color: "#787774" }}>
                  Agent name
                </label>
                <input
                  type="text"
                  placeholder="e.g. research-agent"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void create();
                  }}
                  autoFocus
                  className="w-full text-[13px] outline-none rounded-md px-3 py-2"
                  style={{ border: "1px solid #EAEAEA", color: "#111111", background: "#fff" }}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wider mb-1.5" style={{ color: "#787774" }}>
                  Role
                </label>
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  className="w-full text-[13px] outline-none rounded-md px-3 py-2"
                  style={{ border: "1px solid #EAEAEA", color: "#111111", background: "#fff" }}
                >
                  {ROLES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wider mb-1.5" style={{ color: "#787774" }}>
                  Daily budget
                </label>
                <div className="flex items-center gap-2 rounded-md px-3 py-2" style={{ border: "1px solid #EAEAEA" }}>
                  <input
                    type="number"
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    className="flex-1 text-[13px] font-medium outline-none"
                    style={{ color: "#111111", background: "transparent" }}
                  />
                  <span className="text-[12px]" style={{ color: "#787774" }}>USDC</span>
                </div>
              </div>
              {createError && (
                <p className="text-[11px]" style={{ color: "#9F2F2D" }}>{createError}</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4" style={{ borderTop: "1px solid #EAEAEA" }}>
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-1.5 rounded-md text-[12px] font-medium transition-colors duration-150"
                style={{ border: "1px solid #EAEAEA", color: "#787774", background: "#fff" }}
              >
                Cancel
              </button>
              <button
                onClick={() => void create()}
                disabled={!name.trim() || creating}
                className="px-4 py-1.5 rounded-md text-[12px] font-semibold transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
                style={{ background: "#111111", color: "#fff" }}
              >
                {creating ? "Creating..." : "Create agent"}
              </button>
            </div>
          </div>
        </div>
      )}

      {allocate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.25)" }}
          onClick={() => setAllocate(null)}
        >
          <div
            className="bg-white rounded-xl w-full max-w-xs mx-4 overflow-hidden shadow-xl"
            style={border}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #EAEAEA" }}>
              <div>
                <p className="text-[13px] font-semibold" style={{ color: "#111111" }}>Allocate USDC</p>
                <p className="text-[11px] mt-0.5 font-mono" style={{ color: "#787774" }}>{allocate.agentId}</p>
              </div>
              <button onClick={() => setAllocate(null)} className="p-1 rounded" style={{ color: "#787774" }}>
                <X size={14} />
              </button>
            </div>
            <div className="px-6 py-5">
              <label className="block text-[11px] font-medium uppercase tracking-wider mb-1.5" style={{ color: "#787774" }}>
                Amount to send from treasury
              </label>
              <div className="flex items-center gap-2 rounded-md px-3 py-2 mb-1" style={{ border: "1px solid #EAEAEA" }}>
                <input
                  type="number"
                  placeholder="0.00"
                  value={allocate.amount}
                  onChange={(event) =>
                    setAllocate((previous) =>
                      previous ? { ...previous, amount: event.target.value } : previous,
                    )
                  }
                  autoFocus
                  className="flex-1 text-[13px] font-medium outline-none"
                  style={{ color: "#111111", background: "transparent" }}
                />
                <span className="text-[12px]" style={{ color: "#787774" }}>USDC</span>
              </div>
              <p className="text-[11px]" style={{ color: "#787774" }}>
                This transfers real USDC from your treasury wallet to the agent&apos;s wallet on-chain.
              </p>
              {allocate.error && (
                <p className="text-[11px] mt-2" style={{ color: "#9F2F2D" }}>{allocate.error}</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4" style={{ borderTop: "1px solid #EAEAEA" }}>
              <button
                onClick={() => setAllocate(null)}
                className="px-4 py-1.5 rounded-md text-[12px] font-medium"
                style={{ border: "1px solid #EAEAEA", color: "#787774", background: "#fff" }}
              >
                Cancel
              </button>
              <button
                onClick={() => void doAllocate()}
                disabled={allocate.loading || !allocate.amount}
                className="px-4 py-1.5 rounded-md text-[12px] font-semibold transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
                style={{ background: "#111111", color: "#fff" }}
              >
                {allocate.loading ? "Sending..." : "Send USDC"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
