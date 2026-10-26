"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import AgentAvatar from "@/components/smoothui/agent-avatar";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";
const border = { border: "1px solid #EAEAEA" };

/**
 * The budget tree.
 *
 * The Solana-era page called six endpoints the NEAR adapter does not serve —
 * /v1/agents/:id/kill, /sweep, /top-up, /rename, /allocate and POST /v1/agents
 * — so every action on it failed silently. It also carried an "Open x402"
 * badge driven by `allowX402`, a field this vault has no concept of, and warned
 * that agents could "pay any Solana address".
 *
 * What replaces it is what this product is actually about: the hierarchy, each
 * node's enforced caps, and what it has spent today. Teams are rows too — they
 * hold the shared pool, which is the whole point.
 *
 * Freeze is the one mutating action kept, because it maps to a real contract
 * method (`freeze_node`). Like every owner method it produces a command for the
 * owner to run rather than being signed here.
 */
type ApiAgent = {
  agentId: string;
  displayName?: string | null;
  walletAddress: string;
  status: "active" | "killed";
  dailySpent?: string;
  dailyBudgetUsedPercent?: number;
  policy: {
    dailyBudget?: string;
    perTxLimit?: string;
    cooldownSeconds?: number;
    allowedAddresses?: string[];
  } | null;
};

type VaultInfo = {
  vaultId: string;
  explorerBase: string;
  paused: boolean;
  strictAllocation: boolean;
};

function nodeIdOf(a: ApiAgent, all: ApiAgent[]): number {
  const m = /^node-(\d+)$/.exec(a.agentId);
  return m ? Number(m[1]) : all.indexOf(a);
}

/** Depth from the non-breaking-space prefix the adapter puts in displayName. */
function depthOf(a: ApiAgent): number {
  const d = a.displayName ?? "";
  const nb = (d.match(/ /g) ?? []).length;
  if (nb > 0) return nb / 3 + 1;
  return d.startsWith("└") ? 1 : 0;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ cli: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [dashRes, infoRes] = await Promise.all([
        fetch(`${API_BASE_URL}/v1/dashboard`, { cache: "no-store" }),
        fetch(`${API_BASE_URL}/v1/vault-info`, { cache: "no-store" }),
      ]);
      if (!dashRes.ok) throw new Error(`dashboard returned HTTP ${dashRes.status}`);
      const d = (await dashRes.json()) as { agents?: ApiAgent[] };
      setAgents(d.agents ?? []);
      if (infoRes.ok) setInfo((await infoRes.json()) as VaultInfo);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to reach the vault adapter.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const buildFreeze = useCallback(
    async (a: ApiAgent) => {
      const frozen = a.status !== "killed";
      try {
        const res = await fetch(`${API_BASE_URL}/v1/owner-plan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "freeze", nodeId: nodeIdOf(a, agents), frozen }),
        });
        const body = (await res.json()) as { cli?: string; error?: string };
        if (!res.ok || !body.cli) throw new Error(body.error ?? `HTTP ${res.status}`);
        setPlan({
          cli: body.cli,
          label: `${frozen ? "Freeze" : "Unfreeze"} ${(a.displayName ?? a.agentId).trim()}`,
        });
      } catch (e) {
        setPlan({
          cli: e instanceof Error ? e.message : "Could not build the command.",
          label: "Error",
        });
      }
    },
    [agents],
  );

  // Nodes with no resolvable allowlist. Every payment from them is refused, so
  // it is worth surfacing — the inverse of the old "Open x402" warning, which
  // stated the opposite of the truth.
  const noAllowlist = agents.filter((a) => !a.policy?.allowedAddresses?.length);

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <p
          className="text-[11px] font-medium uppercase tracking-widest mb-1"
          style={{ color: "#787774" }}
        >
          Agent Console
        </p>
        <h2 className="text-[22px] font-semibold tracking-tight" style={{ color: "#111111" }}>
          Budget tree
        </h2>
        <p className="text-[13px] mt-1.5 max-w-2xl" style={{ color: "#787774" }}>
          Every payment is checked at each level from the agent up to the root. A child can be
          refused because a pool it shares is exhausted, even when its own budget is untouched.
        </p>
      </div>

      {loading ? (
        <Panel>Loading the tree...</Panel>
      ) : error ? (
        <Panel tone="error">{error}</Panel>
      ) : agents.length === 0 ? (
        <Panel>
          This vault has no budget nodes yet. The owner creates them with{" "}
          <span className="font-mono">add_node</span>.
        </Panel>
      ) : (
        <>
          {info?.paused && (
            <div
              className="mb-4 rounded-lg px-5 py-3 text-[12px]"
              style={{ background: "#FDEBEC", color: "#9F2F2D", ...border }}
            >
              The vault is <span className="font-mono">paused</span>. Every payment is refused with
              VAULT_PAUSED, regardless of budgets.
            </div>
          )}

          {noAllowlist.length > 0 && (
            <div className="mb-4 rounded-lg px-5 py-3" style={{ background: "#FEF3E2", ...border }}>
              <p className="text-[13px] font-semibold" style={{ color: "#78350F" }}>
                {noAllowlist.length === 1
                  ? "1 node has no payee allowlist"
                  : `${noAllowlist.length} nodes have no payee allowlist`}
              </p>
              <p className="text-[12px] mt-1" style={{ color: "#92400E" }}>
                {noAllowlist.map((a) => (a.displayName ?? a.agentId).trim()).join(", ")} — every
                payment from {noAllowlist.length === 1 ? "it is" : "them is"} refused with
                RECIPIENT_NOT_ALLOWED. The allowlist is always enforced and is inherited from the
                nearest ancestor that has one, so setting it on the root covers the whole tree.{" "}
                <Link href="/policies" className="underline">
                  Open Policies
                </Link>
                .
              </p>
            </div>
          )}

          <div className="bg-white rounded-lg overflow-hidden" style={border}>
            <div
              className="grid grid-cols-[1.5fr_7rem_6rem_6rem_9rem_7rem] gap-4 px-6 py-3 text-[11px] font-medium uppercase tracking-wider"
              style={{ color: "#787774", borderBottom: "1px solid #EAEAEA" }}
            >
              <span>Node</span>
              <span className="text-right">Daily cap</span>
              <span className="text-right">Per payment</span>
              <span className="text-right">Spent today</span>
              <span>Utilisation</span>
              <span className="text-right">State</span>
            </div>

            {agents.map((a, i) => {
              const pct = Math.min(a.dailyBudgetUsedPercent ?? 0, 100);
              const depth = depthOf(a);
              const isAgent = Boolean(a.walletAddress);
              return (
                <div
                  key={a.agentId}
                  className="grid grid-cols-[1.5fr_7rem_6rem_6rem_9rem_7rem] gap-4 items-center px-6 py-3 hover:bg-[#FBFBFA] transition-colors duration-100"
                  style={{ borderBottom: i < agents.length - 1 ? "1px solid #EAEAEA" : "none" }}
                >
                  {/* The hierarchy, drawn. displayName already carries the depth
                      prefix in NON-BREAKING spaces: plain spaces collapse in
                      HTML and the tree renders flat. */}
                  <div className="flex items-center gap-2.5 min-w-0">
                    {isAgent ? (
                      <div className="relative shrink-0">
                        <AgentAvatar seed={a.agentId} size={22} animated />
                      </div>
                    ) : (
                      <span
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
                        style={{ background: "#F2F2F0", color: "#787774" }}
                      >
                        {depth === 0 ? "root" : "team"}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium truncate" style={{ color: "#111111" }}>
                        {a.displayName ?? a.agentId}
                      </p>
                      {isAgent && (
                        <p
                          className="font-mono text-[10.5px] truncate"
                          style={{ color: "#A0A09A" }}
                        >
                          {a.walletAddress}
                        </p>
                      )}
                    </div>
                  </div>

                  <Num value={a.policy?.dailyBudget} />
                  <Num value={a.policy?.perTxLimit} />
                  <Num value={a.dailySpent} />

                  <div className="flex items-center gap-2">
                    <div
                      className="h-1.5 flex-1 rounded-full overflow-hidden"
                      style={{ background: "#F2F2F0" }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          background: pct >= 100 ? "#9F2F2D" : pct >= 75 ? "#B45309" : "#346538",
                          transition: "width 400ms ease",
                        }}
                      />
                    </div>
                    <span
                      className="text-[10px] font-mono tabular-nums w-8 text-right"
                      style={{ color: "#787774" }}
                    >
                      {pct}%
                    </span>
                  </div>

                  <div className="flex items-center justify-end gap-1.5">
                    <span
                      className="whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                      style={
                        a.status === "killed"
                          ? { background: "#FDEBEC", color: "#9F2F2D" }
                          : { background: "#EDF3EC", color: "#346538" }
                      }
                    >
                      {a.status === "killed" ? "Frozen" : "Active"}
                    </span>
                    <button
                      onClick={() => void buildFreeze(a)}
                      title={
                        a.status === "killed"
                          ? "Build the unfreeze command for the owner to run"
                          : "Build the freeze command for the owner to run"
                      }
                      className="rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-[#F0F0EE]"
                      style={{ color: "#787774" }}
                    >
                      {a.status === "killed" ? "unfreeze" : "freeze"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {plan && (
            <div className="mt-4 bg-white rounded-lg p-4" style={border}>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold" style={{ color: "#111111" }}>
                  {plan.label}
                </p>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(plan.cli);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium"
                  style={{ ...border, background: "#fff", color: "#111111" }}
                >
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre
                className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10.5px] leading-5"
                style={{ color: "#787774" }}
              >
                {plan.cli}
              </pre>
              <p className="mt-2 text-[11px]" style={{ color: "#787774" }}>
                Owner methods are never signed by this dashboard — it can only ever hold an agent
                key.
              </p>
            </div>
          )}

          <p className="mt-4 text-[11.5px] leading-5" style={{ color: "#787774" }}>
            Allocation is{" "}
            <span className="font-mono">{info?.strictAllocation ? "strict" : "overcommit"}</span>
            {info?.strictAllocation
              ? " — children cannot be allocated more than their parent holds."
              : " — children may be allocated more than their parent holds, so the shared pool is what actually binds. That is the behaviour Activity reports as PARENT_DAILY_BUDGET."}
          </p>
        </>
      )}
    </div>
  );
}

function Num({ value }: { value?: string }) {
  return (
    <span className="text-[12px] font-mono text-right tabular-nums" style={{ color: "#111111" }}>
      {value ?? "—"}
      <span className="text-[10px] ml-0.5" style={{ color: "#A0A09A" }}>
        USDC
      </span>
    </span>
  );
}

function Panel({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div className="bg-white rounded-lg overflow-hidden" style={border}>
      <div className="px-6 py-16 text-center">
        <p
          className="text-[12px] leading-5"
          style={{ color: tone === "error" ? "#9F2F2D" : "#787774" }}
        >
          {children}
        </p>
      </div>
    </div>
  );
}
