"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import { useWallet } from "@/components/wallet-provider";
import { getOwnerAuthHeaders, getOwnerQuery, hasOwnerSession } from "@/lib/float-session";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";

type DashboardTreasury = {
  walletAddress: string;
  amount: string;
  currency: string;
  decimals: number;
};

type DashboardResponse = {
  treasury: DashboardTreasury | null;
  error?: string;
};

type Deposit = {
  signature: string;
  amount: string;
  fromAddress: string;
  timestamp: string;
};

export default function FundPage() {
  return (
    <Suspense fallback={<FundPageSkeleton />}>
      <FundPageContent />
    </Suspense>
  );
}

const BALANCE_POLL_INTERVAL_MS = 15_000;

function FundPageContent() {
  const searchParams = useSearchParams();
  const { walletAddress } = useWallet();
  const deepLinkedWallet = searchParams.get("wallet")?.trim() || "";

  const [treasury, setTreasury] = useState<DashboardTreasury | null>(null);
  const [loadingTreasury, setLoadingTreasury] = useState(false);
  const [treasuryError, setTreasuryError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [loadingDeposits, setLoadingDeposits] = useState(false);

  // Extracted as a stable callback so it can be called from polling + post-checkout refresh
  const loadTreasury = useCallback(async () => {
    // Deep-link case: URL has ?wallet=<treasuryAddress> — fetch balance directly
    // from the public /v1/treasury/usdc-balance endpoint (no owner session needed).
    if (deepLinkedWallet) {
      setLoadingTreasury(true);
      try {
        const res = await fetch(
          `${API_BASE_URL}/v1/treasury/usdc-balance?address=${encodeURIComponent(deepLinkedWallet)}`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as {
          address: string;
          amount: string;
          currency: string;
          decimals: number;
        };
        setTreasury({
          walletAddress: deepLinkedWallet,
          amount: data.amount ?? "0",
          currency: data.currency ?? "USDC",
          decimals: data.decimals ?? 6,
        });
        setTreasuryError(null);
      } catch {
        setTreasury({ walletAddress: deepLinkedWallet, amount: "0", currency: "USDC", decimals: 6 });
      } finally {
        setLoadingTreasury(false);
      }
      return;
    }

    if (!walletAddress && !hasOwnerSession()) {
      setTreasury(null);
      setTreasuryError(null);
      setLoadingTreasury(false);
      return;
    }

    setLoadingTreasury(true);
    setTreasuryError(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/v1/dashboard${getOwnerQuery(walletAddress)}`,
        { cache: "no-store", headers: getOwnerAuthHeaders() },
      );
      const payload = (await response.json()) as DashboardResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to load treasury wallet.");
      }

      setTreasury(payload.treasury);
    } catch (error) {
      setTreasury(null);
      setTreasuryError(
        error instanceof Error ? error.message : "Unable to load treasury wallet.",
      );
    } finally {
      setLoadingTreasury(false);
    }
  }, [deepLinkedWallet, walletAddress]);

  // Extracted as a stable callback so it can be called from polling + post-checkout refresh
  const loadDeposits = useCallback(async () => {
    const ownerWallet = walletAddress || deepLinkedWallet;
    if (!ownerWallet && !hasOwnerSession()) { setDeposits([]); return; }
    setLoadingDeposits(true);
    try {
      const query = deepLinkedWallet
        ? `?owner=${encodeURIComponent(deepLinkedWallet)}`
        : getOwnerQuery(walletAddress);
      const r = await fetch(
        `${API_BASE_URL}/v1/treasury/deposits${query}`,
        { cache: "no-store", headers: getOwnerAuthHeaders() },
      );
      const p = (await r.json()) as { deposits?: Deposit[] };
      setDeposits(p.deposits ?? []);
    } catch {
      setDeposits([]);
    } finally {
      setLoadingDeposits(false);
    }
  }, [walletAddress, deepLinkedWallet]);

  // Initial load
  useEffect(() => {
    void loadTreasury();
    void loadDeposits();
  }, [loadTreasury, loadDeposits]);

  // Poll balance + deposits every 15s so on-chain transfers show up automatically
  useEffect(() => {
    const interval = setInterval(() => {
      void loadTreasury();
      void loadDeposits();
    }, BALANCE_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadTreasury, loadDeposits]);

  // Called by CoinflowCard when checkout closes — re-fetch immediately
  const onCheckoutClose = useCallback(() => {
    void loadTreasury();
    void loadDeposits();
  }, [loadTreasury, loadDeposits]);

  const treasuryAddress = treasury?.walletAddress ?? "";
  const balance = treasury ? toUiAmount(treasury.amount, treasury.decimals) : 0;
  const showBalanceHint = Boolean(deepLinkedWallet && !walletAddress);

  const copyAddress = useCallback(() => {
    if (!treasuryAddress) return;

    void navigator.clipboard.writeText(treasuryAddress);
    setCopied(true);

    if (copyTimeout.current) {
      clearTimeout(copyTimeout.current);
    }

    copyTimeout.current = setTimeout(() => setCopied(false), 2_000);
  }, [treasuryAddress]);

  useEffect(() => {
    return () => {
      if (copyTimeout.current) {
        clearTimeout(copyTimeout.current);
      }
    };
  }, []);

  if (!treasuryAddress && !loadingTreasury) {
    return (
      <EmptyPageState
        title="Fund wallet"
        message={
          treasuryError ||
          "No treasury wallet connected. Run npx @usefloat/cli install to get started."
        }
      />
    );
  }

  return (
    <div className="min-h-screen px-6 py-10 md:px-10" style={{ background: "#FBFBFA" }}>
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="space-y-1">
          <h1
            className="text-[26px] font-semibold tracking-[-0.03em]"
            style={{ color: "#111111" }}
          >
            Fund wallet
          </h1>
          <p className="text-[14px] leading-6" style={{ color: "#787774" }}>
            Add USDC to your treasury wallet. Your agents draw from this balance.
          </p>
        </div>

        <div
          className="flex flex-col gap-3 rounded-[18px] px-5 py-4 md:flex-row md:items-center md:justify-between"
          style={{ border: "1px solid #EAEAEA", background: "#fff" }}
        >
          <div>
            <p
              className="text-[11px] font-medium uppercase tracking-[0.14em]"
              style={{ color: "#A0A09A" }}
            >
              Treasury balance
            </p>
            <p
              className="mt-0.5 text-[22px] font-semibold tracking-[-0.03em]"
              style={{ color: "#111111" }}
            >
              {loadingTreasury ? "Loading..." : formatUsdc(balance)}{" "}
              <span className="text-[14px] font-medium" style={{ color: "#787774" }}>
                USDC
              </span>
            </p>
          </div>

          {treasuryAddress ? (
            <a
              href={`https://solscan.io/account/${treasuryAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[12px] font-medium transition-opacity hover:opacity-70"
              style={{ color: "#787774" }}
            >
              View on Solscan
              <ExternalLink size={12} />
            </a>
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-[1.15fr_0.85fr]">
          <Card title="Pay with card" subtitle="No crypto needed. Enter an amount, pay with your debit or credit card, and the funds go directly into your treasury, ready for your agents to use.">
            {treasuryAddress ? (
              <CoinflowCard treasuryAddress={treasuryAddress} onClose={onCheckoutClose} />
            ) : (
              <p className="text-[13px]" style={{ color: "#787774" }}>
                Treasury wallet unavailable.
              </p>
            )}
          </Card>

          <Card
            title="Send USDC directly"
            subtitle="Already have crypto? Paste this address into any wallet or exchange and send USDC on Solana, it lands straight in your treasury."
          >
            {treasuryAddress ? (
              <div className="flex flex-col items-center gap-3">
                <div
                  className="rounded-[18px] p-4"
                  style={{ border: "1px solid #EAEAEA", background: "#FAFAF9" }}
                >
                  <QRCodeSVG value={treasuryAddress} size={156} />
                </div>

                <button
                  type="button"
                  onClick={copyAddress}
                  className="inline-flex items-center gap-2 rounded-[12px] border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[#F7F7F6]"
                  style={{ borderColor: "#EAEAEA", color: "#111111" }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy address"}
                </button>

                <div
                  className="w-full rounded-[12px] px-3 py-2.5 font-mono text-[11px] text-center truncate"
                  style={{ border: "1px solid #EAEAEA", background: "#F7F7F6", color: "#787774" }}
                >
                  {treasuryAddress}
                </div>

                <p className="text-[11px]" style={{ color: "#A0A09A" }}>
                  USDC on Solana only, other assets won&apos;t arrive.
                </p>
              </div>
            ) : (
              <p className="text-[13px]" style={{ color: "#787774" }}>
                Treasury wallet unavailable.
              </p>
            )}
          </Card>
        </div>

        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.02em]" style={{ color: "#111111" }}>
            Recent deposits
          </h2>
          <div className="overflow-hidden rounded-[18px]" style={{ border: "1px solid #EAEAEA", background: "#fff" }}>
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ borderBottom: "1px solid #EAEAEA" }}>
                  {["Amount", "From", "Status", "Time"].map(col => (
                    <th key={col} className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-[0.12em]" style={{ color: "#A0A09A" }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loadingDeposits ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-[13px]" style={{ color: "#787774" }}>
                      Loading deposits...
                    </td>
                  </tr>
                ) : deposits.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-[13px]" style={{ color: "#787774" }}>
                      No deposits yet.
                    </td>
                  </tr>
                ) : (
                  deposits.map((d, i) => (
                    <tr key={d.signature}
                      style={{ borderBottom: i < deposits.length - 1 ? "1px solid #EAEAEA" : "none" }}>
                      <td className="px-5 py-3.5 text-[13px] font-medium font-mono" style={{ color: "#111111" }}>
                        +{d.amount} <span className="text-[11px] font-normal" style={{ color: "#787774" }}>USDC</span>
                      </td>
                      <td className="px-5 py-3.5 text-[12px] font-mono" style={{ color: "#787774" }}>
                        {d.fromAddress
                          ? `${d.fromAddress.slice(0, 6)}···${d.fromAddress.slice(-4)}`
                          : "On-chain transfer"}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
                          style={{ background: "#EDF3EC", color: "#346538" }}>
                          Confirmed
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-[12px] font-mono" style={{ color: "#787774" }}>
                        {new Date(d.timestamp).toLocaleString([], {
                          month: "short", day: "numeric",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
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

function CoinflowCard({ treasuryAddress, onClose }: { treasuryAddress: string; onClose?: () => void }) {
  const [amountUsd, setAmountUsd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutLink, setCheckoutLink] = useState<string | null>(null);

  async function openCheckout() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/v1/coinflow/checkout-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          treasuryAddress,
          amountUsd,
        }),
      });

      const payload = (await response.json()) as { link?: string; error?: string };
      if (!response.ok || !payload.link) {
        throw new Error(payload.error ?? "Unable to open Coinflow checkout.");
      }

      setCheckoutLink(payload.link);
    } catch (checkoutError) {
      setError(
        checkoutError instanceof Error
          ? checkoutError.message
          : "Unable to open Coinflow checkout.",
      );
    } finally {
      setLoading(false);
    }
  }

  const closeCheckout = useCallback(() => {
    setCheckoutLink(null);
    onClose?.();
  }, [onClose]);

  return (
    <div className="space-y-3">
      <label className="block space-y-1.5">
        <span
          className="text-[11px] font-medium uppercase tracking-[0.14em]"
          style={{ color: "#A0A09A" }}
        >
          Amount (USD)
        </span>
        <div
          className="flex items-center gap-2 rounded-[12px] px-3 py-3"
          style={{ border: "1px solid #EAEAEA", background: "#F7F7F6" }}
        >
          <span className="text-[14px] font-medium" style={{ color: "#787774" }}>
            $
          </span>
          <input
            value={amountUsd}
            onChange={(event) => setAmountUsd(event.target.value)}
            inputMode="decimal"
            placeholder="50"
            className="w-full bg-transparent text-[14px] font-medium outline-none"
            style={{ color: "#111111" }}
          />
        </div>
      </label>

      <button
        onClick={() => void openCheckout()}
        disabled={loading}
        className="w-full rounded-[12px] px-5 py-3 text-[14px] font-semibold tracking-tight transition-opacity disabled:opacity-50"
        style={{ background: "#111111", color: "#fff" }}
      >
        {loading ? "Opening checkout..." : "Add funds with card"}
      </button>

      {error ? (
        <p className="text-[12px]" style={{ color: "#9F2F2D" }}>
          {error}
        </p>
      ) : null}

      <p className="text-[12px]" style={{ color: "#A0A09A" }}>
        Visa, Mastercard, and most debit cards accepted. Funds arrive in your treasury within minutes.
      </p>

      <div className="mt-2 rounded-[14px] p-4 space-y-3" style={{ background: "#F7F6F3", border: "1px solid #EAEAEA" }}>
        <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "#A0A09A" }}>How it works</p>
        {[
          { n: "1", label: "Enter amount",     desc: "Type how much USDC you want to add." },
          { n: "2", label: "Pay with card",    desc: "Complete the secure checkout in seconds." },
          { n: "3", label: "Funds arrive",     desc: "USDC lands in your treasury, agents can spend immediately." },
        ].map(step => (
          <div key={step.n} className="flex items-start gap-3">
            <div className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[10px] font-semibold mt-0.5" style={{ background: "#EAEAEA", color: "#787774" }}>
              {step.n}
            </div>
            <div>
              <p className="text-[12px] font-medium" style={{ color: "#111111" }}>{step.label}</p>
              <p className="text-[11px]" style={{ color: "#787774" }}>{step.desc}</p>
            </div>
          </div>
        ))}
      </div>

      {checkoutLink ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeCheckout}
        >
          <div
            className="relative w-full max-w-4xl overflow-hidden rounded-[24px] bg-white"
            style={{ border: "1px solid #EAEAEA" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex items-center justify-between border-b px-4 py-3"
              style={{ borderColor: "#EAEAEA" }}
            >
              <div>
                <p className="text-[14px] font-semibold" style={{ color: "#111111" }}>
                  Coinflow checkout
                </p>
                <p className="text-[12px]" style={{ color: "#787774" }}>
                  Complete checkout to fund your Float treasury.
                </p>
              </div>
              <button
                type="button"
                onClick={closeCheckout}
                className="rounded-[10px] p-2 transition-opacity hover:opacity-70"
                style={{ color: "#787774" }}
                title="Close checkout"
              >
                <X size={16} />
              </button>
            </div>
            <iframe
              title="Coinflow Checkout"
              src={checkoutLink}
              allow="payment *"
              className="h-[720px] w-full"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FeatureRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-[10px]" style={{ color: "#A0A09A" }}>
        +
      </span>
      <span>{children}</span>
    </li>
  );
}

function EmptyPageState({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="min-h-screen px-6 py-10 md:px-10" style={{ background: "#FBFBFA" }}>
      <div className="mx-auto flex max-w-4xl justify-center">
        <div
          className="w-full max-w-xl rounded-[24px] px-8 py-16 text-center"
          style={{ border: "1px solid #EAEAEA", background: "#fff" }}
        >
          <h1
            className="text-[26px] font-semibold tracking-[-0.03em]"
            style={{ color: "#111111" }}
          >
            {title}
          </h1>
          <p className="mt-3 text-[14px] leading-7" style={{ color: "#787774" }}>
            {message}
          </p>
        </div>
      </div>
    </div>
  );
}

function FundPageSkeleton() {
  return (
    <div className="min-h-screen px-6 py-10 md:px-10" style={{ background: "#FBFBFA" }}>
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="h-8 w-48 rounded-[10px]" style={{ background: "#F2F2F1" }} />
        <div className="h-16 rounded-[18px]" style={{ border: "1px solid #EAEAEA", background: "#fff" }} />
        <div className="grid gap-4 md:grid-cols-[1.15fr_0.85fr]">
          <div className="h-64 rounded-[20px]" style={{ border: "1px solid #EAEAEA", background: "#fff" }} />
          <div className="h-64 rounded-[20px]" style={{ border: "1px solid #EAEAEA", background: "#fff" }} />
        </div>
      </div>
    </div>
  );
}

function formatUsdc(amount: number): string {
  return amount.toLocaleString([], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function toUiAmount(amount: string, decimals: number): number {
  const raw = Number(amount);
  if (!Number.isFinite(raw)) {
    return 0;
  }

  return raw / 10 ** decimals;
}
