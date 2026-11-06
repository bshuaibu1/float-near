/**
 * Undo the edits the preview tool makes to tracked Next.js config files.
 *
 * WHAT HAPPENS
 *
 * The preview harness runs Next with a different dist dir (`.next-preview`).
 * Next then REWRITES two tracked files to point at it:
 *
 *   next-env.d.ts   /// <reference path="./.next-preview/types/routes.d.ts" />
 *   tsconfig.json   adds ".next-preview/types/**\/*.ts" to `include`
 *
 * Committed, that breaks the build for anyone not running the preview, because
 * `.next-preview` only exists while it does. It is pure tool exhaust, so it is
 * reverted mechanically rather than being read and judged each time.
 *
 * WHY NOT `git checkout --`
 *
 * Both files sit beside uncommitted implementation work, and a checkout that
 * takes an extra path by accident destroys it with no undo. Every edit here is
 * an exact string replacement that fails loudly if its anchor is missing, so
 * the worst case is a thrown error rather than lost work.
 *
 * Next also rewrites tsconfig.json with CRLF where the repo has LF, which
 * leaves the file reported as modified with a byte-empty `git diff` - so line
 * endings are normalised too, or the tree never comes clean.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const LF = String.fromCharCode(10);

/** Files whose line endings must be LF to match the index. */
const NORMALISE_EOL = ["apps/dashboard/tsconfig.json"];

const EDITS = [
  {
    file: "apps/dashboard/next-env.d.ts",
    from: "./.next-preview/types/routes.d.ts",
    to: "./.next/types/routes.d.ts",
  },
  {
    file: "apps/dashboard/tsconfig.json",
    from: '    "next-env.d.ts",' + LF + '    ".next-preview/types/**/*.ts"',
    to: '    "next-env.d.ts"',
  },
];

let changed = 0;
for (const e of EDITS) {
  const raw = readFileSync(e.file, "utf8");
  const crlf = raw.includes(CRLF);
  const s = raw.split(CRLF).join(LF);
  if (!s.includes(e.from)) {
    console.log(`  clean    ${e.file}`);
    continue;
  }
  const out = s.replace(e.from, e.to);
  writeFileSync(e.file, crlf ? out.split(LF).join(CRLF) : out);
  console.log(`  reverted ${e.file}`);
  changed++;
}

for (const f of NORMALISE_EOL) {
  const s = readFileSync(f, "utf8");
  if (!s.includes(CRLF)) continue;
  writeFileSync(f, s.split(CRLF).join(LF));
  console.log(`  eol->LF  ${f}`);
  changed++;
}

/**
 * PROVE IT, rather than trusting that the replacements ran.
 *
 * `git diff --exit-code` on exactly these paths is the only claim that
 * matters: 0 means byte-identical to HEAD. A script that prints "reverted"
 * and leaves a difference behind is the failure this check exists to catch.
 */
const paths = [...new Set([...EDITS.map((e) => e.file), ...NORMALISE_EOL])];
let dirty = 0;
for (const p of paths) {
  try {
    execSync(`git diff --exit-code -- ${p}`, { stdio: "pipe" });
  } catch {
    console.log(`  STILL DIFFERS FROM HEAD: ${p}`);
    dirty++;
  }
}

if (dirty) {
  console.log(`${dirty} file(s) still differ from HEAD`);
  process.exit(1);
}
console.log(`  all ${paths.length} config file(s) match HEAD (${changed} edit(s) made)`);
