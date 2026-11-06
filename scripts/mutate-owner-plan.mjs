/**
 * Mutation check for the owner-plan builder.
 *
 * Retargeted after `addRole` was removed. The previous set aimed entirely at
 * that action, so when it went every mutant reported SKIP - a suite whose
 * subject no longer exists, which reads identically to a suite that passed.
 * verify-all caught it, which is the whole reason it treats SKIP as a
 * failure.
 *
 * What is left is still worth protecting. M1 is the sharpest: `recipients`
 * defaulting to `[]` instead of `null` does not fail here - it produces a
 * transaction the owner signs, and the CONTRACT panics, after they have
 * approved it.
 *
 * Multi-line anchors are joined on an LF constant rather than typed as
 * escapes: this script was first generated through a shell heredoc, where the
 * escape became a real newline and the file would not parse.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "packages/float-adapter/src/owner-plan.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 recipients default [] instead of null (contract panics after signing)",
    from: "planSetRecipients(env.vault, b.nodeId, b.recipients ?? null)",
    to: "planSetRecipients(env.vault, b.nodeId, b.recipients ?? [])",
  },
  {
    name: "M2 caps pre-scaled here, so planSetNodeCaps scales them twice",
    from: '          dailyCap: b.dailyCap ?? "0",',
    to: '          dailyCap: String(Number(b.dailyCap ?? "0") * 1e6),',
  },
  {
    name: "M3 freeze defaults to true, so a bare call FREEZES an agent",
    from: "planFreezeNode(env.vault, b.nodeId, b.frozen ?? false)",
    to: "planFreezeNode(env.vault, b.nodeId, b.frozen ?? true)",
  },
  {
    name: "M4 pause defaults to true, so a bare call STOPS the vault",
    from: "planSetPaused(env.vault, b.paused ?? false)",
    to: "planSetPaused(env.vault, b.paused ?? true)",
  },
  {
    name: "M5 an unknown action throws a plain Error, so the HTTP layer cannot tell it from a bad argument",
    from: "throw new UnknownActionError(String((b as { action: string }).action));",
    to: "throw new Error(`unknown action: ${String((b as { action: string }).action)}`);",
  },
  {
    name: "M6 caps addressed to something other than the vault",
    from: "return planSetNodeCaps(env.vault, b.nodeId, [",
    to: 'return planSetNodeCaps("someone.else", b.nodeId, [',
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
    execSync("npx vitest run src/owner-plan.test.ts", {
      cwd: "packages/float-adapter",
      stdio: "pipe",
    });
    verdict = "SURVIVED <-- NOT COVERED";
  } catch {
    verdict = "killed";
  }
  console.log(`  ${verdict.padEnd(22)} ${m.name}`);
}

writeFileSync(p, orig);
console.log(`  reverted byte-identical: ${readFileSync(p, "utf8") === orig}`);
