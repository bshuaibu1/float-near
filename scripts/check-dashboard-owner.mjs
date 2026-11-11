#!/usr/bin/env node
/**
 * Does every dashboard call to the adapter say WHO is asking?
 *
 * The proxy resolves `?owner=` into that account's vault, and otherwise falls
 * back to whichever vault the adapter is configured with. On the public
 * deployment that is the operator's TESTNET demo vault. So a fetch that omits
 * the owner does not fail — it quietly renders someone else's money.
 *
 * Measured 2026-11-11: SEVENTEEN fetches across seven pages had no owner.
 * `/v1/dashboard` was passed one in exactly one of five call sites, so the
 * Overview resolved correctly while Policies showed a mainnet owner the
 * TESTNET budget tree — 100 USDC master, a `marketing` agent, a 42.25 balance
 * — as their own. Incognito did not help; the requests never mentioned them.
 *
 * THE FAILURE IS SILENT AND PLAUSIBLE, which is why it needs a build gate
 * rather than review: a page that forgets the owner looks correct, returns
 * HTTP 200, and renders a real vault. Nothing is red.
 *
 * So: nobody may build an adapter URL by hand. `lib/float-fetch.ts` is the one
 * door and it attaches the owner itself.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "apps/dashboard";
const ALLOWED = [
  // The door itself.
  join("lib", "float-fetch.ts"),
  // The server-side proxy: it RECEIVES these requests and rewrites the owner
  // into a vault. It is the other end of the wire, not a caller.
  join("app", "api", "float"),
];

const offenders = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".next")) continue;
      walk(p);
      continue;
    }
    if (!/\.(tsx?|jsx?)$/.test(name)) continue;
    const rel = p.slice(ROOT.length + 1);
    if (ALLOWED.some((a) => rel.startsWith(a))) continue;

    readFileSync(p, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // A bare `fetch(` against the adapter, by any spelling of the base.
        if (/fetch\(\s*`?\$?\{?API_BASE_URL/.test(line) || /fetch\(\s*["'`]\/api\/float/.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim().slice(0, 88) });
        }
      });
  }
};
walk(ROOT);

if (offenders.length) {
  console.error(`BROKEN: ${offenders.length} adapter call(s) bypass floatFetch.\n`);
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}`);
    console.error(`    ${o.text}`);
  }
  console.error(
    `\n  A fetch without an owner does not fail — the proxy falls back to the\n` +
      `  adapter's configured vault, which on the public deployment is the\n` +
      `  operator's testnet demo. The page renders a real vault belonging to\n` +
      `  someone else, returns 200, and nothing goes red.\n\n` +
      `  Use floatFetch("/v1/...") from @/lib/float-fetch.`,
  );
  process.exit(1);
}
console.log("dashboard: every adapter call goes through floatFetch and carries the owner");
