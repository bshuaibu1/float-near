/**
 * Make /fund and /link stop polling a tab nobody is looking at.
 */
import { readFileSync, writeFileSync } from "node:fs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

function edit(path, fn) {
  const raw = readFileSync(path, "utf8");
  const wasCrlf = raw.includes(CRLF);
  let s = raw.split(CRLF).join(LF);
  s = fn(s, (from, to, what) => {
    if (!s.includes(from)) throw new Error(`${path}: not found: ${what}`);
    return s.replace(from, to);
  });
  writeFileSync(path, wasCrlf ? s.split(LF).join(CRLF) : s);
  return wasCrlf;
}

// --- /fund ----------------------------------------------------------------
const fundCrlf = edit("apps/dashboard/app/fund/page.tsx", (s) => {
  const importFrom = 'const BALANCE_POLL_INTERVAL_MS = 15_000;';
  if (!s.includes(importFrom)) throw new Error("fund: poll constant not found");

  const oldEffect = [
    "  useEffect(() => {",
    "    const t = setInterval(() => void load(), BALANCE_POLL_INTERVAL_MS);",
    "    return () => clearInterval(t);",
    "  }, [load]);",
  ].join(LF);
  if (!s.includes(oldEffect)) throw new Error("fund: poll effect not found");

  const newEffect = [
    "  // Polls only while someone is looking, and refreshes the moment they",
    "  // come back. Unconditional 15s polling meant a tab left open overnight",
    "  // made about 5,700 requests through the adapter to a public RPC for a",
    "  // page nobody was reading.",
    "  useVisiblePolling(load, BALANCE_POLL_INTERVAL_MS);",
  ].join(LF);

  s = s.replace(oldEffect, newEffect);

  // Import it next to the other lib imports, or after the react import.
  const reactImport = s.match(/^import \{[^}]*\} from "react";$/m);
  if (!reactImport) throw new Error("fund: react import not found");
  s = s.replace(
    reactImport[0],
    `${reactImport[0]}${LF}import { useVisiblePolling } from "@/lib/use-chain-watch";`,
  );
  return s;
});

console.log(`  /fund uses useVisiblePolling (CRLF: ${fundCrlf})`);

// --- /link ----------------------------------------------------------------
const linkRaw = readFileSync("apps/dashboard/app/link/page.tsx", "utf8");
const hasGuard = linkRaw.includes("visibilityState");
console.log(
  `  /link polls only while a session is pending; visibility guard present: ${hasGuard}`,
);
console.log("  left alone - its loop is already bounded by session status");
