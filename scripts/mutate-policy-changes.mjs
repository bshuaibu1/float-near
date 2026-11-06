/**
 * Mutation check for the review-panel diff.
 *
 * This is the last thing a user reads before signing, so the mutants are
 * phrased as what the owner would be told. M1 and M2 are the dangerous ones:
 * both produce a review line that describes a DIFFERENT edit from the one the
 * transaction performs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/lib/policy-changes.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 'from' always reads unset, so a cut looks like filling a blank",
    from: "      from: base.daily ? `${base.daily} USDC` : \"unset\",\n      to: `${draft.dailyCap || \"0\"} USDC`,",
    to: '      from: "unset",\n      to: `${draft.dailyCap || "0"} USDC`,',
  },
  {
    name: "M2 an emptied payee list reads as a lockout rather than inheritance",
    from: "      to: draft.recipients.length ? draft.recipients.join(\", \") : INHERIT_FROM,",
    to: '      to: draft.recipients.length ? draft.recipients.join(", ") : "none",',
  },
  {
    name: "M3 per-payment is filed under its own group, implying a second signature",
    from: '      group: "caps",\n      label: "Per payment",',
    to: '      group: "cooldown",\n      label: "Per payment",',
  },
  {
    name: "M4 a reorder of payees is not reported as a change",
    from: "  if (draft.recipients.join(\"\\n\") !== base.ownRecipients.join(\"\\n\")) {",
    to: "  if ([...draft.recipients].sort().join(\"\\n\") !== [...base.ownRecipients].sort().join(\"\\n\")) {",
  },
  {
    name: "M5 cooldown is shown as raw seconds",
    from: "      from: cooldownLabel(base.cooldown),\n      to: cooldownLabel(draft.cooldown),",
    to: "      from: String(base.cooldown),\n      to: String(draft.cooldown),",
  },
  {
    name: "M6 changes are reported even with no agent selected",
    from: "  if (!hasSelection) return [];",
    to: "  if (false) return [];",
  },
  {
    name: "M7 an emptied cap renders as a blank instead of 0",
    from: "      to: `${draft.dailyCap || \"0\"} USDC`,",
    to: "      to: `${draft.dailyCap} USDC`,",
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
    execSync("npx vitest run lib/policy-changes.test.ts", {
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
