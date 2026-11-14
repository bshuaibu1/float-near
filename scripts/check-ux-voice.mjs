#!/usr/bin/env node
/**
 * The product-voice rules exist, sit EARLY, and the tools actually emit the
 * fields they promise.
 *
 * WHY THIS IS A GATE AND NOT JUST A DOC. Every coding agent that drives Float
 * reads `SKILL.md` and the server's `instructions`. Those two are the entire
 * mechanism for "talk like a product, not like an engineer" — there is no
 * runtime that can enforce it. So the rules are load-bearing text, and
 * load-bearing text that nothing asserts on is one refactor from being
 * summarised away.
 *
 * Measured 2026-11-14: the voice rules existed, but at line 308 of a ~29 KB
 * file — AFTER the tool tables and the reason-code reference. Agents read the
 * tables, followed them, and narrated gas keys and reason codes at users. The
 * rules were present and not where anyone would reach them first, which is
 * indistinguishable from absent.
 *
 * THREE THINGS CHECKED, and the third is the one that matters:
 *   1. the section exists and is EARLY (before the first tool table)
 *   2. the Always/Never lists still carry their specifics
 *   3. every tool the rules PROMISE a `say` from actually returns one
 *
 * (3) is what stops this becoming a doc that describes a product we do not
 * ship. A rule telling agents to "relay say" is worse than nothing if half the
 * tools have no `say` to relay — the agent falls back to inventing a technical
 * story, which is the behaviour being fixed.
 *
 *   node scripts/check-ux-voice.mjs
 */
import { readFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const problems = [];
const fail = (m) => problems.push(m);

const skill = readFileSync("SKILL.md", "utf8");
const server = readFileSync("packages/mcp/src/server.ts", "utf8");

// ---------------------------------------------------------------- 1. placement
const VOICE_HEADING = "## How you talk to the human (non-negotiable)";
const voiceAt = skill.indexOf(VOICE_HEADING);
if (voiceAt === -1) {
  fail(`SKILL.md has no "${VOICE_HEADING}" section. It is the product-voice contract.`);
} else {
  /**
   * BEFORE THE FIRST TOOL TABLE, measured by position rather than by line
   * number, so inserting prose above cannot silently break it.
   *
   * The tool tables are what an agent follows when it is mid-task; a voice
   * rule that arrives after them has already lost.
   */
  const firstToolTable = skill.indexOf("## Daily use — the MCP tools");
  if (firstToolTable !== -1 && voiceAt > firstToolTable) {
    fail(
      `the voice section is at offset ${voiceAt}, AFTER the tool tables at ${firstToolTable}.` +
        `${LF}      It must come first — an agent mid-task reads the tables, not the appendix.`,
    );
  }
}

// ------------------------------------------------------------- 2. the specifics
/**
 * Each entry is a rule that was earned. A generic "be friendly" survives any
 * rewrite and changes no behaviour; these are the concrete ones.
 */
const MUST_SAY = [
  ["money moved", "the explicit money-moved rule — the one fact a person cannot infer"],
  ["PARENT_PER_TX_LIMIT", "a named reason code in the Never list, so the ban is concrete"],
  ["Relay `say`", "the actual instruction: relay say, add next_step, stop"],
  ["yoctoNEAR", "yoctoNEAR in the forbidden-jargon list"],
  ["Nothing was sent", "the blocked-payment template, which must state nothing moved"],
  ["approve in your wallet", "the human-signature wording"],
];
for (const [needle, what] of MUST_SAY) {
  if (!skill.includes(needle)) fail(`SKILL.md is missing ${what} (looked for "${needle}").`);
}

// --------------------------------------------- 3. the server promises the same
for (const needle of ["say", "next_step", "money_moved"]) {
  // The INSTRUCTIONS block is injected into the client's system prompt and is
  // the only text guaranteed to be read, SKILL.md being a resource a client
  // may never fetch.
  if (!server.includes(needle)) fail(`packages/mcp/src/server.ts never mentions "${needle}".`);
}

/**
 * EVERY TOOL THE RULES PROMISE A SENTENCE FROM MUST RETURN ONE.
 *
 * Checked by finding each tool's registration and requiring a `say:` inside
 * its body. Crude, and it holds: these are flat `server.tool("name", …)`
 * blocks, and the alternative — driving 20 tools over stdio — needs a live
 * vault for most of them.
 *
 * `renderPlan` covers all 13 `vault_plan_*` tools, so it is checked once at
 * the helper rather than per tool.
 */
const MUST_RETURN_SAY = [
  ["vault_pay", null],
  ["vault_budget", null],
  ["vault_add_role", null],
  ["vault_await_create", null],
  [null, "function renderPlan"],
];
for (const [tool, helper] of MUST_RETURN_SAY) {
  const marker = helper ?? `"${tool}",`;
  const at = server.indexOf(marker);
  if (at === -1) {
    fail(`could not find ${helper ?? tool} in server.ts — this check needs updating.`);
    continue;
  }
  // The body of one registration. Generous window; the next `server.tool(`
  // bounds it when one follows.
  const nextTool = server.indexOf("server.tool(", at + marker.length);
  const body = server.slice(at, nextTool === -1 ? at + 12000 : nextTool);
  /**
   * BOTH `say: value` AND the ES6 shorthand `say,`.
   *
   * This matched only `say:` and went red the moment `renderPlan` was
   * refactored to build a local `say` and return it shorthand — the field was
   * still there. A false positive on a check this strict is expensive: the
   * honest fix is to teach it the second spelling, not to relax the pattern
   * into something that would also match a comment mentioning say.
   */
  if (!/(?:^|[\s{,])say\s*[:,]/m.test(body)) {
    fail(
      `${helper ?? tool} returns no \`say:\` field.${LF}` +
        `      SKILL.md tells agents to relay \`say\` — a tool without one forces them` +
        `${LF}      back to inventing a technical story, which is the bug being fixed.`,
    );
  }
}

// --------------------------------------------------------------------- verdict
if (problems.length) {
  console.error(`BROKEN: the product-voice contract is not intact.${LF}`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `${LF}  These rules are the ONLY mechanism making agents speak like a product.` +
      `${LF}  Nothing at runtime enforces them.`,
  );
  process.exit(1);
}

console.log(
  `ux voice: SKILL.md carries the voice contract before the tool tables, ` +
    `all ${MUST_SAY.length} specifics intact, and ${MUST_RETURN_SAY.length} tool/helper(s) return \`say\``,
);
