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
const border = { border: "1px solid #EAEAEA" };

type SettingsResponse = {
  notificationEmail: string | null;
  error?: string;
};

type ApiAgent = { agentId: string; status?: string };
type DashboardResponse = { agents?: ApiAgent[] };

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg overflow-hidden mb-3" style={border}>
      <div className="px-6 py-4" style={{ borderBottom: "1px solid #EAEAEA" }}>
        <p className="text-[13px] font-semibold" style={{ color: "#111111" }}>{title}</p>
        {description && <p className="text-[12px] mt-0.5" style={{ color: "#787774" }}>{description}</p>}
      </div>
      <div className="px-6 py-2">{children}</div>
    </div>
  );
}

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-4" style={{ borderBottom: "1px solid #EAEAEA" }}>
      <div>
        <p className="text-[13px] font-medium" style={{ color: "#111111" }}>{label}</p>
        {description && <p className="text-[12px] mt-0.5" style={{ color: "#787774" }}>{description}</p>}
      </div>
      <div className="ml-8 shrink-0">{children}</div>
    </div>
  );
}

export default function Settings() {
  const { walletAddress } = useWallet();
  const ownerSessionAvailable = useOwnerSessionAvailable();

  // Email
  const [email, setEmail]           = useState("");
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [saving, setSaving]         = useState(false);

  // Kill all
  const [killConfirm, setKillConfirm] = useState(false);
  const [killing, setKilling]         = useState(false);
  const [killDone, setKillDone]       = useState(false);
  const [killError, setKillError]     = useState<string | null>(null);

  useEffect(() => {
    if (!walletAddress && !hasOwnerSession()) { setEmail(""); return; }
    fetch(`${API_BASE_URL}/v1/settings${getOwnerQuery(walletAddress)}`, {
      cache: "no-store",
      headers: getOwnerAuthHeaders(),
    })
      .then(r => r.json())
      .then((p: SettingsResponse) => { setEmail(p.notificationEmail ?? ""); })
      .catch(() => {});
  }, [walletAddress]);

  const saveEmail = async () => {
    const ownerWallet = getOwnerWalletForBody(walletAddress);
    if (!walletAddress && !hasOwnerSession()) return;
    setSaving(true);
    setEmailError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getOwnerAuthHeaders() },
        body: JSON.stringify({
          notificationEmail: email,
          ...(ownerWallet ? { ownerWallet } : {}),
        }),
      });
      const payload = (await res.json()) as SettingsResponse;
      if (!res.ok) throw new Error(payload.error ?? "Unable to save.");
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 2000);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Unable to save.");
    } finally {
      setSaving(false);
    }
  };

  const killAll = async () => {
    if (!walletAddress && !hasOwnerSession()) return;
    setKilling(true);
    setKillError(null);
    try {
      // Fetch all agents for this wallet
      const res = await fetch(
        `${API_BASE_URL}/v1/dashboard${getOwnerQuery(walletAddress)}`,
        { cache: "no-store", headers: getOwnerAuthHeaders() },
      );
      const data = (await res.json()) as DashboardResponse;
      const active = (data.agents ?? []).filter(a => a.status !== "killed");

      // Kill each active agent in parallel
      await Promise.all(
        active.map(a =>
          fetch(
            `${API_BASE_URL}/v1/agents/${encodeURIComponent(a.agentId)}/kill${getOwnerQuery(walletAddress)}`,
            { method: "POST", headers: getOwnerAuthHeaders() },
          ),
        ),
      );

      setKillDone(true);
      setKillConfirm(false);
      setTimeout(() => setKillDone(false), 3000);
    } catch (err) {
      setKillError(err instanceof Error ? err.message : "Failed to kill agents.");
    } finally {
      setKilling(false);
    }
  };

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-widest mb-1" style={{ color: "#787774" }}>Agent Console</p>
        <h2 className="text-[22px] font-semibold tracking-tight" style={{ color: "#111111" }}>Settings</h2>
      </div>

      <div className="max-w-xl">

        {/* Account */}
        <Section title="Account" description="Your Float account details.">
          <Row label="Email" description="Get notified when your agent is killed or budget runs low.">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="text-[13px] outline-none w-44"
                  style={{ border: "1px solid #EAEAEA", borderRadius: 6, padding: "6px 10px", color: "#111111", background: "#fff" }}
                />
                <button
                  onClick={() => void saveEmail()}
                  disabled={(!walletAddress && !ownerSessionAvailable) || saving}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium transition-all duration-150 active:scale-[0.98] disabled:opacity-40"
                  style={emailSaved
                    ? { background: "#EDF3EC", color: "#346538", border: "1px solid #EDF3EC" }
                    : { background: "#111111", color: "#fff" }
                  }
                >
                  {saving ? "Saving…" : emailSaved ? "Saved" : "Save"}
                </button>
              </div>
              {emailError && <p className="text-[11px]" style={{ color:"#9F2F2D" }}>{emailError}</p>}
            </div>
          </Row>
        </Section>

        {/* Danger Zone */}
        <div className="bg-white rounded-lg overflow-hidden" style={{ border: "1px solid #FDEBEC" }}>
          <div className="px-6 py-4" style={{ borderBottom: "1px solid #FDEBEC" }}>
            <p className="text-[13px] font-semibold" style={{ color: "#9F2F2D" }}>Danger Zone</p>
            <p className="text-[12px] mt-0.5" style={{ color: "#787774" }}>These actions are irreversible.</p>
          </div>
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] font-medium" style={{ color: "#111111" }}>Kill all agents</p>
                <p className="text-[12px] mt-0.5" style={{ color: "#787774" }}>Stop all agents from making payments immediately.</p>
                {killError && <p className="text-[11px] mt-1" style={{ color: "#9F2F2D" }}>{killError}</p>}
              </div>

              <div className="ml-8 shrink-0 flex items-center gap-2">
                {killConfirm ? (
                  <>
                    <button
                      onClick={() => { setKillConfirm(false); setKillError(null); }}
                      disabled={killing}
                      className="text-[12px] font-medium px-3 py-1.5 rounded-md transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
                      style={{ background: "#F5F5F4", color: "#111111", border: "1px solid #EAEAEA" }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void killAll()}
                      disabled={killing || (!walletAddress && !ownerSessionAvailable)}
                      className="text-[12px] font-medium px-3 py-1.5 rounded-md transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
                      style={{ background: "#9F2F2D", color: "#fff", border: "1px solid #9F2F2D" }}
                    >
                      {killing ? "Killing…" : "Confirm"}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => killDone ? undefined : setKillConfirm(true)}
                    disabled={!walletAddress && !ownerSessionAvailable}
                    className="text-[12px] font-medium px-3 py-1.5 rounded-md transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
                    style={killDone
                      ? { background: "#EDF3EC", color: "#346538", border: "1px solid #EDF3EC" }
                      : { background: "#FDEBEC", color: "#9F2F2D", border: "1px solid #fccaca" }
                    }
                  >
                    {killDone ? "Done" : "Kill"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
