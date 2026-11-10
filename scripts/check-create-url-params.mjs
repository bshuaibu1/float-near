#!/usr/bin/env node
/**
 * Do the two ends of the create URL still agree?
 *
 * The signing page reads its configuration from the query string; the MCP
 * builds that query string. They live in different languages, in different
 * packages, with no shared type — and nothing compared them, so they drifted
 * for weeks without a single test going red.
 *
 * Measured 2026-11-10: `web/index.html` honoured TWELVE params and
 * `buildCreatePlan` set FOUR. `daily`, `pertx`, `token`, `decimals` and `label`
 * were accepted by the page and never sent, which is exactly why an agent
 * could not ask "how much per day?" and hand back a ready-to-sign link — the
 * entire point of the flow. The page was finished; the MCP side never was.
 *
 * The asymmetry below is deliberate and is the whole design of this check:
 *
 *   SENT BUT NOT READ   -> hard failure. A param the page ignores means the
 *                          user silently gets a DEFAULT instead of the value
 *                          they were asked for. Nothing errors; the cap is
 *                          just not the one they agreed to. This is the
 *                          dangerous direction, and a typo (`perTx` for
 *                          `pertx`) lands squarely in it.
 *
 *   READ BUT NOT SENT   -> reported, not failed, and only outside the
 *                          allowlist. Some params belong to other flows
 *                          (`action` is owner-action signing, `dashboard` is a
 *                          redirect), so "unsent" is often correct. But an
 *                          unexplained one is how the gap above persisted, so
 *                          it must be visible rather than invisible.
 */
import { readFileSync } from "node:fs";

const PAGE = "web/index.html";
const MCP = "packages/mcp/src/create.ts";

const pageSrc = readFileSync(PAGE, "utf8");
const mcpSrc = readFileSync(MCP, "utf8");

/**
 * Params the page reads. Both `q.get("x")` and `searchParams.get("x")`, since
 * the page uses a local alias and a future edit might not.
 *
 * THE CHARACTER CLASS IS WIDE ON PURPOSE. It was `[a-z_]+`, which could not
 * match a camelCase name — so when this check was tested by renaming the sent
 * param to `perTx`, the extractor simply did not SEE it, the hard-fail branch
 * never ran, and the mistake surfaced only as a weaker "nothing sends pertx"
 * message. A validator that cannot represent the wrong value cannot fail on
 * it, and the one shape most likely to be wrong here is a casing slip.
 */
const reads = new Set(
  [...pageSrc.matchAll(/(?:\bq|searchParams)\.get\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g)].map((m) => m[1]),
);

/** Params the MCP sets. */
const sends = new Set(
  [...mcpSrc.matchAll(/searchParams\.set\(\s*["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1]),
);

/**
 * Page params the MCP deliberately does not send, each with its reason.
 *
 * A BARE LIST WOULD ROT. If a name sits here with no reason, nobody can tell
 * later whether it was a decision or an oversight — which is the exact
 * condition that let five params go unsent.
 */
const INTENTIONALLY_UNSENT = {
  action: "owner-action signing flow, not create — the payload comes from a vault_plan_* tool",
  dashboard: "a redirect target the dashboard sets for itself",
  prefix: "cosmetic account-name prefix, defaulted by the page and not part of the interview",
};

let bad = 0;

// 1. THE DANGEROUS DIRECTION.
for (const p of [...sends].sort()) {
  if (!reads.has(p)) {
    if (bad === 0) console.error(`BROKEN: the MCP sends params the page does not read.\n`);
    console.error(`  "${p}" is set by ${MCP} and never read by ${PAGE}.`);
    console.error(
      `    The page will silently use its own default, so the user gets a value\n` +
        `    they were never asked about. Check the spelling against the page —\n` +
        `    the page's names are lowercase and unseparated (e.g. 'pertx').`,
    );
    bad++;
  }
}

// 2. THE VISIBILITY DIRECTION.
const unsent = [...reads].filter((p) => !sends.has(p)).sort();
const unexplained = unsent.filter((p) => !(p in INTENTIONALLY_UNSENT));
if (unexplained.length) {
  if (bad === 0) console.error(`BROKEN: the page reads params nothing sends, with no reason given.\n`);
  for (const p of unexplained) {
    console.error(`  "${p}" is read by ${PAGE} and never sent by ${MCP}.`);
    console.error(
      `    Either wire it up, or add it to INTENTIONALLY_UNSENT in this file with\n` +
        `    the reason. Five params sat in this state and that is why an agent\n` +
        `    could not ask the user their budget.`,
    );
  }
  bad += unexplained.length;
}

if (bad) {
  console.error(
    `\n  ${bad} mismatch(es) between ${PAGE} and ${MCP}. These two have no shared\n` +
      `  type and no shared language, so this check is the only thing holding them\n` +
      `  together.`,
  );
  process.exit(1);
}

const explained = unsent.filter((p) => p in INTENTIONALLY_UNSENT);
console.log(
  `create URL: ${sends.size} sent, all read by the page; ` +
    `${explained.length} read-but-unsent and explained (${explained.join(", ")})`,
);
