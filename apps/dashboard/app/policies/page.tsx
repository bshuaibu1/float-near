"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@/components/wallet-provider";
import {
  getOwnerAuthHeaders,
  getOwnerQuery,
  getOwnerWalletForBody,
  hasOwnerSession,
  useOwnerSessionAvailable,
} from "@/lib/float-session";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";
const border = { border:"1px solid #EAEAEA" };

type ApiAgent = {
  agentId: string;
  displayName?: string | null;
};

type Policy = {
  dailyBudget: string;
  perTxLimit: string;
  cooldownSeconds: number;
  killOnBudget: boolean;
  blockUnknown: boolean;
  allowedAddresses: string[];
  policyMode: "strict" | "registry";
  allowX402: boolean;
  allowMpp: boolean;
  autoTopUp: boolean;
  autoTopUpThreshold: string;
  autoTopUpAmount: string;
};

const DEFAULT_POLICY: Policy = {
  dailyBudget: "50",
  perTxLimit:  "2",
  cooldownSeconds: 0,
  killOnBudget: true,
  blockUnknown: false,
  allowedAddresses: [],
  policyMode: "strict",
  allowX402:   true,
  allowMpp:    true,
  autoTopUp: false,
  autoTopUpThreshold: "5",
  autoTopUpAmount: "10",
};

type PaymentApproval = {
  id: string;
  endpoint: string;
  payTo: string;
  chain: "solana" | "base" | "tempo";
  assetMint: string;
  decimals: number;
  price: string;
  lastSeenPrice?: string;
  minPriceSeen?: string;
  maxPriceSeen?: string;
  attemptCount?: number;
  manifestSnapshot?: unknown;
  reason: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
};

// Well-known Solana program addresses users commonly need
const KNOWN_SERVICES = [
  { name: "Jupiter",       address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
  { name: "Jupiter v4",    address: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB" },
  { name: "Raydium AMM",   address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
  { name: "Orca Whirlpool",address: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" },
];

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg overflow-hidden mb-2.5" style={border}>
      <div className="px-5 py-3" style={{ borderBottom:"1px solid #EAEAEA" }}>
        <p className="text-[13px] font-semibold mb-0.5" style={{ color:"#111111" }}>{title}</p>
        <p className="text-[12px]" style={{ color:"#787774" }}>{description}</p>
      </div>
      <div className="px-5 py-3.5">{children}</div>
    </div>
  );
}

function Row({ label, description, children, last }: { label: string; description: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5"
      style={{ borderBottom: last ? "none" : "1px solid #EAEAEA" }}>
      <div>
        <p className="text-[13px] font-medium" style={{ color:"#111111" }}>{label}</p>
        <p className="text-[12px] mt-0.5" style={{ color:"#787774" }}>{description}</p>
      </div>
      <div className="ml-8 shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="relative w-9 h-5 rounded-full transition-colors duration-200"
      style={{ background: on ? "#111111" : "#EAEAEA" }}
    >
      <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200"
        style={{ left:"2px", transform: on ? "translateX(16px)" : "translateX(0)" }}/>
    </button>
  );
}

function AddressChip({ address, onRemove }: { address: string; onRemove: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className="group flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors"
      style={{ border:"1px solid #EAEAEA", background:"#FBFBFA" }}
    >
      <button onClick={copy} title={address} className="flex items-center gap-1.5">
        <span className="font-mono text-[11px]" style={{ color:"#111111" }}>
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
        <span className="text-[10px] transition-opacity" style={{ color:"#787774", opacity: copied ? 1 : 0 }}>
          {copied ? "copied" : "copy"}
        </span>
      </button>
      <button
        onClick={onRemove}
        className="ml-0.5 text-[14px] leading-none transition-colors hover:opacity-60"
        style={{ color:"#787774" }}
        title="Remove"
      >
        ×
      </button>
    </div>
  );
}

function PendingApprovalCard({
  approval,
  busy,
  onAction,
}: {
  approval: PaymentApproval;
  busy: boolean;
  onAction: (id: string, action: "approve" | "deny") => void;
}) {
  return (
    <div className="rounded-lg p-3 space-y-2" style={{ border:"1px solid #EAEAEA", background:"#FBFBFA" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold truncate" style={{ color:"#111111" }}>
            {approval.endpoint}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color:"#787774" }}>
            {(approval.minPriceSeen && approval.maxPriceSeen && approval.minPriceSeen !== approval.maxPriceSeen)
              ? `${approval.minPriceSeen}-${approval.maxPriceSeen} USDC`
              : `${approval.lastSeenPrice ?? approval.price} USDC`} · {approval.chain} · {approval.attemptCount ?? 1} attempt{(approval.attemptCount ?? 1) === 1 ? "" : "s"}
          </p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background:"#FFF8E1", color:"#7A5000" }}>
          Review
        </span>
      </div>

      <div className="rounded-md p-2" style={{ border:"1px solid #EAEAEA", background:"#fff" }}>
        <p className="text-[11px] font-medium mb-1" style={{ color:"#111111" }}>
          Approve {approval.payTo.slice(0, 8)}...{approval.payTo.slice(-6)} to receive payments from this agent?
        </p>
        <p className="text-[11px]" style={{ color:"#787774" }}>
          This will allow your agent to autonomously pay this address for future calls within its budget caps.
          Most services use unique addresses, but a shared payment address would be trusted across services.
          The call that created this request has already failed, so ask the agent to retry after approval.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onAction(approval.id, "approve")}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
          style={{ background:"#111111", color:"#fff" }}
        >
          Approve
        </button>
        <button
          onClick={() => onAction(approval.id, "deny")}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
          style={{ border:"1px solid #EAEAEA", color:"#111111", background:"#fff" }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export default function Policies() {
  const { walletAddress } = useWallet();
  const ownerSessionAvailable = useOwnerSessionAvailable();
  const dashboardAuthorized = Boolean(walletAddress) || ownerSessionAvailable;

  const [agents, setAgents]             = useState<ApiAgent[]>([]);
  const [selectedId, setSelectedId]     = useState<string>("");
  const [policy, setPolicy]             = useState<Policy>(DEFAULT_POLICY);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingPolicy, setLoadingPolicy] = useState(false);
  const [saving, setSaving]             = useState(false);
  const [saved, setSaved]               = useState(false);
  const [saveError, setSaveError]       = useState<string | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [inputError, setInputError]     = useState<string | null>(null);
  const [showKnown, setShowKnown]       = useState(false);
  const [approvals, setApprovals]       = useState<PaymentApproval[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);

  // Load agents list
  useEffect(() => {
    if (!walletAddress && !hasOwnerSession()) { setAgents([]); setSelectedId(""); return; }
    setLoadingAgents(true);
    fetch(`${API_BASE_URL}/v1/dashboard${getOwnerQuery(walletAddress)}`, {
      cache: "no-store",
      headers: getOwnerAuthHeaders(),
    })
      .then(r => r.json())
      .then((p: { agents?: ApiAgent[] }) => {
        const list = p.agents ?? [];
        setAgents(list);
        if (list.length > 0 && !selectedId) setSelectedId(list[0].agentId);
      })
      .catch(() => {})
      .finally(() => setLoadingAgents(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // Load policy whenever selected agent changes
  useEffect(() => {
    if ((!walletAddress && !hasOwnerSession()) || !selectedId) return;
    setLoadingPolicy(true);
    fetch(
      `${API_BASE_URL}/v1/agents/${encodeURIComponent(selectedId)}/policy${getOwnerQuery(walletAddress)}`,
      { cache: "no-store", headers: getOwnerAuthHeaders() },
    )
      .then(r => r.json())
      .then((res: { policy?: Partial<Policy> }) => {
        const p = res.policy ?? {};
        setPolicy({
          dailyBudget:        p.dailyBudget        ?? DEFAULT_POLICY.dailyBudget,
          perTxLimit:         p.perTxLimit          ?? DEFAULT_POLICY.perTxLimit,
          cooldownSeconds:    p.cooldownSeconds     ?? DEFAULT_POLICY.cooldownSeconds,
          killOnBudget:       p.killOnBudget        ?? DEFAULT_POLICY.killOnBudget,
          blockUnknown:       p.blockUnknown        ?? DEFAULT_POLICY.blockUnknown,
          allowedAddresses:   p.allowedAddresses    ?? [],
          policyMode:         p.policyMode          ?? DEFAULT_POLICY.policyMode,
          allowX402:          p.allowX402           ?? DEFAULT_POLICY.allowX402,
          allowMpp:           p.allowMpp            ?? DEFAULT_POLICY.allowMpp,
          autoTopUp:          p.autoTopUp           ?? DEFAULT_POLICY.autoTopUp,
          autoTopUpThreshold: p.autoTopUpThreshold  ?? DEFAULT_POLICY.autoTopUpThreshold,
          autoTopUpAmount:    p.autoTopUpAmount      ?? DEFAULT_POLICY.autoTopUpAmount,
        });
      })
      .catch(() => setPolicy(DEFAULT_POLICY))
      .finally(() => setLoadingPolicy(false));
  }, [walletAddress, selectedId]);

  const loadApprovals = async () => {
    if ((!walletAddress && !hasOwnerSession()) || !selectedId) return;
    setApprovalsLoading(true);
    try {
      const res = await fetch(
        `${API_BASE_URL}/v1/agents/${encodeURIComponent(selectedId)}/approvals?status=pending${getOwnerQuery(walletAddress).replace("?", "&")}`,
        { cache: "no-store", headers: getOwnerAuthHeaders() },
      );
      const payload = await res.json() as { approvals?: PaymentApproval[] };
      setApprovals(payload.approvals ?? []);
    } catch {
      setApprovals([]);
    } finally {
      setApprovalsLoading(false);
    }
  };

  useEffect(() => {
    void loadApprovals();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, selectedId]);

  const save = async () => {
    const ownerWallet = getOwnerWalletForBody(walletAddress);
    if ((!walletAddress && !hasOwnerSession()) || !selectedId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(
        `${API_BASE_URL}/v1/agents/${encodeURIComponent(selectedId)}/policy${getOwnerQuery(walletAddress)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Tells the API this is a deliberate user-driven edit from the
            // dashboard UI, not a programmatic call from an MCP tool. The
            // server requires this header for sensitive fields (allowedAddresses,
            // disabling blockUnknown) to block prompt-injection attacks.
            "X-Float-Dashboard-Origin": "true",
            ...getOwnerAuthHeaders(),
          },
          body: JSON.stringify({ ...(ownerWallet ? { ownerWallet } : {}), ...policy }),
        },
      );
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? "Failed to save.");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof Policy>(key: K, val: Policy[K]) =>
    setPolicy(p => ({ ...p, [key]: val }));

  const isValidSolanaAddress = (addr: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr.trim());

  const addAddress = (addr: string) => {
    const trimmed = addr.trim();
    if (!trimmed) return;
    if (!isValidSolanaAddress(trimmed)) {
      setInputError("That doesn't look like a valid Solana address.");
      return;
    }
    if (policy.allowedAddresses.includes(trimmed)) {
      setInputError("Already in the list.");
      return;
    }
    set("allowedAddresses", [...policy.allowedAddresses, trimmed]);
    setAddressInput("");
    setInputError(null);
  };

  const removeAddress = (addr: string) =>
    set("allowedAddresses", policy.allowedAddresses.filter(a => a !== addr));

  const resolveApproval = async (id: string, action: "approve" | "deny") => {
    if ((!walletAddress && !hasOwnerSession()) || !selectedId) return;
    setApprovalBusyId(id);
    try {
      const res = await fetch(
        `${API_BASE_URL}/v1/agents/${encodeURIComponent(selectedId)}/approvals/${encodeURIComponent(id)}${getOwnerQuery(walletAddress)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Float-Dashboard-Origin": "true",
            ...getOwnerAuthHeaders(),
          },
          body: JSON.stringify({ action }),
        },
      );
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? "Approval update failed.");
      }
      const data = await res.json() as { policy?: Partial<Policy> };
      if (data.policy) {
        setPolicy((previous) => ({
          ...previous,
          ...data.policy,
          allowedAddresses: data.policy?.allowedAddresses ?? previous.allowedAddresses,
        }));
      }
      await loadApprovals();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Approval update failed.");
    } finally {
      setApprovalBusyId(null);
    }
  };

  const agentLabel = (a: ApiAgent) => a.displayName || a.agentId;

  const availableKnown = KNOWN_SERVICES.filter(
    s => !policy.allowedAddresses.includes(s.address)
  );

  return (
    <div className="px-8 py-5 max-w-6xl mx-auto">
      <div className="mb-5">
        <p className="text-[11px] font-medium uppercase tracking-widest mb-1" style={{ color:"#787774" }}>Agent Console</p>
        <h2 className="text-[22px] font-semibold tracking-tight" style={{ color:"#111111" }}>Policies</h2>
      </div>

      {/* No wallet */}
      {!dashboardAuthorized ? (
        <div className="bg-white rounded-lg overflow-hidden" style={border}>
          <div className="px-6 py-16 text-center">
            <p className="text-[13px] font-medium mb-1" style={{ color:"#111111" }}>No wallet connected</p>
            <p className="text-[12px]" style={{ color:"#787774" }}>Connect your wallet to manage agent policies.</p>
          </div>
        </div>
      ) : loadingAgents ? (
        <div className="bg-white rounded-lg overflow-hidden" style={border}>
          <div className="px-6 py-16 text-center">
            <p className="text-[13px]" style={{ color:"#787774" }}>Loading agents...</p>
          </div>
        </div>
      ) : agents.length === 0 ? (
        <div className="bg-white rounded-lg overflow-hidden" style={border}>
          <div className="px-6 py-16 text-center">
            <p className="text-[13px] font-medium mb-1" style={{ color:"#111111" }}>No agents found</p>
            <p className="text-[12px]" style={{ color:"#787774" }}>Run <span className="font-mono">npx @usefloat/cli install</span> to provision your first agent.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Agent selector */}
          <div className="mb-4 flex items-center gap-3">
            <p className="text-[12px] font-medium shrink-0" style={{ color:"#787774" }}>Editing policy for</p>
            <select
              value={selectedId}
              onChange={e => setSelectedId(e.target.value)}
              className="text-[13px] font-medium outline-none rounded-md px-3 py-2"
              style={{ border:"1px solid #EAEAEA", color:"#111111", background:"#fff", minWidth:180 }}
            >
              {agents.map(a => (
                <option key={a.agentId} value={a.agentId}>{agentLabel(a)}</option>
              ))}
            </select>
            {loadingPolicy && <span className="text-[12px]" style={{ color:"#787774" }}>Loading...</span>}
            <button
              onClick={() => void save()}
              disabled={saving || loadingPolicy}
              className="ml-auto text-[13px] font-medium px-5 py-2 rounded-md transition-all duration-150 active:scale-[0.98] disabled:opacity-40"
              style={saved
                ? { background:"#EDF3EC", color:"#346538", border:"1px solid #EDF3EC" }
                : { background:"#111111", color:"#fff", border:"1px solid #111111" }
              }
            >
              {saving ? "Saving..." : saved ? "Saved" : "Save policy"}
            </button>
          </div>
          {saveError && <p className="text-[11px] mb-3" style={{ color:"#9F2F2D" }}>{saveError}</p>}

          <div className="grid grid-cols-12 gap-4">

            {/* Left col */}
            <div className="col-span-12 md:col-span-8">

              <Section title="Spending Limits" description="Hard caps that apply before any agent payment is submitted.">
                <Row label="Daily limit" description="Maximum USDC the agent can spend in a 24-hour window.">
                  <div className="flex items-center gap-2" style={{ border:"1px solid #EAEAEA", borderRadius:6, padding:"6px 12px", background:"#fff" }}>
                    <input type="number" value={policy.dailyBudget}
                      onChange={e => set("dailyBudget", e.target.value)}
                      className="w-16 text-[13px] font-medium outline-none"
                      style={{ color:"#111111", background:"transparent" }}/>
                    <span className="text-[12px]" style={{ color:"#787774" }}>USDC</span>
                  </div>
                </Row>
                <Row label="Per-transaction limit" description="Block any single payment above this amount.">
                  <div className="flex items-center gap-2" style={{ border:"1px solid #EAEAEA", borderRadius:6, padding:"6px 12px", background:"#fff" }}>
                    <input type="number" value={policy.perTxLimit}
                      onChange={e => set("perTxLimit", e.target.value)}
                      className="w-16 text-[13px] font-medium outline-none"
                      style={{ color:"#111111", background:"transparent" }}/>
                    <span className="text-[12px]" style={{ color:"#787774" }}>USDC</span>
                  </div>
                </Row>
                <Row label="Cooldown between payments" description="Minimum wait time between any two payments - applies to built-in services, direct transfers, external x402, and MPP. Set to 0 to disable." last>
                  <div className="flex items-center gap-2" style={{ border:"1px solid #EAEAEA", borderRadius:6, padding:"6px 12px", background:"#fff" }}>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={policy.cooldownSeconds}
                      onChange={e => set("cooldownSeconds", Math.max(0, Math.floor(Number(e.target.value))))}
                      className="w-16 text-[13px] font-medium outline-none"
                      style={{ color:"#111111", background:"transparent" }}
                    />
                    <span className="text-[12px]" style={{ color:"#787774" }}>sec</span>
                  </div>
                </Row>
              </Section>

              <Section title="Safety Rules" description="Control when an agent is stopped or where it is allowed to send funds.">
                <Row label="Kill on budget exhausted" description="Stop the agent immediately if it tries to spend past its daily limit.">
                  <Toggle on={policy.killOnBudget} onChange={v => set("killOnBudget", v)}/>
                </Row>

                <Row label="External API trust mode" description="Strict only pays approved addresses. Registry lets verified x402/MPP APIs run automatically and asks you about new ones.">
                  <select
                    value={policy.policyMode}
                    onChange={e => set("policyMode", e.target.value === "registry" ? "registry" : "strict")}
                    className="text-[12px] font-medium outline-none rounded-md px-3 py-2"
                    style={{ border:"1px solid #EAEAEA", color:"#111111", background:"#fff", minWidth:120 }}
                  >
                    <option value="strict">Strict</option>
                    <option value="registry">Registry</option>
                  </select>
                </Row>

                {/* blockUnknown row + address panel */}
                <div style={{ borderBottom: "none" }}>
                  <div className="flex items-center justify-between py-3.5">
                    <div>
                      <p className="text-[13px] font-medium" style={{ color:"#111111" }}>Block unknown wallet destinations</p>
                      <p className="text-[12px] mt-0.5" style={{ color:"#787774" }}>
                        Restrict direct Solana transfers and external x402 recipients to approved wallet addresses.
                      </p>
                    </div>
                    <div className="ml-8 shrink-0">
                      <Toggle on={policy.blockUnknown} onChange={v => set("blockUnknown", v)}/>
                    </div>
                  </div>

                  {policy.blockUnknown && (
                    <div
                      className="mb-2 rounded-lg p-4 space-y-4"
                      style={{ background:"#FBFBFA", border:"1px solid #EAEAEA" }}
                    >
                      {/* Header */}
                      <div>
                        <p className="text-[12px] font-semibold" style={{ color:"#111111" }}>Approved addresses</p>
                        <p className="text-[11px] mt-0.5" style={{ color:"#787774" }}>
                          Your agent can only send USDC to wallet destinations on this list.
                          Built-in services still use your spend limits and do not need to be allowlisted.
                        </p>
                      </div>

                      {/* Current chips */}
                      {policy.allowedAddresses.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {policy.allowedAddresses.map(addr => (
                            <AddressChip
                              key={addr}
                              address={addr}
                              onRemove={() => removeAddress(addr)}
                            />
                          ))}
                        </div>
                      )}

                      {/* Empty state */}
                      {policy.allowedAddresses.length === 0 && (
                        <div
                          className="rounded-lg px-4 py-3 text-center"
                          style={{ border:"1px dashed #EAEAEA" }}
                        >
                          <p className="text-[11px]" style={{ color:"#787774" }}>
                            No addresses added yet - direct wallet transfers and external x402 payments will be blocked until you add at least one.
                          </p>
                        </div>
                      )}

                      {/* Input */}
                      <div className="space-y-1.5">
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={addressInput}
                            onChange={e => { setAddressInput(e.target.value); setInputError(null); }}
                            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addAddress(addressInput); } }}
                            placeholder="Paste a Solana wallet address and press Enter…"
                            className="flex-1 rounded-md px-3 py-2 font-mono text-[11px] outline-none transition-colors"
                            style={{
                              border: inputError ? "1px solid #9F2F2D" : "1px solid #EAEAEA",
                              background:"#fff",
                              color:"#111111",
                            }}
                          />
                          <button
                            onClick={() => addAddress(addressInput)}
                            disabled={!addressInput.trim()}
                            className="rounded-md px-3 py-2 text-[12px] font-medium transition-opacity disabled:opacity-40"
                            style={{ background:"#111111", color:"#fff" }}
                          >
                            Add
                          </button>
                        </div>
                        {inputError && (
                          <p className="text-[11px]" style={{ color:"#9F2F2D" }}>{inputError}</p>
                        )}
                      </div>

                      {/* Quick-add: known services */}
                      <div>
                        <button
                          onClick={() => setShowKnown(v => !v)}
                          className="flex items-center gap-1 text-[11px] transition-opacity hover:opacity-70"
                          style={{ color:"#787774" }}
                        >
                          <span>{showKnown ? "▾" : "▸"}</span>
                          <span>Quick-add a known service</span>
                        </button>

                        {showKnown && (
                          <div className="mt-2 space-y-1">
                            {availableKnown.length === 0 ? (
                              <p className="text-[11px]" style={{ color:"#787774" }}>All known services already added.</p>
                            ) : (
                              availableKnown.map(s => (
                                <button
                                  key={s.address}
                                  onClick={() => addAddress(s.address)}
                                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left transition-colors hover:opacity-80"
                                  style={{ border:"1px solid #EAEAEA", background:"#fff" }}
                                >
                                  <span className="text-[12px] font-medium" style={{ color:"#111111" }}>{s.name}</span>
                                  <span className="font-mono text-[10px]" style={{ color:"#787774" }}>
                                    {s.address.slice(0, 6)}…{s.address.slice(-4)}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </Section>

              <Section title="Pending Approvals" description="New x402 or MPP payment destinations that need your decision before this agent can pay them.">
                {approvalsLoading ? (
                  <p className="text-[12px]" style={{ color:"#787774" }}>Loading approval requests...</p>
                ) : approvals.length === 0 ? (
                  <div className="rounded-lg px-4 py-3 text-center" style={{ border:"1px dashed #EAEAEA" }}>
                    <p className="text-[11px]" style={{ color:"#787774" }}>
                      No pending approvals. Unknown external paywalls will appear here when registry mode is on.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {approvals.map((approval) => (
                      <PendingApprovalCard
                        key={approval.id}
                        approval={approval}
                        busy={approvalBusyId === approval.id}
                        onAction={resolveApproval}
                      />
                    ))}
                  </div>
                )}
              </Section>

            </div>

            {/* Right col - Payment permissions */}
            <div className="col-span-12 md:col-span-4 self-start sticky top-6">
              <Section title="Payment Permissions" description="Choose which payment surfaces this agent can use. Spending limits still apply to every option.">
                <Row label="Built-in services" description="Image, video, voice, social data, web data, and other services available in Float. Controlled by spending limits and safety rules.">
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full whitespace-nowrap"
                    style={{ background:"#EDF3EC", color:"#346538" }}
                  >
                    On
                  </span>
                </Row>
                <Row label="Direct Solana transfers" description="Send USDC directly to a wallet. Use Block unknown wallet destinations to require an approved-address list.">
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full whitespace-nowrap"
                    style={{ background:"#F5F5F4", color:"#787774" }}
                  >
                    Guarded
                  </span>
                </Row>
                <Row label="External x402 APIs" description="Let this agent pay x402 endpoints outside Float. Use this only when the agent needs to call an external paid API.">
                  <Toggle on={policy.allowX402} onChange={v => set("allowX402", v)}/>
                </Row>
                <Row label="MPP sessions" description="Pre-authorize a session budget once, then make many API calls with fewer on-chain transactions." last>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full whitespace-nowrap"
                      style={{ background:"#FFF8E1", color:"#7A5000" }}
                    >
                      Beta
                    </span>
                    <Toggle on={policy.allowMpp} onChange={v => set("allowMpp", v)}/>
                  </div>
                </Row>
              </Section>

              <Section title="Auto Top-Up" description="Refill this agent from your treasury when the balance runs low.">
                <Row label="Enable auto top-up" description="Automatically add funds from treasury when needed.">
                  <Toggle on={policy.autoTopUp} onChange={v => set("autoTopUp", v)}/>
                </Row>

                {policy.autoTopUp && (
                  <div className="mt-2 rounded-lg p-3 space-y-3" style={{ background:"#FBFBFA", border:"1px solid #EAEAEA" }}>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-[11px] font-medium mb-1.5" style={{ color:"#111111" }}>Below</p>
                        <div className="flex items-center gap-2" style={{ border:"1px solid #EAEAEA", borderRadius:6, padding:"6px 10px", background:"#fff" }}>
                          <input
                            type="number"
                            value={policy.autoTopUpThreshold}
                            onChange={e => set("autoTopUpThreshold", e.target.value)}
                            className="w-14 text-[13px] font-medium outline-none"
                            style={{ color:"#111111", background:"transparent" }}
                          />
                          <span className="text-[12px]" style={{ color:"#787774" }}>USDC</span>
                        </div>
                      </div>
                      <div>
                        <p className="text-[11px] font-medium mb-1.5" style={{ color:"#111111" }}>Add</p>
                        <div className="flex items-center gap-2" style={{ border:"1px solid #EAEAEA", borderRadius:6, padding:"6px 10px", background:"#fff" }}>
                          <input
                            type="number"
                            value={policy.autoTopUpAmount}
                            onChange={e => set("autoTopUpAmount", e.target.value)}
                            className="w-14 text-[13px] font-medium outline-none"
                            style={{ color:"#111111", background:"transparent" }}
                          />
                          <span className="text-[12px]" style={{ color:"#787774" }}>USDC</span>
                        </div>
                      </div>
                    </div>
                    <p className="text-[11px]" style={{ color:"#787774" }}>
                      Treasury must have enough USDC. Top-ups run after successful payments.
                    </p>
                  </div>
                )}
              </Section>
            </div>

          </div>
        </>
      )}
    </div>
  );
}
