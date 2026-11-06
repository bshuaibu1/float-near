/**
 * Two fixes from installing the watcher at the wrong insertion point.
 *
 *  1. `discardDrafts` still called the removed `setCheckedAt`. Discarding
 *     should also STOP the watch - otherwise the page keeps polling for a
 *     transaction the user has just thrown away.
 *  2. `allApplied` referenced `snapshots` above its declaration. The whole
 *     watcher block moves below it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// --- 1. discardDrafts ------------------------------------------------------
must(
  `    resetDrafts();
    setTxs([]);
    setPlanError(null);
    setCheckedAt(null);
  }, [resetDrafts]);`,
  `    resetDrafts();
    setTxs([]);
    setPlanError(null);
    // Stop the watcher too: there is no longer a transaction to watch for,
    // and leaving it running would poll the chain for a discarded intent.
    setWatching(false);
    setGaveUp(false);
  }, [resetDrafts]);`,
  "discardDrafts",
);

// --- 2. move the watcher below `snapshots` --------------------------------
const START = "  /** Everything prepared is now visible on chain. */";
const END = "  /** The agent list in the shape lib/applied.ts compares against. */";

const a = s.indexOf(START);
const b = s.indexOf(END);
if (a < 0 || b < 0 || b < a) throw new Error("watcher/snapshots markers not found");

const watcher = s.slice(a, b);
s = s.slice(0, a) + s.slice(b);

// `snapshots` ends at the next blank line after its useMemo closes.
const snapAt = s.indexOf(END);
const closeAt = s.indexOf("    [agents],\n  );\n", snapAt);
if (closeAt < 0) throw new Error("snapshots memo terminator not found");
const insertAt = closeAt + "    [agents],\n  );\n".length;

s = s.slice(0, insertAt) + "\n" + watcher + s.slice(insertAt);

writeFileSync(p, s);
console.log("  discardDrafts stops the watch; watcher moved below snapshots");
