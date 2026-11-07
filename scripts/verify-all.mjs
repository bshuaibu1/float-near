/**
 * One command that runs every check and REFUSES to report a false pass.
 *
 * Written after a near miss: `scripts/mutate-indent.mjs` targeted a function
 * that had just been deleted. It printed "anchor not found" and exited 1 - and
 * the loop that checked it was grepping output for "SURVIVED|SKIP", so it
 * counted zero problems and reported a pass. A check that CANNOT RUN looked
 * exactly like a check that passed.
 *
 * So every step here asserts three things, in this order:
 *   1. the exit code is zero
 *   2. the output matches a success pattern that must be PRESENT
 *   3. no failure pattern is present
 *
 * (2) is the part that catches a silently broken check: a command that dies
 * early, prints nothing useful and still exits 0 fails the must-contain test.
 */
import { execSync } from "node:child_process";

const LF_CHAR = String.fromCharCode(10);

const steps = [
  {
    name: "dashboard typecheck",
    /**
     * `--incremental false`, AND THAT IS THE WHOLE POINT OF THIS STEP.
     *
     * tsconfig.json sets `incremental: true`, so tsc writes
     * tsconfig.tsbuildinfo and skips files it believes are unchanged. This
     * gate was passing on that cache while the project did not actually
     * compile: `components/ui/button.tsx` imported `@base-ui/react/button`,
     * a package declared in package.json, never present in the lockfile and
     * never installed. A clean checkout — CI, a new machine, anyone — would
     * have failed where this said "ok".
     *
     * Found by accident, which is the problem: nothing here was going to
     * find it. A cache that can hide an error from a gate makes the gate
     * report the cache's opinion rather than the code's.
     *
     * The cost is a few seconds. A typecheck that is fast and sometimes
     * wrong is worth less than one that is slow and always right.
     */
    cmd: "npx tsc --noEmit --incremental false -p tsconfig.json",
    cwd: "apps/dashboard",
    // tsc prints nothing on success, so there is no success marker to require.
    mustNotMatch: /error TS/,
  },
  {
    name: "adapter typecheck",
    cmd: "npx tsc --noEmit -p tsconfig.json",
    cwd: "packages/float-adapter",
    mustNotMatch: /error TS/,
  },
  {
    name: "dashboard tests",
    cmd: "npx vitest run",
    cwd: "apps/dashboard",
    mustMatch: /Tests\s+\d+ passed/,
    mustNotMatch: /failed/,
  },
  {
    name: "adapter tests",
    cmd: "npx vitest run",
    cwd: "packages/float-adapter",
    mustMatch: /Tests\s+\d+ passed/,
    mustNotMatch: /failed/,
  },
  {
    name: "mcp tests",
    cmd: "npx vitest run",
    cwd: "packages/mcp",
    mustMatch: /Tests\s+\d+ passed/,
    mustNotMatch: /failed/,
  },
  {
    name: "invisible characters",
    cmd: "node scripts/scan-invisible-chars.mjs",
    cwd: ".",
    mustMatch: /no literal U\+00A0/,
  },
  {
    // The checker's OWN rules, pinned. Its git-ref half has almost no live
    // subject in this repo - nearly every ref here is a placeholder or
    // exempted - so the scan below can pass while the regexes are broken.
    // This runs first so a broken matcher is reported as a broken matcher,
    // not as a clean repo.
    name: "ref-checker self-test",
    cmd: "node scripts/check-script-refs.mjs --self-test",
    cwd: ".",
    mustMatch: /all \d+ self-tests passed/,
    mustNotMatch: /FAIL/,
  },
  {
    // Added after pruning 81 scripts, extended after deleting a merged
    // branch that a VPS runbook still named. A comment or a runbook line
    // pointing at a deleted file or ref does not crash anything - it quietly
    // lies, which is worse, because it reads as working.
    name: "script and ref references resolve",
    cmd: "node scripts/check-script-refs.mjs",
    cwd: ".",
    mustMatch: /no dangling script references/,
    mustNotMatch: /MISSING|UNRESOLVABLE/,
  },
  {
    // lib/colors.ts exists so a colour is named once. The migration to it was
    // incomplete - sixteen "#fff" survived, several in the same style object
    // as an already-tokenised INK. An EXACT match only: a similar colour is a
    // design decision, an identical one is a duplicate with a name waiting.
    name: "colour tokens",
    cmd: "node scripts/check-color-tokens.mjs",
    cwd: ".",
    mustMatch: /no duplicated colours/,
    mustNotMatch: /DUPLICATE/,
  },
  {
    /**
     * Added after the freeze flow ended in a dead tab: "Sign in wallet"
     * pointed at a port nothing was listening on.
     *
     * This does NOT assert that someone started the server - that is a fact
     * about a machine at a moment, not about the repo, and a build gate has
     * no business claiming it. It boots the real server on an ephemeral port
     * and asks for the page and every asset the page references, which
     * catches the repo-side causes of the same symptom: a crash on boot, a
     * missing font, a MIME type the browser refuses, a dashboard and a
     * server that disagree about which port to use.
     */
    name: "signing page serves",
    cmd: "node scripts/check-signing-page.mjs",
    cwd: ".",
    mustMatch: /signing page serves, \d+ asset\(s\) resolve/,
    mustNotMatch: /BROKEN/,
  },
];

// Mutation suites are discovered, not listed, so a deleted one cannot linger
// as a silent pass and a new one is picked up without editing this file.
import { readdirSync } from "node:fs";
for (const f of readdirSync("scripts").filter((f) => /^mutate-.*\.mjs$/.test(f))) {
  steps.push({
    name: `mutation: ${f.replace(/^mutate-|\.mjs$/g, "")}`,
    cmd: `node scripts/${f}`,
    cwd: ".",
    // Every mutant must be KILLED. "SURVIVED" means untested behaviour;
    // "SKIP" means the anchor drifted and the mutant never ran at all -
    // which is the failure this whole file exists to catch.
    mustMatch: /killed/,
    mustNotMatch: /SURVIVED|SKIP|anchor not found/,
  });
}

let failures = 0;
for (const s of steps) {
  let out = "";
  let code = 0;
  try {
    out = execSync(s.cmd, { cwd: s.cwd, stdio: "pipe", encoding: "utf8" });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  /**
   * STALE BUILD ARTEFACTS ARE NOT SOURCE ERRORS.
   *
   * tsconfig includes `.next/types/**`, which Next generates per route. Delete
   * a route and every typecheck fails on the generated file for a page that
   * no longer exists - until the dev server rebuilds. Reporting that as a
   * source failure made this script cry wolf during a route removal today,
   * and a checker that cries wolf is one people learn to ignore. That is
   * precisely the failure mode this file was written to prevent.
   *
   * So errors under a build directory are separated out and named as what
   * they are. They are NOT silently dropped: the step still reports, it just
   * says 'stale cache' instead of 'broken code'.
   */
  const lines = out.split(LF_CHAR);
  const staleOnly =
    /error TS/.test(out) &&
    lines
      .filter((l) => /error TS/.test(l))
      // `startsWith`, not a regex: a path pattern with slashes and
      // backslashes in a character class has been mangled by every layer
      // between here and the file. This says the same thing and cannot be
      // mis-escaped.
      .every((l) => l.trim().startsWith(".next"));

  const problems = [];
  if (code !== 0 && !staleOnly) problems.push(`exit ${code}`);
  if (s.mustMatch && !s.mustMatch.test(out)) problems.push(`missing ${s.mustMatch}`);
  if (s.mustNotMatch && s.mustNotMatch.test(out) && !staleOnly)
    problems.push(`matched ${s.mustNotMatch}`);

  if (problems.length) {
    failures++;
    console.log(`  FAIL  ${s.name}  (${problems.join("; ")})`);
    console.log(
      out
        .split("\n")
        .filter((l) => l.trim())
        .slice(-6)
        .map((l) => `          ${l}`)
        .join("\n"),
    );
  } else {
    const summary = (out.match(/Tests\s+\d+ passed[^\n]*/) || [])[0];
    console.log(`  ok    ${s.name}${summary ? `  - ${summary.trim()}` : ""}`);
  }
}

console.log("");
if (failures) {
  console.log(`${failures} of ${steps.length} checks FAILED`);
  process.exit(1);
}
console.log(`all ${steps.length} checks passed`);
