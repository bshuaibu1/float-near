"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// This route has been superseded by /activity.
// Redirect permanently so any bookmarked or linked URLs still work.
export default function PaymentsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/activity"); }, [router]);
  return null;
}
