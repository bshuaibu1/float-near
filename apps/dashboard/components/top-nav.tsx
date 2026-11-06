"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, LogOut } from "lucide-react";
import { useWallet, type WalletLoginMethod } from "@/components/wallet-provider";
import { clearFloatOwnerSession, getFloatOwnerSession } from "@/lib/float-session";
import { CARD, DANGER, INK, LINE, MUTED, SUCCESS } from "@/lib/colors";
import { shortAccount } from "@/lib/short-account";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";

type VaultInfo = {
  vaultId: string;
  network: string;
  explorerBase: string;
  paused: boolean;
};

/**
 * The vault account, short enough to sit in a toolbar.
 *
 * `work12-testnet-fleet.fac.floatv4.testnet` is forty characters; the factory
 * suffix is identical for every vault it creates, so the leading label is the
 * only part that distinguishes one from another. The full id stays one click
 * away rather than being truncated into ambiguity.
 */
function shortVaultName(vaultId: string): string {
  return vaultId.split(".")[0] || vaultId;
}


// Registry tab hidden — planned as standalone registry.usefloat.xyz once
// APIs are natively x402. Not linked until that work is complete.
//
// DOCS IS NOT A TAB. Every other entry switches which part of this vault you
// are looking at; Docs leaves the application entirely, and it was the only
// one carrying a target="_blank". It also cost 51px in a strip that was
// measured 42px short of fitting "Settings" at 900px — so the item that is
// not a section is the item that gives up its seat.
const tabs = [
  { label: "Overview", href: "/" },
  { label: "Budget Tree", href: "/agents" },
  { label: "Policies", href: "/policies" },
  { label: "Activity", href: "/activity" },
  { label: "Fund", href: "/fund" },
  { label: "Agent Keys", href: "/api-keys" },
  { label: "Settings", href: "/settings" },
];

const DOCS_URL = "https://docs.usefloat.xyz/";

export function TopNav() {
  const pathname = usePathname();
  const { walletAddress, login, disconnect, ready } = useWallet();
  const [ownerSessionLabel, setOwnerSessionLabel] = useState<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [connectMenuOpen, setConnectMenuOpen] = useState(false);
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const connectMenuRef = useRef<HTMLDivElement | null>(null);
  const vaultMenuRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const [navFade, setNavFade] = useState(false);

  /**
   * Below roughly 870px the seven tabs genuinely do not fit, and no amount of
   * trimming padding changes that — measured 71px short at 820px. The strip
   * has always scrolled; the problem was that a hard clip mid-word reads as a
   * broken layout rather than as "there is more to the right".
   *
   * So: fade the right edge, but ONLY while there is actually something
   * hidden. A permanent fade would dim the last tab at widths where nothing
   * is cut off, which is its own small lie.
   */
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const update = () => {
      const overflows = el.scrollWidth > el.clientWidth + 1;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      setNavFade(overflows && !atEnd);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const session = getFloatOwnerSession();
    setOwnerSessionLabel(session?.ownerWallet ?? session?.ownerEmail ?? null);
  }, [walletAddress]);

  // WHICH vault am I looking at? It was answerable only on Overview, in small
  // grey text — so every other page showed numbers with no way to tell which
  // account they belonged to. A failure to load is silent on purpose: the nav
  // is not the place to report an adapter outage, and each page already does.
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE_URL}/v1/vault-info`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: VaultInfo | null) => {
        if (alive && d?.vaultId) setVault(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const displayedAccount = walletAddress ?? ownerSessionLabel;
  const truncatedAddress = shortAccount(displayedAccount);

  useEffect(() => {
    if (!accountMenuOpen && !connectMenuOpen && !vaultMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const clickedOutsideAccount =
        accountMenuRef.current &&
        !accountMenuRef.current.contains(event.target as Node);
      const clickedOutsideConnect =
        connectMenuRef.current &&
        !connectMenuRef.current.contains(event.target as Node);
      const clickedOutsideVault =
        vaultMenuRef.current && !vaultMenuRef.current.contains(event.target as Node);

      if (clickedOutsideAccount) {
        setAccountMenuOpen(false);
      }
      if (clickedOutsideConnect) {
        setConnectMenuOpen(false);
      }
      if (clickedOutsideVault) {
        setVaultMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
        setConnectMenuOpen(false);
        setVaultMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen, connectMenuOpen, vaultMenuOpen]);

  const handleConnect = (method: WalletLoginMethod) => {
    setConnectMenuOpen(false);
    void login(method).catch(() => {
      // The full auth screen renders provider errors when auth is required.
    });
  };

  return (
    <header style={{ background: CARD, borderBottom: `1px solid ${LINE}` }}>
      <div className="flex h-14 items-center gap-3 px-4 md:px-6">
        <div className="flex shrink-0 items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/nobgfloat.png"
            alt="Float"
            style={{ width: 32, height: 32, objectFit: "contain" }}
            className="shrink-0"
          />
          {/* The wordmark is the first thing to go when space is tight: the
              logo already carries the brand, and the vault id beside it is
              the fact the user cannot get anywhere else. */}
          <span className="hidden text-[15px] font-bold tracking-[-0.02em] text-ink lg:inline">
            Float
          </span>

          {vault ? (
            <div ref={vaultMenuRef} className="relative">
              <button
                onClick={() => setVaultMenuOpen((o) => !o)}
                aria-expanded={vaultMenuOpen}
                aria-haspopup="menu"
                title={vault.vaultId}
                // The chip yields width before the tabs do. Measured at 980px
                // the strip was 18px short of fitting "Settings"; this chip
                // was 176px wide. Truncating HERE is honest — the control is
                // explicitly "click for the full id", and the title attribute
                // carries it on hover — whereas a clipped nav label just
                // reads as broken.
                /* lg:max-w was 11rem (176px), which left the label 140px of
                   the 144px it needs - clipping `work12-testnet-fleet` to
                   `work12-testnet-fle…` for want of FOUR pixels, on a 1440px
                   screen with room to spare. The cap is meant to stop a
                   pathological label eating the toolbar, not to truncate the
                   ordinary case; 14rem clears a ~180px label and still caps. */
                className="flex max-w-[7.5rem] items-center gap-1.5 rounded-md border border-line bg-canvas px-2 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-chip lg:max-w-[14rem]"
              >
                {vault.paused ? (
                  <span
                    aria-label="paused"
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: DANGER }}
                  />
                ) : null}
                <span className="truncate font-mono">{shortVaultName(vault.vaultId)}</span>
                <ChevronDown size={12} strokeWidth={2.2} className="shrink-0 text-muted" />
              </button>

              {vaultMenuOpen ? (
                <div
                  role="menu"
                  className="absolute left-0 top-[calc(100%+8px)] z-50 w-[20rem] overflow-hidden rounded-lg border border-line bg-card text-left"
                  style={{ boxShadow: "0 18px 44px rgba(17, 17, 17, 0.12)" }}
                >
                  <div className="px-3 py-3">
                    <p className="text-[10px] font-medium uppercase tracking-widest text-faint">
                      Vault account
                    </p>
                    {/* FULL, and wrapped rather than truncated. A partially
                        shown account id is worse than none: it reads as
                        precise while being unusable for comparison. */}
                    <p className="mt-1 break-all font-mono text-[12px] leading-5 text-ink">
                      {vault.vaultId}
                    </p>
                    <p className="mt-1.5 text-[11px] text-muted">
                      {vault.network}
                      {vault.paused ? " - paused, every payment is refused" : ""}
                    </p>
                  </div>
                  <div className="border-t border-line" />
                  <button
                    role="menuitem"
                    onClick={() => {
                      void navigator.clipboard.writeText(vault.vaultId);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-medium text-ink transition-colors hover:bg-chip"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? "Copied" : "Copy account id"}
                  </button>
                  {vault.explorerBase ? (
                    <a
                      role="menuitem"
                      href={`${vault.explorerBase}/address/${vault.vaultId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setVaultMenuOpen(false)}
                      className="flex w-full items-center gap-2 border-t border-line px-3 py-2.5 text-left text-[13px] font-medium text-ink transition-colors hover:bg-chip"
                    >
                      <ExternalLink size={14} />
                      View on explorer
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="relative flex h-full min-w-0 flex-1">
        <nav
          ref={navRef}
          className="scrollbar-hide flex h-full flex-1 overflow-x-auto whitespace-nowrap"
        >
          <div className="flex h-full min-w-max items-center gap-0 md:mx-auto">
            {tabs.map((tab) => {
              // Every tab is now an in-app route, so the external branch that
              // forced active=false and added target="_blank" is gone with
              // the Docs entry it existed for.
              const active =
                tab.href === "/"
                  ? pathname === "/"
                  : pathname === tab.href || pathname.startsWith(tab.href + "/");
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  // Padding yields before the label does. At px-4 the eight
                  // tabs plus both side blocks overflowed around 980px and
                  // "Settings" rendered as "Settin" — clipped by the scroll
                  // container, which reads as broken rather than scrollable.
                  className="relative flex h-full items-center px-2.5 text-[13px] font-medium transition-colors duration-150 lg:px-3.5"
                  style={{ color: active ? INK : MUTED }}
                >
                  {tab.label}
                  {active ? (
                    <span
                      className="absolute bottom-0 left-2.5 right-2.5 h-[1.5px] rounded-full bg-ink lg:left-3.5 lg:right-3.5"
                    />
                  ) : null}
                </Link>
              );
            })}
          </div>
        </nav>
        {navFade ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-12"
            style={{
              background: `linear-gradient(to right, rgba(255,255,255,0), ${CARD} 85%)`,
            }}
          />
        ) : null}
        </div>

        <div className="hidden shrink-0 justify-end md:flex">
          {displayedAccount ? (
            <div ref={accountMenuRef} className="relative">
              <button
                onClick={() => setAccountMenuOpen((open) => !open)}
                className="flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all duration-150 active:scale-[0.97]"
                style={{
                  border: `1px solid ${LINE}`,
                  background: CARD,
                  color: INK,
                }}
                aria-expanded={accountMenuOpen}
                aria-haspopup="menu"
              >
                <div
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: SUCCESS }}
                />
                <span className="font-mono">{truncatedAddress}</span>
                <ChevronDown size={12} strokeWidth={2.2} className="text-muted" />
              </button>

              {accountMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-[calc(100%+8px)] z-50 w-56 overflow-hidden rounded-lg text-left"
                  style={{
                    border: `1px solid ${LINE}`,
                    background: CARD,
                    boxShadow: "0 18px 44px rgba(17, 17, 17, 0.12)",
                  }}
                >
                  <div className="px-3 py-3">
                    <p
                      className="text-[10px] font-medium uppercase tracking-widest text-faint"
                    >
                      Connected wallet
                    </p>
                    <p
                      className="mt-1 truncate font-mono text-[12px] text-ink"
                      title={displayedAccount}
                    >
                      {displayedAccount}
                    </p>
                  </div>
                  <div style={{ borderTop: `1px solid ${LINE}` }} />
                  <DocsMenuItem onNavigate={() => setAccountMenuOpen(false)} />
                  <div style={{ borderTop: `1px solid ${LINE}` }} />
                  <button
                    role="menuitem"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      clearFloatOwnerSession();
                      setOwnerSessionLabel(null);
                      disconnect();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-medium transition-colors duration-150"
                    style={{ color: DANGER, background: CARD }}
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
                  background: INK,
                  color: CARD,
                  border: `1px solid ${INK}`,
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
                    border: `1px solid ${LINE}`,
                    background: CARD,
                    boxShadow: "0 18px 44px rgba(17, 17, 17, 0.12)",
                  }}
                >
                  <div className="px-3 py-3">
                    <p
                      className="text-[10px] font-medium uppercase tracking-widest text-faint"
                    >
                      Sign in
                    </p>
                    <p className="mt-1 text-[12px] text-muted">
                      Choose how to open Float.
                    </p>
                  </div>
                  <div style={{ borderTop: `1px solid ${LINE}` }} />
                  {/* ONE action, because there is only one.
                      The NEAR provider's login() does not open a popup and
                      does not ask for a signature — nothing this dashboard
                      does requires one. It re-reads the vault. Offering
                      "Google / Apple / Phantom" was three labels for that same
                      call, and Phantom is a Solana wallet besides. */}
                  <ConnectMenuItem
                    icon={<NearIcon />}
                    label="Connect to the vault"
                    onClick={() => handleConnect("wallet")}
                  />
                  {/* Docs lives in BOTH menus. It left the tab strip for
                      space, and a signed-out visitor is the one most likely
                      to want it — putting it only behind the account menu
                      would hide it from exactly that reader. */}
                  <div style={{ borderTop: `1px solid ${LINE}` }} />
                  <DocsMenuItem onNavigate={() => setConnectMenuOpen(false)} />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function DocsMenuItem({ onNavigate }: { onNavigate: () => void }) {
  return (
    <a
      role="menuitem"
      href={DOCS_URL}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onNavigate}
      className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-medium text-ink transition-colors hover:bg-chip"
    >
      <ExternalLink size={14} />
      Documentation
    </a>
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
      style={{ color: INK, background: CARD }}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-chip"
      >
        {icon}
      </span>
      {label}
    </button>
  );
}



function NearIcon() {
  return (
    <span
      className="flex h-4 w-4 items-center justify-center rounded-[3px] text-[8px] font-bold"
      style={{ background: INK, color: CARD }}
      aria-hidden
    >
      N
    </span>
  );
}
