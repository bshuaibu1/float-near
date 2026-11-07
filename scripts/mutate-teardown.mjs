/**
 * Mutation check for the teardown guard.
 *
 * This module decides whether a user is shown a control that deletes an
 * account which cannot be recovered. Every mutant below is a plausible
 * simplification — the kind of thing that reads fine in review — and each one
 * would, if it survived, let a vault holding money be reported as empty.
 *
 * M1 and M2 are the pair that matter. "null is not zero" and "a malformed
 * value is not zero" are exactly the rules a tidy-up deletes, because the
 * code looks redundant next to a BigInt parse that appears to handle
 * everything.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/lib/teardown.ts";
const orig = readFileSync(p, "utf8");

/**
 * LINE ENDINGS ARE NOT PART OF THE PATTERN.
 *
 * This file is CRLF on Windows, so a multi-line `from` written with an LF
 * escape matches NOTHING — and a mutant whose pattern is absent is reported
 * as SKIP, which this script counts as survived. That is the right call (a
 * mutation that cannot be applied proves nothing), and it is also how two
 * mutants here sat silently unapplied on the first run: the suite reported a
 * failure, which read as "the tests are weak" rather than "the script is
 * broken".
 *
 * So: match against an LF-normalised copy, and write back in whatever the
 * file actually uses, so the revert is byte-identical either way.
 *
 * The characters are built from char codes rather than written as escapes,
 * because every shell heredoc that has touched this repo eats a backslash —
 * which is exactly how the first attempt at this comment ended up containing
 * a real newline instead of the escape it was describing.
 */
const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const CRLF = CR + NL;
const usesCrlf = orig.includes(CRLF);
const toLf = (t) => t.split(CRLF).join(NL);
const toFile = (t) => (usesCrlf ? t.split(NL).join(CRLF) : t);
const origLf = toLf(orig);

const MUTANTS = [
  {
    name: "M1 an unreadable balance is treated as zero — the delete unlocks on an RPC failure",
    from:
      'if (vaultTokenBalance === null || vaultTokenBalance === undefined || vaultTokenBalance === "") {',
    to: "if (false) {",
  },
  {
    name: 'M2 the decimal check goes, so BigInt("0x0") reports a malformed balance as EMPTY',
    from: "if (!/^-?\\d+$/.test(vaultTokenBalance)) {",
    to: "if (false) {",
  },
  {
    name: "M3 a negative balance falls through to the empty branch",
    from: "if (bal < BigInt(0)) {",
    to: "if (false) {",
  },
  {
    name: "M4 any balance at all is called empty — the inverse of the whole guard",
    from: "if (bal > BigInt(0)) {",
    to: "if (false) {",
  },
  /**
   * M5 WAS HERE AND IS DELIBERATELY GONE: it was an EQUIVALENT MUTANT.
   *
   * It replaced `BigInt(x)` with `BigInt(Number(x))`, which loses exactness
   * past 2^53. That reads like an obvious bug, and it ran as SURVIVED — so
   * the first instinct was that the suite was weak.
   *
   * It is not. Every output of `teardownState` is decided by `bal > 0n`,
   * `bal < 0n` and `bal === 0n`. Rounding a huge integer produces a
   * different huge integer; it can never produce zero or flip a sign. No
   * input distinguishes the two versions, so no test can kill it, and
   * writing one would mean contorting the module to make a difference that
   * does not matter observable.
   *
   * WHERE EXACTNESS DOES MATTER is the withdraw AMOUNT, and it is handled by
   * never parsing it at all: the base-unit string the chain returned is
   * passed through to the payload verbatim. A reparse there would leave
   * dust behind and the vault would never reach zero. That is pinned in
   * payloads.test.ts ("is exact past 2^53, where floating point stops
   * being"), on the function that actually carries the number.
   *
   * The `teardownState` exactness test stays as documentation of why BigInt
   * is used, and is honestly labelled as not mutation-sensitive.
   */
  {
    name: "M6 withdraw is offered on an empty vault, sending the owner to sign a revert",
    from: "  return { canWithdraw: false, isEmpty: true, blocker: null };",
    to: "  return { canWithdraw: true, isEmpty: true, blocker: null };",
  },
  {
    name: "M7 the blocker goes silent, so a refusal has no reason attached",
    from: '"This vault still holds tokens. Move them out first — deleting an account does " +',
    to: '"" +',
  },
  {
    name: "M8 the teardown command drops its network, defaulting a mainnet teardown to testnet",
    from: "    `NETWORK=${network}`,",
    to: "",
  },
  /**
   * M9 AND M10 ARE THE PAIR THAT COST REAL MONEY TO FIND.
   *
   * The command genuinely shipped without `OWNER` and `TOKEN`, so both fell
   * back to the script's defaults — the author's dev account and the mock
   * FT. M10 is the worse half and the reason the script no longer defaults:
   * `ft_balance_of` on a real-but-wrong token returns "0", so the teardown
   * reports nothing to withdraw, finds no registration to unregister, and
   * deletes the vault with the balance still inside. Reproduced against a
   * live vault holding 46.5 USDC with TOKEN=wrap.testnet — every read said
   * zero and nothing in the output hinted otherwise.
   */
  {
    name: "M9 the command drops OWNER, so the user inherits the script's dev account",
    from: "    `OWNER=${owner}`,",
    to: "",
  },
  {
    name: "M10 the command drops TOKEN — a wrong token reads as zero and the delete strands the real balance",
    from: "    `TOKEN=${token}`,",
    to: "",
  },
  /**
   * M11 is the subtle one, because it looks like MORE checking rather than
   * less. Asserting `EXPECT_TOKENS=0` on a balance that could not be read
   * converts "I do not know" into "I checked, it is empty" — and the script
   * then passes its own guard and deletes. An unknown balance has to omit
   * the assertion entirely.
   */
  {
    name: "M11 an unknown balance asserts zero instead of omitting the expectation",
    from: "  if (expectTokens !== null) parts.push(`EXPECT_TOKENS=${expectTokens}`);",
    to: "  parts.push(`EXPECT_TOKENS=${expectTokens ?? 0}`);",
  },
  {
    name: "M12 baseToDecimal goes back to float arithmetic, rounding the assertion past 2^53",
    from: "  const d = base.padStart(decimals + 1, \"0\");",
    to: "  return (Number(base) / 10 ** decimals).toFixed(decimals);\n  const d = base.padStart(decimals + 1, \"0\");",
  },
  {
    name: "M13 baseToDecimal accepts anything, so a malformed balance becomes a plausible number",
    from: "  if (!/^\\d+$/.test(base)) throw new Error(`not a base-unit string: ${base}`);",
    to: "",
  },
];

let survived = 0;
for (const m of MUTANTS) {
  if (!origLf.includes(m.from)) {
    console.log(`  SKIP (pattern absent)  ${m.name}`);
    survived++;
    continue;
  }
  writeFileSync(p, toFile(origLf.replace(m.from, m.to)));
  let verdict;
  try {
    execSync("npx vitest run lib/teardown.test.ts", {
      cwd: "apps/dashboard",
      stdio: "pipe",
    });
    verdict = "SURVIVED";
    survived++;
  } catch {
    verdict = "killed";
  }
  console.log(`  ${verdict.padEnd(21)}${m.name}`);
}

writeFileSync(p, orig);
const restored = readFileSync(p, "utf8") === orig;
console.log(`  reverted byte-identical: ${restored}`);

if (!restored) {
  console.error("FATAL: the file was not restored.");
  process.exit(1);
}
if (survived) {
  console.error(`\n${survived} mutant(s) survived — the suite does not pin this behaviour.`);
  process.exit(1);
}
