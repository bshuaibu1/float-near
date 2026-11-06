/**
 * Mutation check for the "did it land" comparator.
 *
 * The dangerous failure mode here is a FALSE POSITIVE: reporting a change as
 * applied when it is not. That would tell the owner their limit took effect
 * while the chain still enforces the old one. M1/M2/M5 are all that shape.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/lib/applied.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 a missing node counts as applied (false positive)",
    from: "  if (!n) return false;",
    to: "  if (!n) return true;",
  },
  {
    name: "M2 caps: only the daily cap is checked",
    from: "      return sameAmount(n.dailyBudget, e.daily) && sameAmount(n.perTxLimit, e.perTx);",
    to: "      return sameAmount(n.dailyBudget, e.daily);",
  },
  {
    name: "M3 amounts compared as STRINGS (25 vs 25.0 -> pending forever)",
    from: "  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;",
    to: "  return a === b;\n  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;",
  },
  {
    name: "M4 recipients: length ignored, a prefix matches",
    from: "  return x.length === y.length && x.every((v, i) => v === y[i]);",
    to: "  return x.every((v, i) => v === y[i]);",
  },
  {
    name: "M5 a null vault read counts as applied (false positive)",
    from: '  if (e.kind === "paused") return vault?.paused === e.value;',
    to: '  if (e.kind === "paused") return vault ? vault.paused === e.value : true;',
  },
  {
    name: "M6 absent cooldown no longer defaults to 0",
    from: "      return (n.cooldownSeconds ?? 0) === e.seconds;",
    to: "      return n.cooldownSeconds === e.seconds;",
  },
];

for (const m of MUTANTS) {
  if (!orig.includes(m.from)) {
    console.log(`  SKIP (pattern absent)  ${m.name}`);
    continue;
  }
  writeFileSync(p, orig.replace(m.from, m.to));
  let verdict;
  try {
    execSync("npx vitest run lib/applied.test.ts", { cwd: "apps/dashboard", stdio: "pipe" });
    verdict = "SURVIVED <-- NOT COVERED";
  } catch {
    verdict = "killed";
  }
  console.log(`  ${verdict.padEnd(22)} ${m.name}`);
}

writeFileSync(p, orig);
console.log(`  reverted byte-identical: ${readFileSync(p, "utf8") === orig}`);
