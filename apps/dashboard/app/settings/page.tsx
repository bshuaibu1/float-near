"use client";

import { useEffect, useState } from "react";
import { CARD, DANGER, DANGER_BG, INK, LINE, SUCCESS, SUCCESS_BG } from "@/lib/colors";
import { ExternalLink } from "lucide-react";
import { signLink, type OwnerPayload } from "@/lib/sign-link";
import { useWallet } from "@/components/wallet-provider";
import {
  getOwnerAuthHeaders,
  getOwnerQuery,
  getOwnerWalletForBody,
  hasOwnerSession,
  useOwnerSessionAvailable,
} from "@/lib/float-session";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";
const border = { border: `1px solid ${LINE}` };

type SettingsResponse = {
  /** The vault's owner account, from get_config. */
  ownerWallet?: string;
  notificationEmail: string | null;
  error?: string;
};

type ApiAgent = { agentId: string; status?: string };
type DashboardResponse = { agents?: ApiAgent[] };

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg overflow-hidden mb-3" style={border}>
      <div className="px-6 py-4" style={{ borderBottom: `1px solid ${LINE}` }}>
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        {description && <p className="text-[12px] mt-0.5 text-muted">{description}</p>}
      </div>
      <div className="px-6 py-2">{children}</div>
    </div>
  );
}

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-4" style={{ borderBottom: `1px solid ${LINE}` }}>
      <div>
        <p className="text-[13px] font-medium text-ink">{label}</p>
        {description && <p className="text-[12px] mt-0.5 text-muted">{description}</p>}
      </div>
      <div className="ml-8 shrink-0">{children}</div>
    </div>
  );
}

export default function Settings() {
  const { walletAddress } = useWallet();
  const ownerSessionAvailable = useOwnerSessionAvailable();


  // Kill all
  const [killConfirm, setKillConfirm] = useState(false);
  const [killing, setKilling]         = useState(false);
  const [killDone, setKillDone]       = useState(false);
  const [killError, setKillError]     = useState<string | null>(null);
  const [ownerWallet, setOwnerWallet] = useState("");
  // The prepared pause, and the network its signing link needs.
  const [pausePlan, setPausePlan] = useState<OwnerPayload | null>(null);
  const [network, setNetwork] = useState("testnet");

  useEffect(() => {
    if (!walletAddress && !hasOwnerSession()) { return; }
    fetch(`${API_BASE_URL}/v1/settings${getOwnerQuery(walletAddress)}`, {
      cache: "no-store",
      headers: getOwnerAuthHeaders(),
    })
      .then(r => r.json())
      .then((p: SettingsResponse) => { setOwnerWallet(p.ownerWallet ?? ""); })
      .catch(() => {});
  }, [walletAddress]);

  // The signing link has to name the right network.
  useEffect(() => {
    fetch(`${API_BASE_URL}/v1/vault-info`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { network?: string } | null) => {
        if (d?.network) setNetwork(d.network);
      })
      .catch(() => {});
  }, []);


  /**
   * Prepare the real emergency stop.
   *
   * This used to POST /v1/agents/:id/kill for every active agent. That
   * endpoint returns 404 - one of the Solana-era routes the NEAR adapter
   * never served - and the handler discarded every response, so the button
   * reported "Done" while nothing had been stopped.
   *
   * `set_paused(true)` is the genuine equivalent and strictly stronger:
   * one transaction, refuses every payment vault-wide including the root's,
   * and reversible from /policies.
   */
  const preparePause = async () => {
    setKilling(true);
    setKillError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/owner-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pause", paused: true }),
      });
      const body = (await res.json()) as { payload?: OwnerPayload; error?: string };
      // CHECKED. The previous version never looked at a response, which is
      // exactly how a 404 rendered as success.
      if (!res.ok || !body.payload) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPausePlan(body.payload);
      setKillConfirm(false);
    } catch (err) {
      setKillError(err instanceof Error ? err.message : "Could not prepare the pause.");
    } finally {
      setKilling(false);
    }
  };

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-widest mb-1 text-muted">Agent Console</p>
        <h2 className="text-[22px] font-semibold tracking-tight text-ink">Settings</h2>
      </div>

      <div className="max-w-xl">

        {/* Account */}
        {/* The email field is gone.
            It POSTed to /v1/settings, whose handler ignores the body and
            returns notificationEmail: null - a POST and a GET produce
            byte-identical JSON. Nothing stored an address, so no
            notification could ever arrive, yet the button went green and
            said "Saved". A control that cannot work is worse than an
            absent one: it buys trust it cannot honour. */}
        <Section title="Account" description="Who owns this vault.">
          <Row label="Owner" description="The only account that can change a policy or pause the vault.">
            <span className="font-mono text-[12px] text-ink">{ownerWallet || "-"}</span>
          </Row>
        </Section>

        {/* Danger Zone */}
        <div className="bg-white rounded-lg overflow-hidden" style={{ border: `1px solid ${DANGER_BG}` }}>
          <div className="px-6 py-4" style={{ borderBottom: `1px solid ${DANGER_BG}` }}>
            <p className="text-[13px] font-semibold" style={{ color: DANGER }}>Danger Zone</p>
            <p className="text-[12px] mt-0.5 text-muted">This takes effect only once you sign it, and can be undone from Policies.</p>
          </div>
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] font-medium text-ink">Pause all payments</p>
                <p className="text-[12px] mt-0.5 text-muted">Refuses every payment vault-wide until you unpause. One transaction for you to sign.</p>
                {killError && <p className="text-[11px] mt-1" style={{ color: DANGER }}>{killError}</p>}
              </div>

              <div className="ml-8 shrink-0 flex items-center gap-2">
                {killConfirm ? (
                  <>
                    <button
                      onClick={() => { setKillConfirm(false); setKillError(null); }}
                      disabled={killing}
                      className="text-[12px] font-medium px-3 py-1.5 rounded-md transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
                      style={{ background: "#F5F5F4", color: INK, border: `1px solid ${LINE}` }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void preparePause()}
                      disabled={killing || (!walletAddress && !ownerSessionAvailable)}
                      className="text-[12px] font-medium px-3 py-1.5 rounded-md transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
                      style={{ background: DANGER, color: CARD, border: `1px solid ${DANGER}` }}
                    >
                      {killing ? "Preparing…" : "Prepare pause"}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => killDone ? undefined : setKillConfirm(true)}
                    disabled={!walletAddress && !ownerSessionAvailable}
                    className="text-[12px] font-medium px-3 py-1.5 rounded-md transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
                    style={killDone
                      ? { background: SUCCESS_BG, color: SUCCESS, border: `1px solid ${SUCCESS_BG}` }
                      : { background: DANGER_BG, color: DANGER, border: "1px solid #fccaca" }
                    }
                  >
                    {killDone ? "Prepared" : "Pause"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* A LINK, not a claim.
            The button above no longer performs anything - it prepares a
            transaction. Nothing is paused until this is signed, and saying
            so is the entire point: the version this replaced reported
            success without sending a single request that worked. */}
        {pausePlan && (
          <div className="mt-4 rounded-lg border border-line bg-card p-4">
            <p className="text-[13px] font-semibold text-ink">Ready to sign</p>
            <p className="mt-1 text-[12px] text-muted">
              {pausePlan.summary ?? pausePlan.methodName}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href={signLink(pausePlan, network)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3.5 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
              >
                Sign in wallet
                <ExternalLink size={12} />
              </a>
              <button
                onClick={() => setPausePlan(null)}
                className="text-[12px] text-muted transition-colors hover:text-ink"
              >
                Cancel
              </button>
            </div>
            <p className="mt-2.5 text-[11px] leading-5 text-faint">
              Nothing is paused until this is signed. The signing page checks the wallet
              you connect owns this vault.
            </p>
          </div>
        )}

      </div>
    </div>
  );
}
