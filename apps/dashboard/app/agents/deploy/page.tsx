"use client";

import { useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/wallet-provider";
import {
  getOwnerAuthHeaders,
  getOwnerQuery,
  getOwnerWalletForBody,
  hasOwnerSession,
  useOwnerSessionAvailable,
} from "@/lib/float-session";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";

type DeployStep = "form" | "deploying" | "success";

type DeployResult = {
  agent: {
    agentId: string;
    walletAddress: string;
    displayName: string;
    policy: {
      dailyBudget: string;
      perTxLimit: string;
    };
    createdAt: string;
    status: string;
  };
  apiKey: string;
  mcpConfig: Record<string, unknown>;
};

function handleCopy(text: string, setCopied: (v: boolean) => void) {
  void navigator.clipboard.writeText(text);
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
}

export default function DeployPage() {
  const { walletAddress } = useWallet();
  const ownerSessionAvailable = useOwnerSessionAvailable();
  const dashboardAuthorized = Boolean(walletAddress) || ownerSessionAvailable;

  const [step, setStep]           = useState<DeployStep>("form");
  const [name, setName]           = useState("");
  const [budget, setBudget]       = useState("5");
  const [perTxLimit, setPerTxLimit] = useState("2");
  const [deployProgress, setDeployProgress] = useState("");
  const [result, setResult]       = useState<DeployResult | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  async function deploy() {
    const ownerWallet = getOwnerWalletForBody(walletAddress);
    if ((!walletAddress && !hasOwnerSession()) || !name.trim()) return;
    setStep("deploying");
    setError(null);

    try {
      setDeployProgress("Creating agent wallet…");
      await new Promise((r) => setTimeout(r, 600));
      setDeployProgress("Setting spending policy…");

      const res = await fetch(
        `${API_BASE_URL}/v1/agents/deploy${getOwnerQuery(walletAddress)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getOwnerAuthHeaders() },
          body: JSON.stringify({
            name: name.trim(),
            displayName: name.trim(),
            budget,
            perTxLimit,
            cooldownSeconds: 0,
            ...(ownerWallet ? { ownerWallet } : {}),
          }),
        },
      );

      const payload = (await res.json()) as DeployResult & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Provisioning failed.");

      setDeployProgress("Done.");
      await new Promise((r) => setTimeout(r, 300));
      setResult(payload);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Provisioning failed.");
      setStep("form");
    }
  }

  return (
    <div className="px-8 py-8 max-w-2xl mx-auto">

      {/* ── Form ── */}
      {step === "form" && (
        <>
          <div className="mb-8">
            <p className="text-[11px] font-medium uppercase tracking-widest mb-1" style={{ color: "#787774" }}>
              Agent Console
            </p>
            <h2 className="text-[22px] font-semibold tracking-tight" style={{ color: "#111111" }}>
              New Agent
            </h2>
            <p className="text-[13px] mt-1" style={{ color: "#787774" }}>
              Provision a wallet and set spending limits for your agent.
            </p>
          </div>

          <div className="bg-white rounded-lg p-6" style={{ border: "1px solid #EAEAEA" }}>
            <div className="grid grid-cols-2 gap-4">

              {/* Agent name — full width */}
              <div className="col-span-2">
                <label className="block text-[11px] font-medium uppercase tracking-widest mb-1.5" style={{ color: "#787774" }}>
                  Agent name
                </label>
                <input
                  type="text"
                  className="w-full text-[13px] outline-none rounded-md px-3 py-2"
                  style={{ border: "1px solid #EAEAEA", color: "#111111", background: "#fff" }}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-agent"
                  autoFocus
                />
              </div>

              {/* Daily budget */}
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-widest mb-1.5" style={{ color: "#787774" }}>
                  Daily budget
                </label>
                <div className="flex items-center gap-2 rounded-md px-3 py-2" style={{ border: "1px solid #EAEAEA" }}>
                  <input
                    type="number"
                    min="0"
                    className="flex-1 text-[13px] font-medium outline-none"
                    style={{ color: "#111111", background: "transparent" }}
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                  />
                  <span className="text-[12px]" style={{ color: "#787774" }}>USDC</span>
                </div>
              </div>

              {/* Per-tx limit */}
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-widest mb-1.5" style={{ color: "#787774" }}>
                  Per-tx limit
                </label>
                <div className="flex items-center gap-2 rounded-md px-3 py-2" style={{ border: "1px solid #EAEAEA" }}>
                  <input
                    type="number"
                    min="0"
                    className="flex-1 text-[13px] font-medium outline-none"
                    style={{ color: "#111111", background: "transparent" }}
                    value={perTxLimit}
                    onChange={(e) => setPerTxLimit(e.target.value)}
                  />
                  <span className="text-[12px]" style={{ color: "#787774" }}>USDC</span>
                </div>
              </div>

            </div>

            {error && (
              <p className="text-[12px] mt-4" style={{ color: "#9F2F2D" }}>{error}</p>
            )}

            <div className="mt-5">
              {!dashboardAuthorized ? (
                <p className="text-[12px]" style={{ color: "#787774" }}>Connect your wallet to provision an agent.</p>
              ) : (
                <button
                  onClick={() => void deploy()}
                  disabled={!name.trim()}
                  className="w-full py-2.5 rounded-md text-[13px] font-semibold tracking-wide transition-all duration-150 active:scale-[0.98] disabled:opacity-40"
                  style={{ background: "#111111", color: "#fff" }}
                >
                  Provision Agent
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Deploying ── */}
      {step === "deploying" && (
        <div className="flex flex-col items-center justify-center py-32 gap-5">
          <div className="w-3 h-3 rounded-full animate-pulse" style={{ background: "#346538" }} />
          <p className="text-[13px]" style={{ color: "#787774" }}>{deployProgress}</p>
        </div>
      )}

      {/* ── Success ── */}
      {step === "success" && result && (
        <>
          <div className="mb-8">
            <div
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-medium uppercase tracking-widest mb-4"
              style={{ background: "#EDF3EC", color: "#346538" }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#346538" }} />
              Wallet provisioned
            </div>
            <h2 className="text-[22px] font-semibold tracking-tight" style={{ color: "#111111" }}>
              {result.agent.displayName}
            </h2>
            <p className="text-[12px] font-mono mt-1" style={{ color: "#787774" }}>
              {result.agent.walletAddress.slice(0, 12)}…{result.agent.walletAddress.slice(-8)}
            </p>
          </div>

          {/* Policy pills */}
          <div className="bg-white rounded-lg p-5 mb-4" style={{ border: "1px solid #EAEAEA" }}>
            <p className="text-[11px] font-medium uppercase tracking-widest mb-3" style={{ color: "#787774" }}>Policy</p>
            <div className="flex flex-wrap gap-2">
              <span className="px-2.5 py-1 rounded-full text-[11px] font-medium" style={{ background: "#F7F6F3", color: "#111111" }}>
                Daily budget: ${result.agent.policy.dailyBudget} USDC
              </span>
              <span className="px-2.5 py-1 rounded-full text-[11px] font-medium" style={{ background: "#F7F6F3", color: "#111111" }}>
                Per-tx limit: ${result.agent.policy.perTxLimit} USDC
              </span>
            </div>
          </div>

          {/* MCP config */}
          <div className="bg-white rounded-lg p-5 mb-4" style={{ border: "1px solid #EAEAEA" }}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-medium uppercase tracking-widest" style={{ color: "#787774" }}>
                Claude / Cursor Config
              </p>
              <button
                onClick={() => handleCopy(JSON.stringify(result.mcpConfig, null, 2), setCopiedMcp)}
                className="text-[11px] font-medium px-3 py-1 rounded-md transition-all duration-150 active:scale-[0.97]"
                style={{ border: "1px solid #EAEAEA", color: copiedMcp ? "#346538" : "#787774", background: copiedMcp ? "#EDF3EC" : "#fff" }}
              >
                {copiedMcp ? "Copied" : "Copy"}
              </button>
            </div>
            <pre
              className="overflow-x-auto rounded-md p-4 text-[12px] font-mono leading-relaxed"
              style={{ background: "#F7F6F3", color: "#111111" }}
            >
              {JSON.stringify(result.mcpConfig, null, 2)}
            </pre>
          </div>

          {/* API key */}
          <div className="bg-white rounded-lg p-5 mb-6" style={{ border: "1px solid #EAEAEA" }}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-medium uppercase tracking-widest" style={{ color: "#787774" }}>API Key</p>
              <button
                onClick={() => handleCopy(result.apiKey, setCopiedKey)}
                className="text-[11px] font-medium px-3 py-1 rounded-md transition-all duration-150 active:scale-[0.97]"
                style={{ border: "1px solid #EAEAEA", color: copiedKey ? "#346538" : "#787774", background: copiedKey ? "#EDF3EC" : "#fff" }}
              >
                {copiedKey ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="rounded-md px-4 py-3 font-mono text-[12px] mb-2" style={{ background: "#F7F6F3", color: "#111111" }}>
              {result.apiKey.slice(0, 8)}{"•".repeat(24)}{result.apiKey.slice(-6)}
            </div>
            <p className="text-[11px]" style={{ color: "#B45309" }}>Save this — it will not be shown again.</p>
          </div>

          <Link href="/agents" className="text-[12px] font-medium transition-colors duration-150" style={{ color: "#787774" }}>
            ← Back to agents
          </Link>
        </>
      )}
    </div>
  );
}
