/**
 * Remove `maxPolls` from useVisiblePolling.
 *
 * I added it an hour ago for /link, which has now been deleted as Solana
 * residue. /fund is the only remaining caller and deliberately does NOT want
 * a ceiling - 15s is four requests a minute, fine to run all day while you
 * watch for a deposit.
 *
 * So the parameter, the budget counter and the `gaveUp` return are all dead.
 * Keeping them because they "might be useful" is how a hook accumulates
 * options nobody can explain: there is no caller to justify the behaviour,
 * and the behaviour was only ever proven by a temporary probe. If a future
 * poller needs a ceiling it comes back WITH its caller, and with a test that
 * has something real to assert against.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const p = "apps/dashboard/lib/use-chain-watch.ts";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

must(
  [
    "  active = true,",
    "  /**",
    "   * Stop after this many reads, or poll for as long as the page is open.",
    "   *",
    "   * The visibility guard only covers a tab nobody is LOOKING at. A tab left",
    "   * visible but unattended still polls forever, and whether that matters is",
    "   * a question of rate: /fund at 15s is four requests a minute and can run",
    "   * all day, while /link at 2s is thirty - so /link gets a ceiling and /fund",
    "   * does not. The caller decides, because only the caller knows the rate.",
    "   */",
    "  maxPolls?: number,",
    ") {",
  ].join(LF),
  ["  active = true,", ") {"].join(LF),
  "signature",
);

must(
  [
    "  const lastFetch = useRef(0);",
    "  const polls = useRef(0);",
    "  const [gaveUp, setGaveUp] = useState(false);",
    "",
    "  // A fresh activation gets a fresh budget.",
    "  useEffect(() => {",
    "    if (!active) return;",
    "    polls.current = 0;",
    "    setGaveUp(false);",
    "  }, [active, ms, maxPolls]);",
    "",
    "  useEffect(() => {",
    "    if (!active || gaveUp) return;",
  ].join(LF),
  ["  const lastFetch = useRef(0);", "", "  useEffect(() => {", "    if (!active) return;"].join(LF),
  "state",
);

must(
  [
    "    const run = () => {",
    "      lastFetch.current = Date.now();",
    "      polls.current += 1;",
    "      void refreshRef.current();",
    "    };",
  ].join(LF),
  [
    "    const run = () => {",
    "      lastFetch.current = Date.now();",
    "      void refreshRef.current();",
    "    };",
  ].join(LF),
  "run",
);

must(
  [
    "      if (typeof document !== \"undefined\" && document.visibilityState === \"hidden\") return;",
    "      if (maxPolls !== undefined && polls.current >= maxPolls) {",
    "        setGaveUp(true);",
    "        return;",
    "      }",
    "      run();",
  ].join(LF),
  [
    "      if (typeof document !== \"undefined\" && document.visibilityState === \"hidden\") return;",
    "      run();",
  ].join(LF),
  "tick",
);

must("  }, [ms, active, gaveUp, maxPolls]);", "  }, [ms, active]);", "deps");
must(LF + "  return { gaveUp };" + LF + "}", LF + "}", "return");

writeFileSync(p, s);
console.log("  maxPolls, the budget counter and the gaveUp return are gone");
