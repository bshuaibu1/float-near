"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { utilisation } from "@/lib/utilisation";
import Link from "next/link";
import { Check, Copy, ExternalLink } from "lucide-react";
import AgentAvatar from "@/components/smoothui/agent-avatar";
import { signLink, type OwnerPayload } from "@/lib/sign-link";
import { floatFetch } from "@/lib/float-fetch";
import { appliedStatus, type Expectation, type PolicySnapshot } from "@/lib/applied";
import { useChainWatch, useToast } from "@/lib/use-chain-watch";
import { Toast, WatchStatus } from "@/components/toast";
import { DANGER, DANGER_BG, SUCCESS, SUCCESS_BG, WARN, WARN_BG } from "@/lib/colors";
import { InfoDot } from "@/components/ui/info-dot";
import { agentHue, agentSeed } from "@/lib/agent-hue";
import { BindAgent } from "@/components/bind-agent";
import { treeConnectors, treeOrderHolds, type TreeConnector } from "@/lib/tree-connectors";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";

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
 * method (`freeze_node`). It is never signed here - this dashboard can only
 * ever hold an agent key - so it produces a LINK to the signing page, which
 * holds the wallet connection and refuses unless get_config().owner matches.
 *
 * It used to print a near-cli command instead. That instruction ended in
 * `sign-with-keychain`, so following it required the owner's key on disk;
 * for an owner whose key is in a browser wallet it was simply impossible.
 */
type ApiAgent = {
  agentId: string;
  displayName?: string | null;
  walletAddress: string;
  status: "active" | "killed";
  /** Depth in the budget tree, root 0. A number, not characters. */
  depth?: number;
  /**
   * This node's parent id, or null at root. Supplied by the adapter
   * (packages/float-adapter/src/map.ts) and used here to NAME the parent on the
   * phone layout, where a drawn connector cannot work. `depth` alone says a row
   * sits at level 2 but not WHICH level-1 node it hangs from.
   */
  parent?: number | null;
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
  /**
   * The vault's ACTUAL token balance, base units — not the root node's
   * remaining daily budget, which is a different quantity entirely. The
   * Danger Zone's guard reads this and nothing else. Null when the token
   * contract could not be read, which is NOT zero.
   */
  vaultTokenBalance?: string | null;
  /** The contract's own day counter, for a purge cutoff. Null, never 0. */
  currentDay?: number | null;
  /** Declared because the signing link needs it; the adapter always sent it. */
  network: string;
  /**
   * Both sent by the adapter all along (`owner`, `tokenId` in vault-info) and
   * simply never declared here — which is how the Danger Zone came to build a
   * teardown command without them, letting the script fall back to its
   * author's dev account and the mock FT. A wrong token reads as a zero
   * balance and the delete strands the real one, so these are required rather
   * than optional: the only safe teardown command is a complete one.
   */
  owner: string;
  tokenId: string;
  explorerBase: string;
  paused: boolean;
  strictAllocation: boolean;
};

function nodeIdOf(a: ApiAgent, all: ApiAgent[]): number {
  const m = /^node-(\d+)$/.exec(a.agentId);
  return m ? Number(m[1]) : all.indexOf(a);
}

/**
 * `depthOf` lived here and is gone. It existed only to pick between a
 * "root" and a "team" label on the badge, and that badge is now an avatar.
 * Depth is still visible: the adapter prefixes `displayName` with
 * box-drawing characters and non-breaking spaces, and that is what draws
 * the tree.
 */

export default function AgentsPage() {
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{
    payload: OwnerPayload;
    label: string;
    from: string;
    to: string;
    /**
     * What the chain should show once signed - see lib/applied.ts.
     *
     * OPTIONAL, because two actions have nothing a snapshot can observe. A
     * withdrawal moves a balance on the TOKEN contract and a purge removes
     * records, and `appliedStatus` compares policy fields: neither would
     * ever be seen to apply. Inventing a kind that reports "applied"
     * immediately would announce success before the transaction landed;
     * leaving it absent means the watcher does not run, which is the honest
     * answer to "can this be confirmed from here".
     */
    expect?: Expectation;
  } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [dashRes, infoRes] = await Promise.all([
        floatFetch(`/v1/dashboard`, { cache: "no-store" }),
        floatFetch(`/v1/vault-info`, { cache: "no-store" }),
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
        const res = await floatFetch(`/v1/owner-plan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "freeze", nodeId: nodeIdOf(a, agents), frozen }),
        });
        const body = (await res.json()) as {
          payload?: OwnerPayload;
          error?: string;
        };
        if (!res.ok || !body.payload) throw new Error(body.error ?? `HTTP ${res.status}`);
        setPlan({
          payload: body.payload,
          // The label is plain text now: depth travels as a number, so the
          // sentence the owner reads carries no tree characters.
          label: `${frozen ? "Freeze" : "Unfreeze"} ${(a.displayName ?? a.agentId)}`,
          from: frozen ? "Active" : "Frozen",
          to: frozen ? "Frozen" : "Active",
          expect: { kind: "frozen", nodeId: nodeIdOf(a, agents), value: frozen },
        });
        setPlanError(null);
      } catch (e) {
        setPlan(null);
        setPlanError(e instanceof Error ? e.message : "Could not prepare the transaction.");
      }
    },
    [agents],
  );

  /**
   * The two teardown steps a browser signature can actually reach.
   *
   * See lib/teardown.ts for why it is only two: four of the six steps need
   * the VAULT as signer, and one of those is a DeployContract, which wallets
   * refuse from a dApp.
   */
  const buildTeardownStep = useCallback(
    async (body: Record<string, unknown>, label: string, from: string, to: string) => {
      try {
        const res = await floatFetch(`/v1/owner-plan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const b = (await res.json()) as { payload?: OwnerPayload; error?: string };
        if (!res.ok || !b.payload) throw new Error(b.error ?? `HTTP ${res.status}`);
        setPlan({
          payload: b.payload,
          label,
          from,
          to,
          /**
           * NOTHING TO WATCH FOR. `lib/applied.ts` compares a policy
           * snapshot, and neither a withdrawal nor a purge changes one — a
           * balance lives on the token contract and purged records are
           * simply absent. Claiming an expectation the watcher cannot
           * observe would leave it spinning forever on a transaction that
           * had in fact landed.
           */
          // No expectation: see the field's note on the plan state.
        });
        setPlanError(null);
      } catch (e) {
        setPlan(null);
        setPlanError(e instanceof Error ? e.message : "Could not prepare the transaction.");
      }
    },
    [],
  );

  /** The agent list in the shape lib/applied.ts compares against. */
  const snapshots = useMemo<PolicySnapshot[]>(
    () =>
      agents.map((a) => ({
        nodeId: nodeIdOf(a, agents),
        dailyBudget: a.policy?.dailyBudget,
        perTxLimit: a.policy?.perTxLimit,
        cooldownSeconds: a.policy?.cooldownSeconds,
        frozen: a.status === "killed",
      })),
    [agents],
  );

  const allApplied = useMemo(
    () =>
      plan?.expect !== undefined &&
      appliedStatus(plan.expect, snapshots, info ? { paused: info.paused, strictAllocation: info.strictAllocation } : null) ===
        "applied",
    [plan, snapshots, info],
  );

  const { toast, setToast } = useToast();
  const { phase: watchPhase } = useChainWatch({
    // Only watch what can be watched. A plan with no expectation (withdraw,
    // purge) would otherwise leave the watcher spinning on a transaction it
    // has no way to observe.
    txCount: plan?.expect ? 1 : 0,
    allApplied,
    refresh: load,
    onApplied: setToast,
  });

  // Clear the finished panel shortly after the toast, NOT from inside the
  // watcher: on /policies a timer started in the watcher's own effect was
  // cancelled by that effect's cleanup when the watcher changed state.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setPlan(null), 1400);
    return () => clearTimeout(t);
  }, [toast]);

  // Nodes with no resolvable allowlist. Every payment from them is refused, so
  // it is worth surfacing — the inverse of the old "Open x402" warning, which
  // stated the opposite of the truth.
  const noAllowlist = agents.filter((a) => !a.policy?.allowedAddresses?.length);

  // ROOT IS NOT AN AGENT, so it does not belong in a list of them.
  //
  // It is the vault's ceiling: every agent's payment is checked against it on
  // the way up, which is why one agent can be refused because a sibling
  // drained the shared pool. Rendering it as the first row of an agent table
  // made it look like a peer that happened to be listed first, and forced the
  // column header to be vague enough to cover both.
  //
  // Split by NODE ID rather than by depth or by the display prefix: node 0 is
  // root by construction in the contract, and the prefix is a presentation
  // detail the adapter happens to add.
  const root = agents.find((a) => nodeIdOf(a, agents) === 0) ?? null;
  const fleet = agents.filter((a) => nodeIdOf(a, agents) !== 0);

  // CONTAINMENT, not just indentation.
  //
  // Indenting by depth alone was reported as unreadable, and the report was
  // right: `agent / news / headlines` rendered as three peers 18px apart, when
  // `headlines` actually lives INSIDE `news` and every payment it makes is
  // checked against both budgets. That relationship is the product; a table
  // that hides it is describing a different product.
  //
  // `filter` above preserves the adapter's tree order, which is the one thing
  // these connectors depend on. `treeOrderHolds` checks it rather than
  // assuming it — if it ever fails we fall back to bare indentation, because
  // drawing a line to the WRONG parent is worse than drawing no line.
  // The containing budget's NAME, for the phone layout.
  //
  // Resolved through `parent` (a node id) rather than by position, so it is a
  // stated fact rather than an inference — and unlike the table's connector it
  // stays correct even if the rows were ever reordered. Root is excluded
  // deliberately: every top-level agent hangs off root, and "in root" on every
  // card is noise that says nothing the master-budget panel above has not
  // already said.
  const nameByNodeId = new Map(agents.map((a) => [nodeIdOf(a, agents), a.displayName ?? a.agentId]));
  const parentNameOf = (a: ApiAgent): string | null => {
    if ((a.depth ?? 1) < 2 || a.parent == null) return null;
    return nameByNodeId.get(a.parent) ?? null;
  };

  const fleetDepths = fleet.map((a) => a.depth ?? 1);
  const connectors = useMemo(
    () => (treeOrderHolds(fleetDepths) ? treeConnectors(fleetDepths) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fleetDepths.join(",")],
  );
  // Computed from the RAW spend and cap: the API rounds its percentage to an
  // integer, so a real 0.02-against-25 payment arrives as 0 and the master bar
  // renders empty beside a line saying 0.02 was spent. See lib/utilisation.ts.
  const rootUse = utilisation(root?.dailySpent, root?.policy?.dailyBudget, root?.dailyBudgetUsedPercent);
  const rootPct = rootUse.pct;

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <p
          className="text-[11px] font-medium uppercase tracking-widest mb-1 text-muted">
          Agent Console
        </p>
        <h2 className="text-[22px] font-semibold tracking-tight text-ink flex items-center gap-2">
          Budget tree
          <InfoDot label="why agents are not added from this page">
            A key is never GENERATED here. Creating one needs a keypair whose secret
            has to reach whatever runs the agent, and a browser can only put that on a
            screen or hand it to a server — so{" "}
            <code className="rounded px-1 py-0.5 font-mono text-[11.5px] bg-chip">
              vault_add_role
            </code>{" "}
            generates it on your own machine and writes the secret to disk there.
            {" "}
            What this page can do is the owner&apos;s half: paste the PUBLIC key your
            agent printed and it builds the transaction for your wallet. That matters
            for a vault created by following a link, which binds no key at all — before
            this, the only way back was the command line.
          </InfoDot>
        </h2>
        <p className="text-[13px] mt-1.5 max-w-2xl text-muted">
          Every payment is checked at each level, from the agent up to the master budget. An agent
          can be refused because a pool it shares is empty, even when its own limit is untouched.
        </p>
      </div>

      {loading ? (
        <Panel>Loading the tree...</Panel>
      ) : error ? (
        <Panel tone="error">{error}</Panel>
      ) : agents.length === 0 ? (
        <Panel>
          This vault has no spending levels yet. The owner creates them.
        </Panel>
      ) : (
        <>
          {info?.paused && (
            <div
              className="mb-4 rounded-xl border border-line px-5 py-3 text-[12px]"
              style={{ background: DANGER_BG, color: DANGER }}
            >
              The vault is paused. Every payment is refused right now, whatever the limits say.
            </div>
          )}

          {noAllowlist.length > 0 && (
            <div className="mb-4 rounded-xl border border-line px-5 py-3" style={{ background: WARN_BG }}>
              <p className="text-[13px] font-semibold" style={{ color: "#78350F" }}>
                {noAllowlist.length === 1
                  ? "1 node has no payee allowlist"
                  : `${noAllowlist.length} nodes have no payee allowlist`}
              </p>
              <p className="text-[12px] mt-1" style={{ color: WARN }}>
                {noAllowlist.map((a) => a.displayName ?? a.agentId).join(", ")} — every
                payment from {noAllowlist.length === 1 ? "it is" : "them is"} refused. A level with
                no list of its own uses the nearest one above it, so setting one at the top covers
                everything.{" "}
                <Link href="/policies" className="underline">
                  Open Policies
                </Link>
                .
              </p>
            </div>
          )}

          {/* THE MASTER BUDGET, above the fleet rather than inside it.
              Root is what every agent's payment is finally checked against,
              so it reads as a ceiling, not a peer. */}
          {root && (
            <div className="mb-5 bg-card border border-line rounded-xl shadow-[0_1px_2px_rgba(17,17,17,0.04)] px-6 py-5">
              <div className="flex items-start justify-between gap-6 flex-wrap">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-widest text-muted">
                    Master vault budget
                  </p>
                  <p className="mt-2 text-[28px] font-semibold tracking-tight text-ink tabular-nums">
                    {root.policy?.dailyBudget ?? "—"}
                    <span className="ml-1.5 text-[13px] font-normal text-faint">USDC / day</span>
                  </p>
                  <p className="mt-1 text-[12px] text-muted">
                    Shared by every agent. {root.dailySpent ?? "0"} spent today
                    {root.policy?.perTxLimit ? ` · ${root.policy.perTxLimit} max per payment` : ""}.
                  </p>
                </div>

                <div className="min-w-[12rem] flex-1 max-w-xs">
                  <div className="flex items-center justify-between text-[11px] text-muted mb-1.5">
                    <span>Used today</span>
                    <span className="font-mono tabular-nums">{rootUse.label}</span>
                  </div>
                  <div className="h-2 rounded-full overflow-hidden bg-chip">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${rootUse.barWidth}%`,
                        background: rootPct >= 100 ? DANGER : rootPct >= 75 ? WARN : SUCCESS,
                        transition: "width 400ms ease",
                      }}
                    />
                  </div>
                  <p className="mt-2 text-[11px] text-faint">
                    When this runs out every agent is refused, whatever its own limit says.
                  </p>
                </div>
              </div>
            </div>
          )}

          <p className="mb-2 text-[11px] font-medium uppercase tracking-widest text-muted">
            Active fleet
          </p>

          {fleet.length === 0 ? (
            <Panel>
              No agents yet. Add one and it will draw from the master budget above.
            </Panel>
          ) : (
          /* overflow-x-auto + a min-width on the rows: the fixed columns add
             up to 35rem, so below roughly 600px the 1.5fr name column was
             crushed to zero width and the node labels disappeared entirely
             while still being present in the DOM. Scrolling is the honest
             behaviour; silently hiding the one column that identifies the row
             is not.

             BELOW `md` NONE OF THAT APPLIES, because there is no table: the
             rows render as cards that fit the viewport. `overflow-x-auto`
             stays harmlessly (nothing inside is wider than the container at
             that width), but the `min-w-[55rem]` must not - it is what made
             a row run 538px past a 375px screen. */
          <div className="bg-card border border-line rounded-xl shadow-[0_1px_2px_rgba(17,17,17,0.04)] overflow-x-auto">
            <div
              className="hidden md:grid min-w-[55rem] grid-cols-[minmax(12rem,1.5fr)_7rem_6rem_6rem_9rem_7rem] gap-4 px-6 py-3 text-[11px] font-medium uppercase tracking-wider text-muted border-b border-line bg-canvas"
            >
              <span>Agent</span>
              <span className="text-right">Daily cap</span>
              <span className="text-right">Per payment</span>
              <span className="text-right">Spent today</span>
              <span>Utilisation</span>
              <span className="text-right">State</span>
            </div>

            {fleet.map((a, i) => (
              <FleetRow
                key={a.agentId}
                agent={a}
                // nodeIdOf against the FULL list, not the filtered one: its
                // fallback is `all.indexOf(a)`, so passing `fleet` would shift
                // every id by one once root is removed.
                nodeId={nodeIdOf(a, agents)}
                isLast={i === fleet.length - 1}
                connector={connectors?.[i] ?? null}
                parentName={parentNameOf(a)}
                onToggleFreeze={() => void buildFreeze(a)}
              />
            ))}
          </div>
          )}

          {planError && (
            <p className="mt-4 text-[12px]" style={{ color: DANGER }}>
              {planError}
            </p>
          )}

          {/* A LINK, not a command.
              This panel used to print a near-cli invocation ending in
              `sign-with-keychain`, which reads the local keychain. The owner
              of this vault keeps their key in a browser wallet, so following
              that instruction meant exporting a private key to disk - the
              exact trade this product exists to remove. The link carries the
              same payload to a page that holds the wallet connection and
              refuses unless get_config().owner matches. */}
          {plan && (
            <div className="mt-4 bg-card border border-line rounded-xl shadow-[0_1px_2px_rgba(17,17,17,0.04)] p-4">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p className="text-[13px] font-semibold text-ink">{plan.label}</p>
                <span className="font-mono text-[10.5px] text-faint">
                  {plan.payload.methodName}
                </span>
              </div>

              {/* The human diff. The raw args stay available but collapsed:
                  {"node_id":1,"frozen":true} is precise and unreadable. */}
              <p className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[12px]">
                <span className="text-muted">Status</span>
                <span className="text-faint line-through">{plan.from}</span>
                <span className="text-faint">{"->"}</span>
                <span className="font-medium text-ink">{plan.to}</span>
              </p>

              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-faint hover:text-muted">
                  Exact arguments
                </summary>
                <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-chip p-2.5 font-mono text-[10.5px] leading-5 text-muted">
                  {JSON.stringify(plan.payload.args, null, 2)}
                </pre>
              </details>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href={signLink(plan.payload, info?.network ?? "testnet")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3.5 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  Sign in wallet
                  <ExternalLink size={12} />
                </a>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(signLink(plan.payload, info?.network ?? "testnet"));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-2 text-[11px] font-medium text-ink transition-colors hover:bg-chip"
                >
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <WatchStatus phase={watchPhase} />
                <p className="text-[11px] leading-5 text-faint">
                  The signing page checks the wallet you connect owns this vault.
                </p>
              </div>
            </div>
          )}

          {/*
            THE DANGER ZONE.

            It does NOT offer a "Close vault" button, and that is the honest
            part. Closing is six steps (scripts/teardown-vault.mjs) and four
            of them need the VAULT as signer — the gas-key withdrawal, the
            token's storage_unregister, the 33-byte stub deploy and the
            DeleteAccount. A wallet refuses DeployContract from a dApp, which
            is the whole reason vault CREATION goes through a factory, so no
            amount of work here reaches them.

            What it does offer is the two steps a browser signature can
            reach, and the first is the one that decides whether the money
            survives: deleting an account does not return fungible tokens.
            Then it hands over the exact command for the rest.

            See lib/teardown.ts for the guard. The short version: an
            UNREADABLE balance is not an empty one, so it blocks.
          */}
          <BindAgent onPlan={buildTeardownStep} />

          {/*
            THE DANGER ZONE IS GONE FROM THE UI, deliberately.

            Closing a vault is three steps and the last one needs a command a
            wallet cannot produce — a signature whose signer_id is the VAULT.
            So the panel could never finish the job it offered; it walked a
            user to step three and handed them a terminal command. On a
            dashboard whose whole claim is "nothing here can move funds", the
            most prominent destructive control was one that could not complete.

            Teardown is still fully supported where it actually works:
              npx -p @floatonnear/create-float float-exit
              vault_teardown_report   (what comes back, what strands)
            Both are documented in SKILL.md. Nothing was removed from the
            product -- only from the place it could not be finished.
          */}

          <p className="mt-4 text-[11.5px] leading-5 text-muted">
            {info?.strictAllocation
              ? "A team cannot hand out more than it holds, so an agent's own limit is always real."
              : "Agents can be given more budget than the team has. They share one pool. When the pool runs out, later agents are blocked even if they still have their own limit left."}
          </p>
        </>
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

/**
 * One agent, as a table row on a desktop and as a card on a phone.
 *
 * THE TABLE IS 880px WIDE AND WILL NOT NARROW. `min-w-[55rem]` on every row
 * is deliberate - the comment on the scroll container explains why, and it
 * is right: the fixed columns add up to 35rem, so letting them squeeze
 * crushed the 1.5fr name column to zero and the node labels vanished while
 * still being in the DOM. Scrolling beats silently hiding the column that
 * says WHICH agent a row is.
 *
 * But measured at 375px that means a row extending 538px past the viewport.
 * Reading one agent is two and a half screens of sideways dragging, and the
 * freeze control - the only action on this page - is at the far end of it,
 * 42x19px. Scrolling is the honest behaviour for a table; the answer on a
 * phone is to stop being a table.
 *
 * The card surfaces two things the row could only imply:
 *
 *   THE NODE ID, as text. On the row it lives in a `title` on the avatar,
 *   and a title never fires on a touch screen. It is what `vault_pay` and
 *   `vault_add_role` key on, so "reachable only by hovering" means "not
 *   reachable at all" on the device this card is for.
 *
 *   WHAT FREEZE DOES. "freeze" in 10px grey is the smallest thing on the
 *   screen, and it is the destructive control. Here it is a full-width
 *   button at the touch floor, saying "Freeze agent" rather than "freeze".
 */
/**
 * The line that says a budget lives INSIDE the one above it.
 *
 * DRAWN, NOT WRITTEN. `packages/float-adapter/src/map.ts` records that U+00A0
 * padding plus a box-drawing glyph is the origin of every invisible-character
 * bug in this project — regexes silently matching nothing, `btoa` throwing,
 * names carrying padding into prose. So this is borders and nothing else: no
 * character here can leak into a name, a URL or a signed payload.
 *
 * `-my-3` CANCELS THE ROW'S `py-3`. Without it each line stops at the row's
 * content box and restarts at the next one, leaving a 12px gap at every row
 * boundary — a dashed-looking rail that reads as a rendering fault rather than
 * as structure. The lines have to cross the boundary to connect.
 *
 * `aria-hidden`: it is decoration. The containment it depicts has to reach a
 * screen reader through text, not through a border — see the caller's tooltip,
 * which names the node id.
 */
/**
 * FULL STRENGTH, DELIBERATELY.
 *
 * This was `bg-faint opacity-50` and it shipped invisible: composited on the
 * white row that is ≈#CFCFCC, a contrast ratio of about 1.27:1, and the
 * reporter's answer to it was "still nothing is showing". Full `faint` is
 * ≈2.6:1 — still clearly subordinate to the 13px ink label beside it, but
 * actually present.
 *
 * The reasoning that produced the bug is worth keeping: "a connector should
 * recede" is true of a table that already reads correctly, and this one did
 * not. A line nobody can see is not a subtle line, it is the original bug with
 * extra code. A 1px stroke 9px long also needs far more contrast than a
 * full-width divider of the same colour — presence scales with length, not
 * contrast alone.
 */
const STROKE = "absolute bg-faint";

/**
 * SLOT is the width of one level's connector column, and it must match the
 * caller's base padding exactly or the elbow lands beside the avatar instead
 * of against it. Desktop keeps the 1.1rem the old indent used; the phone card
 * is narrower and uses less.
 */
const SLOT_DESKTOP = "1.1rem";

function TreeRail({ connector, slot, bleed }: {
  connector: TreeConnector;
  slot: string;
  /** Negative margin cancelling the row's vertical padding; see below. */
  bleed: string;
}) {
  // Depth-1 rows hang off root, and root is rendered above as the master
  // budget rather than as a row — so there is nothing on screen to connect to.
  if (!connector.elbow) return null;

  return (
    <span className={`flex self-stretch shrink-0 ${bleed}`} aria-hidden="true">
      {/* Ancestors further out: a line only passes through when that branch
          actually continues below this row. */}
      {connector.rails.map((continues, i) => (
        <span key={i} className="relative" style={{ width: slot }}>
          {continues && <span className={`${STROKE} left-1/2 top-0 bottom-0 w-px -translate-x-1/2`} />}
        </span>
      ))}

      {/* The elbow itself. */}
      <span className="relative" style={{ width: slot }}>
        {/* Vertical. Stops at the middle on the LAST child; carries on to the
            next sibling otherwise. A terminator drawn full-height points at a
            row that does not exist. */}
        <span
          className={`${STROKE} left-1/2 top-0 w-px -translate-x-1/2 ${connector.last ? "h-1/2" : "bottom-0"}`}
        />
        {/* Horizontal, from the stem across to the avatar. */}
        <span className={`${STROKE} left-1/2 top-1/2 right-0 h-px`} />
      </span>
    </span>
  );
}

/**
 * The parent's half of the join: a stub from this row's middle down to its
 * bottom edge, sitting in the column the first child's elbow will occupy.
 *
 * WHY IT IS SEPARATE FROM TreeRail. The elbow belongs to the CHILD row and can
 * only start at that row's top edge. Drawn alone it appears to sprout from the
 * divider rule between the two rows, which still reads as "standalone" — the
 * original complaint, surviving the first fix. The descender is the half that
 * makes the line visibly leave the parent.
 *
 * ABSOLUTE, so it cannot move the parent's avatar by a pixel. `left` is the
 * centre of the child's elbow column: the child pads by one SLOT and then
 * draws `depth` slots, so that centre is `depth * SLOT + SLOT/2` from the
 * cell's edge. Derived, not measured — a hardcoded offset would silently
 * decouple the moment SLOT changed, which is exactly what differs on phones.
 */
function TreeDescender({ connector, depth, slot, bleed }: {
  connector: TreeConnector;
  depth: number;
  slot: string;
  bleed: string;
}) {
  if (!connector.hasChildren) return null;

  return (
    <span
      className={`pointer-events-none absolute top-0 bottom-0 w-px ${bleed}`}
      style={{ left: `calc(${slot} * ${depth} + ${slot} / 2)` }}
      aria-hidden="true"
    >
      <span className={`${STROKE} left-0 top-1/2 bottom-0 w-px`} />
    </span>
  );
}

function FleetRow({ agent, nodeId, isLast, connector, parentName, onToggleFreeze }: {
  agent: ApiAgent;
  nodeId: number;
  isLast: boolean;
  /** Tree geometry for this row, or null when tree order could not be trusted. */
  connector: TreeConnector | null;
  /** The containing budget's name, for the phone layout. Null at top level. */
  parentName: string | null;
  onToggleFreeze: () => void;
}) {
  // Computed once; both layouts read these and neither recomputes.
  const use = utilisation(agent.dailySpent, agent.policy?.dailyBudget, agent.dailyBudgetUsedPercent);
  const pct = use.pct;
  const frozen = agent.status === "killed";
  const name = agent.displayName ?? agent.agentId;
  const barColor = pct >= 100 ? DANGER : pct >= 75 ? WARN : SUCCESS;
  const actionWord = frozen ? "unfreeze" : "freeze";
  const actionTitle = frozen
    ? "Build the unfreeze command for the owner to run"
    : "Build the freeze command for the owner to run";

  const stateChip = (
    <span
      className="whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
      style={frozen ? { background: DANGER_BG, color: DANGER } : { background: SUCCESS_BG, color: SUCCESS }}
    >
      {frozen ? "Frozen" : "Active"}
    </span>
  );

  const meter = (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full overflow-hidden bg-chip">
        <div
          className="h-full rounded-full"
          style={{ width: `${use.barWidth}%`, background: barColor, transition: "width 400ms ease" }}
        />
      </div>
      <span className="text-[10px] font-mono tabular-nums w-8 text-right text-muted">{use.label}</span>
    </div>
  );

  return (
    <>
      {/* DESKTOP: unchanged, verified against main element by element. */}
      <div
        className={`hidden md:grid min-w-[55rem] grid-cols-[minmax(12rem,1.5fr)_7rem_6rem_6rem_9rem_7rem] gap-4 items-center px-6 py-3 border-b border-line hover:bg-canvas transition-colors duration-100 ${isLast ? "border-b-0" : ""}`}
      >
        {/* The hierarchy, drawn with REAL padding.
            Depth used to arrive as U+00A0 characters inside the label,
            which is why it broke whenever anyone typed a plain space -
            and why agent names carried that invisible padding into the
            prose warning further up this page. */}
        {/* ALWAYS AN AVATAR.
            This was gated on `Boolean(a.walletAddress)` — a
            Solana-era field the NEAR adapter never populates,
            because a virtual agent's key is a gas key ON THE VAULT
            and it owns no wallet. The gate was therefore always
            false and no row ever got a face, while the Overview
            page drew one unconditionally from the same data.

            The node id moves to the tooltip. It is what `vault_pay`
            and `vault_add_role` key on, so it has to stay reachable
            — but it is the contract's vocabulary, not the reader's,
            and it was crowding the one column that says who a row
            is. */}
        <div
          className="relative flex items-center min-w-0 self-stretch"
          // SAME TOTAL INDENT AS BEFORE, so no row moves.
          // Was `depth * 1.1rem` of padding. Now one 1.1rem base plus one
          // 1.1rem connector slot per level below the top, which comes to the
          // identical offset at every depth — the lines are the only change.
          // Without a trustworthy connector we fall back to the old formula.
          style={{
            paddingLeft: connector
              ? SLOT_DESKTOP
              : `${(agent.depth ?? 0) * 1.1}rem`,
          }}
        >
          {connector && (
            <TreeDescender
              connector={connector}
              depth={agent.depth ?? 1}
              slot={SLOT_DESKTOP}
              bleed="-my-3"
            />
          )}
          {connector && <TreeRail connector={connector} slot={SLOT_DESKTOP} bleed="-my-3" />}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative shrink-0" title={`Budget node ${nodeId}`}>
              <AgentAvatar seed={agentSeed(agent.agentId)} hue={agentHue(agent.agentId)} size={22} animated />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium truncate text-ink">{name}</p>
            </div>
          </div>
        </div>

        <Num value={agent.policy?.dailyBudget} />
        <Num value={agent.policy?.perTxLimit} />
        <Num value={agent.dailySpent} />

        {meter}

        <div className="flex items-center justify-end gap-1.5">
          {stateChip}
          <button
            onClick={onToggleFreeze}
            title={actionTitle}
            className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted transition-colors hover:bg-chip"
          >
            {actionWord}
          </button>
        </div>
      </div>

      {/* PHONE */}
      <div className={`md:hidden px-4 py-4 border-b border-line ${isLast ? "border-b-0" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div
            className="flex items-center gap-2.5 min-w-0"
            // Indentation still carries the tree. One level is 1.1rem on a
            // 1180px table and would eat 18% of a 375px card at depth 4, so
            // it is halved here - enough to read as nesting, not enough to
            // squeeze the name it is meant to qualify.
            style={{ paddingLeft: `${(agent.depth ?? 0) * 0.55}rem` }}
          >
            <AgentAvatar seed={agentSeed(agent.agentId)} hue={agentHue(agent.agentId)} size={26} animated />
            <div className="min-w-0">
              <p className="text-[14px] font-medium truncate text-ink">{name}</p>
              {/* The id, as TEXT. See the note above: on the row it is a
                  `title`, and a phone has no hover to reveal it. */}
              <p className="text-[11px] font-mono text-faint">node {nodeId}</p>
              {/* CONTAINMENT IN WORDS, because the table's connector CANNOT
                  work here and trying it was a visible bug.
                  A tree connector assumes a ROW: a thin band where "half the
                  height" is a few pixels either side of the label. Below `md`
                  each agent is a TALL CARD — name, three figures, a meter and
                  a button — so the same descender ran a vertical line straight
                  down through "Daily cap", and the child's elbow crossed the
                  card boundary into its neighbour. Measured at 390px before
                  this replaced it.
                  9px of indent cannot carry the relationship either, so the
                  phone says it instead. It also beats the connector on one
                  point the table still cannot match: it names WHICH parent,
                  rather than implying it by position. */}
              {parentName && (
                <p className="text-[11px] text-muted truncate">in {parentName}</p>
              )}
            </div>
          </div>
          <div className="shrink-0 pt-0.5">{stateChip}</div>
        </div>

        <dl className="mt-3.5 space-y-2">
          {[
            ["Daily cap", agent.policy?.dailyBudget],
            ["Per payment", agent.policy?.perTxLimit],
            ["Spent today", agent.dailySpent],
          ].map(([label, value]) => (
            <div key={label as string} className="flex items-baseline justify-between gap-3">
              <dt className="text-[12px] text-muted">{label}</dt>
              <dd><Num value={value as string | undefined} /></dd>
            </div>
          ))}
        </dl>

        <div className="mt-3">
          <p className="mb-1.5 text-[12px] text-muted">Utilisation</p>
          {meter}
        </div>

        <button
          onClick={onToggleFreeze}
          // h-11 is the 44px touch floor. On the row this control is 42x19px
          // and reads "freeze" in 10px grey - the smallest thing on the page,
          // and the destructive one.
          className="mt-4 flex h-11 w-full items-center justify-center rounded-lg border border-line text-[13px] font-medium text-ink transition-colors active:bg-chip"
        >
          {frozen ? "Unfreeze agent" : "Freeze agent"}
        </button>
      </div>
    </>
  );
}

function Num({ value }: { value?: string }) {
  return (
    <span className="text-[12px] font-mono text-right tabular-nums text-ink">
      {value ?? "—"}
      <span className="text-[10px] ml-0.5 text-faint">
        USDC
      </span>
    </span>
  );
}

function Panel({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div className="bg-card border border-line rounded-xl shadow-[0_1px_2px_rgba(17,17,17,0.04)] overflow-hidden">
      <div className="px-6 py-16 text-center">
        <p
          className={`text-[12px] leading-5 ${tone === "error" ? "text-danger" : "text-muted"}`}
        >
          {children}
        </p>
      </div>
    </div>
  );
}
