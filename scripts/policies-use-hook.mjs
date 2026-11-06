/**
 * Point /policies at the shared watcher instead of its own inline copy.
 *
 * The logic is identical; what changes is that the transitions now live in
 * a tested reducer (lib/watch.ts, 20 tests / 7 mutants) rather than in the
 * body of a useEffect where the only way to find a bug was to drive the page
 * in a browser - which is how the self-cancelling timer was found.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

function cut(startMarker, endMarker, what) {
  const a = s.indexOf(startMarker);
  const b = s.indexOf(endMarker, a);
  if (a < 0 || b < 0 || b < a) throw new Error(`markers not found: ${what}`);
  s = s.slice(0, a) + s.slice(b);
}

// --- imports --------------------------------------------------------------
must(
  'import { signLink } from "@/lib/sign-link";',
  [
    'import { signLink } from "@/lib/sign-link";',
    'import { useChainWatch, useToast } from "@/lib/use-chain-watch";',
    'import { Toast, WatchStatus } from "@/components/toast";',
  ].join(LF),
  "imports",
);

// --- state ----------------------------------------------------------------
must(
  [
    "  // The watcher. `gaveUp` is NOT \"it failed\" - it is \"we stopped looking\".",
    "  const [watching, setWatching] = useState(false);",
    "  const [gaveUp, setGaveUp] = useState(false);",
    "  const [toast, setToast] = useState<string | null>(null);",
    "  const polls = useRef(0);",
  ].join(LF),
  "  const { toast, setToast } = useToast();",
  "watcher state",
);

// --- discardDrafts no longer pokes the watcher's internals ---------------
must(
  [
    "    // Stop the watcher too: there is no longer a transaction to watch for,",
    "    // and leaving it running would poll the chain for a discarded intent.",
    "    setWatching(false);",
    "    setGaveUp(false);",
  ].join(LF),
  [
    "    // Clearing txs stops the watcher by itself: the hook restarts from",
    "    // the transaction count, and zero means idle.",
  ].join(LF),
  "discardDrafts",
);

// --- the constants and the two effects -----------------------------------
cut(
  "  /**\n   * How long to keep looking. 4s x 45 is three minutes, which comfortably",
  "  /** The agent list in the shape lib/applied.ts compares against. */",
  "poll constants",
);

cut(
  "  // A freshly prepared transaction restarts the watch.\n  useEffect(() => {",
  "  // The toast says its piece and leaves, taking the finished panel with it.",
  "watch effects",
);

// --- drive the hook instead ----------------------------------------------
must(
  "  // The toast says its piece and leaves, taking the finished panel with it.",
  [
    "  const { phase: watchPhase } = useChainWatch({",
    "    txCount: txs.length,",
    "    allApplied,",
    "    refresh: load,",
    "    onApplied: setToast,",
    "  });",
    "",
    "  // The toast says its piece and leaves, taking the finished panel with it.",
  ].join(LF),
  "hook call",
);

// --- render: status line --------------------------------------------------
const OLD_STATUS = [
  "                  {watching ? (",
  '                    <span className="inline-flex items-center gap-2 text-[11.5px] font-medium text-muted">',
  "                      {/* A live pulse, so \"nothing is happening yet\" is",
  "                          visibly different from \"nobody is looking\". */}",
  '                      <span className="relative flex h-2 w-2" aria-hidden>',
  '                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ink opacity-50" />',
  '                        <span className="relative inline-flex h-2 w-2 rounded-full bg-ink" />',
  "                      </span>",
  "                      Watching the chain for this change...",
  "                    </span>",
  "                  ) : gaveUp ? (",
  '                    <span className="text-[11.5px] font-medium" style={{ color: "#92400E" }}>',
  "                      Stopped watching. If you have signed since, reload to pick it up.",
  "                    </span>",
  "                  ) : null}",
].join(LF);

must(OLD_STATUS, "                  <WatchStatus phase={watchPhase} />", "status line");

// --- render: toast --------------------------------------------------------
const a = s.indexOf("      {/* THE TOAST.");
const b = s.indexOf("    </div>\n  );\n}", a);
if (a < 0 || b < 0) throw new Error("toast block markers not found");
s =
  s.slice(0, a) +
  "      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}\n" +
  s.slice(b);

// --- the per-tx verdict still referenced gaveUp --------------------------
s = s.split("|| gaveUp)").join('|| watchPhase === "gave-up")');

writeFileSync(p, s);
console.log("  /policies now drives the shared watcher");
console.log(`  leftover inline watcher refs: ${s.split("setWatching").length - 1 + (s.split("setGaveUp").length - 1)}`);
