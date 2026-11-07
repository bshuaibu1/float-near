"use client";

import type { ReactNode } from "react";
import { TopNav } from "@/components/top-nav";
import { MobileTabBar } from "@/components/mobile-tab-bar";
import { useWallet } from "@/components/wallet-provider";
import { DANGER, DANGER_BG } from "@/lib/colors";


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
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center px-4 bg-canvas"
      >
        <div className="w-full max-w-md text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/nobgfloat.png"
            alt="Float"
            className="mx-auto h-24 w-24 object-contain"
          />
          <h1
            className="mt-8 text-[30px] font-semibold leading-tight text-ink"
          >
            Connect to the vault
          </h1>
          <p
            className="mx-auto mt-3 max-w-sm text-[14px] leading-6 text-muted"
          >
            This dashboard reads a NEAR vault contract. Use Connect in the top
            right to retry — no signature is needed, and nothing here can move
            funds.
          </p>
          {error ? (
            <p
              className="mx-auto mt-5 rounded-lg px-3 py-2 text-left text-[12px] leading-5"
              style={{
                border: "1px solid #F2D7D9",
                background: DANGER_BG,
                color: DANGER,
              }}
            >
              {error}
            </p>
          ) : null}
        </div>
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
