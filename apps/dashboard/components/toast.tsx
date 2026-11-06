"use client";

import { Check } from "lucide-react";
import { SUCCESS, SUCCESS_BG, WARN } from "@/lib/colors";

/**
 * The one thing on these pages that interrupts.
 *
 * Everything else is a readout you consult when you choose to. "Your
 * signature took effect" is news, and it arrives while the reader is looking
 * at their wallet or at another tab — so it gets a corner of the screen and
 * six seconds, then gets out of the way.
 *
 * `role="status"` with `aria-live="polite"` rather than an alert: it is
 * confirmation of something the user themselves just did, not a warning, and
 * it should not interrupt a screen reader mid-sentence.
 */
export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 rounded-xl border border-line bg-card px-4 py-3"
      style={{ boxShadow: "0 18px 44px rgba(17, 17, 17, 0.16)" }}
    >
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={{ background: SUCCESS_BG }}
      >
        <Check size={12} style={{ color: SUCCESS }} />
      </span>
      <span className="text-[13px] font-medium text-ink">{message}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ml-1 text-[11px] text-faint transition-colors hover:text-ink"
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * The live "still looking" line that sits with a prepared transaction.
 *
 * A pulse, because "nothing has happened yet" and "nobody is looking" are
 * different states that otherwise render identically.
 */
export function WatchStatus({ phase }: { phase: "idle" | "watching" | "applied" | "gave-up" }) {
  if (phase === "watching") {
    return (
      <span className="inline-flex items-center gap-2 text-[11.5px] font-medium text-muted">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ink opacity-50" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-ink" />
        </span>
        Watching the chain for this change...
      </span>
    );
  }
  if (phase === "gave-up") {
    // NOT "failed". A view call at final finality can trail a write, and the
    // transaction may simply not have been signed yet. All we know is that we
    // stopped looking.
    return (
      <span className="text-[11.5px] font-medium" style={{ color: WARN }}>
        Stopped watching. If you have signed since, reload to pick it up.
      </span>
    );
  }
  return null;
}
