#!/usr/bin/env node
/**
 * Does the MCP agree with the create PAGE about which owner actions can be
 * approved from a link?
 *
 * WHY. `approve-url.ts` mirrors `OWNER_METHODS` out of `web/index.html`,
 * because one is TypeScript in a published package and the other a
 * `<script type="module">` served as a static file — no import crosses that
 * boundary. A mirrored allowlist is an allowlist that goes stale, and both
 * directions of staleness are bad in different ways:
 *
 *   MCP has a method the PAGE lacks  -> the agent hands over a link, the user
 *                                       clicks it, the page refuses, and that
 *                                       reads as the product being broken
 *                                       rather than as a terminal-only action.
 *   PAGE has a method the MCP lacks  -> the user is pushed to the CLI for
 *                                       something they could have clicked. A
 *                                       silent downgrade of the main UX.
 *
 * This is the same shape as `check-create-factory-default.mjs`: two ends of a
 * boundary that must agree, compared as strings because nothing else can.
 *
 * It ALSO checks the third list — the methods the MCP's plan tools actually
 * emit — because an allowlist that agrees with the page but not with reality
 * is just as broken. `withdraw` lives in exactly that gap, deliberately, so it
 * is named here rather than left looking like an oversight.
 *
 *   node scripts/check-approve-url-methods.mjs
 */
import { readFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const problems = [];

const page = readFileSync("web/index.html", "utf8");
const mirror = readFileSync("packages/mcp/src/approve-url.ts", "utf8");
const payloads = readFileSync("packages/mcp/src/payloads.ts", "utf8");

/** The page's allowlist, parsed out of its `new Set([...])`. */
const pageBlock = page.match(/OWNER_METHODS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
if (!pageBlock) problems.push("could not find OWNER_METHODS in web/index.html");
const pageMethods = new Set(
  pageBlock ? [...pageBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [],
);

/** The MCP's mirror of it. */
const mirrorBlock = mirror.match(/PAGE_OWNER_METHODS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
if (!mirrorBlock) problems.push("could not find PAGE_OWNER_METHODS in approve-url.ts");
const mirrorMethods = new Set(
  mirrorBlock ? [...mirrorBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [],
);

/** Everything the plan builders actually produce. */
const emitted = new Set([...payloads.matchAll(/methodName: "([a-z_]+)"/g)].map((m) => m[1]));

if (pageBlock && mirrorBlock) {
  for (const m of mirrorMethods) {
    if (!pageMethods.has(m)) {
      problems.push(
        `approve-url.ts allows "${m}" but the PAGE does not render it.${LF}` +
          `      The agent would hand over a link the page refuses, which reads as` +
          `${LF}      the product being broken.`,
      );
    }
  }
  for (const m of pageMethods) {
    if (!mirrorMethods.has(m)) {
      problems.push(
        `the page renders "${m}" but approve-url.ts does not allow it.${LF}` +
          `      Users are pushed to the CLI for something they could have clicked.`,
      );
    }
  }
}

/**
 * A method the tools emit, the page cannot render, and which therefore has NO
 * approval link. Expected — but it must be a known, named list, so that a NEW
 * one appearing is noticed rather than silently becoming CLI-only.
 */
const KNOWN_CLI_ONLY = new Set(["withdraw"]);
for (const m of emitted) {
  if (pageMethods.has(m) || KNOWN_CLI_ONLY.has(m)) continue;
  problems.push(
    `the plan tools emit "${m}", the page cannot render it, and it is not in this` +
      `${LF}      check's KNOWN_CLI_ONLY list. Either add it to the page's OWNER_METHODS,` +
      `${LF}      or add it here with a reason — silently CLI-only is how the main UX` +
      `${LF}      degrades without anyone deciding to.`,
  );
}
for (const m of KNOWN_CLI_ONLY) {
  if (pageMethods.has(m)) {
    problems.push(
      `"${m}" is listed as CLI-only here, but the page now renders it. Remove it ` +
        `from KNOWN_CLI_ONLY and from approve-url.ts's exclusion so users get a link.`,
    );
  }
}

if (problems.length) {
  console.error(`BROKEN: the approval-link allowlists disagree.${LF}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `approve links: page and MCP agree on ${pageMethods.size} owner method(s); ` +
    `${[...KNOWN_CLI_ONLY].join(", ")} is CLI-only by design`,
);
