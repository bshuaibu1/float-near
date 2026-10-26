"use client";

import { useEffect } from "react";

// Setup content has moved to docs.usefloat.xyz (Mintlify).
// This page redirects immediately so existing links don't break.

export default function SetupRedirect() {
  useEffect(() => {
    window.location.replace("https://usefloat.xyz/docs/quickstart");
  }, []);

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: "#FBFBFA" }}
    >
      <p className="text-[14px]" style={{ color: "#787774" }}>
        Redirecting to docs...
      </p>
    </div>
  );
}
