#!/usr/bin/env node
/**
 * List a wasm module's REAL imports, by parsing the import section.
 *
 * Why this exists rather than `grep -c panic_utf8 file.wasm`: a grep hit proves
 * only that the byte sequence appears SOMEWHERE in the file. Host-function
 * names also appear in the name section, in debug info, and in string data, so
 * a grep can report an import that is not imported. The question "do these two
 * artifacts import the same host functions?" can only be answered from the
 * import section itself.
 *
 * The parser now lives in packages/create-float/scripts/wasm-imports.mjs, which
 * is pure. This file is only the command line around it.
 *
 * Usage: node scripts/wasm-imports.mjs <a.wasm> [b.wasm]
 *        With two files, prints the set difference.
 *
 * NOTE on comparing build modes: do NOT compare target/near/vault/vault.wasm
 * against target/wasm32-unknown-unknown/release/vault.wasm and conclude the two
 * build modes agree. The second path is cargo-near's own intermediate, built
 * WITH --cfg near and then wasm-opted into the first — so that comparison is
 * cargo-near against itself. A genuine plain build needs
 * `cargo build -p vault --target wasm32-unknown-unknown --release` run on its
 * own, which overwrites that same path. Measured 2026-10-30: 40 env imports for
 * cargo-near, 38 for plain cargo, with panic_utf8 and sha256 the difference.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { parseImports } from "../packages/create-float/scripts/wasm-imports.mjs";

/** Read a file and parse it, so the CLI keeps its old path-taking shape. */
export function imports(path) {
  return parseImports(readFileSync(path));
}

// Only run the CLI when this file is the entry point. Importing it must never
// terminate the caller: the previous version parsed argv at module scope and
// called process.exit(1) when there were no files, so `import` printed usage
// and killed the importing process. args.mjs carries a comment about the same
// failure happening with parseArgs — this was the second instance.
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node scripts/wasm-imports.mjs <a.wasm> [b.wasm]");
    process.exit(1);
  }

  const parsed = files.map((f) => {
    const r = imports(f);
    const names = r.imports.filter((i) => i.kind === "func").map((i) => `${i.module}.${i.field}`);
    console.log(`\n=== ${f}`);
    console.log(`    wasm version   : ${r.version}`);
    console.log(
      `    sections       : ${r.sections.length} (ids: ${[...new Set(r.sections.map((s) => s.id))].join(",")})`,
    );
    console.log(`    function imports: ${names.length}`);
    const byModule = {};
    for (const n of names) {
      const m = n.split(".")[0];
      (byModule[m] ??= []).push(n.slice(m.length + 1));
    }
    for (const [m, fs] of Object.entries(byModule)) {
      console.log(`    module "${m}": ${fs.length}`);
      for (const f of fs.sort()) console.log(`        ${f}`);
    }
    return new Set(names);
  });

  if (parsed.length === 2) {
    const [a, b] = parsed;
    const onlyA = [...a].filter((x) => !b.has(x)).sort();
    const onlyB = [...b].filter((x) => !a.has(x)).sort();
    console.log(`\n=== DIFF`);
    console.log(`    in both        : ${[...a].filter((x) => b.has(x)).length}`);
    console.log(
      `    only in ${files[0]}: ${onlyA.length}${onlyA.length ? "\n        " + onlyA.join("\n        ") : ""}`,
    );
    console.log(
      `    only in ${files[1]}: ${onlyB.length}${onlyB.length ? "\n        " + onlyB.join("\n        ") : ""}`,
    );
    console.log(
      `    VERDICT        : ${onlyA.length === 0 && onlyB.length === 0 ? "IDENTICAL import sets" : "DIFFERENT import sets"}`,
    );
  }
}
