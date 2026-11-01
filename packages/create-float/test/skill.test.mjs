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

// ---------------------------------------------------------------------------
// The reverse direction, which was missing.
//
// The checks above assert that every code SKILL.md names really exists. They
// say nothing about codes the contract can emit and the document never
// mentions — and that gap is silent in the worse direction: an agent meets a
// refusal it has no entry for and reports something useless to its human.
//
// Proven by this exact case: appending NoRecipientsSet to the contract left
// every test green while SKILL.md said nothing about it.
//
// The agent-reachable set is computable rather than maintained by hand. Every
// refusal an agent can receive comes from a `blocked(..)` inside
// dispatch_payment, so scanning that function's body catches both shapes —
// the 19 call sites passing a literal AND the 3 passing a local, which between
// them supply the six cap/cooldown codes a literal-only grep misses.

test("every reason code the AGENT ENTRY POINTS can emit is documented in SKILL.md", () => {
  // WIDER THAN THE TEST BELOW, AND THAT GAP WAS REAL. The scan below covers
  // `dispatch_payment` only, on the reasoning that "every refusal an agent can
  // receive comes from a `blocked(..)` inside dispatch_payment". That misses
  // the codes the ENTRY POINTS raise before they ever reach dispatch — agent
  // resolution failures — and both of them were undocumented:
  //
  //   NOT_AGENT          an unbound ACCOUNT calling request_payment
  //   NOT_VIRTUAL_AGENT  an unbound KEY, via request_payment_signed or, since
  //                      the self-submit path, request_payment itself
  //
  // They arrive as PANICS rather than BLOCKED outcomes — deliberately, since
  // there is no node to attribute a blocked event to — so an agent sees a
  // failed transaction, not a reason_code field. That makes them MORE in need
  // of documentation, not less: an agent that cannot tell "your key is not
  // bound" from a network error will retry forever.
  const lib = read(join(ROOT, "contracts", "vault", "src", "lib.rs"));
  const doc = read(SKILL);
  const screaming = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

  const entryPoints = ["pub fn request_payment(", "pub fn request_payment_signed("];
  const emitted = new Set();
  for (const sig of entryPoints) {
    const start = lib.indexOf(sig);
    assert.ok(start > 0, `${sig} not found — this scan is measuring nothing`);
    const rest = lib.slice(start + sig.length);
    const endRel = rest.search(/\n {4}(pub )?fn /);
    const body = endRel < 0 ? rest : rest.slice(0, endRel);
    for (const m of body.matchAll(/ReasonCode::([A-Za-z]+)/g)) emitted.add(m[1]);
  }
  assert.ok(emitted.size >= 2, `only found ${emitted.size} codes in the entry points — scan is broken`);

  const missing = [...emitted].map(screaming).filter((c) => !doc.includes(c));
  assert.deepEqual(
    missing,
    [],
    `SKILL.md does not mention ${missing.length} entry-point code(s) an agent can hit: ${missing.join(", ")}`,
  );
});

test("every reason code dispatch_payment can emit is documented in SKILL.md", () => {
  const lib = read(join(ROOT, "contracts", "vault", "src", "lib.rs"));

  const start = lib.indexOf("fn dispatch_payment");
  assert.ok(start > 0, "dispatch_payment not found — this scan is measuring nothing");
  // The body ends at the next method at the same indentation.
  const rest = lib.slice(start + 1);
  const endRel = rest.search(/\n {4}(pub )?fn /);
  const body = endRel < 0 ? rest : rest.slice(0, endRel);

  const emitted = [...new Set([...body.matchAll(/ReasonCode::([A-Za-z]+)/g)].map((m) => m[1]))];
  // Guard the guard: if this ever collapses to a handful, the slice is wrong
  // and a clean result would mean nothing.
  assert.ok(emitted.length >= 15, `only found ${emitted.length} codes in dispatch_payment — scan is broken`);

  const screaming = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  const doc = read(SKILL);
  const missing = emitted.map(screaming).filter((c) => !doc.includes(c));

  assert.deepEqual(
    missing,
    [],
    `SKILL.md does not mention ${missing.length} code(s) an agent can receive: ${missing.join(", ")}`,
  );
});

// ---- the cost SKILL.md quotes must match the cost the wizard charges
//
// Found 2026-10-31. SKILL.md said "hold ~3 NEAR in it" while the real ask is
// 3.341 for a bare vault and 3.891 with one agent. A user who tops up to
// exactly 3 hits `insufficient balance: need 3.341, have ...` after reading our
// own instructions — reproduced live against test015.near.
//
// This is the SECOND time this number has gone stale in two days: usage() was
// corrected 3.6 -> 3.9 and SKILL.md was not. So it is derived here rather than
// written down, to one decimal place — tight enough to catch "~3", loose enough
// to survive a few kilobytes of contract growth.
import { statSync as skStat } from "node:fs";
import { vaultFunding, codeStakeYocto } from "../bin/funding.mjs";
import { usage as skUsage } from "../bin/args.mjs";

const AGENT_ACCOUNT_NEAR = 0.55; // 0.5 key allowance + 0.05 storage

test("REAL DATA: SKILL.md quotes the derived setup cost, not a stale round number", () => {
  const skillText = read(SKILL);
  const bytes = skStat(join(HERE, "..", "res", "vault.wasm")).size;
  const bare = Number(vaultFunding(bytes)) / 1e24;
  const withAgent = bare + AGENT_ACCOUNT_NEAR;

  // One decimal: 3.3 and 3.8 as of a 299,016-byte contract.
  const bare1dp = bare.toFixed(1);
  const agent1dp = withAgent.toFixed(1);

  assert.ok(
    skillText.includes(bare1dp) || skillText.includes(agent1dp),
    `SKILL.md mentions neither ${bare1dp} nor ${agent1dp} NEAR — the real ask is ` +
      `${bare.toFixed(3)} bare / ${withAgent.toFixed(3)} with one agent`,
  );
  assert.ok(
    !/~\s*3 NEAR|about 3 NEAR|hold ~3/i.test(skillText),
    "SKILL.md still says ~3 NEAR, which is below the real ask and fails the affordability check",
  );
});

test("REAL DATA: usage() and SKILL.md do not disagree about the cost", () => {
  // Two documents quoting one measured fact is how the first drift happened.
  const skillText = read(SKILL);
  const bytes = skStat(join(HERE, "..", "res", "vault.wasm")).size;
  const bare1dp = (Number(vaultFunding(bytes)) / 1e24).toFixed(1);
  const help = skUsage();
  assert.ok(help.includes(bare1dp), `usage() does not quote ${bare1dp} NEAR`);
  assert.ok(skillText.includes(bare1dp), `SKILL.md does not quote ${bare1dp} NEAR`);
  // Sanity on the derivation itself, so a broken vaultFunding cannot make both
  // documents agree on a wrong number.
  assert.ok(Number(codeStakeYocto(bytes)) / 1e24 > 2.5, "code stake derivation looks wrong");
});

test("SKILL.md says an agent must be asked for, or the vault cannot pay", () => {
  // The documented one-liner omitted --agents, and the default creates none, so
  // following our own docs produced a vault that answers
  // "Paying requires NEAR_VAULT_AGENT_ID and NEAR_VAULT_AGENT_KEY".
  const skillText = read(SKILL);
  // Not just "is --agents mentioned somewhere" — it IS, in a list of useful
  // flags, and that passed while the bug was live. The COMMAND the agent is
  // told to run is what matters.
  const cmds = skillText
    .split("\n")
    .filter((l) => l.includes("npx") && l.includes("create-float"))
    .map((l) => l.trim());
  assert.ok(cmds.length >= 1, "SKILL.md has no create-float command to check");
  const without = cmds.filter((c) => !c.includes("--agents") && !c.includes("--help"));
  assert.deepEqual(
    without,
    [],
    "a documented setup command omits --agents, so following the docs yields a vault that cannot spend",
  );
});
