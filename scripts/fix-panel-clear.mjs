/**
 * The success timer was cancelling itself.
 *
 * MEASURED: on success the effect did
 *
 *     setWatching(false);
 *     setToast(...);
 *     const t = setTimeout(() => setTxs([]), 1400);
 *     return () => clearTimeout(t);
 *
 * `watching` is one of that effect's dependencies, so setWatching(false)
 * immediately re-ran it - firing the cleanup, which cleared the timeout
 * before it could ever fire. The toast appeared and the panel stayed up
 * forever. Confirmed in the browser: toastAppeared true, panelCleared false.
 *
 * The dismissal belongs on an effect keyed to the TOAST, which lives for six
 * seconds and is not torn down by the watcher's own state changes.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

must(
  `    if (allApplied) {
      setWatching(false);
      setToast(txs.length > 1 ? \`\${txs.length} changes applied\` : "Change applied");
      // Leave the panel up briefly so the green tick is seen, then clear it.
      const t = setTimeout(() => setTxs([]), 1400);
      return () => clearTimeout(t);
    }`,
  `    if (allApplied) {
      setWatching(false);
      setToast(txs.length > 1 ? \`\${txs.length} changes applied\` : "Change applied");
      // The panel is dismissed by the toast effect below, NOT here: setting
      // 'watching' false re-runs this effect, and its cleanup would cancel
      // any timer started on this line before it could fire.
      return;
    }`,
  "success branch",
);

must(
  `  // The toast says its piece and leaves.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);`,
  `  // The toast says its piece and leaves, taking the finished panel with it.
  // Keyed on the toast because that state is stable for its whole lifetime -
  // unlike the watcher's, which changes the instant a change is detected.
  useEffect(() => {
    if (!toast) return;
    const clearPanel = setTimeout(() => setTxs([]), 1400);
    const hide = setTimeout(() => setToast(null), 6000);
    return () => {
      clearTimeout(clearPanel);
      clearTimeout(hide);
    };
  }, [toast]);`,
  "toast effect",
);

writeFileSync(p, s);
console.log("  panel dismissal moved onto the toast's own effect");
