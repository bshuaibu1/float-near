"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCheck, Copy, Eye, EyeOff, Loader } from "lucide-react";
import { useWallet } from "@/components/wallet-provider";
import {
  getOwnerAuthHeaders,
  getOwnerQuery,
  hasOwnerSession,
  useOwnerSessionAvailable,
} from "@/lib/float-session";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";
const HIDE_AFTER_MS = 30_000;
const border = { border: "1px solid #EAEAEA" };

type ApiAgent = {
  agentId: string;
  walletAddress: string;
  maskedApiKey: string | null;
  createdAt: string;
  displayName?: string | null;
};

type RevealState = {
  fullKey: string | null;
  visible: boolean;
  loading: boolean;
  error: string | null;
};

function maskWallet(walletAddress: string): string {
  return `${walletAddress.slice(0, 6)}···${walletAddress.slice(-4)}`;
}

function formatCreatedAt(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ApiKeysPage() {
  const { walletAddress } = useWallet();
  const ownerSessionAvailable = useOwnerSessionAvailable();
  const dashboardAuthorized = Boolean(walletAddress) || ownerSessionAvailable;
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, RevealState>>({});
  const hideTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!walletAddress && !hasOwnerSession()) {
      setAgents([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetch(`${API_BASE_URL}/v1/dashboard${getOwnerQuery(walletAddress)}`, {
      cache: "no-store",
      headers: getOwnerAuthHeaders(),
    })
      .then((response) => response.json())
      .then((payload: { agents?: ApiAgent[] }) => {
        if (!cancelled) {
          setAgents(payload.agents ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  useEffect(() => {
    const timers = hideTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  const REVEAL_DEFAULT: RevealState = {
    fullKey: null,
    visible: false,
    loading: false,
    error: null,
  };

  const setRevealFor = (agentId: string, patch: Partial<RevealState>) => {
    setReveal((previous) => ({
      ...previous,
      [agentId]: {
        ...REVEAL_DEFAULT,
        ...previous[agentId],
        ...patch,
      },
    }));
  };

  const scheduleHide = (agentId: string) => {
    clearTimeout(hideTimers.current[agentId]);
    hideTimers.current[agentId] = setTimeout(() => {
      setRevealFor(agentId, { visible: false });
    }, HIDE_AFTER_MS);
  };

  const toggleReveal = async (agentId: string) => {
    if (!walletAddress && !hasOwnerSession()) return;
    const state = reveal[agentId];

    if (state?.fullKey) {
      const nextVisible = !state.visible;
      setRevealFor(agentId, { visible: nextVisible });
      if (nextVisible) {
        scheduleHide(agentId);
      } else {
        clearTimeout(hideTimers.current[agentId]);
      }
      return;
    }

    setRevealFor(agentId, { loading: true, error: null });
    try {
      const response = await fetch(
        `${API_BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/key${getOwnerQuery(walletAddress)}`,
        { cache: "no-store", headers: getOwnerAuthHeaders() },
      );
      const payload = (await response.json()) as { apiKey?: string | null; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load key.");
      }
      if (!payload.apiKey) {
        throw new Error("No key on record for this agent.");
      }

      setRevealFor(agentId, {
        fullKey: payload.apiKey,
        visible: true,
        loading: false,
      });
      scheduleHide(agentId);
    } catch (error) {
      setRevealFor(agentId, {
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load key.",
      });
    }
  };

  const loadFullKey = async (agentId: string): Promise<string> => {
    const existing = reveal[agentId]?.fullKey;
    if (existing) return existing;

    const response = await fetch(
      `${API_BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/key${getOwnerQuery(walletAddress)}`,
      { cache: "no-store", headers: getOwnerAuthHeaders() },
    );
    const payload = (await response.json()) as { apiKey?: string | null; error?: string };
    if (!response.ok || !payload.apiKey) {
      throw new Error(payload.error ?? "Failed to load key.");
    }
    setRevealFor(agentId, { fullKey: payload.apiKey, visible: false, loading: false, error: null });
    return payload.apiKey;
  };

  const copy = async (agentId: string) => {
    try {
      setRevealFor(agentId, { loading: true, error: null });
      const fullKey = await loadFullKey(agentId);
      await navigator.clipboard.writeText(fullKey);
      setRevealFor(agentId, { loading: false });
      setCopied(agentId);
      setTimeout(() => setCopied(null), 2000);
    } catch (error) {
      setRevealFor(agentId, {
        loading: false,
        error: error instanceof Error ? error.message : "Failed to copy key.",
      });
    }
  };

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-widest mb-1" style={{ color: "#787774" }}>
          Agent Console
        </p>
        <h2 className="text-[22px] font-semibold tracking-tight" style={{ color: "#111111" }}>
          Float Keys
        </h2>
      </div>

      <div className="max-w-5xl">
        {!dashboardAuthorized ? (
          <div className="bg-white rounded-lg overflow-hidden" style={border}>
            <div className="px-6 py-16 text-center">
              <p className="text-[13px] font-medium mb-1" style={{ color: "#111111" }}>
                No wallet connected
              </p>
              <p className="text-[12px]" style={{ color: "#787774" }}>
                Connect the wallet you used during Float onboarding to view your agent keys.
              </p>
            </div>
          </div>
        ) : loading ? (
          <div className="bg-white rounded-lg overflow-hidden" style={border}>
            <div className="px-6 py-16 text-center">
              <p className="text-[13px]" style={{ color: "#787774" }}>
                Loading agent keys...
              </p>
            </div>
          </div>
        ) : agents.length === 0 ? (
          <div className="bg-white rounded-lg overflow-hidden" style={border}>
            <div className="px-6 py-16 text-center">
              <p className="text-[13px] font-medium mb-1" style={{ color: "#111111" }}>
                No agents found
              </p>
              <p className="text-[12px]" style={{ color: "#787774" }}>
                Run <span className="font-mono">npx @usefloat/cli install</span> to provision your first agent.
              </p>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg overflow-hidden" style={border}>
            <div
              className="grid grid-cols-[1.2fr_1.1fr_0.8fr_1.6fr_5.5rem] gap-4 px-6 py-3 text-[11px] font-medium uppercase tracking-wider"
              style={{ color: "#787774", borderBottom: "1px solid #EAEAEA" }}
            >
              <span>Agent</span>
              <span>Agent ID</span>
              <span>Created</span>
              <span>FLOAT_KEY</span>
              <span className="text-right">Actions</span>
            </div>

            {agents.map((agent, index) => {
              const revealState = reveal[agent.agentId];
              const isVisible = revealState?.visible ?? false;
              const fullKey = revealState?.fullKey ?? null;
              const isLoading = revealState?.loading ?? false;
              const revealError = revealState?.error ?? null;
              const displayName = agent.displayName?.trim() || agent.agentId;
              const displayKey = isVisible && fullKey
                ? `FLOAT_KEY=${fullKey}`
                : `FLOAT_KEY=${agent.maskedApiKey ?? "••••••••••••••••••••••••••••••••"}`;

              return (
                <div
                  key={agent.agentId}
                  className="px-6 py-4"
                  style={{ borderBottom: index < agents.length - 1 ? "1px solid #EAEAEA" : "none" }}
                >
                  <div className="grid grid-cols-[1.2fr_1.1fr_0.8fr_1.6fr_5.5rem] gap-4 items-start">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold truncate" style={{ color: "#111111" }}>
                        {displayName}
                      </p>
                      <p className="text-[11px] mt-1 truncate" style={{ color: "#787774" }}>
                        Wallet {maskWallet(agent.walletAddress)}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <p className="text-[12px] font-mono truncate" style={{ color: "#111111" }}>
                        {agent.agentId}
                      </p>
                      {displayName !== agent.agentId && (
                        <p className="text-[11px] mt-1" style={{ color: "#787774" }}>
                          Immutable system ID
                        </p>
                      )}
                    </div>

                    <div>
                      <p className="text-[12px] font-medium" style={{ color: "#111111" }}>
                        {formatCreatedAt(agent.createdAt)}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <div
                        className="flex items-center gap-2 px-3 py-2 rounded-md"
                        style={{ background: "#F7F6F3", border: "1px solid #EAEAEA" }}
                      >
                        <code className="flex-1 text-[12px] font-mono truncate" style={{ color: "#111111" }}>
                          {displayKey}
                        </code>
                      </div>
                      {revealError && (
                        <p className="text-[11px] mt-2" style={{ color: "#9F2F2D" }}>
                          {revealError}
                        </p>
                      )}
                      {isVisible && !revealError && (
                        <p className="text-[11px] mt-2" style={{ color: "#787774" }}>
                          Full key visible for 30 seconds.
                        </p>
                      )}
                    </div>

                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => void toggleReveal(agent.agentId)}
                        disabled={isLoading}
                        title={isVisible ? "Hide key" : "Reveal full key"}
                        className="p-2 rounded-md transition-colors duration-150 shrink-0 disabled:opacity-40"
                        style={{ color: isVisible ? "#111111" : "#787774", border: "1px solid #EAEAEA" }}
                      >
                        {isLoading ? (
                          <Loader size={14} className="animate-spin" />
                        ) : isVisible ? (
                          <EyeOff size={14} />
                        ) : (
                          <Eye size={14} />
                        )}
                      </button>

                      <button
                        onClick={() => void copy(agent.agentId)}
                        disabled={isLoading}
                        title="Copy full key"
                        className="p-2 rounded-md transition-colors duration-150 shrink-0"
                        style={{ color: copied === agent.agentId ? "#346538" : "#787774", border: "1px solid #EAEAEA" }}
                      >
                        {copied === agent.agentId ? <CheckCheck size={14} /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>

                  {copied === agent.agentId && (
                    <p className="text-[11px] mt-2" style={{ color: "#346538" }}>
                      Full key copied to clipboard.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
