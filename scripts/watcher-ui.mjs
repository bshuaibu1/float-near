/**
 * Swap the manual check button for a live status line, and add the toast.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// --- footer: status, not a button -----------------------------------------
must(
  `                <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
                  <button
                    onClick={() => void checkApplied()}
                    disabled={checking}
                    className="inline-flex h-[40px] items-center rounded-md border border-line bg-card px-3.5 text-[12px] font-medium text-ink transition-colors hover:bg-chip disabled:opacity-40"
                  >
                    {checking ? "Checking..." : "Check if it landed"}
                  </button>
                  <p className="text-[11px] leading-5 text-faint">
                    {txs.length > 1
                      ? "Each is a separate transaction and needs its own signature. "
                      : ""}
                    The signing page checks the wallet you connect owns this vault.
                  </p>
                </div>`,
  `                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
                  {watching ? (
                    <span className="inline-flex items-center gap-2 text-[11.5px] font-medium text-muted">
                      {/* A live pulse, so "nothing is happening yet" is
                          visibly different from "nobody is looking". */}
                      <span className="relative flex h-2 w-2" aria-hidden>
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ink opacity-50" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-ink" />
                      </span>
                      Watching the chain for this change...
                    </span>
                  ) : gaveUp ? (
                    <span className="text-[11.5px] font-medium" style={{ color: "#92400E" }}>
                      Stopped watching. If you have signed since, reload to pick it up.
                    </span>
                  ) : null}
                  <p className="text-[11px] leading-5 text-faint">
                    {txs.length > 1
                      ? "Each is a separate transaction and needs its own signature. "
                      : ""}
                    The signing page checks the wallet you connect owns this vault.
                  </p>
                </div>`,
  "footer",
);

// --- the toast ------------------------------------------------------------
must(
  `          </>
        )}
      </div>
    </div>
  );
}`,
  `          </>
        )}
      </div>

      {/* THE TOAST.
          Deliberately the only thing that interrupts: everything else on this
          page is a readout you consult, but "your signature took effect" is
          news, and it arrives while the reader is looking somewhere else. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 rounded-xl border border-line bg-card px-4 py-3"
          style={{ boxShadow: "0 18px 44px rgba(17, 17, 17, 0.16)" }}
        >
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
            style={{ background: "#EDF3EC" }}
          >
            <Check size={12} style={{ color: "#346538" }} />
          </span>
          <span className="text-[13px] font-medium text-ink">{toast}</span>
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="ml-1 text-[11px] text-faint transition-colors hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}`,
  "toast",
);

writeFileSync(p, s);
console.log("  status line + toast in place");
