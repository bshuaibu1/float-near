"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { AddressType } from "@phantom/browser-sdk";
import {
  useAccounts,
  useConnect,
  useIsExtensionInstalled,
  usePhantom,
  useSolana,
} from "@phantom/react-sdk";
import { Check, ChevronRight, Copy } from "lucide-react";
import { saveFloatOwnerSession } from "@/lib/float-session";

interface OwnerIdentity {
  authMethod: "wallet" | "google" | "apple" | "email";
  walletAddress?: string;
  email?: string;
  displayName?: string;
}

interface LinkSessionResponse {
  token: string;
  agentId: string;
  status: "pending" | "completed";
  createdAt: string;
  expiresAt: string;
  linkUrl: string;
  owner?: OwnerIdentity;
  result?: {
    agentId: string;
    walletAddress: string;
    apiKey: string;
    createdAt: string;
    owner: OwnerIdentity;
    ownerControlKey: string;
    treasury?: {
      walletAddress: string;
      createdAt: string;
    };
  };
  error?: string;
}

type AuthPhase = "idle" | "connecting" | "signing" | "submitting" | "success";
type AuthMethod = "google" | "apple" | "wallet";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";
const RETURN_TO_KEY = "float.auth.returnTo";
const LINK_AUTH_STARTED_KEY = "float.link.started";
const LINK_AUTH_METHOD_KEY = "float.link.method";

export default function LinkPage() {
  return (
    <Suspense fallback={<LinkPageSkeleton />}>
      <LinkPageContent />
    </Suspense>
  );
}

function LinkPageContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token")?.trim() || "";

  const [session, setSession] = useState<LinkSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const expiresLabel = useMemo(() => {
    if (!session?.expiresAt) return null;
    return new Date(session.expiresAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }, [session?.expiresAt]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError("Missing link token.");
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(
          `${API_BASE_URL}/v1/link-sessions/${token}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as LinkSessionResponse;
        if (!response.ok) {
          throw new Error(payload.error ?? "Unable to load link session.");
        }
        if (!cancelled) {
          setSession(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || session?.status !== "pending") return;

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/v1/link-sessions/${token}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as LinkSessionResponse;
        if (response.ok) setSession(payload);
      } catch {
        // best-effort poll
      }
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [session?.status, token]);

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 py-10"
      style={{ background: "#FBFBFA" }}
    >
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <div className="space-y-3">
          <h1
            className="text-[32px] font-semibold tracking-[-0.04em]"
            style={{ color: "#111111" }}
          >
            Link this agent to your account
          </h1>
          <p
            className="mx-auto max-w-sm text-[14px] leading-6"
            style={{ color: "#787774" }}
          >
            Finish{" "}
            <code
              className="rounded-md px-1.5 py-0.5 font-mono text-[13px]"
              style={{ color: "#111111", background: "#F3F3F1" }}
            >
              npx @usefloat/cli init
            </code>{" "}
            by connecting below.
          </p>
        </div>

        {loading ? (
          <div
            className="w-full rounded-[24px] p-6"
            style={{ border: "1px solid #EAEAEA", background: "#FFFFFF" }}
          >
            <div className="space-y-4">
              <div
                className="mx-auto h-4 w-28 rounded-full"
                style={{ background: "#F2F2F1" }}
              />
              <div
                className="h-12 w-full rounded-[16px]"
                style={{ background: "#F2F2F1" }}
              />
              <div
                className="h-12 w-full rounded-[16px]"
                style={{ background: "#F2F2F1" }}
              />
              <div
                className="h-12 w-full rounded-[16px]"
                style={{ background: "#F2F2F1" }}
              />
            </div>
          </div>
        ) : error ? (
          <div
            className="w-full rounded-[18px] p-4 text-[14px]"
            style={{
              border: "1px solid #F2D7D9",
              background: "#FDEBEC",
              color: "#9F2F2D",
            }}
          >
            {error}
          </div>
        ) : session?.status === "completed" && session.result ? (
          <div
            className="w-full rounded-[24px] p-6 text-left"
            style={{ border: "1px solid #EAEAEA", background: "#FFFFFF" }}
          >
            <SuccessView result={session.result} />
          </div>
        ) : (
          <AuthSurface
            token={token}
            session={session}
            onCompleted={setSession}
            onError={setError}
          />
        )}

        {expiresLabel && session?.status !== "completed" ? (
          <p className="text-[12px]" style={{ color: "#A0A09A" }}>
            Session expires at {expiresLabel}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AuthSurface({
  token,
  session,
  onCompleted,
  onError,
}: {
  token: string;
  session: LinkSessionResponse | null;
  onCompleted: (session: LinkSessionResponse) => void;
  onError: (message: string | null) => void;
}) {
  const accounts = useAccounts();
  const { connect, isConnecting } = useConnect();
  const { isConnected, isLoading } = usePhantom();
  const { isInstalled } = useIsExtensionInstalled();
  const { solana, isAvailable: isSolanaAvailable } = useSolana();

  const [phase, setPhase] = useState<AuthPhase>("idle");
  const hasSignedRef = useRef(false);
  const startedAuthRef = useRef(false);
  const selectedMethodRef = useRef<AuthMethod | null>(null);

  const walletAddress = useMemo(() => {
    if (!accounts || accounts.length === 0) {
      return null;
    }

    return (
      accounts.find((account) => account.addressType === AddressType.solana)
        ?.address ??
      accounts[0]?.address ??
      null
    );
  }, [accounts]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    startedAuthRef.current =
      window.sessionStorage.getItem(LINK_AUTH_STARTED_KEY) === "1";

    const storedMethod = window.sessionStorage.getItem(LINK_AUTH_METHOD_KEY);
    if (
      storedMethod === "google" ||
      storedMethod === "apple" ||
      storedMethod === "wallet"
    ) {
      selectedMethodRef.current = storedMethod;
    } else {
      selectedMethodRef.current = null;
    }
  }, []);

  const clearPendingAuthState = useCallback(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(LINK_AUTH_STARTED_KEY);
    window.sessionStorage.removeItem(LINK_AUTH_METHOD_KEY);
  }, []);

  const persistPendingAuthState = useCallback((method: AuthMethod) => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(LINK_AUTH_STARTED_KEY, "1");
    window.sessionStorage.setItem(LINK_AUTH_METHOD_KEY, method);
    window.sessionStorage.setItem(
      RETURN_TO_KEY,
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);

  const postSession = useCallback(
    async (walletAddressValue: string, signedMessage: string, message: string) => {
      setPhase("submitting");
      onError(null);

      try {
        const response = await fetch(
          `${API_BASE_URL}/v1/link-sessions/${token}/complete`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              phantomSession: {
                walletAddress: walletAddressValue,
                signedMessage,
                message,
              },
            }),
          },
        );
        const payload = (await response.json()) as LinkSessionResponse;
        if (!response.ok) {
          throw new Error(payload.error ?? "Unable to complete link session.");
        }
        if (payload.result?.ownerControlKey) {
          saveFloatOwnerSession({
            ownerControlKey: payload.result.ownerControlKey,
            ownerWallet: payload.result.owner.walletAddress ?? null,
            ownerEmail: payload.result.owner.email ?? null,
            ownerDisplayName: payload.result.owner.displayName ?? null,
            agentId: payload.result.agentId,
            agentWalletAddress: payload.result.walletAddress,
            treasuryWalletAddress: payload.result.treasury?.walletAddress,
            savedAt: new Date().toISOString(),
          });
        }
        clearPendingAuthState();
        startedAuthRef.current = false;
        selectedMethodRef.current = null;
        setPhase("success");
        onCompleted(payload);
      } catch (err) {
        onError(normalizeAuthError(err));
        hasSignedRef.current = false;
        setPhase("idle");
      }
    },
    [clearPendingAuthState, onCompleted, onError, token],
  );

  useEffect(() => {
    if (isLoading || !isConnected || !walletAddress || !isSolanaAvailable) return;
    if (!startedAuthRef.current) return;
    if (hasSignedRef.current || session?.status === "completed") {
      return;
    }

    let cancelled = false;
    hasSignedRef.current = true;
    setPhase("signing");

    const message = `Float link session: ${token}`;

    solana
      .signMessage(message)
      .then((result) => {
        const signedMessage = normalizePhantomSignedMessage(result);
        if (!signedMessage) {
          throw new Error("Phantom did not return a usable signature.");
        }
        if (!cancelled) {
          void postSession(walletAddress, signedMessage, message);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          clearPendingAuthState();
          startedAuthRef.current = false;
          selectedMethodRef.current = null;
          hasSignedRef.current = false;
          onError(normalizeAuthError(err));
          setPhase("idle");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    clearPendingAuthState,
    isConnected,
    isLoading,
    isSolanaAvailable,
    onError,
    postSession,
    session?.status,
    solana,
    token,
    walletAddress,
  ]);

  const handleConnect = useCallback(
    async (method: AuthMethod) => {
      startedAuthRef.current = true;
      selectedMethodRef.current = method;
      hasSignedRef.current = false;
      persistPendingAuthState(method);
      setPhase("connecting");
      onError(null);

      if (isConnected && walletAddress) {
        return;
      }

      try {
        await connect({
          provider:
            method === "google"
              ? "google"
              : method === "apple"
                ? "apple"
                : isInstalled
                  ? "injected"
                  : "phantom",
        });
      } catch (err) {
        clearPendingAuthState();
        startedAuthRef.current = false;
        selectedMethodRef.current = null;
        hasSignedRef.current = false;
        setPhase("idle");
        onError(normalizeAuthError(err));
      }
    },
    [
      clearPendingAuthState,
      connect,
      isConnected,
      isInstalled,
      onError,
      persistPendingAuthState,
      walletAddress,
    ],
  );

  const isBusy =
    phase === "connecting" ||
    phase === "signing" ||
    phase === "submitting" ||
    phase === "success" ||
    isConnecting;

  return (
    <div
      className="w-full rounded-[24px] p-6"
      style={{ border: "1px solid #EAEAEA", background: "#FFFFFF" }}
    >
      <div className="space-y-6 text-center">
        <div className="flex flex-col items-center space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/nobgfloat.png"
            alt="Float"
            className="h-14 w-14 object-contain"
          />
          <div className="space-y-2">
            <p className="text-[13px] font-medium" style={{ color: "#111111" }}>
              Login or sign up
            </p>
            <p className="text-[13px] leading-6" style={{ color: "#787774" }}>
              Connect once, sign once, and the CLI will finish automatically.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <AuthButton
            label={
              phase === "connecting" && selectedMethodRef.current === "google"
                ? "Connecting..."
                : phase === "signing"
                  ? "Approve signature..."
                  : phase === "submitting"
                    ? "Finishing setup..."
                    : "Continue with Google"
            }
            onClick={() => {
              void handleConnect("google");
            }}
            disabled={isBusy}
            icon={<GoogleIcon />}
          />

          <AuthButton
            label={
              phase === "connecting" && selectedMethodRef.current === "apple"
                ? "Connecting..."
                : "Continue with Apple"
            }
            onClick={() => {
              void handleConnect("apple");
            }}
            disabled={isBusy}
            icon={<AppleLogoIcon />}
          />

          <div className="flex items-center gap-3">
            <div className="h-px flex-1" style={{ background: "#EAEAEA" }} />
            <span className="text-[12px]" style={{ color: "#A0A09A" }}>
              or
            </span>
            <div className="h-px flex-1" style={{ background: "#EAEAEA" }} />
          </div>

          <AuthButton
            label={
              phase === "connecting" && selectedMethodRef.current === "wallet"
                ? "Opening Phantom..."
                : "Continue with Phantom"
            }
            onClick={() => {
              void handleConnect("wallet");
            }}
            disabled={isBusy}
            kind="primary"
            icon={<PhantomIcon />}
          />
        </div>

        <div
          className="rounded-[14px] px-4 py-3 text-[12px]"
          style={{
            border: "1px solid #EAEAEA",
            background: "#FAFAF9",
            color: "#787774",
          }}
        >
          {phase === "connecting"
            ? "Waiting for sign-in to complete..."
            : phase === "signing"
              ? "Connected. Approve the Float link message to continue."
              : phase === "submitting"
                ? "Finishing setup. Head back to your terminal in a moment."
                : "Pick Google, Apple, or Phantom. We only ask you to sign a short link message."}
        </div>
      </div>
    </div>
  );
}

function AuthButton({
  label,
  onClick,
  disabled = false,
  kind = "secondary",
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary";
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-[16px] px-5 py-4 text-left text-[15px] font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      style={
        kind === "primary"
          ? {
              background: "#111111",
              color: "#FFFFFF",
              border: "1px solid #111111",
            }
          : {
              background: "#F4F4F2",
              color: "#111111",
              border: "1px solid #EAEAEA",
            }
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {icon ? (
            <span
              className="inline-flex h-8 w-8 items-center justify-center rounded-[10px]"
              style={{
                background: "#FFFFFF",
                color: kind === "primary" ? "#111111" : "#111111",
              }}
            >
              {icon}
            </span>
          ) : null}
          <span>{label}</span>
        </div>
        <ChevronRight
          size={16}
          style={{ color: kind === "primary" ? "#FFFFFF" : "#A0A09A" }}
        />
      </div>
    </button>
  );
}

function SuccessView({
  result,
}: {
  result: NonNullable<LinkSessionResponse["result"]>;
}) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium"
          style={{ border: "1px solid #DCEEDC", background: "#F3FAF3", color: "#2F6B3D" }}
        >
          <Check size={10} strokeWidth={2.5} />
          Agent linked
        </div>
        <h2
          className="text-[24px] font-semibold tracking-[-0.03em]"
          style={{ color: "#111111" }}
        >
          Float is ready
        </h2>
        <p className="text-[14px] leading-relaxed" style={{ color: "#787774" }}>
          Head back to your terminal. The CLI will detect this and finish setup automatically.
          You can also open your dashboard now to fund and manage this agent.
        </p>
      </div>

      {/* Divider */}
      <div style={{ height: "1px", background: "#EAEAEA" }} />

      {/* Data grid */}
      <dl className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <SummaryCard label="Agent" value={result.agentId} />
          <SummaryCard label="Issued" value={formatDateTime(result.createdAt)} />
        </div>
        <AddressCard label="Wallet" value={result.walletAddress} />
        <AddressCard
          label="Owner"
          value={result.owner.walletAddress ?? result.owner.authMethod}
          mono={!!result.owner.walletAddress}
        />
        {result.treasury?.walletAddress ? (
          <AddressCard label="Treasury" value={result.treasury.walletAddress} />
        ) : null}
      </dl>

      <a
        href="/agents"
        className="block rounded-[14px] px-4 py-3 text-center text-[13px] font-semibold transition-opacity hover:opacity-90"
        style={{ background: "#111111", color: "#FFFFFF" }}
      >
        Open dashboard
      </a>
    </div>
  );
}

function LinkPageSkeleton() {
  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 py-10"
      style={{ background: "#FBFBFA" }}
    >
      <div className="w-full max-w-md space-y-6">
        <div
          className="mx-auto h-10 w-64 rounded-[14px]"
          style={{ background: "#F2F2F1" }}
        />
        <div
          className="w-full rounded-[24px] p-6"
          style={{ border: "1px solid #EAEAEA", background: "#FFFFFF" }}
        >
          <div className="space-y-4">
            <div
              className="mx-auto h-4 w-24 rounded-full"
              style={{ background: "#F2F2F1" }}
            />
            <div
              className="h-12 w-full rounded-[16px]"
              style={{ background: "#F2F2F1" }}
            />
            <div
              className="h-12 w-full rounded-[16px]"
              style={{ background: "#F2F2F1" }}
            />
            <div
              className="h-12 w-full rounded-[16px]"
              style={{ background: "#F2F2F1" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-[18px] p-4"
      style={{ border: "1px solid #EAEAEA", background: "#FCFCFB" }}
    >
      <p
        className="text-[11px] font-medium uppercase tracking-[0.16em]"
        style={{ color: "#A0A09A" }}
      >
        {label}
      </p>
      <p
        className="mt-2 truncate text-[14px] font-medium"
        style={{ color: "#111111" }}
      >
        {value}
      </p>
    </div>
  );
}

function AddressCard({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const truncated =
    mono && value.length > 20
      ? `${value.slice(0, 8)}...${value.slice(-6)}`
      : value;

  function handleCopy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div
      className="flex items-center justify-between rounded-[18px] px-4 py-3"
      style={{ border: "1px solid #EAEAEA", background: "#FCFCFB" }}
    >
      <div className="min-w-0 flex-1">
        <p
          className="text-[11px] font-medium uppercase tracking-[0.16em]"
          style={{ color: "#A0A09A" }}
        >
          {label}
        </p>
        <p
          className={`mt-1 truncate text-[14px] font-medium ${mono ? "font-mono" : ""}`}
          style={{ color: "#111111" }}
          title={value}
        >
          {truncated}
        </p>
      </div>
      {mono && (
        <button
          onClick={handleCopy}
          className="ml-3 flex-shrink-0 rounded-[10px] p-2 transition-colors duration-150"
          style={{
            background: copied ? "#F3FAF3" : "#F2F2F1",
            color: copied ? "#2F6B3D" : "#787774",
          }}
          title="Copy address"
        >
          {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} />}
        </button>
      )}
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
}

function normalizePhantomSignedMessage(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const candidate = result as {
    rawSignature?: string;
    signature?: string | Uint8Array;
  };

  if (typeof candidate.rawSignature === "string" && candidate.rawSignature.trim()) {
    return candidate.rawSignature.trim();
  }

  if (typeof candidate.signature === "string" && candidate.signature.trim()) {
    return candidate.signature.trim();
  }

  if (candidate.signature instanceof Uint8Array) {
    return bytesToBase64(candidate.signature);
  }

  return null;
}

function normalizeAuthError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Authentication failed.";

  if (message.includes("4001") || /rejected|cancelled/i.test(message)) {
    return "The request was cancelled. Try again and approve the wallet prompt.";
  }
  if (/not detected|not installed/i.test(message)) {
    return "Phantom was not detected in this browser.";
  }
  return message;
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M21.805 12.23c0-.79-.071-1.547-.203-2.273H12v4.302h5.488a4.695 4.695 0 0 1-2.037 3.081v2.56h3.296c1.93-1.777 3.058-4.398 3.058-7.67Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.76 0 5.074-.915 6.765-2.48l-3.296-2.56c-.914.612-2.082.973-3.469.973-2.668 0-4.928-1.8-5.736-4.22H2.857v2.64A9.997 9.997 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.264 13.713A5.99 5.99 0 0 1 5.943 12c0-.595.107-1.171.321-1.713V7.647H2.857A9.998 9.998 0 0 0 2 12c0 1.607.383 3.13 1.057 4.353l3.207-2.64Z"
        fill="#FBBC04"
      />
      <path
        d="M12 6.067c1.502 0 2.852.517 3.914 1.533l2.934-2.934C17.069 3.009 14.755 2 12 2 8.143 2 4.797 4.206 3.057 7.647l3.207 2.64c.808-2.42 3.068-4.22 5.736-4.22Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function AppleLogoIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M16.365 12.233c.026 2.797 2.454 3.726 2.481 3.738-.02.066-.387 1.326-1.273 2.628-.766 1.125-1.561 2.247-2.814 2.27-1.232.023-1.629-.73-3.039-.73-1.41 0-1.851.707-3.016.753-1.209.046-2.129-1.209-2.901-2.329-1.58-2.287-2.786-6.461-1.166-9.273.805-1.397 2.244-2.281 3.806-2.305 1.188-.023 2.309.8 3.039.8.73 0 2.102-.99 3.542-.844.603.025 2.296.243 3.384 1.835-.088.055-2.02 1.176-2.043 3.457Zm-2.476-7.81c.642-.778 1.074-1.86.956-2.94-.924.037-2.041.615-2.704 1.392-.595.688-1.117 1.788-.976 2.84 1.03.08 2.083-.524 2.724-1.292Z" />
    </svg>
  );
}

function PhantomIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M5.556 15.259c.21-.305.63-.38.935-.17l1.164.802c.304.21.379.63.169.935a.667.667 0 0 1-.936.169l-1.163-.801a.667.667 0 0 1-.169-.935Zm10.263-6.704c1.297 0 2.348 1.052 2.348 2.349v1.519c0 2.64-2.14 4.781-4.78 4.781h-.562a.667.667 0 1 1 0-1.334h.562a3.448 3.448 0 0 0 3.447-3.447v-1.519a1.015 1.015 0 0 0-2.03 0v1.27a.667.667 0 1 1-1.333 0v-1.27a2.349 2.349 0 0 1 2.348-2.349Zm-7.638 0a2.349 2.349 0 0 1 2.348 2.349v1.27a.667.667 0 1 1-1.333 0v-1.27a1.015 1.015 0 0 0-2.03 0v1.519a3.448 3.448 0 0 0 3.447 3.447h.562a.667.667 0 1 1 0 1.334h-.562a4.781 4.781 0 0 1-4.78-4.781v-1.519a2.349 2.349 0 0 1 2.348-2.349Zm3.82-3.907c2.148 0 3.889 1.741 3.889 3.889v2.37a.667.667 0 0 1-1.334 0v-2.37a2.555 2.555 0 0 0-5.11 0v2.37a.667.667 0 0 1-1.333 0v-2.37a3.889 3.889 0 0 1 3.888-3.889Z" />
    </svg>
  );
}
