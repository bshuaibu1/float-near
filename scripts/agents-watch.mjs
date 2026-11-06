/**
 * Give /agents the same self-confirming watcher as /policies.
 *
 * Freeze now produces a signing link, but after signing the page still showed
 * the old status until a manual reload - so a successful freeze and a dropped
 * one looked identical. The shared hook closes that gap with one tested
 * reducer rather than a second hand-rolled poll loop.
 */
import { readFileSync, writeFileSync } from "node:fs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

const p = "apps/dashboard/app/agents/page.tsx";
const raw = readFileSync(p, "utf8");
const WAS_CRLF = raw.includes(CRLF);
let s = raw.split(CRLF).join(LF);

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// --- imports --------------------------------------------------------------
must(
  'import { useCallback, useEffect, useState } from "react";',
  'import { useCallback, useEffect, useMemo, useState } from "react";',
  "react import",
);

must(
  'import { treeLabel } from "@/lib/tree-label";',
  [
    'import { treeLabel } from "@/lib/tree-label";',
    'import { appliedStatus, type Expectation, type PolicySnapshot } from "@/lib/applied";',
    'import { useChainWatch, useToast } from "@/lib/use-chain-watch";',
    'import { Toast, WatchStatus } from "@/components/toast";',
  ].join(LF),
  "lib imports",
);

// --- the plan carries an expectation --------------------------------------
must(
  [
    "  const [plan, setPlan] = useState<{",
    "    payload: OwnerPayload;",
    "    label: string;",
    "    from: string;",
    "    to: string;",
    "  } | null>(null);",
  ].join(LF),
  [
    "  const [plan, setPlan] = useState<{",
    "    payload: OwnerPayload;",
    "    label: string;",
    "    from: string;",
    "    to: string;",
    "    /** What the chain should show once signed - see lib/applied.ts. */",
    "    expect: Expectation;",
    "  } | null>(null);",
  ].join(LF),
  "plan type",
);

must(
  [
    '          from: frozen ? "Active" : "Frozen",',
    '          to: frozen ? "Frozen" : "Active",',
    "        });",
  ].join(LF),
  [
    '          from: frozen ? "Active" : "Frozen",',
    '          to: frozen ? "Frozen" : "Active",',
    '          expect: { kind: "frozen", nodeId: nodeIdOf(a, agents), value: frozen },',
    "        });",
  ].join(LF),
  "expectation",
);

// --- snapshots + watcher --------------------------------------------------
must(
  "  // Nodes with no resolvable allowlist.",
  [
    "  /** The agent list in the shape lib/applied.ts compares against. */",
    "  const snapshots = useMemo<PolicySnapshot[]>(",
    "    () =>",
    "      agents.map((a) => ({",
    "        nodeId: nodeIdOf(a, agents),",
    "        dailyBudget: a.policy?.dailyBudget,",
    "        perTxLimit: a.policy?.perTxLimit,",
    "        cooldownSeconds: a.policy?.cooldownSeconds,",
    '        frozen: a.status === "killed",',
    "      })),",
    "    [agents],",
    "  );",
    "",
    "  const allApplied = useMemo(",
    "    () =>",
    "      plan !== null &&",
    '      appliedStatus(plan.expect, snapshots, info ? { paused: info.paused, strictAllocation: info.strictAllocation } : null) ===',
    '        "applied",',
    "    [plan, snapshots, info],",
    "  );",
    "",
    "  const { toast, setToast } = useToast();",
    "  const { phase: watchPhase } = useChainWatch({",
    "    txCount: plan ? 1 : 0,",
    "    allApplied,",
    "    refresh: load,",
    "    onApplied: setToast,",
    "  });",
    "",
    "  // Clear the finished panel shortly after the toast, NOT from inside the",
    "  // watcher: on /policies a timer started in the watcher's own effect was",
    "  // cancelled by that effect's cleanup when the watcher changed state.",
    "  useEffect(() => {",
    "    if (!toast) return;",
    "    const t = setTimeout(() => setPlan(null), 1400);",
    "    return () => clearTimeout(t);",
    "  }, [toast]);",
    "",
    "  // Nodes with no resolvable allowlist.",
  ].join(LF),
  "watcher block",
);

// --- render: status line + toast ------------------------------------------
must(
  [
    '              <p className="mt-2.5 text-[11px] leading-5 text-faint">',
    "                The signing page checks the wallet you connect owns this vault.",
    "              </p>",
    "            </div>",
    "          )}",
  ].join(LF),
  [
    '              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">',
    "                <WatchStatus phase={watchPhase} />",
    '                <p className="text-[11px] leading-5 text-faint">',
    "                  The signing page checks the wallet you connect owns this vault.",
    "                </p>",
    "              </div>",
    "            </div>",
    "          )}",
  ].join(LF),
  "status line",
);

// The toast is page-level, so it renders outside the conditional content.
must(
  ["        </>", "      )}", "    </div>", "  );", "}"].join(LF),
  [
    "        </>",
    "      )}",
    "",
    "      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}",
    "    </div>",
    "  );",
    "}",
  ].join(LF),
  "toast",
);

writeFileSync(p, WAS_CRLF ? s.split(LF).join(CRLF) : s);
console.log(`  /agents now self-confirms (CRLF preserved: ${WAS_CRLF})`);
