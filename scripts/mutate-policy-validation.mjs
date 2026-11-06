/**
 * Mutation check for the policy validator.
 *
 * M1 IS THE POINT OF THE WHOLE EXERCISE: it restores the exact bug that was
 * shipped - the downward allocation rule running only at the root. If the
 * suite cannot kill that, then adding `parent` and rewriting the check proved
 * nothing, and an owner can still be charged gas for a transaction the
 * contract was always going to reject.
 *
 * The boundary mutants (M4, M5) matter nearly as much. The contract uses `>`
 * and `<`, not `>=` and `<=`, and an off-by-one in the safe-looking direction
 * blocks edits that are perfectly legal - which users experience as the
 * product being broken, with no error anyone can act on.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/lib/policy-validation.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 downward check runs ONLY at root again (the shipped bug)",
    from: "    const kids = childrenOf(selected, all, nodeIdOf);",
    to: "    const kids = selected.depth === 0 ? childrenOf(selected, all, nodeIdOf) : [];",
  },
  {
    name: "M2 children are found by DEPTH instead of parent",
    from: "  return all.filter((a) => a.parent === id);",
    to: "  return all.filter((a) => (a.depth ?? 0) === (node.depth ?? 0) + 1);",
  },
  {
    name: "M3 upward check skipped, so a child may overflow its parent",
    from: "    const parentNode = all.find((a) => nodeIdOf(a) === selected.parent);",
    to: "    const parentNode = undefined;",
  },
  {
    name: "M4 per_tx == daily is rejected, blocking a legal edit",
    from: "d > 0 && p > 0 && p > d) {",
    to: "d > 0 && p > 0 && p >= d) {",
  },
  {
    name: "M5 downward boundary becomes <=, rejecting an exact allocation",
    from: "      if (d < allocated) {",
    to: "      if (d <= allocated) {",
  },
  {
    name: "M6 upward boundary becomes >=, rejecting exact headroom",
    from: "        if (others + d > parentCap) {",
    to: "        if (others + d >= parentCap) {",
  },
  {
    name: "M7 allocation rules run even when strict allocation is OFF",
    from: "  if (capsTouched && strictAllocation && selected && Number.isFinite(d) && d > 0) {",
    to: "  if (capsTouched && selected && Number.isFinite(d) && d > 0) {",
  },
  {
    name: "M8 the 32-payee cap is off by one",
    from: "  if (recipients.length > 32)",
    to: "  if (recipients.length > 33)",
  },
  {
    name: "M9 an untouched pair is validated anyway, nagging about existing state",
    from: "  const capsTouched = dailyCap !== base.daily || perTxCap !== base.perTx;",
    to: "  const capsTouched = true;",
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
    execSync("npx vitest run lib/policy-validation.test.ts", {
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
