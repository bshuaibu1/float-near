"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ConnectBox, usePhantom } from "@phantom/react-sdk";

const RETURN_TO_KEY = "float.auth.returnTo";
const PHANTOM_APP_ID =
  process.env.NEXT_PUBLIC_PHANTOM_CONNECT_APP_ID?.trim() ?? "";

export default function AuthCallbackPage() {
  if (!PHANTOM_APP_ID) {
    return <CallbackCard />;
  }

  return <AuthCallbackSurface />;
}

function AuthCallbackSurface() {
  const router = useRouter();
  const { isConnected, isLoading } = usePhantom();

  useEffect(() => {
    if (isLoading || !isConnected) return;

    const nextPath = window.sessionStorage.getItem(RETURN_TO_KEY) ?? "/";
    window.sessionStorage.removeItem(RETURN_TO_KEY);
    router.replace(nextPath);
  }, [isConnected, isLoading, router]);

  return <CallbackCard showConnectBox />;
}

function CallbackCard({ showConnectBox = false }: { showConnectBox?: boolean }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 py-10"
      style={{ background: "#FBFBFA" }}
    >
      <div
        className="w-full max-w-sm rounded-[24px] px-6 py-8 text-center"
        style={{ border: "1px solid #EAEAEA", background: "#FFFFFF" }}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-[15px] font-medium" style={{ color: "#111111" }}>
              Finishing sign-in
            </p>
            <p className="text-[13px] leading-6" style={{ color: "#787774" }}>
              Approve the Phantom prompt if it appears. You&apos;ll be redirected
              back to Float automatically.
            </p>
          </div>
          {showConnectBox ? (
            <div className="flex justify-center">
              <ConnectBox
                transparent
                appName="Float"
                appIcon="/nobgfloat.png"
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
