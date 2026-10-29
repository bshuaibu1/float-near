import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SKILL.md is the agent's instruction manual, so every identifier in it has to
 * be real.
 *
 * WHY THIS IS A TEST AND NOT A ONE-OFF CHECK. Writing it, I named two reason
 * codes from memory that the contract does not emit — `DAILY_LIMIT` and
 * `PARENT_DAILY_LIMIT`, where it actually emits `DAILY_BUDGET` and
 * `PARENT_DAILY_BUDGET`. Shipped, every agent reading this file would have
 * matched on strings that never appear, and the failure mode is silent: the
 * agent simply never recognises a budget refusal and reports something useless
 * to its human.
 *
 * Documentation that can drift from the contract without anything going red is
 * worse than no documentation, because it is trusted.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const SKILL = join(ROOT, "SKILL.md");
const TYPES = join(ROOT, "contracts", "vault", "src", "types.rs");
const SERVER = join(ROOT, "packages", "mcp", "src", "server.ts");

const read = (p) => readFileSync(p, "utf8");

test("SKILL.md exists — it is the entry point an agent is given", () => {
  assert.ok(existsSync(SKILL), `${SKILL} is missing`);
});

test("every REASON CODE named in SKILL.md is one the contract can emit", () => {
  const named = new Set([...read(SKILL).matchAll(/`([A-Z_]{4,})`/g)].map((m) => m[1]));
  const real = new Set([...read(TYPES).matchAll(/"([A-Z_]{4,})"/g)].map((m) => m[1]));
  assert.ok(named.size >= 10, `expected the skill to document the codes; found ${named.size}`);
  const bogus = [...named].filter((n) => !real.has(n));
  assert.deepEqual(bogus, [], `SKILL.md names codes the contract cannot emit: ${bogus.join(", ")}`);
});

test("every MCP TOOL named in SKILL.md actually exists", () => {
  const named = new Set(
    [...read(SKILL).matchAll(/`(vault_[a-z_]+)`/g)].map((m) => m[1]).filter((n) => !n.endsWith("_")),
  );
  const real = new Set([...read(SERVER).matchAll(/"(vault_[a-z_]+)"/g)].map((m) => m[1]));
  assert.ok(named.size >= 5, `expected the skill to name the tools; found ${named.size}`);
  const bogus = [...named].filter((n) => !real.has(n));
  assert.deepEqual(bogus, [], `SKILL.md names tools that do not exist: ${bogus.join(", ")}`);
});

test("every WIZARD FLAG named in SKILL.md is one the wizard reads", () => {
  const wizard =
    read(join(ROOT, "packages", "create-float", "bin", "create-float.mjs")) +
    read(join(ROOT, "packages", "create-float", "bin", "args.mjs"));
  const real = new Set([...wizard.matchAll(/["'](--[a-z-]+)["']/g)].map((m) => m[1]));
  const named = new Set([...read(SKILL).matchAll(/`(--[a-z-]+)[ `]/g)].map((m) => m[1]));
  const bogus = [...named].filter((n) => !real.has(n));
  assert.deepEqual(bogus, [], `SKILL.md names flags the wizard ignores: ${bogus.join(", ")}`);
});

/** The text between a heading/marker and the next blank-line-separated block. */
function section(text, startMarker, endMarker) {
  const i = text.indexOf(startMarker);
  assert.notEqual(i, -1, `section marker not found: ${startMarker}`);
  const j = endMarker ? text.indexOf(endMarker, i + startMarker.length) : -1;
  return text.slice(i, j === -1 ? undefined : j);
}

test("the CAPABILITY LIST says the agent cannot raise its own limit", () => {
  // Scoped to the section, because asserting against the whole document passed
  // while the claim was deleted from here: the same phrase appears in the
  // frontmatter description and in the refusals guidance, so a
  // whole-file regex was carried by a different occurrence than the one it
  // named. Three mentions, one test, two of them load-bearing for nothing.
  const cannot = section(read(SKILL), "**Cannot", "## Daily use");
  assert.match(cannot, /raise (its|your) own limit/i, "the Cannot list must say it");
  assert.match(cannot, /request_payment/, "must name the one method the key can call");
  assert.match(cannot, /fund the vault/i, "must say the agent cannot fund the vault");
});

test("the REFUSALS guidance repeats it, where an agent is actually tempted", () => {
  // Different job from the capability list: this one is read at the moment a
  // payment has just been refused, which is exactly when a helpful agent
  // starts looking for a way around.
  const refusals = section(read(SKILL), "## When a payment is refused", "## Setting up");
  assert.match(refusals, /cannot raise your own limit/i);
  assert.match(refusals, /must not imply otherwise/i);
});

test("the frontmatter description states the restriction too", () => {
  // It is what a client shows when choosing between skills, so it is the only
  // part some agents read.
  const front = section(read(SKILL), "---", "---");
  assert.match(front, /cannot/i);
});

test("the skill does not promise that SETTLED means cross-chain delivery", () => {
  // It does not, and conflating the two is the single most misleading thing an
  // agent could tell a human about a cross-chain payment.
  assert.match(
    read(SKILL),
    /SETTLED.*(does not mean|not mean delivered)/is,
    "must distinguish NEAR settlement from far-chain delivery",
  );
});
