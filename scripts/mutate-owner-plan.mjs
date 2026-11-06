/**
 * Mutation check for the owner-plan builder, now that add_role is in it.
 *
 * M1 is the dangerous one. `add_role` is the ONLY owner method whose deposit
 * is not one yocto, and sending one yocto installs a gas key that cannot make
 * a single call - NEAR reserves `prepaid_gas * 1e9` up front. The transaction
 * SUCCEEDS, the agent appears in the tree, and it is dead on arrival. Nothing
 * reverts and nothing warns.
 *
 * Multi-line anchors are built by joining on an LF constant rather than typed
 * as escapes: this script was first generated through a shell heredoc, where
 * the escape became a real newline and the file would not parse.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const LF = String.fromCharCode(10);
const p = "packages/float-adapter/src/owner-plan.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 add_role funding replaced by one yocto (installs a dead gas key)",
    from: "        b.fundingYocto,",
    to: '        "1",',
  },
  {
    name: "M2 add_role recipients default [] instead of null (contract panic)",
    from: "        b.recipients ?? null,",
    to: "        b.recipients ?? [],",
  },
  {
    name: "M3 caps pre-scaled, so planAddRole scales them twice",
    from: "            dailyCap: b.dailyCap,",
    to: "            dailyCap: String(Number(b.dailyCap) * 1e6),",
  },
  {
    name: "M4 cooldown default dropped",
    from: "        b.cooldownSec ?? 0,",
    to: "        b.cooldownSec as number,",
  },
  {
    name: "M5 add_role addressed to something other than the vault",
    from: ["      return planAddRole(", "        env.vault,"].join(LF),
    to: ["      return planAddRole(", '        "someone.else",'].join(LF),
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
