#!/usr/bin/env node
/**
 * Does the DEPLOYED skill.md match the one in this repo?
 *
 * WHY THIS EXISTS. `scripts/check-plugin.mjs` keeps the three repo copies of
 * SKILL.md byte-identical and fails the gate when they drift. It passed, all
 * three agreed — and `usefloat.xyz/skill.md` served a file 4 KB older, because
 * the gate compares FILES and the one users read lives on a server.
 *
 * Measured 2026-11-12: four cold-install defects were found, fixed, committed
 * and pushed. A second cold install then reported the SAME four, word for
 * word, because it fetched the stale deployed copy. The fixes were real and
 * invisible. That is the whole failure mode — "committed" and "served" are
 * different states, exactly as "connected" and "callable" are for an MCP
 * server.
 *
 * NOT IN `verify-all`, deliberately, for the same reason `check-mcp-live.mjs`
 * is not: it needs the internet and a live host, and it fails for reasons a
 * working tree cannot fix. Run it after a deploy, and before telling anyone a
 * doc fix has shipped.
 *
 *   node scripts/check-live-docs.mjs
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const LF = String.fromCharCode(10);
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Every URL that is supposed to serve this repo's SKILL.md. */
const TARGETS = [
  "https://usefloat.xyz/skill.md",
  "https://app.usefloat.xyz/skill.md",
];

const local = readFileSync("SKILL.md", "utf8");
console.log(`repo SKILL.md  ${local.length} bytes  sha ${sha(local)}`);
console.log("");

/**
 * Specific claims worth naming when they are MISSING, rather than only
 * reporting a hash mismatch. A byte diff tells you something is stale; these
 * tell you WHICH user-visible defect is still live, which is what decides
 * whether it matters today.
 */
const MUST_CONTAIN = [
  ['claude mcp add float "--" npx', "the PowerShell install fix (bare -- is swallowed)"],
  ["27 in total", "the corrected tool count"],
  ["Tools appear after a RESTART", "the restart note"],
];

let problems = 0;

for (const url of TARGETS) {
  let res;
  let body;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    body = await res.text();
  } catch (e) {
    console.log(`  UNREACHABLE  ${url}${LF}      ${e.message}`);
    problems += 1;
    continue;
  }

  if (res.status !== 200) {
    console.log(`  BROKEN  ${url} -> HTTP ${res.status}`);
    problems += 1;
    continue;
  }

  /**
   * CONTENT TYPE MATTERS. The deploy asserts text/plain because an agent
   * fetching this is handed the bytes; served as text/markdown or html some
   * clients render or rewrite it.
   */
  const ctype = res.headers.get("content-type") ?? "(none)";

  if (body === local) {
    console.log(`  ok      ${url}  identical  (${ctype})`);
    continue;
  }

  problems += 1;
  console.log(
    `  STALE   ${url}${LF}` +
      `      served ${body.length} bytes sha ${sha(body)}, repo has ${local.length} sha ${sha(local)}` +
      `${LF}      content-type ${ctype}`,
  );
  for (const [needle, what] of MUST_CONTAIN) {
    if (!body.includes(needle)) console.log(`      MISSING: ${what}`);
  }
}

if (problems) {
  console.error(
    `${LF}BROKEN: ${problems} target(s) do not serve this repo's SKILL.md.` +
      `${LF}  web/serve.mjs reads SKILL.md per request (readFileSync in the handler,` +
      `${LF}  cache-control: no-store), so a PULL is enough — no restart, no redeploy:` +
      `${LF}` +
      `${LF}      ssh root@154.12.117.17 'cd /srv/float-near-web && git pull --ff-only origin main'` +
      `${LF}` +
      `${LF}  Then re-run this. A doc fix that is committed but not served has not shipped.`,
  );
  process.exit(1);
}

console.log(`${LF}live docs: all ${TARGETS.length} target(s) serve this repo's SKILL.md`);
