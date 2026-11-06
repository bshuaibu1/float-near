"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink } from "lucide-react";
import {
  COOLDOWN_PRESETS,
  CUSTOM,
  applyCooldownSelection,
  cooldownLabel,
  cooldownSelectValue,
  initialCustomMode,
  parseCooldownInput,
  showsCustomInput,
} from "@/lib/cooldown";
import { appliedStatus, type Expectation, type PolicySnapshot } from "@/lib/applied";
import { signLink } from "@/lib/sign-link";
import { useChainWatch, useToast } from "@/lib/use-chain-watch";
import { Toast, WatchStatus } from "@/components/toast";
import { DANGER, DANGER_BG, INK, NEUTRAL, SUCCESS, SUCCESS_BG, WARN, WARN_BG } from "@/lib/colors";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";

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
 */
type ApiAgent = {
  agentId: string;
  displayName?: string | null;
  /** Depth in the budget tree, root 0. A number, not characters. */
  depth?: number;
  walletAddress: string;
  status: "active" | "killed";
  policy: {
    dailyBudget?: string;
    perTxLimit?: string;
    cooldownSeconds?: number;
    blockUnknown?: boolean;
    allowedAddresses?: string[];
    /** This node's OWN list. Absent means it inherits. */
    ownAllowedAddresses?: string[];
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
  payload: {
    receiverId: string;
    methodName: string;
    args: Record<string, unknown>;
    gasTgas?: number;
    depositYocto?: string;
    summary?: string;
  };
  cli: string;
};

/**
 * ONE TRANSACTION. Not one row, not one field.
 *
 * This is the distinction the previous page got wrong, and it was the real
 * defect behind the layout complaints. `daily_cap` and `per_tx_cap` are two
 * arguments of a SINGLE `set_node_caps` call, but the page gave each its own
 * row with its own "Prepare change" button. Edit both, press either button,
 * and the other edit shipped too — silently, under a label naming only one of
 * them. Verified against the live adapter: posting dailyCap 150 with perTxCap
 * 99 returns one payload carrying both.
 *
 * Grouping changes by the call that applies them makes the page honest: you
 * see two edits collapse into one transaction, because that is what the
 * contract does.
 */
type ChangeGroup = "caps" | "cooldown" | "recipients";

type Change = {
  group: ChangeGroup;
  label: string;
  from: string;
  to: string;
};

const GROUP_TITLE: Record<ChangeGroup, string> = {
  caps: "Spending limits",
  cooldown: "Payment pacing",
  recipients: "Payee allowlist",
};

/** A prepared transaction, with the human diff that produced it. */
type PreparedTx = {
  plan: OwnerPlan;
  title: string;
  lines: Change[];
  /**
   * What the chain should look like once this is signed.
   *
   * Declarative rather than a closure so the comparison stays a pure,
   * tested function - see lib/applied.ts.
   */
  expect: Expectation;
};

/** Node id out of the adapter's agentId, which is `node-<id>` or an account. */
function nodeIdOf(a: ApiAgent, all: ApiAgent[]): number {
  const m = /^node-(\d+)$/.exec(a.agentId);
  if (m) return Number(m[1]);
  return all.indexOf(a);
}

function splitList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export default function Policies() {
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Draft values. They do NOT pretend to be saved state.
  const [dailyCap, setDailyCap] = useState("");
  const [perTxCap, setPerTxCap] = useState("");
  const [cooldown, setCooldown] = useState(0);
  // Whether the Custom option is chosen. NOT derivable from the seconds:
  // 60 is both a preset and a plausible typed value, so the number alone
  // cannot say which the user picked.
  const [cooldownCustom, setCooldownCustom] = useState(false);
  // One address per line. Empty means INHERIT (null), never an empty list —
  // `validate_recipients` panics on `[]` with "1..=32 recipients, or None".
  const [recipients, setRecipients] = useState("");

  const [txs, setTxs] = useState<PreparedTx[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const { toast, setToast } = useToast();

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

  /** What the chain holds right now, for this agent. */
  const base = useMemo(
    () => ({
      daily: selected?.policy?.dailyBudget ?? "",
      perTx: selected?.policy?.perTxLimit ?? "",
      cooldown: selected?.policy?.cooldownSeconds ?? 0,
      ownRecipients: selected?.policy?.ownAllowedAddresses ?? [],
    }),
    [selected],
  );

  const resetDrafts = useCallback(() => {
    setDailyCap(base.daily);
    setPerTxCap(base.perTx);
    setCooldown(base.cooldown);
    setCooldownCustom(initialCustomMode(base.cooldown));
    // SEED FROM THE NODE'S OWN LIST, never the effective one.
    //
    // Seeding from `allowedAddresses` would prefill an inheriting node's form
    // with its PARENT's addresses. Saving would then write them onto the child
    // — detaching it from the parent permanently — while looking like it
    // changed nothing at all.
    setRecipients(base.ownRecipients.join("\n"));
  }, [base]);

  /**
   * Seed ONLY when the selected agent changes.
   *
   * Without the ref this effect also fires whenever `agents` is refetched,
   * because `base` is derived from it - which silently discarded pending
   * edits on every refresh.
   */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || seededFor.current === selectedId) return;
    seededFor.current = selectedId;
    resetDrafts();
  }, [selectedId, selected, resetDrafts]);

  /** The explicit throw-away: drafts AND the prepared panel. */
  const discardDrafts = useCallback(() => {
    resetDrafts();
    setTxs([]);
    setPlanError(null);
    // Clearing txs stops the watcher by itself: the hook restarts from
    // the transaction count, and zero means idle.
  }, [resetDrafts]);

  const recipientList = useMemo(() => splitList(recipients), [recipients]);

  /**
   * The master budget's daily cap, which every other cap is a slice of.
   *
   * Node 0 is the root by the contract's own ROOT_NODE constant, so this is a
   * fact rather than an inference — unlike "who is this node's parent", which
   * would need the tree path the dashboard API does not expose. A share of
   * the MASTER is well-defined at any depth, and it is the question an owner
   * actually has: how much of the treasury can this thing reach?
   */
  const rootCap = useMemo(() => {
    const root = agents.find((a) => nodeIdOf(a, agents) === 0);
    const n = Number(root?.policy?.dailyBudget ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [agents]);

  const shareOfMaster = useCallback(
    (a: ApiAgent): number | null => {
      if (!rootCap) return null;
      const n = Number(a.policy?.dailyBudget ?? 0);
      if (!Number.isFinite(n) || n <= 0) return null;
      return Math.min(100, (n / rootCap) * 100);
    },
    [rootCap],
  );

  /** Every pending edit, grouped by the contract call that applies it. */
  const changes = useMemo<Change[]>(() => {
    if (!selected) return [];
    const out: Change[] = [];
    if (dailyCap !== base.daily) {
      out.push({
        group: "caps",
        label: "Daily limit",
        from: base.daily ? `${base.daily} USDC` : "unset",
        to: `${dailyCap || "0"} USDC`,
      });
    }
    if (perTxCap !== base.perTx) {
      out.push({
        group: "caps",
        label: "Per payment",
        from: base.perTx ? `${base.perTx} USDC` : "unset",
        to: `${perTxCap || "0"} USDC`,
      });
    }
    if (cooldown !== base.cooldown) {
      out.push({
        group: "cooldown",
        label: "Cooldown",
        from: cooldownLabel(base.cooldown),
        to: cooldownLabel(cooldown),
      });
    }
    if (recipientList.join("\n") !== base.ownRecipients.join("\n")) {
      out.push({
        group: "recipients",
        label: "Who this agent may pay",
        from: base.ownRecipients.length
          ? base.ownRecipients.join(", ")
          : "inherited from above",
        to: recipientList.length ? recipientList.join(", ") : "inherit from above",
      });
    }
    return out;
  }, [selected, base, dailyCap, perTxCap, cooldown, recipientList]);

  const groups = useMemo(
    () => [...new Set(changes.map((c) => c.group))] as ChangeGroup[],
    [changes],
  );

  /**
   * The contract's OWN rules, checked here so a doomed transaction is never
   * built, signed, and paid for.
   *
   * Transcribed from `validate_limits` and `set_node_caps` in
   * contracts/vault/src/lib.rs — not from intuition. The first draft of this
   * function got it materially wrong: it called `per_tx > daily` a soft
   * warning that "can never bind", on the assumption the contract would shrug
   * and let the daily cap stop the payment first. It does not. Line 2310
   * fails outright with `per_tx_cap must be <= daily_cap`, so the owner would
   * have approved a transaction in their wallet, paid gas, and watched it
   * revert.
   *
   * The allocation rules are only checked where they can be checked HONESTLY.
   * Depth 1 implies the parent is root, so a sibling sum is exact there; at
   * greater depth the page does not know the parent and says nothing rather
   * than guessing.
   */
  const issues = useMemo(() => {
    const errs: string[] = [];
    const warns: string[] = [];
    const d = Number(dailyCap);
    const p = Number(perTxCap);
    const capsTouched = dailyCap !== base.daily || perTxCap !== base.perTx;

    if (capsTouched) {
      // validate_limits, line 2307: caps must be positive.
      if (!Number.isFinite(d) || d <= 0) {
        errs.push("Daily limit must be greater than zero - the contract rejects a zero cap.");
      }
      if (!Number.isFinite(p) || p <= 0) {
        errs.push("Per payment must be greater than zero - the contract rejects a zero cap.");
      }
      // validate_limits, line 2310: per_tx_cap <= daily_cap.
      if (Number.isFinite(d) && Number.isFinite(p) && d > 0 && p > 0 && p > d) {
        errs.push(
          `Per payment (${perTxCap}) cannot exceed the daily limit (${dailyCap}). The contract refuses this outright: "per_tx_cap must be <= daily_cap".`,
        );
      }
    }

    // set_node_caps allocation rules, only under strict_allocation.
    if (capsTouched && info?.strictAllocation && selected && Number.isFinite(d) && d > 0) {
      const depth = (selected.depth ?? 0);
      const capOf = (a: ApiAgent) => Number(a.policy?.dailyBudget ?? 0) || 0;
      const childrenOfRoot = agents.filter((a) => (a.depth ?? 0) === 1);

      if (depth === 0) {
        // "cap is below the sum already allocated to children" (line 855).
        const allocated = childrenOfRoot.reduce((s, a) => s + capOf(a), 0);
        if (d < allocated) {
          errs.push(
            `Strict allocation is on, and ${allocated} is already allocated to agents beneath the master. A master cap of ${dailyCap} is below that, which the contract rejects.`,
          );
        }
      } else if (depth === 1 && rootCap > 0) {
        // "sum of child caps would exceed the parent cap" (line 876).
        const others = childrenOfRoot
          .filter((a) => a.agentId !== selected.agentId)
          .reduce((s, a) => s + capOf(a), 0);
        if (others + d > rootCap) {
          errs.push(
            `Strict allocation is on. ${others} is allocated to the other agents, so ${dailyCap} here would take the total to ${
              others + d
            }, above the master's ${rootCap}. The contract rejects this.`,
          );
        }
      }
    }

    const dupes = recipientList.filter((l, i) => recipientList.indexOf(l) !== i);
    if (dupes.length) errs.push(`Duplicate payee: ${dupes[0]}`);
    if (info?.vaultId && recipientList.includes(info.vaultId)) errs.push("A vault cannot pay itself.");
    if (recipientList.length > 32) errs.push("At most 32 payees - the contract rejects more.");
    return { errs, warns };
  }, [dailyCap, perTxCap, base, recipientList, info, selected, agents, rootCap]);

  const postPlan = useCallback(
    async (action: string, extra: Record<string, unknown>) => {
      const res = await fetch(`${API_BASE_URL}/v1/owner-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          nodeId: selected ? nodeIdOf(selected, agents) : 0,
          dailyCap,
          perTxCap,
          cooldownSec: cooldown,
          ...extra,
        }),
      });
      const body = (await res.json()) as OwnerPlan & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    },
    [selected, agents, dailyCap, perTxCap, cooldown],
  );

  /** Turn every pending change into the transactions that apply them. */
  const review = useCallback(async () => {
    if (!selected || !groups.length) return;
    setPreparing(true);
    setPlanError(null);
    setTxs([]);
    try {
      const built: PreparedTx[] = [];
      for (const g of groups) {
        const extra =
          g === "recipients"
            ? // `null` means INHERIT. An empty array panics the contract.
              { recipients: recipientList.length ? recipientList : null }
            : {};
        const nodeId = nodeIdOf(selected, agents);
        const expectation: Expectation =
          g === "caps"
            ? { kind: "caps", nodeId, daily: dailyCap, perTx: perTxCap }
            : g === "cooldown"
              ? { kind: "cooldown", nodeId, seconds: cooldown }
              : { kind: "recipients", nodeId, list: recipientList };
        built.push({
          plan: await postPlan(g, extra),
          title: GROUP_TITLE[g],
          lines: changes.filter((c) => c.group === g),
          expect: expectation,
        });
      }
      setTxs(built);
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : "Could not prepare the transaction.");
    } finally {
      setPreparing(false);
    }
  }, [selected, agents, groups, changes, recipientList, dailyCap, perTxCap, cooldown, postPlan]);

  /**
   * A switch, not an edit: freeze, pause, allocation.
   *
   * These carry no draft because pressing the button IS the whole intent —
   * there is no half-typed state to accumulate — so they go straight to a
   * prepared transaction.
   */
  const runSwitch = useCallback(
    async (
      action: string,
      extra: Record<string, unknown>,
      title: string,
      line: Change,
      expectation: Expectation,
    ) => {
      setPreparing(true);
      setPlanError(null);
      setTxs([]);
      try {
        setTxs([{ plan: await postPlan(action, extra), title, lines: [line], expect: expectation }]);
      } catch (e) {
        setPlanError(e instanceof Error ? e.message : "Could not prepare the transaction.");
      } finally {
        setPreparing(false);
      }
    },
    [postPlan],
  );

  /**
   * Re-read the chain and see whether what was signed is actually there.
   *
   * Without this the page would keep showing the pre-signing numbers after a
   * successful change, and would look identical after a FAILED one - the
   * owner had no way to tell the two apart short of a manual reload.
   *
   * It reuses load(), so a success also refreshes the displayed values.
   */
  /** The agent list in the shape lib/applied.ts compares against. */
  const snapshots = useMemo<PolicySnapshot[]>(
    () =>
      agents.map((a) => ({
        nodeId: nodeIdOf(a, agents),
        dailyBudget: a.policy?.dailyBudget,
        perTxLimit: a.policy?.perTxLimit,
        cooldownSeconds: a.policy?.cooldownSeconds,
        ownAllowedAddresses: a.policy?.ownAllowedAddresses,
        frozen: a.status === "killed",
      })),
    [agents],
  );

  /** Everything prepared is now visible on chain. */
  const allApplied = useMemo(
    () =>
      txs.length > 0 &&
      txs.every((t) => appliedStatus(t.expect, snapshots, info) === "applied"),
    [txs, snapshots, info],
  );

  const { phase: watchPhase } = useChainWatch({
    txCount: txs.length,
    allApplied,
    refresh: load,
    onApplied: setToast,
  });

  // The toast says its piece and leaves, taking the finished panel with it.
  // Keyed on the toast because that state is stable for its whole lifetime -
  // unlike the watcher's, which changes the instant a change is detected.
  useEffect(() => {
    if (!toast) return;
    const clearPanel = setTimeout(() => setTxs([]), 1400);
    const hide = setTimeout(() => setToast(null), 6000);
    return () => {
      clearTimeout(clearPanel);
      clearTimeout(hide);
    };
  }, [toast]);


  /** Switching agents would silently discard drafts, so ask first. */
  const selectAgent = useCallback(
    (id: string) => {
      if (
        changes.length > 0 &&
        !window.confirm(
          `You have ${changes.length} unsaved change${changes.length === 1 ? "" : "s"} to ${
            selected ? (selected.displayName ?? selected.agentId) : "this agent"
          }. Switching agents discards ${changes.length === 1 ? "it" : "them"}. Continue?`,
        )
      ) {
        return;
      }
      setSelectedId(id);
    },
    [changes.length, selected],
  );

  return (
    <div className="min-h-screen bg-canvas px-6 py-8 md:px-10">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">Policies</h1>
            <p className="mt-1 text-[13px] text-muted">
              Checked on every payment, at every level, before any money moves.
            </p>
          </div>
          <p className="max-w-[20rem] text-[11.5px] leading-5 text-faint">
            This dashboard holds no key that can change a limit. Edits here produce a transaction
            for the owner to sign.
          </p>
        </div>

        {loading ? (
          <div className="rounded-xl border border-line bg-card px-5 py-10 text-center text-[13px] text-muted">
            Loading policies...
          </div>
        ) : error ? (
          <div
            className="rounded-xl border border-line bg-card px-5 py-10 text-center text-[13px]"
            style={{ color: DANGER }}
          >
            {error}
          </div>
        ) : agents.length === 0 ? (
          <div className="rounded-xl border border-line bg-card px-5 py-10 text-center text-[13px] text-muted">
            This vault has no spending levels yet. The owner creates them.
          </div>
        ) : (
          <>
            {/* THE VAULT-WIDE SWITCHES, as a pair of tiles.
                A different SHAPE from the rows below, because these are not
                more rows of the same list: either one overrides every
                per-agent limit on the page. */}
            <div className="mb-6 grid gap-3 sm:grid-cols-2">
              <SwitchTile
                label="Payments"
                state={info?.paused ? "Paused" : "Running"}
                tone={info?.paused ? "stop" : "go"}
                body={
                  info?.paused
                    ? "Every payment is refused, whatever the limits say."
                    : "Payments go through if they pass the limits."
                }
                actionLabel={info?.paused ? "Resume" : "Pause all"}
                actionTone={info?.paused ? "go" : "stop"}
                onAction={() =>
                  void runSwitch(
                    "pause",
                    { paused: !info?.paused },
                    "Vault payments",
                    {
                      group: "caps",
                      label: "Payments",
                      from: info?.paused ? "Paused" : "Running",
                      to: info?.paused ? "Running" : "Paused",
                    },
                    { kind: "paused", value: !info?.paused },
                  )
                }
              />
              <SwitchTile
                label="Allocation"
                state={info?.strictAllocation ? "Strict" : "Overcommit"}
                tone="neutral"
                body={
                  info?.strictAllocation
                    ? "An agent can never hold more than the pool above it."
                    : "Agents may share a pool they could together overdraw."
                }
                actionLabel={info?.strictAllocation ? "Allow overcommit" : "Require strict"}
                actionTone="plain"
                onAction={() =>
                  void runSwitch(
                    "allocation",
                    { strict: !info?.strictAllocation },
                    "Vault allocation",
                    {
                      group: "caps",
                      label: "Allocation",
                      from: info?.strictAllocation ? "Strict" : "Overcommit",
                      to: info?.strictAllocation ? "Overcommit" : "Strict",
                    },
                    { kind: "strict", value: !info?.strictAllocation },
                  )
                }
              />
            </div>

            {/* A DROPDOWN THAT KEEPS THE TREE.
                The rail showed nesting but spent 15rem of every viewport on
                two agents. This collapses to one line and, when open, renders
                the same indented tree with each agent's cap and its share of
                the master - so the containment is still visible, just not
                permanently in the way. */}
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                Agent
              </span>
              <AgentPicker
                agents={agents}
                selectedId={selectedId}
                onSelect={selectAgent}
                shareOfMaster={shareOfMaster}
                dirtyCount={changes.length}
              />
            </div>

            <div className="overflow-hidden rounded-xl border border-line bg-card shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
              <div>
                <div>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-line px-5 py-3">
                    <h2 className="text-[14px] font-semibold text-ink">
                      {selected ? (selected.displayName ?? selected.agentId) : "-"}
                    </h2>
                    <span className="text-[11.5px] text-faint">
                      {selected && nodeIdOf(selected, agents) === 0
                        ? "the master budget - every agent spends inside it"
                        : "a sub-budget inside the master"}
                    </span>
                  </div>

                  <PolicyRow
                    label="Daily limit"
                    hint="Everything this agent and its sub-budgets spend in a day."
                    changed={dailyCap !== base.daily}
                    context={
                      // Only for a child: saying "100% of the master" on the
                      // master itself is noise, not context.
                      selected && nodeIdOf(selected, agents) !== 0 && rootCap > 0
                        ? `${Math.round((Number(dailyCap || 0) / rootCap) * 100)}% of the master's ${rootCap}`
                        : undefined
                    }
                  >
                    <NumInput value={dailyCap} onChange={setDailyCap} unit="USDC" />
                  </PolicyRow>

                  <PolicyRow
                    label="Per payment"
                    hint="Largest single payment."
                    changed={perTxCap !== base.perTx}
                  >
                    <NumInput value={perTxCap} onChange={setPerTxCap} unit="USDC" />
                  </PolicyRow>

                  <PolicyRow
                    label="Cooldown"
                    hint="Minimum gap between payments."
                    changed={cooldown !== base.cooldown}
                  >
                    <Select
                      value={cooldownSelectValue(cooldown, cooldownCustom)}
                      onChange={(v) => {
                        const next = applyCooldownSelection(v, cooldown);
                        setCooldown(next.seconds);
                        setCooldownCustom(next.customMode);
                      }}
                    >
                      {COOLDOWN_PRESETS.map((c) => (
                        <option key={c.v} value={c.v}>
                          {c.label}
                        </option>
                      ))}
                      <option value={CUSTOM}>Custom</option>
                    </Select>
                    {showsCustomInput(cooldown, cooldownCustom) && (
                      <NumInput
                        value={String(cooldown)}
                        onChange={(v) => setCooldown(parseCooldownInput(v))}
                        unit="sec"
                        size="sm"
                      />
                    )}
                  </PolicyRow>

                  <PolicyRow
                    label="Status"
                    hint="A freeze here, or anywhere above, blocks every payment."
                    changed={false}
                  >
                    <ActionButton
                      tone={selected?.status === "killed" ? "go" : "stop"}
                      onClick={() =>
                        void runSwitch(
                          "freeze",
                          { frozen: selected?.status !== "killed" },
                          "Agent status",
                          {
                            group: "caps",
                            label: "Status",
                            from: selected?.status === "killed" ? "Frozen" : "Active",
                            to: selected?.status === "killed" ? "Active" : "Frozen",
                          },
                          {
                            kind: "frozen",
                            nodeId: selected ? nodeIdOf(selected, agents) : 0,
                            value: selected?.status !== "killed",
                          },
                        )
                      }
                    >
                      {selected?.status === "killed" ? "Unfreeze" : "Freeze"}
                    </ActionButton>
                  </PolicyRow>

                  {(() => {
                    const own = base.ownRecipients;
                    const effective = selected?.policy?.allowedAddresses ?? [];
                    const inheriting = !own.length;
                    const changed = recipientList.join("\n") !== own.join("\n");
                    return (
                      <div className="px-5 py-4">
                        <div className="flex flex-wrap items-baseline justify-between gap-3">
                          <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                            {changed && <ChangeDot />}
                            Who this agent may pay
                          </p>
                          <span className="text-[11px] text-faint">
                            {recipientList.length}/32
                          </span>
                        </div>

                        <div className="mt-2 flex items-start gap-2 rounded-lg bg-chip px-3 py-2">
                          <span className="shrink-0 text-[11px] text-muted">
                            {inheriting ? "Inherited" : "Enforced"}
                          </span>
                          <span className="break-all font-mono text-[11.5px] text-ink">
                            {effective.length
                              ? effective.join(", ")
                              : "nobody; every payment is refused"}
                          </span>
                        </div>

                        {inheriting && (
                          <p className="mt-2 text-[11px] leading-5" style={{ color: WARN }}>
                            Saving a list here <strong>replaces</strong> the inherited one for this
                            agent rather than adding to it, and later changes above will stop
                            reaching it.
                          </p>
                        )}

                        <textarea
                          value={recipients}
                          onChange={(e) => setRecipients(e.target.value)}
                          rows={3}
                          spellCheck={false}
                          placeholder={"one account per line\nempty = inherit from above"}
                          className="mt-2.5 w-full rounded-lg border border-line bg-card px-3 py-2 font-mono text-[12px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ink/10"
                        />
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>

            {issues.warns.map((w) => (
              <p
                key={w}
                className="mt-3 rounded-lg px-3 py-2 text-[12px] leading-5"
                style={{ background: WARN_BG, color: WARN }}
              >
                {w}
              </p>
            ))}
            {issues.errs.map((e) => (
              <p
                key={e}
                className="mt-3 rounded-lg px-3 py-2 text-[12px] leading-5"
                style={{ background: DANGER_BG, color: DANGER }}
              >
                {e}
              </p>
            ))}
            {planError && (
              <p className="mt-3 text-[12px]" style={{ color: DANGER }}>
                {planError}
              </p>
            )}

            {/* ONE BAR FOR ALL PENDING EDITS.
                Replaces a "Prepare change" button per row. Those buttons
                implied each row committed alone, while the caps rows in fact
                shared a single transaction — so pressing one shipped the
                other's edit under a label that named neither. */}
            {changes.length > 0 && txs.length === 0 && (
              <div className="sticky bottom-4 z-20 mt-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-card px-4 py-3 shadow-[0_8px_28px_rgba(17,17,17,0.10)]">
                  <div className="min-w-0 text-[12.5px] leading-5 text-ink">
                    <strong>{changes.length}</strong> unsaved change
                    {changes.length === 1 ? "" : "s"} to{" "}
                    <strong>{selected ? (selected.displayName ?? selected.agentId) : ""}</strong>
                    <span className="text-faint">
                      {" "}
                      - {groups.length} transaction{groups.length === 1 ? "" : "s"} to sign
                    </span>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <button
                      onClick={discardDrafts}
                      className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-ink"
                    >
                      Discard
                    </button>
                    <button
                      onClick={() => void review()}
                      disabled={preparing || issues.errs.length > 0}
                      className="rounded-md bg-ink px-3.5 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                      {preparing ? "Preparing..." : "Review and sign"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* THE CLI STRING IS GONE. Copying a command into a terminal needs
                a full-access key on disk, which is the trade this product
                exists to avoid — and it asked the owner to read an owner
                method out of shell quoting to know what they were approving.
                The link carries the same payload to the signing page, which
                refuses unless get_config().owner matches the connected
                wallet. */}
            {txs.length > 0 && (
              <div className="mt-4 rounded-xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Ready to sign - {txs.length} transaction{txs.length === 1 ? "" : "s"}
                  </p>
                  <button
                    onClick={() => setTxs([])}
                    className="text-[11.5px] text-muted hover:text-ink"
                  >
                    Back to editing
                  </button>
                </div>

                <div className="mt-3 space-y-3">
                  {txs.map((t, i) => (
                    <div key={i} className="rounded-lg border border-line p-3">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <p className="text-[13px] font-semibold text-ink">
                          {txs.length > 1 ? `${i + 1}. ` : ""}
                          {t.title}
                        </p>
                        <span className="font-mono text-[10.5px] text-faint">
                          {t.plan.payload.methodName}
                        </span>
                      </div>

                      {/* A HUMAN DIFF, not the raw args blob. `{"node_id":1,
                          "limits":[{"token":"usdc.fakes.testnet","daily_cap":
                          "150000000"...}]}` asks the owner to divide by 10^6
                          in their head to check what they are approving. */}
                      <dl className="mt-2 space-y-1">
                        {t.lines.map((l) => (
                          <div key={l.label} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                            <dt className="text-muted">{l.label}</dt>
                            <dd className="flex items-baseline gap-1.5">
                              <span className="text-faint line-through">{l.from}</span>
                              <span className="text-faint">{"->"}</span>
                              <span className="font-medium text-ink">{l.to}</span>
                            </dd>
                          </div>
                        ))}
                      </dl>

                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] text-faint hover:text-muted">
                          Exact arguments
                        </summary>
                        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-chip p-2.5 font-mono text-[10.5px] leading-5 text-muted">
                          {JSON.stringify(t.plan.payload.args, null, 2)}
                        </pre>
                      </details>

                      {/* The per-transaction verdict. "not yet" NEVER says
                          failed: a final-finality read taken moments after a
                          write can be a whole transaction behind, so a first
                          miss is far more often lag than a lost change. */}
                      {(appliedStatus(t.expect, snapshots, info) === "applied" || watchPhase === "gave-up") &&
                        (appliedStatus(t.expect, snapshots, info) === "applied" ? (
                          <p
                            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium"
                            style={{ background: SUCCESS_BG, color: SUCCESS }}
                          >
                            <Check size={12} />
                            Applied - the chain now reports these values
                          </p>
                        ) : (
                          <p
                            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium"
                            style={{ background: WARN_BG, color: WARN }}
                          >
                            Not visible yet - sign it, then check again. Reads can lag a
                            write by a few seconds.
                          </p>
                        ))}

                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <a
                          href={signLink(t.plan.payload, info?.network ?? "testnet")}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3.5 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                        >
                          Sign in wallet
                          <ExternalLink size={12} />
                        </a>
                        <button
                          onClick={() => {
                            void navigator.clipboard.writeText(
                              signLink(t.plan.payload, info?.network ?? "testnet"),
                            );
                            setCopiedIdx(i);
                            setTimeout(() => setCopiedIdx(null), 2000);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-2 text-[11px] font-medium text-ink transition-colors hover:bg-chip"
                        >
                          {copiedIdx === i ? <Check size={11} /> : <Copy size={11} />}
                          {copiedIdx === i ? "Copied" : "Copy link"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
                  <WatchStatus phase={watchPhase} />
                  <p className="text-[11px] leading-5 text-faint">
                    {txs.length > 1
                      ? "Each is a separate transaction and needs its own signature. "
                      : ""}
                    The signing page checks the wallet you connect owns this vault.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

/**
 * The agent selector: a listbox that renders the budget TREE.
 *
 * Not a native <select>. An <option> holds text only, so depth would have to
 * be faked with padding characters - the invisible-character trap this
 * codebase has been bitten by repeatedly - and neither the per-agent cap nor
 * its share of the master could be shown beside the name.
 *
 * Indentation is real padding derived from the node's `depth` field, which
 * the adapter sends as a number - so nothing here depends on an invisible
 * character surviving a round trip.
 */
function AgentPicker({
  agents,
  selectedId,
  onSelect,
  shareOfMaster,
  dirtyCount,
}: {
  agents: ApiAgent[];
  selectedId: string;
  onSelect: (id: string) => void;
  shareOfMaster: (a: ApiAgent) => number | null;
  dirtyCount: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sel = agents.find((x) => x.agentId === selectedId) ?? null;
  const selDepth = sel ? (sel.depth ?? 0) : 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-[34px] min-w-[11rem] items-center gap-2 rounded-lg border border-line bg-card pl-3 pr-2.5 text-left shadow-[0_1px_2px_rgba(17,17,17,0.04)] transition-colors hover:border-ink/25 focus:outline-none focus:ring-2 focus:ring-ink/10"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-ink">
              {sel ? (sel.displayName ?? sel.agentId) : "-"}
            </span>
            {sel?.status === "killed" && (
              <span
                className="shrink-0 rounded-full px-1.5 text-[9px] font-semibold uppercase tracking-wider"
                style={{ background: DANGER_BG, color: DANGER }}
              >
                Frozen
              </span>
            )}
            {dirtyCount > 0 && (
              <span
                title={`${dirtyCount} unsaved`}
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: WARN }}
              />
            )}
        </span>
        <ChevronDown size={14} aria-hidden className="shrink-0 text-muted" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+6px)] z-30 w-[21rem] overflow-hidden rounded-lg border border-line bg-card"
          style={{ boxShadow: "0 18px 44px rgba(17, 17, 17, 0.12)" }}
        >
          {agents.map((a) => {
            const isSel = a.agentId === selectedId;
            const d = (a.depth ?? 0);
            const pct = shareOfMaster(a);
            return (
              <button
                key={a.agentId}
                type="button"
                role="option"
                aria-selected={isSel}
                onClick={() => {
                  onSelect(a.agentId);
                  setOpen(false);
                }}
                className={`block w-full border-b border-line py-2 pr-3 text-left last:border-b-0 transition-colors ${
                  isSel ? "bg-chip" : "hover:bg-chip/60"
                }`}
                style={{ paddingLeft: `${0.75 + d * 0.9}rem` }}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={`truncate text-[13px] ${isSel ? "font-semibold text-ink" : "font-medium text-ink"}`}
                  >
                    {(a.displayName ?? a.agentId)}
                  </span>
                  {a.status === "killed" && (
                    <span
                      className="shrink-0 rounded-full px-1.5 text-[9px] font-semibold uppercase tracking-wider"
                      style={{ background: DANGER_BG, color: DANGER }}
                    >
                      Frozen
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-baseline gap-1">
                    <span className="text-[13px] font-semibold tabular-nums tracking-[-0.02em] text-ink">
                      {a.policy?.dailyBudget ?? "-"}
                    </span>
                    <span className="text-[10px] text-faint">/ day</span>
                  </span>
                  {isSel && <Check size={12} className="shrink-0 text-muted" />}
                </span>

                {/* CONTAINMENT, not two bare numbers. "100" and "25" side by
                    side say nothing about the 25 being spent OUT OF the 100 -
                    on a page whose whole subject is nested budgets. */}
                {pct !== null && (
                  <span
                    aria-hidden
                    className="mt-1.5 block h-[3px] w-full overflow-hidden rounded-full bg-chip"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${pct}%`, background: isSel ? INK : "#C9C7C3" }}
                    />
                  </span>
                )}
              </button>
            );
          })}
          <p className="bg-canvas px-3 py-2 text-[10px] leading-4 text-faint">
            bar = share of the master budget
          </p>
        </div>
      )}
    </div>
  );
}

/** The marker that a row differs from the chain. */
function ChangeDot() {
  return (
    <span
      aria-label="changed"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: WARN }}
    />
  );
}

/**
 * One vault-wide switch, as a tile.
 *
 * Deliberately a different SHAPE from the policy rows — state on its own line,
 * action on its own line — because these two are not more rows of the same
 * list. Either one overrides every per-agent limit on the page.
 */
function SwitchTile({
  label,
  state,
  tone,
  body,
  actionLabel,
  actionTone,
  onAction,
}: {
  label: string;
  state: string;
  tone: "go" | "stop" | "neutral";
  body: string;
  actionLabel: string;
  actionTone: "stop" | "go" | "plain";
  onAction: () => void;
}) {
  const dot = tone === "go" ? SUCCESS : tone === "stop" ? DANGER : NEUTRAL;
  return (
    // Four stacked lines became two: the state and its action share a row,
    // since the action is simply the state's opposite and reads as one
    // thought. Saves roughly 30px per tile at the very top of the page,
    // where it was pushing the agents further down than the thing they
    // qualify.
    <div className="rounded-xl border border-line bg-card px-4 py-3 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-faint">{label}</p>
          <p className="mt-0.5 flex items-center gap-2 text-[15px] font-semibold text-ink">
            <span
              aria-hidden
              className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
              style={{ background: dot }}
            />
            {state}
          </p>
        </div>
        <ActionButton tone={actionTone} onClick={onAction}>
          {actionLabel}
        </ActionButton>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-5 text-muted">{body}</p>
    </div>
  );
}

/**
 * The button in a policy row's control slot.
 *
 * Pinned to the same 34px as the inputs and selects beside it, so the control
 * slots form one clean right-hand column. `tone` is the only colour decision:
 * red for a control that STOPS money moving, green for one that lets it move
 * again, plain for a change that is neither.
 */
function ActionButton({
  tone,
  onClick,
  children,
}: {
  tone: "stop" | "go" | "plain";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const colour = tone === "stop" ? DANGER : tone === "go" ? SUCCESS : undefined;
  return (
    <button
      onClick={onClick}
      className="inline-flex h-[40px] items-center rounded-md border border-line bg-card px-3.5 text-[12px] font-medium text-ink transition-colors hover:bg-chip"
      style={colour ? { color: colour } : undefined}
    >
      {children}
    </button>
  );
}

/**
 * A select that matches the rest of the page.
 *
 * A bare `<select>` draws the operating system's own chevron at the OS's own
 * size and colour, so it sat a different height from the number inputs beside
 * it and in a grey nothing else uses. `pointer-events-none` on the icon
 * matters: without it a click on the chevron — the obvious place to click —
 * lands on the icon and does nothing.
 */
function Select({
  id,
  value,
  onChange,
  children,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative inline-flex">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[40px] appearance-none rounded-lg border border-line bg-card pl-3 pr-8 text-[13px] font-medium text-ink shadow-[0_1px_2px_rgba(17,17,17,0.04)] transition-colors hover:border-ink/25 focus:outline-none focus:ring-2 focus:ring-ink/10"
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
    </div>
  );
}

/**
 * One policy: its name, and its current value as an input.
 *
 * No per-row action button. The caps rows map to a single `set_node_caps`
 * call, so a button on each implied a commit granularity the contract does
 * not have. Rows mark themselves changed; the page commits.
 */
function PolicyRow({
  label,
  hint,
  changed,
  context,
  children,
}: {
  label: string;
  hint: string;
  changed: boolean;
  /** A fact about this value's place in the tree, shown under the control. */
  context?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-line px-5 py-3.5 last:border-b-0">
      {/* `flex-1 basis-0` on the text, not just `min-w-0`: without it the text
          block sizes to its CONTENT, so a long hint pushed the control slot
          onto a second line and broke the right-hand column. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-[14rem] flex-1 basis-0">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
            {changed && <ChangeDot />}
            {label}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-5 text-muted">{hint}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-2">{children}</div>
          {context ? (
            <span className="text-[10.5px] leading-4 text-faint">{context}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A number the page is ABOUT, sized like it.
 *
 * Measured on the previous version: eleven distinct font sizes, and 38 of 44
 * declarations between 9px and 13px. The caps — the only values on the page a
 * reader came to check — rendered at 13px, the same size as their own labels
 * and their own help text. With nothing larger than anything else there is no
 * focal point, which is the whole of why it read as flat.
 *
 * `size="lg"` is for the amounts; `sm` stays for the custom-seconds box,
 * which is an escape hatch rather than a headline.
 */
function NumInput({
  value,
  onChange,
  unit,
  size = "lg",
}: {
  value: string;
  onChange: (v: string) => void;
  unit: string;
  size?: "lg" | "sm";
}) {
  const lg = size === "lg";
  return (
    <div
      className={`flex items-baseline gap-1.5 rounded-lg border border-line bg-card focus-within:ring-2 focus-within:ring-ink/10 ${
        lg ? "px-3 py-1" : "px-2.5 py-1.5"
      }`}
    >
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`bg-transparent text-right tabular-nums text-ink focus:outline-none ${
          lg ? "w-[5rem] text-[20px] font-semibold tracking-[-0.02em]" : "w-16 text-[13px]"
        }`}
      />
      <span className={`text-muted ${lg ? "text-[11.5px] font-medium" : "text-[11.5px]"}`}>
        {unit}
      </span>
    </div>
  );
}
