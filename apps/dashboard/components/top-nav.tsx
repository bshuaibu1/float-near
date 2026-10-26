"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";
import { useWallet, type WalletLoginMethod } from "@/components/wallet-provider";
import { clearFloatOwnerSession, getFloatOwnerSession } from "@/lib/float-session";

// Registry tab hidden — planned as standalone registry.usefloat.xyz once
// APIs are natively x402. Not linked until that work is complete.
const tabs = [
  { label: "Overview", href: "/" },
  { label: "Agents", href: "/agents" },
  { label: "Policies", href: "/policies" },
  { label: "Activity", href: "/activity" },
  { label: "Fund", href: "/fund" },
  { label: "Float Keys", href: "/api-keys" },
  { label: "Docs", href: "https://docs.usefloat.xyz/", external: true },
  { label: "Settings", href: "/settings" },
];

export function TopNav() {
  const pathname = usePathname();
  const { walletAddress, login, disconnect, ready } = useWallet();
  const [ownerSessionLabel, setOwnerSessionLabel] = useState<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [connectMenuOpen, setConnectMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const connectMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const session = getFloatOwnerSession();
    setOwnerSessionLabel(session?.ownerWallet ?? session?.ownerEmail ?? null);
  }, [walletAddress]);

  const displayedAccount = walletAddress ?? ownerSessionLabel;
  const truncatedAddress = displayedAccount
    ? displayedAccount.includes("@")
      ? displayedAccount
      : `${displayedAccount.slice(0, 4)}...${displayedAccount.slice(-4)}`
    : null;

  useEffect(() => {
    if (!accountMenuOpen && !connectMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const clickedOutsideAccount =
        accountMenuRef.current &&
        !accountMenuRef.current.contains(event.target as Node);
      const clickedOutsideConnect =
        connectMenuRef.current &&
        !connectMenuRef.current.contains(event.target as Node);

      if (clickedOutsideAccount) {
        setAccountMenuOpen(false);
      }
      if (clickedOutsideConnect) {
        setConnectMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
        setConnectMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen, connectMenuOpen]);

  const handleConnect = (method: WalletLoginMethod) => {
    setConnectMenuOpen(false);
    void login(method).catch(() => {
      // The full auth screen renders provider errors when auth is required.
    });
  };

  return (
    <header style={{ background: "#FFFFFF", borderBottom: "1px solid #EAEAEA" }}>
      <div className="flex h-14 items-center gap-3 px-4 md:px-6">
        <div className="flex shrink-0 items-center gap-3 md:w-36">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/nobgfloat.png"
            alt="Float"
            style={{ width: 32, height: 32, objectFit: "contain" }}
            className="shrink-0"
          />
          <span
            className="hidden text-[15px] font-bold tracking-[-0.02em] md:inline"
            style={{ color: "#111111" }}
          >
            Float
          </span>
        </div>

        <nav className="scrollbar-hide flex h-full flex-1 overflow-x-auto whitespace-nowrap">
          <div className="flex h-full min-w-max items-center gap-0 md:mx-auto">
            {tabs.map((tab) => {
              const isExternal = "external" in tab && tab.external;
              const active = isExternal
                ? false
                : tab.href === "/"
                  ? pathname === "/"
                  : pathname === tab.href || pathname.startsWith(tab.href + "/");
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  className="relative flex h-full items-center px-4 text-[13px] font-medium transition-colors duration-150"
                  style={{ color: active ? "#111111" : "#787774" }}
                >
                  {tab.label}
                  {active ? (
                    <span
                      className="absolute bottom-0 left-4 right-4 h-[1.5px] rounded-full"
                      style={{ background: "#111111" }}
                    />
                  ) : null}
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="hidden w-32 shrink-0 justify-end md:flex">
          {displayedAccount ? (
            <div ref={accountMenuRef} className="relative">
              <button
                onClick={() => setAccountMenuOpen((open) => !open)}
                className="flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all duration-150 active:scale-[0.97]"
                style={{
                  border: "1px solid #EAEAEA",
                  background: "#fff",
                  color: "#111111",
                }}
                aria-expanded={accountMenuOpen}
                aria-haspopup="menu"
              >
                <div
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: "#346538" }}
                />
                <span className="font-mono">{truncatedAddress}</span>
                <ChevronDown size={12} strokeWidth={2.2} style={{ color: "#787774" }} />
              </button>

              {accountMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-[calc(100%+8px)] z-50 w-56 overflow-hidden rounded-lg text-left"
                  style={{
                    border: "1px solid #EAEAEA",
                    background: "#FFFFFF",
                    boxShadow: "0 18px 44px rgba(17, 17, 17, 0.12)",
                  }}
                >
                  <div className="px-3 py-3">
                    <p
                      className="text-[10px] font-medium uppercase tracking-widest"
                      style={{ color: "#A0A09A" }}
                    >
                      Connected wallet
                    </p>
                    <p
                      className="mt-1 truncate font-mono text-[12px]"
                      style={{ color: "#111111" }}
                      title={displayedAccount}
                    >
                      {displayedAccount}
                    </p>
                  </div>
                  <div style={{ borderTop: "1px solid #F0F0EE" }} />
                  <button
                    role="menuitem"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      clearFloatOwnerSession();
                      setOwnerSessionLabel(null);
                      disconnect();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-medium transition-colors duration-150"
                    style={{ color: "#9F2F2D", background: "#FFFFFF" }}
                  >
                    <LogOut size={14} />
                    Disconnect
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div ref={connectMenuRef} className="relative">
              <button
                onClick={() => setConnectMenuOpen((open) => !open)}
                disabled={!ready}
                className="flex items-center gap-2 rounded-md px-4 py-1.5 text-[12px] font-semibold tracking-wide transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
                style={{
                  background: "#111111",
                  color: "#FFFFFF",
                  border: "1px solid #111111",
                }}
                aria-expanded={connectMenuOpen}
                aria-haspopup="menu"
              >
                Connect
                <ChevronDown size={12} strokeWidth={2.2} />
              </button>

              {connectMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-[calc(100%+8px)] z-50 w-60 overflow-hidden rounded-lg text-left"
                  style={{
                    border: "1px solid #EAEAEA",
                    background: "#FFFFFF",
                    boxShadow: "0 18px 44px rgba(17, 17, 17, 0.12)",
                  }}
                >
                  <div className="px-3 py-3">
                    <p
                      className="text-[10px] font-medium uppercase tracking-widest"
                      style={{ color: "#A0A09A" }}
                    >
                      Sign in
                    </p>
                    <p className="mt-1 text-[12px]" style={{ color: "#787774" }}>
                      Choose how to open Float.
                    </p>
                  </div>
                  <div style={{ borderTop: "1px solid #F0F0EE" }} />
                  <ConnectMenuItem
                    icon={<GoogleIcon />}
                    label="Continue with Google"
                    onClick={() => handleConnect("google")}
                  />
                  <ConnectMenuItem
                    icon={<AppleLogoIcon />}
                    label="Continue with Apple"
                    onClick={() => handleConnect("apple")}
                  />
                  <ConnectMenuItem
                    icon={<PhantomIcon />}
                    label="Continue with Phantom"
                    onClick={() => handleConnect("wallet")}
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function ConnectMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-[13px] font-medium transition-colors duration-150"
      style={{ color: "#111111", background: "#FFFFFF" }}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        style={{ background: "#F6F6F5" }}
      >
        {icon}
      </span>
      {label}
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.24 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.996 10.996 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18A10.996 10.996 0 0 0 1 12c0 1.77.43 3.44 1.18 4.94l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A10.996 10.996 0 0 0 2.18 7.06L5.84 9.9C6.71 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

function AppleLogoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M16.365 1.43c0 1.14-.421 2.185-1.263 3.134-.974 1.088-2.05 1.715-3.216 1.616-.05-1.09.39-2.184 1.237-3.108C14.02 2.074 15.2 1.49 16.365 1.43Zm3.795 16.122c-.477 1.1-.704 1.593-1.319 2.565-.856 1.354-2.063 3.04-3.557 3.052-1.328.012-1.67-.886-3.474-.876-1.803.01-2.18.89-3.509.878-1.493-.014-2.633-1.535-3.49-2.888-2.395-3.788-2.647-8.235-1.169-10.596 1.05-1.676 2.707-2.658 4.264-2.658 1.586 0 2.584.887 3.897.887 1.274 0 2.05-.889 3.887-.889 1.389 0 2.86.755 3.906 2.06-3.433 1.88-2.876 6.78.568 8.465Z" />
    </svg>
  );
}

function PhantomIcon() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/Phantom-Icon_Transparent_Black.svg"
      alt=""
      className="h-4 w-4"
    />
  );
}
