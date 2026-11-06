/**
 * Mutation check for the watch state machine.
 *
 * M1 is the off-by-one that would tell someone whose transaction took the
 * full window that it "stopped watching" when it had in fact landed. M3/M4
 * are the hidden-tab budget: getting those wrong means a tab left in the
 * background silently burns its three minutes and gives up before the user
 * ever looks again.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/lib/watch.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 budget checked BEFORE success (last-moment landing lost)",
    from: `  if (opts.allApplied) return { phase: "applied", polls: s.polls };

  if (!opts.tabVisible) return s;

  const polls = s.polls + 1;
  if (polls > MAX_POLLS) return { phase: "gave-up", polls };`,
    to: `  if (!opts.tabVisible) return s;

  const polls = s.polls + 1;
  if (polls > MAX_POLLS) return { phase: "gave-up", polls };
  if (opts.allApplied) return { phase: "applied", polls: s.polls };`,
  },
  {
    name: "M2 off-by-one on the limit (>= instead of >)",
    from: "  if (polls > MAX_POLLS) return { phase: \"gave-up\", polls };",
    to: "  if (polls >= MAX_POLLS) return { phase: \"gave-up\", polls };",
  },
  {
    name: "M3 hidden tab still spends the budget",
    from: "  if (!opts.tabVisible) return s;",
    to: "",
  },
  {
    name: "M4 hidden tab still fetches",
    from: '  return s.phase === "watching" && tabVisible;',
    to: '  return s.phase === "watching";',
  },
  {
    name: "M5 applied state keeps fetching",
    from: '  if (s.phase !== "watching") return s;',
    to: '  if (s.phase === "idle") return s;',
  },
  {
    name: "M6 startWatch does not reset the poll count",
    from: '  return txCount > 0 ? { phase: "watching", polls: 0 } : IDLE;',
    to: '  return txCount > 0 ? { phase: "watching", polls: MAX_POLLS } : IDLE;',
  },
  {
    name: "M7 singular/plural message inverted",
    from: '  return txCount > 1 ? `${txCount} changes applied` : "Change applied";',
    to: '  return txCount > 1 ? "Change applied" : `${txCount} changes applied`;',
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
    execSync("npx vitest run lib/watch.test.ts", { cwd: "apps/dashboard", stdio: "pipe" });
    verdict = "SURVIVED <-- NOT COVERED";
  } catch {
    verdict = "killed";
  }
  console.log(`  ${verdict.padEnd(22)} ${m.name}`);
}

writeFileSync(p, orig);
console.log(`  reverted byte-identical: ${readFileSync(p, "utf8") === orig}`);
