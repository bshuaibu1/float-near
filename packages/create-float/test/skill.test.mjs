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

const AGENT_ACCOUNT_NEAR = 0.12; // a VIRTUAL agent: gasKeyFunding() default

/**
 * ROUND UP, NEVER TO NEAREST — and this test previously REQUIRED the bug.
 *
 * It asserted `bare.toFixed(1)`, which rounds to nearest: a real ask of 3.347
 * became "3.3", so SKILL.md said 3.3 and this test insisted on it. A user
 * topping up to exactly the documented figure is refused for want of 0.047.
 *
 * Found 2026-11-01 by driving the PUBLISHED 0.3.2 — the same bug class 0.3.2
 * itself shipped to fix in `usage()`, surviving one document over because the
 * guard for the other document rounded the wrong way. Fixing a figure in one
 * place and leaving its twin is the recurring shape here; this is the third
 * time this number has gone stale.
 *
 * So the tolerance is now ONE-SIDED: a document may overstate the cost (it
 * costs the reader nothing, the stake is refundable, and the wizard quotes the
 * exact total before spending) but must never understate it, because that sends
 * them to a refusal.
 */
const ceil1 = (n) => (Math.ceil(n * 10) / 10).toFixed(1);

test("REAL DATA: SKILL.md never UNDERSTATES the setup cost", () => {
  const skillText = read(SKILL);
  const bytes = skStat(join(HERE, "..", "res", "vault.wasm")).size;
  const bare = Number(vaultFunding(bytes)) / 1e24;
  const withAgent = bare + AGENT_ACCOUNT_NEAR;

  assert.ok(
    skillText.includes(ceil1(bare)),
    `SKILL.md does not quote ${ceil1(bare)} NEAR for a bare vault (real ask ${bare.toFixed(3)})`,
  );
  assert.ok(
    skillText.includes(ceil1(withAgent)),
    `SKILL.md does not quote ${ceil1(withAgent)} NEAR with one agent (real ask ${withAgent.toFixed(3)})`,
  );

  // And the figure it must NOT carry: the nearest-rounded value, whenever that
  // rounds DOWN. This is the assertion the old test had inverted.
  const nearest = bare.toFixed(1);
  if (Number(nearest) < bare) {
    assert.ok(
      !new RegExp(`\\*\\*${nearest.replace(".", "\\.")}\\*\\*`).test(skillText),
      `SKILL.md quotes **${nearest}** for a bare vault, which is BELOW the real ${bare.toFixed(3)}`,
    );
  }
  assert.ok(
    !/~\s*3 NEAR|about 3 NEAR|hold ~3/i.test(skillText),
    "SKILL.md still says ~3 NEAR, which is below the real ask and fails the affordability check",
  );
});

test("REAL DATA: usage() and SKILL.md do not disagree about the cost", () => {
  // Two documents quoting one measured fact is how every drift here started.
  //
  // NOT a substring check. The previous version asserted `help.includes("3.3")`
  // and passed because "3.347" CONTAINS "3.3" — so a three-decimal figure
  // silently satisfied a one-decimal assertion and the two documents were never
  // actually compared. Parse the figures and compare them as NUMBERS.
  const skillText = read(SKILL);
  const bytes = skStat(join(HERE, "..", "res", "vault.wasm")).size;
  const bare = Number(vaultFunding(bytes)) / 1e24;
  const help = skUsage();

  // SCOPE TO THE COST SENTENCE. Sweeping every decimal in the document was the
  // first version of this and it failed on "measured 1.5% at 0.50 USDC" — a fee
  // percentage read as a NEAR funding figure. The sentence is located first and
  // its absence is a FAILURE, so a changed wording cannot make this vacuous.
  const costSentence = (t, re, label) => {
    const m = t.match(re);
    assert.ok(m, `could not find the cost statement in ${label} — this test is measuring nothing`);
    return m[0];
  };
  // [\s\S]*? not [^.]*? — the figures THEMSELVES contain periods ("3.347"), so a
  // "anything but a full stop" match cannot reach the end of the sentence, and
  // both texts wrap across lines so `.` alone will not either.
  const helpCost = costSentence(help, /Measured from the[\s\S]*?with one agent/, "usage()");
  const skillCost = costSentence(skillText, /hold \*\*[\d.]+ NEAR\*\*[\s\S]*?per agent/, "SKILL.md");

  const figures = (t) => [...t.matchAll(/\b(\d+\.\d{1,3})\b/g)].map((m) => Number(m[1]));
  // 0.55 per agent is a legitimate figure in both sentences and is NOT a vault
  // total, so only figures above 1 are totals here.
  const helpFigs = figures(helpCost).filter((n) => n > 1);
  const skillFigs = figures(skillCost).filter((n) => n > 1);
  assert.ok(helpFigs.length >= 2, `usage()'s cost sentence quotes ${helpFigs.length} totals; expected >= 2`);
  assert.ok(skillFigs.length >= 2, `SKILL.md's cost sentence quotes ${skillFigs.length} totals; expected >= 2`);

  // Neither document may promise less than the wizard will demand.
  assert.ok(
    Math.min(...helpFigs) + 1e-9 >= bare,
    `usage() quotes ${Math.min(...helpFigs)} but the wizard demands ${bare.toFixed(3)}`,
  );
  assert.ok(
    Math.min(...skillFigs) + 1e-9 >= bare,
    `SKILL.md quotes ${Math.min(...skillFigs)} but the wizard demands ${bare.toFixed(3)} ` +
      `(sentence: "${skillCost.replace(/\s+/g, " ").slice(0, 110)}")`,
  );
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
