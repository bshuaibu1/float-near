/**
 * Replace the manual "Check if it landed" button with a self-driving watcher
 * and a toast.
 *
 * Asking the owner to press a button to find out whether their own signature
 * worked puts the burden in the wrong place: the page already knows what it
 * expected and can read the chain itself. The button also had to be pressed
 * at the right MOMENT - too early and it honestly said "not visible yet",
 * which reads like failure to anyone who does not know a view call can trail
 * a write.
 *
 * So the page watches instead: once a transaction is prepared it polls until
 * the chain reports what was asked for, then says so once and gets out of the
 * way.
 *
 * Bounded deliberately. An unbounded poll against a public RPC is a way to
 * get rate-limited - this adapter has already self-rate-limited once in this
 * project - and a transaction that is never signed would otherwise poll
 * forever in a background tab.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// --- state ----------------------------------------------------------------
must(
  `  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);`,
  `  // The watcher. \`gaveUp\` is NOT "it failed" - it is "we stopped looking".
  const [watching, setWatching] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const polls = useRef(0);`,
  "state",
);

// --- replace the manual checker -------------------------------------------
must(
  `  const checkApplied = useCallback(async () => {
    setChecking(true);
    try {
      await load();
      setCheckedAt(Date.now());
    } finally {
      setChecking(false);
    }
  }, [load]);`,
  `  /**
   * How long to keep looking. 4s x 45 is three minutes, which comfortably
   * covers a NEAR testnet transaction plus the lag between a write landing
   * and a final-finality view reporting it, without pinning a public RPC
   * forever when the owner simply closed the wallet without signing.
   */
  const POLL_MS = 4000;
  const MAX_POLLS = 45;`,
  "checker -> constants",
);

// --- the watcher ----------------------------------------------------------
must(
  "  /** The agent list in the shape lib/applied.ts compares against. */",
  `  /** Everything prepared is now visible on chain. */
  const allApplied = useMemo(
    () =>
      txs.length > 0 &&
      txs.every((t) => appliedStatus(t.expect, snapshots, info) === "applied"),
    [txs, snapshots, info],
  );

  // A freshly prepared transaction restarts the watch.
  useEffect(() => {
    polls.current = 0;
    setGaveUp(false);
    setWatching(txs.length > 0);
  }, [txs]);

  useEffect(() => {
    if (!watching) return;

    if (allApplied) {
      setWatching(false);
      setToast(txs.length > 1 ? \`\${txs.length} changes applied\` : "Change applied");
      // Leave the panel up briefly so the green tick is seen, then clear it.
      const t = setTimeout(() => setTxs([]), 1400);
      return () => clearTimeout(t);
    }

    const id = setInterval(() => {
      // Don't poll a tab nobody is looking at. The watch resumes on return
      // because the interval keeps running; it just skips the fetch.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      polls.current += 1;
      if (polls.current > MAX_POLLS) {
        setWatching(false);
        setGaveUp(true);
        return;
      }
      void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [watching, allApplied, txs.length, load]);

  // The toast says its piece and leaves.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  /** The agent list in the shape lib/applied.ts compares against. */`,
  "watcher",
);

// --- per-transaction verdict ----------------------------------------------
must(
  `                      {checkedAt !== null &&
                        (appliedStatus(t.expect, snapshots, info) === "applied" ? (`,
  `                      {(appliedStatus(t.expect, snapshots, info) === "applied" || gaveUp) &&
                        (appliedStatus(t.expect, snapshots, info) === "applied" ? (`,
  "verdict condition",
);

writeFileSync(p, s);
console.log("  watcher installed; manual checker removed");
