/**
 * Find literal U+00A0 (no-break space) characters in source.
 *
 * This character is load-bearing in the budget tree's display names, and a
 * typed one is indistinguishable from a plain space in every editor and diff.
 * It broke `treeLabel`/`treeDepth` three times in one sitting. The only place
 * it is allowed to exist is where it is BUILT with String.fromCharCode —
 * `lib/tree-label.ts` and its test — so this scan should report zero files.
 *
 * A script file, not `node -e`: the shell mangles backslashes and the NBSP
 * itself, which is how two earlier attempts at this check produced nonsense.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const NBSP = String.fromCharCode(160);
const ROOTS = ["apps/dashboard", "packages/float-adapter/src", "packages/mcp/src"];
// Build output, not source. `.next-preview` is the scratch dist dir a second
// dev server uses (see apps/dashboard/next.config.ts); without it here the
// scan reports a U+00A0 inside a minified polyfill chunk and the check stops
// meaning anything.
const SKIP = new Set(["node_modules", ".next", ".next-preview", "dist", ".turbo"]);

function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

let total = 0;
const hits = [];
for (const root of ROOTS) {
  for (const f of walk(root)) {
    const n = readFileSync(f, "utf8").split(NBSP).length - 1;
    if (n > 0) {
      hits.push({ f: f.split("\\").join("/"), n });
      total += n;
    }
  }
}

if (hits.length === 0) {
  console.log("  no literal U+00A0 anywhere in source - the character is only ever built");
} else {
  for (const h of hits) console.log(`  ${String(h.n).padStart(3)}  ${h.f}`);
  console.log(`  total: ${total}`);
}
process.exit(0);
