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
 * Listing the retired values rather than trying to parse every sentence that
 * mentions a number: a sentence explaining WHY 2.04 was wrong is correct and
 * must stay, so the rule is about the word "default" sitting next to the old
 * figure, not about the figure appearing at all.
 */
const RETIRED = ["2.04", "0.51"];

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
  text.split("\n").forEach((line, i) => {
    for (const old of RETIRED) {
      if (!line.includes(old)) continue;
      // Only flag it when the line PRESENTS it as current.
      if (!/default|Defaults|page default/i.test(line)) continue;
      // A line explaining that it is no longer the default is the fix, not the bug.
      if (/was|were|used to|previously|retired|no longer|old\b/i.test(line)) continue;
      console.error(`BROKEN: ${file}:${i + 1} presents ${old} as a default.`);
      console.error(`    ${line.trim().slice(0, 100)}`);
      console.error(`  The page actually defaults to daily=${live.daily}, pertx=${live.pertx}.`);
      bad++;
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
