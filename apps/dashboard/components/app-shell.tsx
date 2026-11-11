"use client";

import type { ReactNode } from "react";
import { TopNav } from "@/components/top-nav";
import { MobileTabBar } from "@/components/mobile-tab-bar";
import { useWallet } from "@/components/wallet-provider";
import { WhoseVault } from "@/components/whose-vault";


function AuthGate({ children }: { children: ReactNode }) {
  const { ready, authenticated, error } = useWallet();

  if (!ready) {
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center bg-canvas"
      >
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-ink" />
      </div>
    );
  }

  if (!authenticated) {
    /**
     * ASK WHO, instead of explaining that a connection failed.
     *
     * This screen used to say "Connect to the vault … use Connect in the top
     * right to retry", which described a connection that does not exist:
     * `login()` opens no wallet, because nothing here needs a signature. The
     * real question was never "are you authenticated" but "whose vault are we
     * looking at", and the dashboard had no way to ask it — so it fell back to
     * the operator's configured vault and a visitor saw someone else's money.
     *
     * `WhoseVault` renders the error and the no-vault offer itself, so both
     * are handled in one place rather than split across two screens.
     */
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-canvas">
        <WhoseVault />
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * PUBLIC_PATHS is gone with its last entry.
 *
 * It let a route render without the nav and the wallet gate, for pages a
 * signed-out visitor had to reach: /link, /auth/callback and /setup. All
 * three were Solana-era and are now deleted, so the array held one path,
 * then none - a switch with nothing left to flip.
 *
 * Every surviving route shows a vault, which requires a connected owner.
 * If a genuinely public page appears later it comes back WITH that page.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { ready, authenticated } = useWallet();

  /**
   * NO CHROME BEFORE WE KNOW WHOSE VAULT IT IS.
   *
   * TopNav and MobileTabBar used to render OUTSIDE the auth gate, so a visitor
   * with no vault got a top bar, a bottom tab bar, and a "Connect" dropdown —
   * around a screen asking them to identify themselves. Every one of those
   * links leads to a page that shows the same prompt again, and the Connect
   * menu opens nothing, because this dashboard has no wallet to connect: it
   * signs nothing.
   *
   * That dropdown is what sent someone looking for a network switcher that
   * does not exist. Navigation to places you cannot go yet is not navigation.
   */
  if (ready && !authenticated) {
    return <AuthGate>{children}</AuthGate>;
  }

  return (
    <>
      <TopNav />
      {/*
        ROOM FOR THE BOTTOM BAR, below `md` only.

        The bar is `position: fixed`, so it is out of flow and the page does
        not know it is there. Without this padding the last element of every
        page sits underneath it — and the thing at the bottom of a page is
        usually the last row of a list or a submit button, so the content
        that disappears is the content you scrolled down to reach.

        56px bar + 24px breathing room, plus the home-indicator inset, which
        is added separately because its height is a runtime value the phone
        reports and not something that can be baked into a number here.
      */}
      <main className="pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0">
        <AuthGate>{children}</AuthGate>
      </main>
      <MobileTabBar />
    </>
  );
}
