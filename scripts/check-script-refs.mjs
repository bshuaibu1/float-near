/**
 * Does every `scripts/<name>` reference in the repo still resolve to a file?
 *
 * Written after pruning 81 scripts. The pruner's own safety check runs BEFORE
 * the deletion and only inspects kept scripts and docs; this runs after, over
 * everything tracked, and is the thing that would catch a reference in a Rust
 * test, a JSON manifest or a PowerShell file that the narrower check missed.
 *
 * A dangling reference is not a crash - it is a comment or a runbook line
 * pointing at nothing, which is worse, because it reads as working.
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
    const name = m[1].split(BACKSLASH).join("/");
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

if (!dangling.size) {
  console.log(`  no dangling script references (${files.length} files scanned)`);
  process.exit(0);
}

for (const [name, where] of [...dangling.entries()].sort()) {
  console.log(`  MISSING  scripts/${name}`);
  for (const w of where) console.log(`             referenced by ${w}`);
}
console.log(`${dangling.size} dangling reference(s)`);
process.exit(1);
