#!/usr/bin/env node
/**
 * Does anything claim a default the page does not actually use?
 *
 * The page's defaults are the real ones. Everything else — MCP tool
 * descriptions, SKILL.md, doc comments — only DESCRIBES them, and a
 * description is a copy that drifts.
 *
 * Measured 2026-11-10. The page defaults were changed 2.04/0.51 -> 25/10 and
 * the tool descriptions were not. Those descriptions are not documentation
 * anybody has to go and read: an MCP tool schema is injected straight into the
 * agent's context, so the agent went on offering "Page defaults: 2.04 / 0.51"
 * as a recommended option, for values no longer in the page, hours after the
 * change shipped. Every other copy was correct — repo, plugin, live site — and
 * the one that actually reached a user was stale.
 *
 * The check is deliberately crude: find the page's real defaults, then look
 * for any OTHER number presented as a default in the files that talk about
 * them. Crude is right here, because the failure is "a stale figure sits in a
 * sentence", not a structural mismatch, and nothing structural would catch it.
 */
import { readFileSync } from "node:fs";

// A literal escape inside a generated file is one backslash level away from
// becoming a real newline and a syntax error. verify-all.mjs does the same.
const LF = String.fromCharCode(10);

const PAGE = "web/index.html";
const html = readFileSync(PAGE, "utf8");

const pageDefault = (name) => {
  const marker = `q.get("${name}") ?? (NETWORK === "mainnet" ? "`;
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`could not find the mainnet '${name}' default in ${PAGE}`);
  const rest = html.slice(at + marker.length);
  return rest.slice(0, rest.indexOf('"'));
};

const live = { daily: pageDefault("daily"), pertx: pageDefault("pertx") };

/**
 * Figures that USED to be defaults and must never be presented as current.
 *
 * Kept alongside the positive check below, because the two catch different
 * mistakes: this one catches a stale sentence nobody updated, the other
 * catches a NEW figure someone invented. A blocklist alone requires remembering
 * to extend it on every change, which is the maintenance burden that lets the
 * next stale value through.
 */
const RETIRED = ["2.04", "0.51"];

/**
 * Phrasings that STATE a current default, and which side they state.
 *
 * SKILL.md now dictates a greeting containing "25 USDC/day and 10 USDC per
 * payment". That is a FOURTH copy of these numbers — after the page, the tool
 * descriptions and the doc comments — and it is the copy a user reads. A
 * blocklist of old values cannot police it: someone writing "50 USDC/day"
 * invents a figure that is wrong without ever mentioning a retired one.
 */
const STATED = [
  { re: /(\d+(?:\.\d+)?)\s*USDC\/day/g, side: "daily" },
  { re: /(\d+(?:\.\d+)?)\s*USDC per payment/g, side: "pertx" },
  { re: /(\d+(?:\.\d+)?)\s*USDC\/tx/g, side: "pertx" },
  { re: /Page default when omitted:\s*(\d+(?:\.\d+)?)\s*\(mainnet\)/g, side: null },
];

const FILES = [
  "packages/mcp/src/server.ts",
  "packages/mcp/src/create.ts",
  "SKILL.md",
];

let bad = 0;
for (const file of FILES) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(LF);

  // 1. A RETIRED FIGURE PRESENTED AS CURRENT.
  lines.forEach((line, i) => {
    for (const old of RETIRED) {
      if (!line.includes(old)) continue;
      if (!/default|Defaults|page default/i.test(line)) continue;
      // A line explaining that it is no longer the default is the fix, not the bug.
      if (/was|were|used to|previously|retired|no longer|old/i.test(line)) continue;
      console.error(`BROKEN: ${file}:${i + 1} presents ${old} as a default.`);
      console.error(`    ${line.trim().slice(0, 100)}`);
      console.error(`  The page actually defaults to daily=${live.daily}, pertx=${live.pertx}.`);
      bad++;
    }
  });

  // 2. A STATED FIGURE THAT DISAGREES WITH THE PAGE.
  lines.forEach((line, i) => {
    // Explanatory prose about a value that is deliberately NOT the default.
    if (/refuses|cannot deliver|costs|charged|was |were |used to|example|e\.g\./i.test(line)) return;
    for (const { re, side } of STATED) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const stated = m[1];
        // `side: null` means the phrasing does not say which cap it is, so
        // accept either — it is still caught if it matches neither.
        const ok =
          side === "daily"
            ? stated === live.daily
            : side === "pertx"
              ? stated === live.pertx
              : stated === live.daily || stated === live.pertx;
        if (ok) continue;
        console.error(`BROKEN: ${file}:${i + 1} states a default of ${stated}.`);
        console.error(`    ${line.trim().slice(0, 100)}`);
        console.error(
          `  The page uses daily=${live.daily}, pertx=${live.pertx}. A figure stated in` + LF +
            `  SKILL.md is read by a USER, so a wrong one is a promise the product breaks.`,
        );
        bad++;
      }
    }
  });
}

if (bad) {
  console.error(
    `\n  ${bad} stale default(s). An MCP tool description is injected into the\n` +
      `  agent's context, so a wrong figure there is not a stale doc — it is what\n` +
      `  the agent offers the user as a recommended option.`,
  );
  process.exit(1);
}
console.log(`quoted defaults: agree with the page (daily=${live.daily}, pertx=${live.pertx})`);
