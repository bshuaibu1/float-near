/**
 * Is any dashboard colour written as a hex when a token already holds it?
 *
 * lib/colors.ts exists so a colour is named once. It was applied incompletely:
 * sixteen `"#fff"` literals survived in inline styles, several of them in the
 * SAME style object as an already-tokenised `INK` or `LINE` -
 * `{ background: "#fff", color: INK }` - which is the shape a half-finished
 * migration leaves behind.
 *
 * This fails on an EXACT match only. A colour that is merely similar to a
 * token is a design decision and none of this script's business; a colour
 * that is byte-identical to one is a duplicate with a name already waiting
 * for it.
 *
 * DELIBERATELY NOT CHECKED:
 *   - tailwind.config.ts, which DEFINES the palette. The hexes there are the
 *     source, not copies of it.
 *   - globals.css, which cannot hold a JS constant.
 *   - comments, where a hex is usually the subject of a sentence explaining
 *     why it is not used.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const ROOT = "apps/dashboard";

const tokenSrc = readFileSync(`${ROOT}/lib/colors.ts`, "utf8");
const TOKENS = {};
for (const m of tokenSrc.matchAll(/export const (\w+) = "(#[0-9A-Fa-f]{3,8})"/g)) {
  TOKENS[m[2].toUpperCase()] = m[1];
}
if (Object.keys(TOKENS).length === 0) {
  console.log("  BROKEN  no tokens parsed out of lib/colors.ts");
  process.exit(1);
}

const files = execSync(`git ls-files ${ROOT}`, { encoding: "utf8" })
  .trim()
  .split(LF)
  .filter((f) => /\.tsx$/.test(f));

/** `#fff` and `#ffffff` are the same colour and must compare equal. */
const expand = (h) =>
  h.length === 4 ? "#" + h.slice(1).split("").map((c) => c + c).join("") : h;

const hits = [];
for (const f of files) {
  readFileSync(f, "utf8")
    .split(LF)
    .forEach((line, i) => {
      // A hex inside a comment is prose about a colour, not a use of one.
      if (/^\s*(\*|\/\/)/.test(line)) return;
      for (const m of line.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
        const token = TOKENS[expand(m[0].toUpperCase())];
        if (token) hits.push({ file: f, line: i + 1, hex: m[0], token });
      }
    });
}

if (hits.length) {
  for (const h of hits) {
    console.log(`  DUPLICATE  ${h.file}:${h.line}  ${h.hex} is already ${h.token}`);
  }
  console.log(`${hits.length} colour(s) written as a hex when a token holds the same value`);
  process.exit(1);
}
console.log(
  `  no duplicated colours (${files.length} files, ${Object.keys(TOKENS).length} tokens)`,
);
