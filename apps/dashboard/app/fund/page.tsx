"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useVisiblePolling } from "@/lib/use-chain-watch";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { INK, LINE, MUTED } from "@/lib/colors";
import { usdc } from "@/lib/money";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";

const BALANCE_POLL_INTERVAL_MS = 15_000;

type VaultInfo = {
  vaultId: string;
  tokenId: string;
  tokenDecimals: number;
  network: string;
  explorerBase: string;
  owner: string;
  paused: boolean;
  /** The vault's real NEP-141 balance. Null means it could not be read. */
  vaultTokenBalance: string | null;
};

type RootBudget = {
  /** Root's remaining daily budget, base units. NOT the balance. */
  amount: string;
  decimals: number;
};

export default function FundPage() {
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [rootBudget, setRootBudget] = useState<RootBudget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [infoRes, dashRes] = await Promise.all([
        fetch(`${API_BASE_URL}/v1/vault-info`, { cache: "no-store" }),
        fetch(`${API_BASE_URL}/v1/dashboard`, { cache: "no-store" }),
      ]);
      if (!infoRes.ok) throw new Error(`vault-info returned HTTP ${infoRes.status}`);
      setInfo((await infoRes.json()) as VaultInfo);
      if (dashRes.ok) {
        const d = (await dashRes.json()) as { treasury: RootBudget | null };
        setRootBudget(d.treasury);
      }
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

  // Polls only while someone is looking, and refreshes the moment they
  // come back. Unconditional 15s polling meant a tab left open overnight
  // made about 5,700 requests through the adapter to a public RPC for a
  // page nobody was reading.
  useVisiblePolling(load, BALANCE_POLL_INTERVAL_MS);

  useEffect(() => () => {
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
  }, []);

  const copy = useCallback((value: string, which: string) => {
    void navigator.clipboard.writeText(value);
    setCopied(which);
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
    copyTimeout.current = setTimeout(() => setCopied(null), 2_000);
  }, []);

  if (loading) return <FundPageSkeleton />;

  if (!info) {
    return (
      <EmptyPageState
        title="Fund the vault"
        message={
          error ??
          "The vault adapter is not reachable. Start it with NEAR_VAULT_CONTRACT set to your vault account."
        }
      />
    );
  }

  const balance = info.vaultTokenBalance;

  return (
    <div className="min-h-screen px-6 py-10 md:px-10 bg-canvas">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="space-y-1">
          <h1
            className="text-[26px] font-semibold tracking-[-0.03em] text-ink"
          >
            Fund the vault
          </h1>
          <p className="text-[14px] leading-6 text-muted">
            Send USDC to this address. Agents never hold the tokens — they only request
            payments, and the vault checks the limits first.
          </p>
        </div>

        {/* Balance strip. This is the vault's REAL token balance, deliberately
            distinct from the root daily budget below it — see the note. */}
        <div
          className="flex flex-col gap-3 rounded-[18px] px-5 py-4 md:flex-row md:items-center md:justify-between"
          style={{ border: `1px solid ${LINE}`, background: "#fff" }}
        >
          <div>
            <p
              className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint"
            >
              Vault balance
            </p>
            <p
              className="mt-0.5 text-[22px] font-semibold tracking-[-0.03em] text-ink"
            >
              {balance === null ? "Unavailable" : usdc(toUiAmount(balance, info.tokenDecimals))}{" "}
              <span className="text-[14px] font-medium text-muted">
                USDC
              </span>
            </p>
          </div>

          <a
            href={`${info.explorerBase}/address/${info.vaultId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[12px] font-medium transition-opacity hover:opacity-70 text-muted"
          >
            View on NEAR Explorer
            <ExternalLink size={12} />
          </a>
        </div>

        <div className="grid gap-4 md:grid-cols-[1.15fr_0.85fr]">
          <Card
            title="How funding works"
            subtitle="The vault holds the tokens. Budgets decide who can spend them."
          >
            <div className="space-y-4">
              <FeatureRow>
                <StepNum n="1" />
                <div>
                  <p className="text-[13px] font-medium text-ink">
                    Send USDC to the vault
                  </p>
                  <p className="mt-0.5 text-[12px] leading-5 text-muted">
                    Send it from any NEAR wallet that supports this token. The vault has to be
                    registered with the token first, which it already is.
                  </p>
                </div>
              </FeatureRow>

              <FeatureRow>
                <StepNum n="2" />
                <div>
                  <p className="text-[13px] font-medium text-ink">
                    The owner sets the limits
                  </p>
                  <p className="mt-0.5 text-[12px] leading-5 text-muted">
                    A daily limit and a per-payment limit at every level — the whole treasury, each
                    team, each agent. Teams can hand out more than they hold, on purpose.
                  </p>
                </div>
              </FeatureRow>

              <FeatureRow>
                <StepNum n="3" />
                <div>
                  <p className="text-[13px] font-medium text-ink">
                    Agents spend without ever holding funds
                  </p>
                  <p className="mt-0.5 text-[12px] leading-5 text-muted">
                    An agent's key can only ask this vault to send money. It cannot move funds
                    itself and cannot touch anything else.
                  </p>
                </div>
              </FeatureRow>

              {/* The distinction that would otherwise read as a bug: a large
                  balance with a small daily cap looks like the deposit never
                  landed. */}
              <div
                className="rounded-[12px] px-3.5 py-3"
                style={{ border: `1px solid ${LINE}`, background: "#FAFAF9" }}
              >
                <p className="text-[12px] leading-5 text-muted">
                  <span className="font-medium text-ink">
                    Balance is not the same as spendable today.
                  </span>{" "}
                  The vault is holding{" "}
                  {balance === null
                    ? "an unknown amount"
                    : `${usdc(toUiAmount(balance, info.tokenDecimals))} USDC`}
                  {rootBudget
                    ? `, and the root budget still allows ${usdc(
                        toUiAmount(rootBudget.amount, rootBudget.decimals),
                      )} USDC to be spent today.`
                    : "."}{" "}
                  Funding raises the first number; only the owner raises the second.
                </p>
              </div>
            </div>
          </Card>

          <Card
            title="Send USDC here"
            subtitle="Transfer to this vault account from any NEAR wallet or exchange."
          >
            <div className="flex flex-col items-center gap-3">
              <div
                className="rounded-[18px] p-4"
                style={{ border: `1px solid ${LINE}`, background: "#FAFAF9" }}
              >
                <QRCodeSVG value={info.vaultId} size={156} />
              </div>

              <button
                type="button"
                onClick={() => copy(info.vaultId, "vault")}
                className="inline-flex items-center gap-2 rounded-[12px] border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[#F7F7F6]"
                style={{ borderColor: LINE, color: INK }}
              >
                {copied === "vault" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "vault" ? "Copied" : "Copy vault address"}
              </button>

              <div
                className="w-full rounded-[12px] px-3 py-2.5 font-mono text-[11px] text-center break-all"
                style={{ border: `1px solid ${LINE}`, background: "#F7F7F6", color: MUTED }}
              >
                {info.vaultId}
              </div>

              {/* The token contract matters as much as the vault address: a
                  NEP-141 transfer is only meaningful for one specific token. */}
              <div className="w-full space-y-1.5 pt-1">
                <p
                  className="text-[10px] font-medium uppercase tracking-[0.12em] text-faint"
                >
                  Token contract
                </p>
                <button
                  type="button"
                  onClick={() => copy(info.tokenId, "token")}
                  className="flex w-full items-center justify-between gap-2 rounded-[12px] px-3 py-2 font-mono text-[11px] transition-colors hover:bg-[#F7F7F6]"
                  style={{ border: `1px solid ${LINE}`, color: MUTED }}
                >
                  <span className="break-all text-left">{info.tokenId}</span>
                  {copied === "token" ? (
                    <Check size={12} className="shrink-0" />
                  ) : (
                    <Copy size={12} className="shrink-0" />
                  )}
                </button>
              </div>

              <p className="text-[11px] text-center leading-4 text-faint">
                This token only, on NEAR {info.network}. Other tokens will not be credited to any
                budget.
              </p>
            </div>
          </Card>
        </div>

        {/* Replaces the old "Recent deposits" table.
            That table called /v1/treasury/deposits, which this adapter does not
            serve — it 404'd and silently rendered "No deposits yet", which is a
            claim ("none arrived") rather than the truth ("not indexed").
            Incoming NEP-141 transfers would need event indexing the vault does
            not do, so the page links out instead of implying it knows. */}
        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-ink">
            Verifying a deposit
          </h2>
          <div
            className="rounded-[18px] px-5 py-4"
            style={{ border: `1px solid ${LINE}`, background: "#fff" }}
          >
            <p className="text-[13px] leading-6 text-muted">
              Incoming transfers are not indexed here — the vault records payments it makes, not
              deposits it receives. The balance above is read from the token contract on every
              refresh, so a completed transfer shows up there within {BALANCE_POLL_INTERVAL_MS / 1000}{" "}
              seconds. For the transaction itself, check the vault or the token contract on the
              explorer.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href={`${info.explorerBase}/address/${info.vaultId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-[#F7F7F6]"
                style={{ borderColor: LINE, color: INK }}
              >
                Vault account
                <ExternalLink size={11} />
              </a>
              <a
                href={`${info.explorerBase}/address/${info.tokenId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-[#F7F7F6]"
                style={{ borderColor: LINE, color: INK }}
              >
                Token contract
                <ExternalLink size={11} />
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function StepNum({ n }: { n: string }) {
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
      style={{ background: "#F2F2F0", color: MUTED }}
    >
      {n}
    </span>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-[20px] p-6"
      style={{ border: `1px solid ${LINE}`, background: "#fff" }}
    >
      <div className="mb-5 space-y-1">
        <h2 className="text-[18px] font-semibold tracking-[-0.03em] text-ink">
          {title}
        </h2>
        <p className="text-[13px] leading-6 text-muted">
          {subtitle}
        </p>
      </div>
      {children}
    </section>
  );
}

function FeatureRow({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-3">{children}</div>;
}

function EmptyPageState({ title, message }: { title: string; message: string }) {
  return (
    <div className="min-h-screen px-6 py-10 md:px-10 bg-canvas">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="space-y-1">
          <h1
            className="text-[26px] font-semibold tracking-[-0.03em] text-ink"
          >
            {title}
          </h1>
        </div>
        <div
          className="rounded-[18px] px-5 py-10 text-center text-[13px]"
          style={{ border: `1px solid ${LINE}`, background: "#fff", color: MUTED }}
        >
          {message}
        </div>
      </div>
    </div>
  );
}

function FundPageSkeleton() {
  return (
    <div className="min-h-screen px-6 py-10 md:px-10 bg-canvas">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="h-8 w-56 rounded-[8px] bg-chip" />
        <div className="h-20 rounded-[18px] bg-chip" />
        <div className="grid gap-4 md:grid-cols-[1.15fr_0.85fr]">
          <div className="h-80 rounded-[20px] bg-chip" />
          <div className="h-80 rounded-[20px] bg-chip" />
        </div>
      </div>
    </div>
  );
}

function toUiAmount(raw: string, decimals: number): number {
  // Via BigInt: a base-unit string can exceed 2^53 and Number() would round it.
  const d = BigInt(10) ** BigInt(decimals);
  const v = BigInt(raw);
  return Number(v / d) + Number(v % d) / Number(d);
}


