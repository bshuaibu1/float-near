/**
 * Replace the dashboard's inline brand hex with Tailwind token classes.
 *
 * The dashboard carried ~395 inline `style={{ color: "#787774" }}` values
 * across 15 files while the Tailwind colour tokens went almost unused —
 * `canvas` 0 times, `ink` 0, `line` 0. Adding tokens without migrating the
 * call sites is a silent no-op: an inline style beats a class on
 * specificity, so the config would claim a theme the page never applies.
 *
 * NARROW ON PURPOSE. It rewrites exactly two shapes, both of which let the
 * `style` attribute disappear completely:
 *
 *     className="a b" style={{ color:"#787774" }}   ->  className="a b text-muted"
 *     style={{ background:"#FFFFFF" }}              ->  className="bg-card"
 *
 * Everything else is LEFT ALONE and reported. That matters more than
 * coverage: a wrong colour is invisible in a 237-line diff, and the status
 * colours that live in the same attributes — error red, success green,
 * warning amber — must not be swept up. They are a different vocabulary and
 * the brand tokens have no equivalent, so a greedy script would silently
 * flatten "payment failed" into "secondary text".
 *
 * Multi-property styles (`style={{ color:"#111", width:"40%" }}`) are also
 * skipped: removing the attribute would drop the other declarations, and
 * merging half of it is how a layout quietly breaks.
 *
 *   node scripts/migrate-dashboard-tokens.mjs            # report only
 *   node scripts/migrate-dashboard-tokens.mjs --write
 */
import { readFileSync, writeFileSync, globSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "apps", "dashboard");
const WRITE = process.argv.includes("--write");

/** Brand surface/text hex -> token. Status colours are deliberately absent. */
const TOKENS = {
  "#FBFBFA": "canvas",
  "#FFFFFF": "card",
  "#FFF": "card",
  "#111111": "ink",
  "#787774": "muted",
  "#A0A09A": "faint",
  "#EAEAEA": "line",
  "#F3F3F1": "chip",
  "#F2F2F1": "chip",
  "#F7F6F3": "chip",
  "#F2F2F0": "chip",
  "#F5F5F4": "chip",
  "#F6F6F5": "chip",
};
const PROP = { color: "text", background: "bg", backgroundColor: "bg", borderColor: "border" };

const util = (prop, hex) => {
  const t = TOKENS[hex.toUpperCase()];
  const p = PROP[prop];
  return t && p ? `${p}-${t}` : null;
};

const files = globSync("**/*.tsx", { cwd: ROOT })
  .map((f) => resolve(ROOT, f))
  .filter((f) => !f.includes("node_modules"));

let replaced = 0;
let changedFiles = 0;
const skipped = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  let out = src;
  const rel = file.slice(ROOT.length + 1);

  // Shape 1: a string className immediately followed by a lone style.
  out = out.replace(
    /className="([^"]*)"(\s+)style=\{\{\s*(\w+)\s*:\s*"(#[0-9A-Fa-f]{3,6})"\s*,?\s*\}\}/g,
    (whole, cls, _ws, prop, hex) => {
      const u = util(prop, hex);
      if (!u) {
        skipped.push(`${rel}  ${prop}:${hex}`);
        return whole;
      }
      replaced++;
      return `className="${cls} ${u}"`;
    },
  );

  // Shape 2: a lone style with no className on the element.
  out = out.replace(
    /style=\{\{\s*(\w+)\s*:\s*"(#[0-9A-Fa-f]{3,6})"\s*,?\s*\}\}/g,
    (whole, prop, hex) => {
      const u = util(prop, hex);
      if (!u) {
        skipped.push(`${rel}  ${prop}:${hex}`);
        return whole;
      }
      replaced++;
      return `className="${u}"`;
    },
  );

  if (out !== src) {
    changedFiles++;
    if (WRITE) writeFileSync(file, out);
  }
}

console.log(`  files scanned  ${files.length}`);
console.log(`  migrated       ${replaced}  across ${changedFiles} file(s)`);
console.log(`  left alone     ${skipped.length}`);

if (skipped.length) {
  const byColour = {};
  for (const s of skipped) byColour[s.slice(s.lastIndexOf(":") + 1)] ??= 0;
  for (const s of skipped) byColour[s.slice(s.lastIndexOf(":") + 1)]++;
  console.log("    (status colours and unmapped values — correct to skip)");
  for (const [hex, n] of Object.entries(byColour).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${hex.padEnd(10)} ${n}`);
  }
}
console.log(WRITE ? "\n  WRITTEN" : "\n  dry run — pass --write to apply");
