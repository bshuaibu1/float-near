"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCheck, Copy, ExternalLink } from "lucide-react";
import { CANVAS, CHIP, DANGER, DANGER_BG, LINE, MUTED, SUCCESS, SUCCESS_BG } from "@/lib/colors";
import { floatFetch } from "@/lib/float-fetch";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";
const border = { border: `1px solid ${LINE}` };

/**
 * Agent keys on NEAR.
 *
 * The Solana-era page listed a FLOAT_KEY API secret per agent, with a reveal
 * button, a copy-secret flow, and a "run npx @usefloat/cli install" empty
 * state. None of it applies: an agent's authority here is an ACCESS KEY on
 * chain. The public half is public, and the private half must never reach a
 * browser — so there is deliberately nothing to reveal.
 *
 * TWO KINDS, and this page listed only the first for a while:
 *
 *   ACCOUNT   `bind_agent` binds an existing account; its keys live there.
 *   VIRTUAL   `bind_virtual_agent` binds a public key to a node, and the key
 *             is a NEP-611 GAS KEY on the vault itself — no sub-account at
 *             all. This is the only kind new vaults create, because the old
 *             `create_agent_account` funded sub-accounts that nobody could
 *             ever empty (10.7752 NEAR is stranded across 18 of them).
 *
 * Because the adapter filtered on `node.account`, which a virtual agent
 * deliberately leaves null, this page rendered an EMPTY LIST for a correctly
 * configured vault — reading as "nothing is authorised here", the exact
 * inversion of the truth.
 *
 * Every field below is read from the chain via /v1/agent-keys, which calls
 * `view_access_key_list`. That matters: "restricted to request_payment" is this
 * product's central security claim, and rendering it from a constant would keep
 * saying so even if someone attached a full-access key to an agent account. A
 * FullAccess key makes `restricted` false, and this page says so in red.
 */
type AgentKey = {
  accountId: string;
  nodeId: number;
  label: string;
  frozen: boolean;
  keys: {
    publicKey: string;
    restricted: boolean;
    receiverId: string | null;
    methodNames: string[];
    allowanceYocto: string | null;
    /** NEP-611 gas keys only. For these the BALANCE is the spending cap. */
    gasBalanceYocto: string | null;
  }[];
  error?: string;
  /** True for a virtual agent: a gas key on the VAULT, not a sub-account. */
  virtual?: boolean;
};

type VaultInfo = { vaultId: string; explorerBase: string; network: string };

function yoctoToNear(y: string | null): string {
  if (y === null) return "unlimited";
  // Via BigInt: an allowance is ~1e23 and Number() would lose its low digits.
  // BigInt(...) calls rather than 10n literals: this app's tsconfig targets
  // below ES2020, where the literal form is a compile error.
  const n = BigInt(y);
  const YOCTO = BigInt(10) ** BigInt(24);
  const whole = n / YOCTO;
  const frac = (n % YOCTO) / BigInt(10) ** BigInt(20); // 4 dp
  return `${whole}.${frac.toString().padStart(4, "0")} NEAR`;
}

export default function AgentKeysPage() {
  const [rows, setRows] = useState<AgentKey[]>([]);
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [keysRes, infoRes] = await Promise.all([
        floatFetch(`/v1/agent-keys`, { cache: "no-store" }),
        floatFetch(`/v1/vault-info`, { cache: "no-store" }),
      ]);
      if (!keysRes.ok) throw new Error(`agent-keys returned HTTP ${keysRes.status}`);
      setRows((await keysRes.json()) as AgentKey[]);
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

  const copy = (value: string, which: string) => {
    void navigator.clipboard.writeText(value);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <p
          className="text-[11px] font-medium uppercase tracking-widest mb-1 text-muted"
        >
          Agent Console
        </p>
        <h2 className="text-[22px] font-semibold tracking-tight text-ink">
          Agent keys
        </h2>
        <p className="text-[13px] mt-1.5 max-w-2xl text-muted">
          Each agent has its own account and its own key. A key can only ask this vault to send
          money — nothing else. Checked against the chain every time this page loads.
        </p>
      </div>

      <div className="max-w-5xl">
        {loading ? (
          <Panel>Loading agent keys from the chain...</Panel>
        ) : error ? (
          <Panel tone="error">{error}</Panel>
        ) : rows.length === 0 ? (
          <Panel>
            <span className="font-medium text-ink">
              No agents bound yet.
            </span>
            <br />
            The owner creates one in a single step, which makes the agent its own account and
            attaches the restricted key at the same time.
          </Panel>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => {
              const anyUnrestricted = row.keys.some((k) => !k.restricted);
              return (
                <div
                  key={row.accountId}
                  className="bg-white rounded-lg overflow-hidden"
                  style={border}
                >
                  {/* Header: the account, and the node it draws from */}
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5"
                    style={{ borderBottom: `1px solid ${LINE}` }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[13px] font-semibold text-ink">
                          {row.label}
                        </p>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                          style={{ background: CHIP, color: MUTED }}
                        >
                          node {row.nodeId}
                        </span>
                        {row.frozen && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                            style={{ background: DANGER_BG, color: DANGER }}
                          >
                            Frozen
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => copy(row.accountId, row.accountId)}
                        className="mt-1 inline-flex items-center gap-1.5 font-mono text-[11px] transition-opacity hover:opacity-70 text-muted"
                      >
                        {row.accountId}
                        {copied === row.accountId ? <CheckCheck size={11} /> : <Copy size={11} />}
                      </button>
                    </div>

                    {info && (
                      <a
                        href={`${info.explorerBase}/address/${row.accountId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium transition-opacity hover:opacity-70 text-muted"
                      >
                        Explorer
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </div>

                  {/* The restriction, as the chain reports it */}
                  <div className="px-6 py-4">
                    {row.error ? (
                      // Unreadable is NOT "no keys". Rendering an empty list
                      // would read as "nothing is authorised here", which is a
                      // different claim from "we could not look".
                      <p className="text-[12px]" style={{ color: DANGER }}>
                        Could not read the key list for this account: {row.error}
                      </p>
                    ) : row.keys.length === 0 ? (
                      <p className="text-[12px]" style={{ color: DANGER }}>
                        This account has no access keys, so the agent cannot pay at all.
                      </p>
                    ) : (
                      <div className="space-y-4">
                        {row.keys.map((k) => (
                          <div key={k.publicKey} className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              {k.restricted ? (
                                <span
                                  className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                                  style={{ background: SUCCESS_BG, color: SUCCESS }}
                                >
                                  {k.gasBalanceYocto !== null ? "Gas key" : "Function-call key"}
                                </span>
                              ) : (
                                <span
                                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                                  style={{ background: DANGER_BG, color: DANGER }}
                                >
                                  <AlertTriangle size={10} />
                                  Full access
                                </span>
                              )}
                              {/* A GAS KEY HAS NO ALLOWANCE, and rendering its
                                  null one read "gas allowance unlimited" —
                                  describing a key whose spend is strictly
                                  bounded by its balance as unbounded. For
                                  NEP-611 the balance IS the cap, so that is
                                  what gets shown. */}
                              {k.restricted && k.gasBalanceYocto !== null && (
                                <span className="text-[11px] text-muted">
                                  gas balance {yoctoToNear(k.gasBalanceYocto)} — its spending cap
                                </span>
                              )}
                              {k.restricted && k.gasBalanceYocto === null && (
                                <span className="text-[11px] text-muted">
                                  gas allowance {yoctoToNear(k.allowanceYocto)}
                                </span>
                              )}
                            </div>

                            <div
                              className="rounded-lg px-3.5 py-2.5 font-mono text-[11px] break-all"
                              style={{ background: CANVAS, ...border, color: MUTED }}
                            >
                              {k.publicKey}
                            </div>

                            {k.restricted ? (
                              <div>
                                <p className="text-[12px] leading-5 text-muted">
                                  This key can only ask the vault to send money. It cannot change
                                  rules, cannot send money by itself, and cannot talk to any other
                                  contract.
                                </p>
                                {/* The exact method and contract, kept as a
                                    secondary line. The plain sentence above is
                                    the claim; THIS is the evidence for it, read
                                    from the chain. Dropping it would leave the
                                    page asserting a restriction without showing
                                    what was actually read. */}
                                <p className="mt-1 text-[11px] leading-4 text-faint">
                                  On chain:{" "}
                                  {k.methodNames.map((m, i) => (
                                    <span key={m}>
                                      {i > 0 && ", "}
                                      <span className="font-mono">{m}</span>
                                    </span>
                                  ))}{" "}
                                  on <span className="font-mono">{k.receiverId}</span>, no deposit.
                                </p>
                              </div>
                            ) : (
                              <p className="text-[12px] leading-5" style={{ color: DANGER }}>
                                This key is NOT restricted — it can call any method on any contract
                                as this account. The vault&apos;s budget tree still bounds what{" "}
                                <span className="font-mono">request_payment</span> pays out, but the
                                key itself is no longer a leash.
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {anyUnrestricted && (
                    <div
                      className="px-6 py-2.5 text-[11px]"
                      style={{ background: DANGER_BG, color: DANGER }}
                    >
                      An unrestricted key on an agent account defeats the key-level guarantee.
                      Remove it with <span className="font-mono">near account delete-key</span>.
                    </div>
                  )}
                </div>
              );
            })}

            {/* Why there is nothing to copy on this page. */}
            <div className="bg-white rounded-lg px-6 py-4" style={border}>
              <p className="text-[12px] leading-5 text-muted">
                <span className="font-medium text-ink">
                  To let an agent spend, put its private key where the agent runs.
                </span>{" "}
                For the MCP server that means the{" "}
                <span className="font-mono">NEAR_VAULT_AGENT_KEY</span> environment variable,
                alongside <span className="font-mono">NEAR_VAULT_AGENT_ID</span>. The key is
                already restricted, so it needs no extra guarding beyond the usual care with
                secrets.
              </p>
              <p className="mt-2 text-[12px] leading-5 text-muted">
                <span className="font-medium text-ink">
                  Private keys are never shown here, and this dashboard does not hold them.
                </span>{" "}
                An agent&apos;s private key lives wherever that agent runs — in the MCP server&apos;s{" "}
                <span className="font-mono">NEAR_VAULT_AGENT_KEY</span> variable, for example. The
                worst a leaked agent key can do is make payments the vault&apos;s on-chain policy
                already permits.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Panel({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div className="bg-white rounded-lg overflow-hidden" style={border}>
      <div className="px-6 py-16 text-center">
        <p className="text-[12px] leading-5" style={{ color: tone === "error" ? DANGER : MUTED }}>
          {children}
        </p>
      </div>
    </div>
  );
}
