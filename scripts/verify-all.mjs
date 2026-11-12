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
    /**
     * THE DASHBOARD MUST ACTUALLY BUILD, not merely typecheck.
     *
     * `tsc` and `next build` disagree about what is an error, and the gap is
     * not academic. Measured 2026-11-11: an import landed above the
     * `"use client"` directive — invisible to tsc, which does not know the
     * directive exists, and FATAL to the build:
     *
     *   The "use client" directive must be placed before other expressions.
     *
     * The gate was green, the typecheck was green, and the DEPLOY failed on
     * the box. A gate that checks something adjacent to what production does
     * reports on a program nobody runs.
     *
     * Costs ~40s, which the deploy pays anyway; paying it here means finding
     * out before the VPS does.
     *
     * A SEPARATE DIST DIR so this cannot race the dev server's `.next` or the
     * deploy's — a build gate that corrupts a running server is worse than no
     * build gate.
     */
    name: "dashboard builds",
    cmd: "npx next build",
    cwd: "apps/dashboard",
    env: { NEXT_DIST_DIR: ".next-verify" },
    mustNotMatch: /Failed to compile|Build error/,
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
  {
    /**
     * The page built the vault id client-side and never checked its length,
     * so an owner whose derived id exceeds NEAR's 64-character cap was shown
     * an illegal address and allowed to sign a ~3.47 NEAR transaction that
     * could only fail. The deposit returns; the gas does not, and the error
     * arrives as a raw contract panic.
     *
     * The MCP refused this all along via the factory's own `vault_id_for`.
     * The BROWSER path was the unguarded one — the path DECISIONS.md calls
     * "onboarding strangers", so the one a stranger actually meets.
     *
     * The check EXTRACTS the function from web/index.html and runs it rather
     * than testing a copy: the page is standalone HTML with nothing to
     * import, and a reimplementation here could pass while the shipped page
     * stayed broken. It also asserts render() CALLS it, because a pure
     * function nobody invokes is the same as no guard at all.
     */
    name: "vault id guard",
    cmd: "node scripts/check-vault-id-guard.mjs",
    cwd: ".",
    mustMatch: /vault id guard: \d+ case\(s\) pass, and the page calls it/,
    mustNotMatch: /BROKEN/,
  },
  {
    /**
     * STATE.md's stamp is maintained by hand and drifts silently. Measured
     * across this repo's own history: the stamp was stale at 11a791d, at
     * fec22f4, and again from fd8ff23 through 2abe8ce - three separate
     * occasions where content was edited and the stamp left alone. Each was
     * noticed only when a stop-hook complained, and the SessionStart drift
     * check had been reporting against the wrong baseline in between.
     *
     * The rule is NOT "changed together in one commit" - this repo
     * squash-merges, so a stamp written on a branch names a sha that is
     * destroyed on merge, and the honest sequence is edit -> merge -> stamp.
     * The invariant is that the stamped commit must not be OLDER than the
     * last commit that changed STATE.md's content.
     *
     * Checked against the default branch, not HEAD: on a feature branch the
     * content exists and its stamp cannot yet, so failing there would make
     * the gate unpassable during normal work.
     */
    name: "state stamp",
    cmd: "node scripts/check-state-stamp.mjs",
    cwd: ".",
    mustMatch: /state stamp: [0-9a-f]+ is not older than the last content change/,
    mustNotMatch: /BROKEN/,
  },
  {
    /**
     * A workspace package must depend on its SIBLING, not on a stranger from
     * the registry.
     *
     * `@floatonnear/float-adapter` asked for `"@floatonnear/mcp": "^0.3.0"`
     * while the sibling was 0.5.0. For a 0.x version caret pins the MINOR, so
     * 0.5.0 did not satisfy it and npm silently installed the PUBLISHED 0.3.0
     * into a nested node_modules — a different build, missing `accountExists`,
     * `planAddRole` and `planWithdraw`.
     *
     * It only fails on a CLEAN install, so every existing machine kept
     * building and proved nothing. It surfaced on the first real VPS deploy.
     */
    name: "workspace deps",
    cmd: "node scripts/check-workspace-deps.mjs",
    cwd: ".",
    mustMatch: /every sibling range satisfied/,
    mustNotMatch: /BROKEN/,
  },
  {
    /**
     * The gas-key arithmetic exists TWICE, deliberately: create-float and mcp
     * are siblings published separately, so importing across them would couple
     * their release cycles — and a workspace range that silently resolved to a
     * PUBLISHED sibling already cost this repo an afternoon.
     *
     * The cost of mirroring is drift, and drift here is not cosmetic: the MCP
     * QUOTES a top-up and the CLI CHARGES for it, so divergence tells a user
     * one number and bills another, with both halves looking right alone.
     *
     * Compared by COMPUTING with both copies, not by grepping for a literal —
     * a regex can match a constant nothing uses.
     */
    name: "gas math mirror",
    cmd: "node scripts/check-gas-math.mjs",
    cwd: ".",
    mustMatch: /mcp and create-float agree/,
    mustNotMatch: /BROKEN/,
  },
  {
    /**
     * A method that demands a yoctoNEAR but is not #[payable] is UNREACHABLE:
     * near-sdk's wrapper rejects a deposit before the body runs, and without
     * one `assert_one_yocto` fails. There is no third kind of call.
     *
     * THE UNIT TIER CANNOT SEE IT — unit tests call the Rust fn directly and
     * never cross the wrapper, so they pass identically either way. It has
     * shipped twice now: the factory's kill switch, and `bind_virtual_agent`,
     * which was dead in the deployed vault until the integration tier was
     * made runnable and caught it. A source scan is the only tier that sees
     * the attribute.
     */
    name: "payable pairing",
    cmd: "node scripts/check-payable.mjs",
    cwd: ".",
    mustMatch: /none unreachable/,
    mustNotMatch: /BROKEN/,
  },
  {
    /**
     * A deploy script's heredocs must not execute their own comments.
     *
     * `<<UNIT` unquoted is deliberate — the systemd units interpolate `$ROOT`
     * and `$PORT` — but bash cannot expand variables selectively, so backticks
     * in prose are command substitution. Measured on wattson 2026-11-10:
     * `ss -ltnp` in a comment RAN, and its socket listing (ports, PIDs) was
     * written into the live `float-near-dash.service`. `ExecStart` survived,
     * the service came up, and all 14 post-deploy assertions passed — the only
     * trace was three "command not found" lines beside a successful deploy.
     *
     * In the gate and not just in the deploy because the damage lands on a
     * remote box, in a file nobody re-reads, and whatever a future comment
     * happens to quote is what runs there.
     */
    /**
     * Every documented `npx` command must resolve to a bin we ship.
     *
     * `float-exit` is a BIN of `@floatonnear/create-float`, not a package, so
     * `npx @floatonnear/float-exit` 404s — and that was the ONLY documented way
     * to recover a vault's ~3.09 NEAR deposit, printed in SKILL.md and in the
     * MCP instructions sent to every connected client. The skill sells the
     * deposit as refundable; the refund path dead-ended at a registry 404.
     *
     * A bin is not a package, and nothing knew the difference because the
     * string was prose in markdown and a template literal in a tool response —
     * neither of which any test reads. Local-only: resolves against the
     * workspace's own bin maps, no registry.
     */
    /**
     * The create URL has two ends in two languages with no shared type.
     *
     * The page reads its config from the query string; the MCP builds it. They
     * drifted for weeks with every test green: the page honoured 12 params and
     * the MCP sent 4, so `daily`, `pertx`, `token`, `decimals` and `label` were
     * accepted and never sent — which is why an agent could not ask a user
     * their budget and hand back a ready-to-sign link.
     *
     * Asymmetric on purpose. Sending a param the page ignores is a HARD failure
     * (the user silently gets a default instead of the cap they agreed to);
     * reading one nothing sends is reported unless it carries a written reason.
     */
    /**
     * A tool description is not documentation; it is the agent's context.
     *
     * The page defaults moved 2.04/0.51 -> 25/10 and the MCP's `daily`/`perTx`
     * descriptions did not. Repo, plugin and live site were all correct — the
     * one copy that actually reached a user was the stale one, so the agent
     * went on offering "Page defaults: 2.04 / 0.51" as a recommended option
     * for values the page no longer had.
     */
    /**
     * Every dashboard call to the adapter must say WHO is asking.
     *
     * A fetch without `?owner=` does not fail — the proxy falls back to the
     * adapter's configured vault, which on the public deployment is the
     * operator's TESTNET demo. The page renders a real vault belonging to
     * someone else, returns 200, and nothing goes red. Seventeen call sites
     * were in that state while the Overview looked correct, because it was
     * the one that passed an owner.
     */
    /**
     * Every contract capability must be reachable by SOMETHING.
     *
     * The contract is the product; the MCP, the CLIs, the adapter and the web
     * page are only ways to reach it. A method with no caller is a feature
     * that shipped and cannot be used -- built, tested, deployed, invisible.
     *
     * Found six on its first run, including a complete two-step ownership
     * transfer that vault_config already REPORTS while nothing can start it.
     * Every gap this week was found by a user tripping over it; this is the
     * thing that was supposed to be looking.
     */
    name: "surface map",
    cmd: "node scripts/map-surfaces.mjs",
    cwd: ".",
    mustMatch: /every contract capability is reachable/,
    mustNotMatch: /BROKEN/,
  },
  {
    name: "dashboard owner",
    cmd: "node scripts/check-dashboard-owner.mjs",
    cwd: ".",
    mustMatch: /every adapter call goes through floatFetch/,
    mustNotMatch: /BROKEN/,
  },
  {
    name: "quoted defaults",
    cmd: "node scripts/check-quoted-defaults.mjs",
    cwd: ".",
    mustMatch: /agree with the page/,
    mustNotMatch: /BROKEN/,
  },
  {
    name: "create url params",
    cmd: "node scripts/check-create-url-params.mjs",
    cwd: ".",
    mustMatch: /all read by the page/,
    mustNotMatch: /BROKEN/,
  },
  {
    name: "npx commands",
    cmd: "node scripts/check-npx-commands.mjs",
    cwd: ".",
    mustMatch: /all resolve to a shipped bin/,
    mustNotMatch: /BROKEN/,
  },
  {
    name: "heredoc expansion",
    cmd: "node scripts/check-heredoc-expansion.mjs",
    cwd: ".",
    mustMatch: /no self-executing content/,
    mustNotMatch: /BROKEN/,
  },
  {
    /**
     * The plugin is how a user installs this without copying
     * `claude mcp add float-near -- npx -y @floatonnear/mcp` correctly: its
     * manifest declares the server, so installing the plugin starts it.
     *
     * It also fixed something that had never worked. `SKILL.md` sat at the
     * repo root with valid frontmatter and shipped inside the create-float
     * tarball, but Claude Code reads skills from `.claude/skills/` or from
     * inside a plugin, never from an npm package root — so a 16.5 KB skill
     * was shipped to every user and loadable by nobody.
     *
     * The check that earns its keep is the third one: it reads the tool names
     * out of the BUILT server and fails if the skill promises one that is not
     * there. The published MCP did exactly that today, advertising
     * `vault_plan_create_agent` for a contract method that had been removed.
     */
    name: "plugin",
    cmd: "node scripts/check-plugin.mjs",
    cwd: ".",
    mustMatch: /plugin: manifest declares .+ via npx, skill matches the root/,
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
    out = execSync(s.cmd, {
      cwd: s.cwd,
      stdio: "pipe",
      encoding: "utf8",
      // A step may need its own environment -- the dashboard build writes to a
      // SEPARATE dist dir so it cannot race the dev server or the deploy.
      env: s.env ? { ...process.env, ...s.env } : process.env,
    });
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
