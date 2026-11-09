#!/usr/bin/env node
/**
 * Does every workspace package's dependency range actually MATCH its sibling?
 *
 * WHAT WENT WRONG, and it only surfaced on deploy day. `@floatonnear/float-adapter`
 * declared `"@floatonnear/mcp": "^0.3.0"` while the sibling in `packages/mcp`
 * had moved to `0.5.0`. `^0.3.0` means `>=0.3.0 <0.4.0`, so 0.5.0 does NOT
 * satisfy it — npm quietly ignored the workspace and downloaded the PUBLISHED
 * 0.3.0 from the registry into a nested `node_modules`.
 *
 * The published 0.3.0 has no `accountExists`, no `planAddRole`, no
 * `planWithdraw`. So the build failed with "has no exported member", pointing
 * at a package that was sitting right there, correct, in the same repo.
 *
 * WHY NOBODY NOTICED FOR DAYS. A machine that installed BEFORE the version
 * bump keeps its linked workspace copy and builds fine forever. The failure
 * needs a clean `npm install` — which happens on a fresh VPS, in CI, and for
 * any new contributor, and nowhere else. "Works on my machine" here is not
 * laziness; it is literally true and literally useless.
 *
 * WORSE THAN A BUILD FAILURE, had tsc been configured to emit anyway: the
 * runtime would have resolved `accountExists` to `undefined`, and that function
 * decides whether a visitor's vault EXISTS. The dashboard would have told
 * owners of real vaults that they had none.
 *
 * So the invariant: if package A depends on workspace package B, B's current
 * version must satisfy A's range — otherwise npm installs a stranger.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOTS = ["packages", "apps"];

/** Every package.json in the repo's workspace-ish directories, by name. */
const pkgs = new Map();
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const d of readdirSync(root)) {
    const f = join(root, d, "package.json");
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (j.name) pkgs.set(j.name, { version: j.version, path: f, json: j });
  }
}

/**
 * Does `version` satisfy `range`?
 *
 * Deliberately handles only the forms this repo uses, and returns `null` for
 * anything else rather than guessing. A checker that silently approves a range
 * it does not understand is worse than no checker — it reports confidence it
 * does not have.
 *
 * `^0.x.y` IS THE TRAP and is why this exists. For a 0.x version, caret pins
 * the MINOR: `^0.3.0` is `>=0.3.0 <0.4.0`, NOT `<1.0.0`. Everyone who has been
 * bitten by this was reasoning about `^1.x` semantics.
 */
export function satisfies(range, version) {
  if (range === "*" || range === "latest") return true;
  if (range.startsWith("workspace:")) return true; // pnpm/yarn form, always local
  if (/^file:|^link:/.test(range)) return true;

  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!v) return null;
  const [, VM, Vm, Vp] = v.map(Number);

  const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) return null;
  const [, op, RMs, Rms, Rps] = m;
  const RM = Number(RMs), Rm = Number(Rms), Rp = Number(Rps);

  const atLeast = VM > RM || (VM === RM && (Vm > Rm || (Vm === Rm && Vp >= Rp)));
  if (!atLeast) return false;

  if (op === "^") {
    // ^0.3.0 -> <0.4.0 ; ^0.0.3 -> <0.0.4 ; ^1.2.3 -> <2.0.0
    if (RM === 0 && Rm === 0) return VM === 0 && Vm === 0 && Vp === Rp;
    if (RM === 0) return VM === 0 && Vm === Rm;
    return VM === RM;
  }
  if (op === "~") return VM === RM && Vm === Rm;
  return VM === RM && Vm === Rm && Vp === Rp; // exact
}

/**
 * RUN ONLY WHEN INVOKED DIRECTLY, so `satisfies` can be imported and tested.
 *
 * Without this the module body — including `process.exit(1)` — fires on
 * import, so a test that imports it dies before asserting anything. The repo
 * already uses this guard in `packages/create-float/bin/float-exit.mjs`.
 */
const INVOKED_DIRECTLY =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

function main() {
let problems = 0;
const unknown = [];

for (const [name, p] of pkgs) {
  const deps = { ...(p.json.dependencies ?? {}), ...(p.json.devDependencies ?? {}) };
  for (const [dep, range] of Object.entries(deps)) {
    const sib = pkgs.get(dep);
    if (!sib) continue; // external dependency, not our problem
    const ok = satisfies(range, sib.version);
    if (ok === null) {
      unknown.push(`${name} -> ${dep} "${range}" (unrecognised range form)`);
      continue;
    }
    if (!ok) {
      problems++;
      console.error(
        `BROKEN: ${name} depends on ${dep} "${range}", but the workspace copy is ${sib.version}.\n` +
          `  npm will IGNORE the sibling and install the PUBLISHED ${dep} instead.\n` +
          `  That copy is a different build: missing exports show up as\n` +
          `  "has no exported member", pointing at a package sitting correct in this repo.\n` +
          `  It only fails on a CLEAN install — fresh VPS, CI, new contributor — so a\n` +
          `  machine that installed before the bump keeps working and proves nothing.\n` +
          `  Fix: set the range in ${p.path} to match ${sib.version}.`,
      );
    }
  }
}

if (unknown.length) {
  console.error(`BROKEN: ${unknown.length} dependency range(s) this check cannot evaluate:`);
  for (const u of unknown) console.error(`  ${u}`);
  console.error(`  Refusing to pass on a range it does not understand.`);
  problems += unknown.length;
}

if (problems) process.exit(1);
console.log(`workspace deps: ${pkgs.size} package(s), every sibling range satisfied`);
}

if (INVOKED_DIRECTLY) main();
