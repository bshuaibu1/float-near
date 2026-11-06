/**
 * Give the three switch call sites their expectations.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

must(
  `                      from: info?.paused ? "Paused" : "Running",
                      to: info?.paused ? "Running" : "Paused",
                    },
                  )`,
  `                      from: info?.paused ? "Paused" : "Running",
                      to: info?.paused ? "Running" : "Paused",
                    },
                    { kind: "paused", value: !info?.paused },
                  )`,
  "pause expectation",
);

must(
  `                      from: info?.strictAllocation ? "Strict" : "Overcommit",
                      to: info?.strictAllocation ? "Overcommit" : "Strict",
                    },
                  )`,
  `                      from: info?.strictAllocation ? "Strict" : "Overcommit",
                      to: info?.strictAllocation ? "Overcommit" : "Strict",
                    },
                    { kind: "strict", value: !info?.strictAllocation },
                  )`,
  "allocation expectation",
);

must(
  `                            from: selected?.status === "killed" ? "Frozen" : "Active",
                            to: selected?.status === "killed" ? "Active" : "Frozen",
                          },
                        )`,
  `                            from: selected?.status === "killed" ? "Frozen" : "Active",
                            to: selected?.status === "killed" ? "Active" : "Frozen",
                          },
                          {
                            kind: "frozen",
                            nodeId: selected ? nodeIdOf(selected, agents) : 0,
                            value: selected?.status !== "killed",
                          },
                        )`,
  "freeze expectation",
);

// --- the panel's check UI --------------------------------------------------
must(
  `                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <a
                          href={signLink(t.plan, info?.network ?? "testnet")}`,
  `                      {/* The per-transaction verdict. "not yet" NEVER says
                          failed: a final-finality read taken moments after a
                          write can be a whole transaction behind, so a first
                          miss is far more often lag than a lost change. */}
                      {checkedAt !== null &&
                        (appliedStatus(t.expect, snapshots, info) === "applied" ? (
                          <p
                            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium"
                            style={{ background: "#EDF3EC", color: "#346538" }}
                          >
                            <Check size={12} />
                            Applied - the chain now reports these values
                          </p>
                        ) : (
                          <p
                            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium"
                            style={{ background: "#FEF6E7", color: "#92400E" }}
                          >
                            Not visible yet - sign it, then check again. Reads can lag a
                            write by a few seconds.
                          </p>
                        ))}

                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <a
                          href={signLink(t.plan, info?.network ?? "testnet")}`,
  "per-tx verdict",
);

must(
  `                <p className="mt-3 text-[11px] leading-5 text-faint">
                  {txs.length > 1
                    ? "Each is a separate transaction and needs its own signature. "
                    : ""}
                  The signing page checks the wallet you connect owns this vault.
                </p>`,
  `                <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
                  <button
                    onClick={() => void checkApplied()}
                    disabled={checking}
                    className="inline-flex h-[34px] items-center rounded-md border border-line bg-card px-3 text-[12px] font-medium text-ink transition-colors hover:bg-chip disabled:opacity-40"
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
  "check button",
);

writeFileSync(p, s);
console.log("  switch expectations + check UI wired");
