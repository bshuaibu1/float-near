#!/usr/bin/env node
/**
 * Does the signing page refuse an illegal vault id BEFORE the wallet?
 *
 * WHAT WENT WRONG. The page builds the vault id client-side and never checked
 * its length. An owner whose derived id exceeds NEAR's 64-character cap was
 * shown a plan containing an illegal address and allowed to sign a ~3.47 NEAR
 * transaction that could only fail. The deposit returns — `begin()` panics
 * BAD_VAULT_ID and NEAR reverts the transaction — but the gas is burnt and the
 * user gets a raw contract panic with no hint of the cause.
 *
 * The MCP refused this up front all along, via the factory's own
 * `vault_id_for` view. The BROWSER path was the unguarded one, which is
 * backwards: DECISIONS.md calls it "the browser `vault_create` path for
 * onboarding strangers", so it is the path a stranger actually meets.
 *
 * WHY EXTRACT FROM THE HTML instead of testing a copy. `web/index.html` is a
 * standalone page with no module system, so there is nothing to import. A
 * reimplementation here could pass while the shipped page stayed broken —
 * which is the exact failure this repo already hit with `res/vault.wasm` and
 * three generations of artifact on disk. So this pulls the real function out
 * of the real file and runs THAT.
 *
 * The boundaries below are not invented. They were read off the live factory
 * `fac.floatv4.testnet` via `vault_id_for`: a 44-character owner lands on
 * exactly 64 and is accepted, 45 is refused, and a 64-character implicit
 * account returns null.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PAGE = resolve(import.meta.dirname, "..", "web", "index.html");
const src = readFileSync(PAGE, "utf8");

/**
 * Pull both functions out by name. Brace-matching rather than a lazy regex:
 * the body contains nested braces in template literals, and `[\s\S]*?}` would
 * stop at the first one and produce something that does not parse.
 */
function extract(name, decl) {
  const start = src.indexOf(decl);
  if (start < 0) {
    console.error(`BROKEN: ${name} is not in web/index.html — the guard is gone.`);
    process.exit(1);
  }
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  console.error(`BROKEN: could not find the end of ${name}.`);
  process.exit(1);
}

const derive = "const derivePrefix = (owner) => owner.replaceAll(\".\", \"-\");";
if (!src.includes(derive)) {
  console.error("BROKEN: derivePrefix is not where this check expects it.");
  process.exit(1);
}
const fnSrc = extract("vaultIdProblem", "function vaultIdProblem(");

// eslint-disable-next-line no-new-func
const vaultIdProblem = new Function(`${derive}\n${fnSrc}\nreturn vaultIdProblem;`)();

const F = "fac.floatv4.testnet"; // 19 chars, the live testnet factory
const ok = (owner, label, why) => {
  const r = vaultIdProblem(owner, label, F);
  if (r !== null) {
    console.error(`BROKEN: refused something legal (${why})\n  ${owner}\n  -> ${r}`);
    process.exit(1);
  }
};
const refuses = (owner, label, mustSay, why) => {
  const r = vaultIdProblem(owner, label, F);
  if (r === null) {
    console.error(`BROKEN: accepted something the factory refuses (${why})\n  ${owner}`);
    process.exit(1);
  }
  if (!mustSay.test(r)) {
    console.error(`BROKEN: refused ${why} but the message does not explain it.\n  ${r}`);
    process.exit(1);
  }
};

// ---- the boundary, as the live factory reports it -------------------------
ok("alice.testnet", null, "an ordinary account");
ok("work12.testnet", "fleet", "an ordinary account with a label");
// 44 characters -> id is exactly 64. `vault_id_for` accepts this on chain.
ok(`${"a".repeat(36)}.testnet`, null, "44 chars, lands exactly on the 64 limit");
// 45 -> 65. Refused on chain.
refuses(`${"a".repeat(37)}.testnet`, null, /64|limit/i, "45 chars, one over");

// ---- implicit accounts, the case that cannot be worked around -------------
const implicit = "a".repeat(64);
refuses(implicit, null, /implicit/i, "a 64-character implicit account");
refuses(implicit, "demo", /implicit/i, "an implicit account with a label");
{
  // The advice has to be the only one that helps. Telling an implicit-account
  // user to shorten a label or pick another factory is a dead end.
  const msg = vaultIdProblem(implicit, null, F);
  if (!/named account/i.test(msg)) {
    console.error(`BROKEN: implicit-account message does not say to use a named account.\n  ${msg}`);
    process.exit(1);
  }
  if (!/[0-9a-f]{64}/.test(implicit) || msg.includes(implicit)) {
    console.error("BROKEN: the message should abbreviate the 64-char id, not echo it whole.");
    process.exit(1);
  }
}

// ---- a label is what pushes a borderline name over ------------------------
{
  // 40 chars -> 60 unlabelled (fine); + "-demo" -> 65 (over).
  const owner = `${"a".repeat(32)}.testnet`;
  ok(owner, null, "40 chars unlabelled");
  refuses(owner, "demo", /label/i, "40 chars plus a label");
  const msg = vaultIdProblem(owner, "demo", F);
  if (!/Dropping the label/.test(msg)) {
    console.error(`BROKEN: a label-caused overflow should say dropping it would help.\n  ${msg}`);
    process.exit(1);
  }
}

// ---- it must not fire on missing inputs -----------------------------------
// `render()` can run before a wallet is connected; a guard that threw or
// refused there would break the page for everyone.
ok(null, null, "no owner yet");
ok("alice.testnet", null, "no label");
if (vaultIdProblem("alice.testnet", null, null) !== null) {
  console.error("BROKEN: refused when no factory is configured; that is a different error path.");
  process.exit(1);
}

// ---- and the page must actually CALL it -----------------------------------
// A pure function nothing invokes is the same as no guard at all.
if (!/const idProblem = vaultIdProblem\(who, LABEL, FACTORY\)/.test(src)) {
  console.error("BROKEN: vaultIdProblem exists but render() never calls it.");
  process.exit(1);
}
if (!/if \(idProblem\)/.test(src)) {
  console.error("BROKEN: render() calls vaultIdProblem but never acts on the result.");
  process.exit(1);
}

console.log("vault id guard: 11 case(s) pass, and the page calls it");
