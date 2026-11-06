/**
 * Does the new suite actually catch the bug the user reported?
 *
 * M1 restores the ORIGINAL broken behaviour verbatim: a select value derived
 * purely from the seconds, ignoring customMode. If the tests pass against it,
 * they are decoration and the fix is unproven.
 *
 * The rest are ordinary off-by-one / inversion mutants.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/lib/cooldown.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 the ORIGINAL bug: value ignores customMode",
    from: "  if (customMode || !isPresetCooldown(seconds)) return CUSTOM;",
    to: "  if (!isPresetCooldown(seconds)) return CUSTOM;",
  },
  {
    name: "M2 choosing Custom does nothing (the old onChange)",
    from: "  if (value === CUSTOM) return { seconds: currentSeconds, customMode: true };",
    to: "  if (value === CUSTOM) return { seconds: currentSeconds, customMode: false };",
  },
  {
    name: "M3 choosing a preset fails to leave custom mode",
    from: "  return { seconds: Number(value), customMode: false };",
    to: "  return { seconds: Number(value), customMode: true };",
  },
  {
    name: "M4 off-preset chain value does not start custom",
    from: "  return !isPresetCooldown(seconds);",
    to: "  return false;",
  },
  {
    name: "M5 negative seconds are not clamped",
    from: "  return Math.max(0, Math.floor(Number(raw) || 0));",
    to: "  return Math.floor(Number(raw) || 0);",
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
    execSync("npx vitest run lib/cooldown.test.ts", {
      cwd: "apps/dashboard",
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
