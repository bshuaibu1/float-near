"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";
const border = { border: "1px solid #EAEAEA" };

/**
 * Only the controls the CONTRACT actually enforces.
 *
 * The Solana-era page carried Direct-transfer / External-x402 / MPP-session /
 * Auto-top-up toggles and an "External API trust mode". None of those exist in
 * this vault, so every one of them was a switch that changed nothing.
 *
 * Worse, it GET and POSTed /v1/agents/:id/policy, which the NEAR adapter does
 * not serve. The GET 404'd and the page fell back to DEFAULT_POLICY — so it
 * displayed a 50 USDC daily cap and a 2 USDC per-tx cap while the contract was
 * enforcing 100 and 100. A policy page showing numbers that are not the
 * enforced ones is worse than no policy page.
 *
 * This reads the real per-node values from /v1/dashboard, which already maps
 * them from the contract's `get_tree` and `get_node_budget`.
 */
type ApiAgent = {
  agentId: string;
  displayName?: string | null;
  walletAddress: string;
  status: "active" | "killed";
  dailySpent?: string;
  policy: {
    dailyBudget?: string;
    perTxLimit?: string;
    cooldownSeconds?: number;
    blockUnknown?: boolean;
    allowedAddresses?: string[];
  } | null;
};

type VaultInfo = {
  vaultId: string;
  network: string;
  explorerBase: string;
  owner: string;
  paused: boolean;
  strictAllocation: boolean;
};

type OwnerPlan = {
  payload: { methodName: string; args: Record<string, unknown> };
  cli: string;
};

/**
 * A selector chip shows the bare label, with the tree glyphs stripped.
 *
 * The first version did `.replace(/ /g, " ")` on displayName, which is
 * the indentation-vanishing bug all over again: HTML collapses the plain
 * spaces, so "   └─ r1" rendered at the same depth as "└─ research" and the
 * chips implied a flat tree. Depth belongs on the Budget Tree page; a chip is a
 * selector, so it gets a clean name instead of a half-drawn one.
 */
function chipLabel(a: ApiAgent): string {
  return (a.displayName ?? a.agentId).replace(/[ ]/g, "").replace(/^└─\s*/, "");
}

/** Node id out of the adapter's agentId, which is `node-<id>` or an account. */
function nodeIdOf(a: ApiAgent, all: ApiAgent[]): number {
  const m = /^node-(\d+)$/.exec(a.agentId);
  if (m) return Number(m[1]);
  return all.indexOf(a);
}

export default function Policies() {
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Draft values for the owner command. They do NOT pretend to be saved state.
  const [dailyCap, setDailyCap] = useState("");
  const [perTxCap, setPerTxCap] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [plan, setPlan] = useState<OwnerPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [dashRes, infoRes] = await Promise.all([
        fetch(`${API_BASE_URL}/v1/dashboard`, { cache: "no-store" }),
        fetch(`${API_BASE_URL}/v1/vault-info`, { cache: "no-store" }),
      ]);
      if (!dashRes.ok) throw new Error(`dashboard returned HTTP ${dashRes.status}`);
      const d = (await dashRes.json()) as { agents?: ApiAgent[] };
      const list = d.agents ?? [];
      setAgents(list);
      setSelectedId((cur) => cur || (list[0]?.agentId ?? ""));
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

  const selected = agents.find((a) => a.agentId === selectedId) ?? null;

  // Seed the draft from the ENFORCED values each time the node changes, so the
  // starting point is what the contract actually holds.
  useEffect(() => {
    if (!selected) return;
    setDailyCap(selected.policy?.dailyBudget ?? "");
    setPerTxCap(selected.policy?.perTxLimit ?? "");
    setCooldown(selected.policy?.cooldownSeconds ?? 0);
    setPlan(null);
    setPlanError(null);
  }, [selectedId, selected]);

  const buildPlan = useCallback(
    async (action: "caps" | "cooldown" | "freeze", extra: Record<string, unknown> = {}) => {
      if (!selected) return;
      setPlanError(null);
      setPlan(null);
      try {
        const res = await fetch(`${API_BASE_URL}/v1/owner-plan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            nodeId: nodeIdOf(selected, agents),
            dailyCap,
            perTxCap,
            cooldownSec: cooldown,
            ...extra,
          }),
        });
        const body = (await res.json()) as OwnerPlan & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setPlan(body);
      } catch (e) {
        setPlanError(e instanceof Error ? e.message : "Could not build the owner command.");
      }
    },
    [selected, agents, dailyCap, perTxCap, cooldown],
  );

  const copyCli = useCallback(() => {
    if (!plan) return;
    void navigator.clipboard.writeText(plan.cli);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [plan]);

  return (
    <div className="min-h-screen px-6 py-8 md:px-10" style={{ background: "#FBFBFA" }}>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h1 className="text-[22px] font-semibold tracking-[-0.03em]" style={{ color: "#111111" }}>
            Policies
          </h1>
          <p className="text-[13px] mt-1" style={{ color: "#787774" }}>
            The limits this vault enforces, level by level. Every payment is checked against all
            of them before any money moves.
          </p>
        </div>

        {loading ? (
          <div className="bg-white rounded-lg px-5 py-10 text-center text-[13px]" style={{ ...border, color: "#787774" }}>
            Loading policies...
          </div>
        ) : error ? (
          <div className="bg-white rounded-lg px-5 py-10 text-center text-[13px]" style={{ ...border, color: "#9F2F2D" }}>
            {error}
          </div>
        ) : agents.length === 0 ? (
          <div className="bg-white rounded-lg px-5 py-10 text-center text-[13px]" style={{ ...border, color: "#787774" }}>
            This vault has no spending levels yet. The owner creates them.
          </div>
        ) : (
          <>
            {/* Node selector. Teams are listed too: they hold the shared pool,
                which is the thing a policy page most needs to show. */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {agents.map((a) => (
                <button
                  key={a.agentId}
                  onClick={() => setSelectedId(a.agentId)}
                  className="rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors"
                  style={
                    a.agentId === selectedId
                      ? { background: "#111111", color: "#fff" }
                      : { ...border, background: "#fff", color: "#111111" }
                  }
                >
                  {chipLabel(a)}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-12 gap-4">
              <div className="col-span-12 md:col-span-8">
                <Section
                  title="Limits in force now"
                  description="Read straight from the vault. These are the numbers it is applying right now."
                >
                  <Row
                    label="Daily limit"
                    description="The most this level can spend in one day, including everything under it."
                  >
                    <Readout value={selected?.policy?.dailyBudget} unit="USDC" />
                  </Row>
                  <Row
                    label="Per-payment limit"
                    description="The most one payment can be."
                  >
                    <Readout value={selected?.policy?.perTxLimit} unit="USDC" />
                  </Row>
                  <Row
                    label="Cooldown"
                    description="The shortest gap allowed between two payments from this level. Zero means no wait."
                  >
                    <Readout value={String(selected?.policy?.cooldownSeconds ?? 0)} unit="sec" />
                  </Row>
                  <Row
                    label="Spent today"
                    description="Spent so far today. Payments still in flight are counted, so this never understates it."
                  >
                    <Readout value={selected?.dailySpent} unit="USDC" />
                  </Row>
                  <Row
                    label="Frozen"
                    description="A frozen level, or any frozen level above it, blocks every payment."
                    last
                  >
                    <Pill
                      on={selected?.status === "killed"}
                      onLabel="Frozen"
                      offLabel="Active"
                    />
                  </Row>
                </Section>

                <Section
                  title="Who can be paid"
                  description="The addresses this level may pay. If it has no list of its own, it uses the nearest one above it. Always on — not a switch."
                >
                  {selected?.policy?.allowedAddresses?.length ? (
                    <div className="flex flex-wrap gap-2 py-1">
                      {selected.policy.allowedAddresses.map((addr) => (
                        <span
                          key={addr}
                          className="rounded-md px-2.5 py-1 font-mono text-[11px]"
                          style={{ ...border, background: "#FBFBFA", color: "#787774" }}
                        >
                          {addr}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="py-1 text-[12px]" style={{ color: "#9F2F2D" }}>
                      No list applies here, so every payment from this level is refused. The owner
                      needs to say who it is allowed to pay.
                    </p>
                  )}
                </Section>

                {/* The write path. Not a save button — see the note below. */}
                <Section
                  title="Change a limit"
                  description="Builds a command for you to run. This dashboard never signs anything that changes the rules."
                >
                  <div className="flex flex-wrap items-end gap-3 py-1">
                    <Field label="Daily limit" unit="USDC" value={dailyCap} onChange={setDailyCap} />
                    <Field label="Per-payment limit" unit="USDC" value={perTxCap} onChange={setPerTxCap} />
                    <button
                      onClick={() => void buildPlan("caps")}
                      className="rounded-md px-3 py-2 text-[12px] font-medium"
                      style={{ background: "#111111", color: "#fff" }}
                    >
                      Build caps command
                    </button>
                  </div>

                  <div className="mt-3 flex flex-wrap items-end gap-3 py-1">
                    <Field
                      label="Cooldown"
                      unit="sec"
                      value={String(cooldown)}
                      onChange={(v) => setCooldown(Math.max(0, Math.floor(Number(v) || 0)))}
                    />
                    <button
                      onClick={() => void buildPlan("cooldown")}
                      className="rounded-md px-3 py-2 text-[12px] font-medium"
                      style={{ ...border, background: "#fff", color: "#111111" }}
                    >
                      Build cooldown command
                    </button>
                    <button
                      onClick={() =>
                        void buildPlan("freeze", { frozen: selected?.status !== "killed" })
                      }
                      className="rounded-md px-3 py-2 text-[12px] font-medium"
                      style={{ ...border, background: "#fff", color: "#9F2F2D" }}
                    >
                      {selected?.status === "killed" ? "Build unfreeze command" : "Build freeze command"}
                    </button>
                  </div>

                  {planError && (
                    <p className="mt-3 text-[11px]" style={{ color: "#9F2F2D" }}>
                      {planError}
                    </p>
                  )}

                  {plan && (
                    <div
                      className="mt-3 rounded-lg p-3"
                      style={{ background: "#FBFBFA", ...border }}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-[11px] font-semibold" style={{ color: "#111111" }}>
                          {plan.payload.methodName}
                        </p>
                        <button
                          onClick={copyCli}
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
                      <p className="mt-2 text-[11.5px] leading-5" style={{ color: "#787774" }}>
                        Copy this and run it in your own wallet. This page never signs for you.
                      </p>
                    </div>
                  )}
                </Section>
              </div>

              <div className="col-span-12 md:col-span-4 self-start md:sticky md:top-6">
                <Section
                  title="Why there is no save button"
                  description="The trust boundary this product is built on."
                >
                  <p className="py-1 text-[12px] leading-5" style={{ color: "#787774" }}>
                    Owner methods decide who may spend the treasury, so this dashboard never signs
                    them. The only key it can hold is an agent key, and that key can call just{" "}
                    <span className="font-mono">request_payment</span> on the vault and cannot
                    attach a deposit. Changing a limit therefore produces a command for the owner
                    to run in their own wallet or CLI.
                  </p>
                </Section>

                <Section title="Vault" description="Where these policies are enforced.">
                  <Row label="Contract" description="The account holding the funds and the tree.">
                    <span className="font-mono text-[11px]" style={{ color: "#787774" }}>
                      {info?.vaultId ?? "-"}
                    </span>
                  </Row>
                  <Row label="Paused" description="set_paused — blocks every payment vault-wide.">
                    <Pill on={Boolean(info?.paused)} onLabel="Paused" offLabel="Running" />
                  </Row>
                  <Row
                    label="Allocation"
                    description="strict_allocation — when off, children may be overcommitted against a shared parent pool."
                    last
                  >
                    <span
                      className="whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                      style={{ background: "#F5F5F4", color: "#787774" }}
                    >
                      {info?.strictAllocation ? "Strict" : "Overcommit"}
                    </span>
                  </Row>
                </Section>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Readout({ value, unit }: { value?: string; unit: string }) {
  return (
    <span className="whitespace-nowrap text-[13px] font-medium" style={{ color: "#111111" }}>
      {value ?? "-"} <span className="text-[12px] font-normal" style={{ color: "#787774" }}>{unit}</span>
    </span>
  );
}

function Pill({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span
      className="whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
      style={on ? { background: "#FDEBEC", color: "#9F2F2D" } : { background: "#EDF3EC", color: "#346538" }}
    >
      {on ? onLabel : offLabel}
    </span>
  );
}

function Field({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium" style={{ color: "#111111" }}>
        {label}
      </p>
      <div
        className="flex items-center gap-2"
        style={{ ...border, borderRadius: 6, padding: "6px 12px", background: "#fff" }}
      >
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 text-[13px] font-medium outline-none"
          style={{ color: "#111111", background: "transparent" }}
        />
        <span className="text-[12px]" style={{ color: "#787774" }}>
          {unit}
        </span>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg overflow-hidden mb-2.5" style={border}>
      <div className="px-5 py-3" style={{ borderBottom: "1px solid #EAEAEA" }}>
        <p className="text-[13px] font-semibold mb-0.5" style={{ color: "#111111" }}>
          {title}
        </p>
        <p className="text-[12px]" style={{ color: "#787774" }}>
          {description}
        </p>
      </div>
      <div className="px-5 py-3.5">{children}</div>
    </div>
  );
}

function Row({
  label,
  description,
  children,
  last,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between py-2.5"
      style={{ borderBottom: last ? "none" : "1px solid #EAEAEA" }}
    >
      <div>
        <p className="text-[13px] font-medium" style={{ color: "#111111" }}>
          {label}
        </p>
        <p className="text-[12px] mt-0.5" style={{ color: "#787774" }}>
          {description}
        </p>
      </div>
      <div className="ml-8 shrink-0">{children}</div>
    </div>
  );
}
