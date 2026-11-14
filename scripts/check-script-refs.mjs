/**
 * Does every reference in the repo still resolve to the thing it names?
 *
 * TWO KINDS, because a pointer can dangle in more than one way:
 *   1. `scripts/<name>` paths  -> must be a file on disk
 *   2. git refs in commands    -> must be resolvable by `git rev-parse`
 *
 * Written after pruning 81 scripts. The pruner's own safety check runs BEFORE
 * the deletion and only inspects kept scripts and docs; this runs after, over
 * everything tracked, and is the thing that would catch a reference in a Rust
 * test, a JSON manifest or a PowerShell file that the narrower check missed.
 *
 * A dangling reference is not a crash - it is a comment or a runbook line
 * pointing at nothing, which is worse, because it reads as working.
 *
 * WHY (2) WAS ADDED, AND WHY THIS FILE KEEPS ITS NARROWER NAME
 *
 * Deleting the merged `intents-rail` branch nearly broke a VPS runbook:
 * DEPLOY-VPS.md used that branch as the worked example of the BRANCH override
 * for scripts/deploy-vps.sh, which is copy-pasteable and worked only because
 * the branch existed. Check (1) could never have seen it: a branch name is
 * not a path, it is just a word.
 *
 * (The offending line is described rather than quoted. Quoting it verbatim
 * made this file fail its own check - correctly, since the quote is a real
 * command shape naming a dead ref. Exempting the file would have been the
 * easy fix and would have blinded it to every future ref it names.)
 *
 * The file is still called check-script-refs.mjs even though it now does
 * more, because two pushed commit messages name it, and history cannot be
 * edited. Renaming would manufacture precisely the dangling reference this
 * script exists to prevent.
 *
 * NOTE ON THE TWO `scripts/` DIRECTORIES
 *
 * `packages/create-float/scripts/` exists too, and package.json paths there
 * are package-relative. A naive grep for "scripts/bundle-wasm.mjs" matches
 * both and reported the root scripts/ as missing a file that was never meant
 * to be there - which briefly put it on the keep-list. So a reference is
 * resolved against the referencing file's OWN directory before being called
 * dangling.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LF = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

// Built from char codes: every layer between here and the file has mangled a
// literal backslash in a character class at least once today.
const REF = new RegExp(
  // GROUP 1 is any path PREFIX written in front of `scripts/`, which the first
  // version threw away. A root-level doc citing
  // `packages/create-float/scripts/bundle-wasm.mjs` had its prefix discarded,
  // leaving `scripts/bundle-wasm.mjs` to be resolved against the repo root --
  // where it has never existed -- so a perfectly correct reference was
  // reported dangling and the only way to satisfy the check was to write a
  // WORSE instruction. The prefix is right there in the text; use it.
  "((?:[A-Za-z0-9._-]+[/" + BACKSLASH + BACKSLASH + "])*)" +
    "scripts[/" + BACKSLASH + BACKSLASH + "]([A-Za-z0-9._/-]+" + BACKSLASH + ".(?:mjs|sh|ps1))",
  "g",
);

const files = execSync("git ls-files", { encoding: "utf8" })
  .trim()
  .split(LF)
  .filter((f) => /\.(mjs|js|ts|tsx|sh|ps1|md|json|rs|toml)$/.test(f));

const dangling = new Map();

/**
 * A file may name a pruned script IF it tells the reader where it went.
 *
 * The docs that cite one are recording a MEASUREMENT - "settled on testnet by
 * scripts/measure-global-contract.sh" - and rewriting them to drop the name
 * would destroy the provenance of the number, which is the valuable part. So
 * the rule is not "never name a missing script", it is "never leave a reader
 * at a dead end": carry a pointer to scripts/README.md, which explains the
 * pruning and gives the git incantation to read one back.
 *
 * The three code files listed explicitly discuss a script's ABSENCE as their
 * subject - verify-all.mjs exists BECAUSE mutate-indent.mjs silently stopped
 * working - so a pointer there would be noise.
 */
const RECOVERY_POINTER = "scripts/README.md";
const EXPLAINS_ABSENCE = new Set([
  "scripts/verify-all.mjs", // its header is the story of mutate-indent.mjs
  "scripts/prune-scripts.mjs", // notes why bundle-wasm.mjs is NOT its business
  "scripts/README.md", // the recovery instructions themselves
]);

for (const f of files) {
  let s;
  try {
    s = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (EXPLAINS_ABSENCE.has(f)) continue;
  if (s.includes(RECOVERY_POINTER)) continue;
  for (const m of s.matchAll(REF)) {
    const prefix = (m[1] ?? "").split(BACKSLASH).join("/");
    const name = m[2].split(BACKSLASH).join("/");

    // The path EXACTLY as written, prefix included. Tried first, because it is
    // the one the reader will copy.
    if (prefix && existsSync(join(prefix, "scripts", name))) continue;
    if (existsSync(join("scripts", name))) continue;

    /**
     * Resolve against the referencing file's own package too, walking UP.
     *
     * First version only tried `dirname(f)/scripts/`, which reported
     * packages/create-float/test/freshness.test.mjs as citing a missing
     * file - it imports `../scripts/freshness.mjs`, which exists one level
     * up at packages/create-float/scripts/. The checker was wrong, not the
     * repo, and a checker that cries wolf is one people stop reading.
     */
    let dir = dirname(f);
    let resolved = false;
    while (dir && dir !== "." && dir !== "/") {
      if (existsSync(join(dir, "scripts", name))) {
        resolved = true;
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (resolved) continue;
    if (!dangling.has(name)) dangling.set(name, new Set());
    dangling.get(name).add(f);
  }
}

// ---------------------------------------------------------------------------
// CHECK 2: do git refs named in commands still resolve?
// ---------------------------------------------------------------------------

/**
 * Only COMMAND SHAPES, never bare words.
 *
 * A branch name is indistinguishable from ordinary prose, so there is no way
 * to scan for "mentions of a branch" without drowning in false positives.
 * What IS unambiguous is a ref sitting in the argument position of a command
 * that takes one. That is narrower than the real risk and deliberately so: a
 * checker nobody trusts gets switched off, and the copy-pasteable lines are
 * the ones that actually hurt.
 */
const REF_COMMANDS = [
  /git\s+(?:pull|push|fetch)\s+(?:-{1,2}[\w-]+\s+)*origin\s+([\w./-]+)/g,
  /git\s+(?:checkout|switch)\s+(?:-{1,2}[\w-]+\s+)*([\w./-]+)/g,
  /git\s+merge(?:-base)?\s+(?:-{1,2}[\w-]+\s+)*([\w./-]+)/g,
  /\bBRANCH=([\w./-]+)/g,
];

/** Lines that name a ref which is SUPPOSED not to exist, or not to be a ref. */
const skipLine = (line) =>
  /git\s+(?:branch|push)[^\n]*(?:--delete|\s-[dD]\b)/.test(line) ||
  /git\s+checkout\s+-b|git\s+switch\s+-c/.test(line);

/**
 * `--self-test` pins the matching and skipping rules.
 *
 * These are the parts with no live subject in this repo right now - every
 * real ref here is a placeholder or exempted - so a passing run proves
 * nothing about them. Without this, the regexes could be quietly broken for
 * months and the check would go on reporting success. Each case below is a
 * behaviour that was wrong at some point while writing this.
 */
if (process.argv.includes("--self-test")) {
  const refsIn = (line) => {
    if (skipLine(line)) return [];
    const out = [];
    for (const p of REF_COMMANDS) {
      p.lastIndex = 0;
      for (const m of line.matchAll(p)) {
        const r = m[1];
        if (/[<>${}*?|]/.test(r)) continue;
        if (r.startsWith("-") || r === "." || r === "..") continue;
        out.push(r);
      }
    }
    return out;
  };

  /**
   * The two "must extract" fixtures deliberately name `main`, a ref that
   * REALLY RESOLVES.
   *
   * They are string literals in a tracked file, so the main scan reads them
   * like any other line. Naming a fictional branch made this file fail its
   * own check - which is the correct behaviour, and the reason the fixtures
   * have to be real. The self-test only exercises EXTRACTION, so the ref's
   * identity is irrelevant to what it proves.
   */
  const CASES = [
    ["git pull origin main", ["main"], "a ref in a pull is checked"],
    ["BRANCH=main bash scripts/deploy-vps.sh", ["main"], "the BRANCH override is checked"],
    ["BRANCH=<git-ref> bash scripts/deploy-vps.sh", [], "a placeholder is NOT a ref"],
    ['BRANCH="${BRANCH:-main}"', [], "a shell variable is NOT a ref"],
    ["git push origin --delete old-branch", [], "deleting a ref names one that should be gone"],
    ["git branch -d merged-branch", [], "same, for a local branch"],
    ["git checkout -b new-feature", [], "creating a branch is not referencing one"],
    [
      "wsl -d Ubuntu -- bash scripts/wsl-sandbox.sh",
      [],
      "wsl's -d must NOT trigger the delete-skip (it did, in the first draft)",
    ],
  ];

  let bad = 0;
  for (const [line, want, why] of CASES) {
    const got = refsIn(line);
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${why}`);
    if (!ok) console.log(`          line: ${line}\n          want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  console.log(bad ? `  ${bad} self-test failure(s)` : `  all ${CASES.length} self-tests passed`);
  process.exit(bad ? 1 : 0);
}

/**
 * Files allowed to name a ref that no longer exists, with the reason.
 *
 * Same shape as the pruner's keep-list, and for the same reason: an explicit
 * entry forces a human decision and can be read back later, where a clever
 * heuristic cannot be audited at all.
 */
const HISTORICAL_REFS = {
  "docs/OVERNIGHT-2026-10-31.md":
    "a dated session record; its staged block is explicitly marked as history, " +
    "and already carries a warning that the branch and the versions are dead",
};

const refMisses = new Map();
const resolvable = new Map();

const resolves = (ref) => {
  if (resolvable.has(ref)) return resolvable.get(ref);
  let ok = false;
  try {
    execSync(`git rev-parse --verify --quiet ${JSON.stringify(ref)}`, { stdio: "pipe" });
    ok = true;
  } catch {
    ok = false;
  }
  resolvable.set(ref, ok);
  return ok;
};

for (const f of files) {
  if (HISTORICAL_REFS[f]) continue;
  let s;
  try {
    s = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const line of s.split(LF)) {
    /**
     * Each skip pattern is anchored to the git subcommand it belongs to. A
     * first draft used a bare `\s-[dD]\s`, which matches ANY line containing
     * " -d " - including `wsl -d Ubuntu -- bash scripts/...`, which appears
     * in this repo. That would have silently switched off ref-checking for
     * those lines. A skip rule that is too broad does not announce itself; it
     * just quietly stops finding things. Pinned by --self-test.
     */
    if (skipLine(line)) continue;

    for (const pattern of REF_COMMANDS) {
      pattern.lastIndex = 0;
      for (const m of line.matchAll(pattern)) {
        const ref = m[1];
        // Placeholders, variables and globs are not refs. `<git-ref>` and
        // `$BRANCH` are the correct way to write a non-rotting example, so
        // flagging them would punish the exact fix this check exists to
        // encourage.
        if (/[<>${}*?|]/.test(ref)) continue;
        if (ref.startsWith("-") || ref === "." || ref === "..") continue;
        if (resolves(ref)) continue;
        if (!refMisses.has(ref)) refMisses.set(ref, new Set());
        refMisses.get(ref).add(f);
      }
    }
  }
}

// ---------------------------------------------------------------------------

const problems = dangling.size + refMisses.size;

if (!problems) {
  console.log(
    `  no dangling script references (${files.length} files scanned, ` +
      `${resolvable.size} git ref(s) resolved)`,
  );
  process.exit(0);
}

for (const [name, where] of [...dangling.entries()].sort()) {
  console.log(`  MISSING  scripts/${name}`);
  for (const w of where) console.log(`             referenced by ${w}`);
}
for (const [ref, where] of [...refMisses.entries()].sort()) {
  console.log(`  UNRESOLVABLE GIT REF  ${ref}`);
  for (const w of where) console.log(`             named by ${w}`);
}
console.log(`${problems} dangling reference(s)`);
process.exit(1);
