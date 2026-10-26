"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, ExternalLink } from "lucide-react";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";

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

  useEffect(() => {
    const t = setInterval(() => void load(), BALANCE_POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [load]);

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
    <div className="min-h-screen px-6 py-10 md:px-10" style={{ background: "#FBFBFA" }}>
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="space-y-1">
          <h1
            className="text-[26px] font-semibold tracking-[-0.03em]"
            style={{ color: "#111111" }}
          >
            Fund the vault
          </h1>
          <p className="text-[14px] leading-6" style={{ color: "#787774" }}>
            Send USDC to this address. Agents never hold the tokens — they only request
            payments, and the vault checks the limits first.
          </p>
        </div>

        {/* Balance strip. This is the vault's REAL token balance, deliberately
            distinct from the root daily budget below it — see the note. */}
        <div
          className="flex flex-col gap-3 rounded-[18px] px-5 py-4 md:flex-row md:items-center md:justify-between"
          style={{ border: "1px solid #EAEAEA", background: "#fff" }}
        >
          <div>
            <p
              className="text-[11px] font-medium uppercase tracking-[0.14em]"
              style={{ color: "#A0A09A" }}
            >
              Vault balance
            </p>
            <p
              className="mt-0.5 text-[22px] font-semibold tracking-[-0.03em]"
              style={{ color: "#111111" }}
            >
              {balance === null ? "Unavailable" : formatUsdc(toUiAmount(balance, info.tokenDecimals))}{" "}
              <span className="text-[14px] font-medium" style={{ color: "#787774" }}>
                USDC
              </span>
            </p>
          </div>

          <a
            href={`${info.explorerBase}/address/${info.vaultId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[12px] font-medium transition-opacity hover:opacity-70"
            style={{ color: "#787774" }}
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
                  <p className="text-[13px] font-medium" style={{ color: "#111111" }}>
                    Send USDC to the vault
                  </p>
                  <p className="mt-0.5 text-[12px] leading-5" style={{ color: "#787774" }}>
                    Send it from any NEAR wallet that supports this token. The vault has to be
                    registered with the token first, which it already is.
                  </p>
                </div>
              </FeatureRow>

              <FeatureRow>
                <StepNum n="2" />
                <div>
                  <p className="text-[13px] font-medium" style={{ color: "#111111" }}>
                    The owner sets the limits
                  </p>
                  <p className="mt-0.5 text-[12px] leading-5" style={{ color: "#787774" }}>
                    A daily limit and a per-payment limit at every level — the whole treasury, each
                    team, each agent. Teams can hand out more than they hold, on purpose.
                  </p>
                </div>
              </FeatureRow>

              <FeatureRow>
                <StepNum n="3" />
                <div>
                  <p className="text-[13px] font-medium" style={{ color: "#111111" }}>
                    Agents spend without ever holding funds
                  </p>
                  <p className="mt-0.5 text-[12px] leading-5" style={{ color: "#787774" }}>
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
                style={{ border: "1px solid #EAEAEA", background: "#FAFAF9" }}
              >
                <p className="text-[12px] leading-5" style={{ color: "#787774" }}>
                  <span className="font-medium" style={{ color: "#111111" }}>
                    Balance is not the same as spendable today.
                  </span>{" "}
                  The vault is holding{" "}
                  {balance === null
                    ? "an unknown amount"
                    : `${formatUsdc(toUiAmount(balance, info.tokenDecimals))} USDC`}
                  {rootBudget
                    ? `, and the root budget still allows ${formatUsdc(
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
                style={{ border: "1px solid #EAEAEA", background: "#FAFAF9" }}
              >
                <QRCodeSVG value={info.vaultId} size={156} />
              </div>

              <button
                type="button"
                onClick={() => copy(info.vaultId, "vault")}
                className="inline-flex items-center gap-2 rounded-[12px] border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[#F7F7F6]"
                style={{ borderColor: "#EAEAEA", color: "#111111" }}
              >
                {copied === "vault" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "vault" ? "Copied" : "Copy vault address"}
              </button>

              <div
                className="w-full rounded-[12px] px-3 py-2.5 font-mono text-[11px] text-center break-all"
                style={{ border: "1px solid #EAEAEA", background: "#F7F7F6", color: "#787774" }}
              >
                {info.vaultId}
              </div>

              {/* The token contract matters as much as the vault address: a
                  NEP-141 transfer is only meaningful for one specific token. */}
              <div className="w-full space-y-1.5 pt-1">
                <p
                  className="text-[10px] font-medium uppercase tracking-[0.12em]"
                  style={{ color: "#A0A09A" }}
                >
                  Token contract
                </p>
                <button
                  type="button"
                  onClick={() => copy(info.tokenId, "token")}
                  className="flex w-full items-center justify-between gap-2 rounded-[12px] px-3 py-2 font-mono text-[11px] transition-colors hover:bg-[#F7F7F6]"
                  style={{ border: "1px solid #EAEAEA", color: "#787774" }}
                >
                  <span className="break-all text-left">{info.tokenId}</span>
                  {copied === "token" ? (
                    <Check size={12} className="shrink-0" />
                  ) : (
                    <Copy size={12} className="shrink-0" />
                  )}
                </button>
              </div>

              <p className="text-[11px] text-center leading-4" style={{ color: "#A0A09A" }}>
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
          <h2 className="text-[15px] font-semibold tracking-[-0.02em]" style={{ color: "#111111" }}>
            Verifying a deposit
          </h2>
          <div
            className="rounded-[18px] px-5 py-4"
            style={{ border: "1px solid #EAEAEA", background: "#fff" }}
          >
            <p className="text-[13px] leading-6" style={{ color: "#787774" }}>
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
                style={{ borderColor: "#EAEAEA", color: "#111111" }}
              >
                Vault account
                <ExternalLink size={11} />
              </a>
              <a
                href={`${info.explorerBase}/address/${info.tokenId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-[#F7F7F6]"
                style={{ borderColor: "#EAEAEA", color: "#111111" }}
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
      style={{ background: "#F2F2F0", color: "#787774" }}
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
      style={{ border: "1px solid #EAEAEA", background: "#fff" }}
    >
      <div className="mb-5 space-y-1">
        <h2 className="text-[18px] font-semibold tracking-[-0.03em]" style={{ color: "#111111" }}>
          {title}
        </h2>
        <p className="text-[13px] leading-6" style={{ color: "#787774" }}>
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
    <div className="min-h-screen px-6 py-10 md:px-10" style={{ background: "#FBFBFA" }}>
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="space-y-1">
          <h1
            className="text-[26px] font-semibold tracking-[-0.03em]"
            style={{ color: "#111111" }}
          >
            {title}
          </h1>
        </div>
        <div
          className="rounded-[18px] px-5 py-10 text-center text-[13px]"
          style={{ border: "1px solid #EAEAEA", background: "#fff", color: "#787774" }}
        >
          {message}
        </div>
      </div>
    </div>
  );
}

function FundPageSkeleton() {
  return (
    <div className="min-h-screen px-6 py-10 md:px-10" style={{ background: "#FBFBFA" }}>
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="h-8 w-56 rounded-[8px]" style={{ background: "#F2F2F0" }} />
        <div className="h-20 rounded-[18px]" style={{ background: "#F2F2F0" }} />
        <div className="grid gap-4 md:grid-cols-[1.15fr_0.85fr]">
          <div className="h-80 rounded-[20px]" style={{ background: "#F2F2F0" }} />
          <div className="h-80 rounded-[20px]" style={{ background: "#F2F2F0" }} />
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

function formatUsdc(amount: number): string {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
