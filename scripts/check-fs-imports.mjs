#!/usr/bin/env node
/**
 * Catch `node --check`'s blind spot: a function used but never imported.
 *
 * `node --check` is a SYNTAX check. It does not resolve identifiers, so a
 * script that calls `readFileSync` without importing it passes cleanly and
 * then dies at runtime with "ReferenceError: readFileSync is not defined".
 * That happened to `print-mcp-command.mjs` after I had run `node --check` on
 * it and treated the pass as verification.
 *
 * It then caused a second failure: the crash left the PREVIOUS run's output
 * file in place, and the `Copy-Item` that followed installed a config for the
 * wrong vault while reporting success.
 *
 * Narrow on purpose — only `node:fs` named imports, the ones these scripts use
 * most. A broader linter would be better, but a check that exists beats one
 * that is proposed.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const FS_FNS = [
  "existsSync",
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
  "unlinkSync",
  "statSync",
  "readdirSync",
  "copyFileSync",
  "renameSync",
];

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/check-fs-imports.mjs <file.mjs> [...]");
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  const path = resolve(f);
  if (!existsSync(path)) {
    console.log(`  SKIP  ${f} (missing)`);
    continue;
  }
  const src = readFileSync(path, "utf8");

  const importBlocks = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:fs["']/g)];
  const imported = new Set(
    importBlocks.flatMap((m) =>
      m[1]
        .split(",")
        .map((x) => x.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean),
    ),
  );

  // Strip comments and strings so a mention inside prose does not count as a
  // call. Without this, the long explanatory comments in these scripts would
  // produce false positives — and a check that cries wolf gets ignored.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");

  const missing = FS_FNS.filter(
    (fn) => new RegExp(`(?<![.\\w])${fn}\\s*\\(`).test(code) && !imported.has(fn),
  );

  if (missing.length) {
    bad++;
    console.log(`  FAIL  ${f}`);
    console.log(`        uses but does not import: ${missing.join(", ")}`);
  } else {
    console.log(`  ok    ${f}`);
  }
}
console.log();
process.exit(bad === 0 ? 0 : 1);
