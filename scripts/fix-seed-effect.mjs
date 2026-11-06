/**
 * Stop the draft-seeding effect from firing on every data refresh.
 *
 * MEASURED BUG: clicking "Check if it landed" called load(), which replaced
 * `agents`, which rebuilt `base`, which changed `resetDrafts`'s identity,
 * which re-ran the effect - wiping `txs` (the panel showing the verdict) and
 * reverting the user's pending edit from 150 back to 100. The verification
 * feature destroyed the thing it was verifying.
 *
 * Seeding is an AGENT-SWITCH concern, not a data-freshness concern. A ref
 * pins which agent has been seeded so a refresh leaves drafts alone, and
 * "Discard" becomes the one explicit path that clears the panel.
 *
 * Keeping drafts across a refresh is also what makes the verdict legible: if
 * the change landed, the refreshed `base` now equals the draft, so the row's
 * change markers and the sticky bar clear themselves. That is the proof,
 * rendered by the page's own state rather than asserted by a banner.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// useRef must be imported.
must(
  'import { useCallback, useEffect, useMemo, useState } from "react";',
  'import { useCallback, useEffect, useMemo, useRef, useState } from "react";',
  "useRef import",
);

// resetDrafts no longer clears the panel; it only seeds.
must(
  `    setRecipients(base.ownRecipients.join("\\n"));
    setTxs([]);
    setPlanError(null);
  }, [base]);

  useEffect(() => {
    resetDrafts();
  }, [selectedId, resetDrafts]);`,
  `    setRecipients(base.ownRecipients.join("\\n"));
  }, [base]);

  /**
   * Seed ONLY when the selected agent changes.
   *
   * Without the ref this effect also fires whenever \`agents\` is refetched,
   * because \`base\` is derived from it - which silently discarded pending
   * edits on every refresh.
   */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || seededFor.current === selectedId) return;
    seededFor.current = selectedId;
    resetDrafts();
  }, [selectedId, selected, resetDrafts]);

  /** The explicit throw-away: drafts AND the prepared panel. */
  const discardDrafts = useCallback(() => {
    resetDrafts();
    setTxs([]);
    setPlanError(null);
    setCheckedAt(null);
  }, [resetDrafts]);`,
  "seed effect",
);

// The Discard button must use the explicit path.
must(
  `                      onClick={resetDrafts}
                      className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-ink"`,
  `                      onClick={discardDrafts}
                      className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-ink"`,
  "discard button",
);

writeFileSync(p, s);
console.log("  seeding is now agent-switch-only; Discard is the explicit clear");
