"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { TopNav } from "@/components/top-nav";
import { useWallet } from "@/components/wallet-provider";

const PUBLIC_PATHS = ["/link", "/auth/callback", "/setup"];

function AuthGate({ children }: { children: ReactNode }) {
  const { ready, authenticated, error } = useWallet();

  if (!ready) {
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center"
        style={{ background: "#FBFBFA" }}
      >
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#EAEAEA] border-t-[#111111]" />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center px-4"
        style={{ background: "#FBFBFA" }}
      >
        <div className="w-full max-w-md text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/nobgfloat.png"
            alt="Float"
            className="mx-auto h-24 w-24 object-contain"
          />
          <h1
            className="mt-8 text-[30px] font-semibold leading-tight"
            style={{ color: "#111111" }}
          >
            Connect to the vault
          </h1>
          <p
            className="mx-auto mt-3 max-w-sm text-[14px] leading-6"
            style={{ color: "#787774" }}
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
                background: "#FDEBEC",
                color: "#9F2F2D",
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

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isPublic = PUBLIC_PATHS.some((path) => pathname.startsWith(path));

  if (isPublic) {
    return <main>{children}</main>;
  }

  return (
    <>
      <TopNav />
      <main>
        <AuthGate>{children}</AuthGate>
      </main>
    </>
  );
}
