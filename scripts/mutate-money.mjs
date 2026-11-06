/**
 * Mutation check for the money formatter.
 *
 * money.test.ts passed on the first run, which is exactly when a suite is
 * least trustworthy - it may be asserting the shape of the output rather than
 * the rules that produce it. Each mutant below is a plausible wrong version
 * that a reader would not notice in review, and every one must be caught.
 *
 * M1 is the bug this module was written to fix, reintroduced: if the suite
 * cannot catch a precision change, it cannot protect the thing it exists for.
 *
 * M4 and M5 are the ones I would most expect to survive, because "is not
 * zero but prints as zero" is the rule people delete as pedantry.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/lib/money.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 dollars render with 3 decimals again (the original bug)",
    from: "return `${sign}$${group(round(abs, 2), 2)}`;",
    to: "return `${sign}$${group(round(abs, 3), 3)}`;",
  },
  {
    name: "M2 exact zero falls through, so $0.00 becomes the tiny marker",
    from: 'if (value === 0) return "$0.00";',
    to: 'if (value === 0 && false) return "$0.00";',
  },
  {
    name: "M3 rounding goes half-to-even, so 1.005 loses a cent",
    from: "return (Math.sign(scaled) * Math.round(nudged)) / factor;",
    to: "return Number(n.toFixed(dp));",
  },
  {
    name: "M4 a non-zero that rounds to zero prints as $0.00 - money vanishes",
    from: "if (round(abs, 2) === 0) return `${sign}<$0.01`;",
    to: "if (false) return `${sign}<$0.01`;",
  },
  {
    name: "M5 the same, for token quantities",
    from: "return ctx === \"compact\" ? `${sign}<0.001` : `${sign}<${10 ** -decimals}`;",
    to: 'return "0";',
  },
  {
    name: "M6 NaN/null render as themselves instead of --",
    from: "typeof n === \"number\" && Number.isFinite(n);",
    to: 'typeof n === "number";',
  },
  {
    name: "M7 token quantities keep trailing zeros, so 1.5 reads 1.5000",
    from: 'const text = group(rounded, decimals).replace(/\\.?0+$/, "");',
    to: "const text = group(rounded, decimals);",
  },
  {
    name: "M8 compact and detailed use the same precision",
    from: 'const threshold = ctx === "compact" ? 0.01 : 0.0001;',
    to: "const threshold = 0.0001;",
  },
  {
    name: "M9 abbreviation kicks in on the detail view too",
    from: 'if (ctx === "compact" && abs >= 1000) {',
    to: "if (abs >= 1000) {",
  },
];

let survived = 0;
for (const m of MUTANTS) {
  if (!orig.includes(m.from)) {
    console.log(`  SKIP (pattern absent)  ${m.name}`);
    survived++;
    continue;
  }
  writeFileSync(p, orig.replace(m.from, m.to));
  let verdict;
  try {
    execSync("npx vitest run lib/money.test.ts", {
      cwd: "apps/dashboard",
      stdio: "pipe",
    });
    verdict = "SURVIVED <-- NOT COVERED";
    survived++;
  } catch {
    verdict = "killed";
  }
  console.log(`  ${verdict.padEnd(22)} ${m.name}`);
}

writeFileSync(p, orig);
console.log(`  reverted byte-identical: ${readFileSync(p, "utf8") === orig}`);
process.exit(survived ? 1 : 0);
