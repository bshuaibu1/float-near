/**
 * Replace neutral hex literals with the named constants.
 *
 * Only values that EXACTLY match an existing token, so every replacement is a
 * rename and the rendered pixel is unchanged. The near-duplicate greys
 * (#F7F6F3, #F7F7F6, #F0F0EE, #F5F5F4, #FAFAF9 ...) are deliberately left
 * alone: unifying them would be a visual decision, and this pass is not one.
 *
 * FOUR SHAPES, in this order - the order matters because each pattern is a
 * subset of the one before it:
 *
 *   1. JSX attribute       stroke="#111111"        -> stroke={INK}
 *   2. Inside a shorthand  "1px solid #EAEAEA"     -> `1px solid ${LINE}`
 *   3. Bare literal        "#111111"               -> INK
 *   4. Tailwind arbitrary  border-[#EAEAEA]        -> reported, not touched
 *
 * (4) is reported rather than rewritten because the class name is matched by
 * Tailwind's scanner at build time; changing it to `border-line` is correct
 * but is a different kind of edit, and doing it blind inside a template
 * literal of class names is how a layout silently loses a border.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

const MAP = {
  "#FBFBFA": "CANVAS",
  "#FFFFFF": "CARD",
  "#111111": "INK",
  "#787774": "MUTED",
  "#A0A09A": "FAINT",
  "#EAEAEA": "LINE",
  "#F3F3F1": "CHIP",
};

function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".next")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

let attrs = 0;
let shorthands = 0;
let bare = 0;
const arbitrary = [];
const touched = [];

for (const file of [...walk("apps/dashboard/app"), ...walk("apps/dashboard/components")]) {
  const raw = readFileSync(file, "utf8");
  const crlf = raw.includes(CRLF);
  let s = raw.split(CRLF).join(LF);
  const used = new Set();

  for (const [hex, NAME] of Object.entries(MAP)) {
    const H = hex.replace("#", "#");

    // 4. Report Tailwind arbitrary values; do not rewrite them.
    for (const m of s.matchAll(new RegExp(`[a-z-]+\\[${H}\\]`, "gi"))) {
      arbitrary.push(`${file.split("\\").join("/")}  ${m[0]}`);
    }

    // 1. JSX attribute: name="#HEX"  ->  name={NAME}
    s = s.replace(new RegExp(`(\\s[a-zA-Z-]+)="${H}"`, "gi"), (_m, attr) => {
      attrs++;
      used.add(NAME);
      return `${attr}={${NAME}}`;
    });

    // 2. A double-quoted string that contains the hex AND other text, with no
    //    brackets (which would mean a Tailwind class) and no backtick.
    s = s.replace(new RegExp(`"([^"\\[\\]\`]*)${H}([^"\\[\\]\`]*)"`, "gi"), (m, pre, post) => {
      if (pre === "" && post === "") return m; // bare literal, handled below
      shorthands++;
      used.add(NAME);
      return `\`${pre}\${${NAME}}${post}\``;
    });

    // 3. Bare literal, either quote style.
    s = s.replace(new RegExp(`(["'])${H}\\1`, "gi"), () => {
      bare++;
      used.add(NAME);
      return NAME;
    });
  }

  if (!used.size) continue;

  const names = [...used].sort();
  const existing = s.match(/^import \{([^}]*)\} from "@\/lib\/colors";$/m);
  if (existing) {
    const merged = [
      ...new Set([...existing[1].split(",").map((x) => x.trim()).filter(Boolean), ...names]),
    ].sort();
    s = s.replace(existing[0], `import { ${merged.join(", ")} } from "@/lib/colors";`);
  } else {
    // Insert by LINE INDEX, never by string replace: the last import's text
    // can be a bare `import {`, which matches the FIRST such line in the file
    // and splices the new import into someone else's. That happened.
    const lines = s.split(LF);
    let last = -1;
    for (let i = 0; i < lines.length; i++) if (/^import /.test(lines[i])) last = i;
    if (last < 0) throw new Error(`${file}: no import to anchor to`);
    // Walk past a multi-line import's body to its terminating line.
    while (last < lines.length && !/;\s*$/.test(lines[last])) last++;
    lines.splice(last + 1, 0, `import { ${names.join(", ")} } from "@/lib/colors";`);
    s = lines.join(LF);
  }

  writeFileSync(file, crlf ? s.split(LF).join(CRLF) : s);
  touched.push(file.split("\\").join("/"));
}

console.log(`  ${attrs} JSX attributes      stroke="#111111" -> stroke={INK}`);
console.log(`  ${shorthands} shorthands          "1px solid #EAEAEA" -> \`1px solid \${LINE}\``);
console.log(`  ${bare} bare literals       "#111111" -> INK`);
console.log(`  ${attrs + shorthands + bare} total, across ${touched.length} files`);
if (arbitrary.length) {
  console.log(`  ${arbitrary.length} Tailwind arbitrary value(s) left alone:`);
  for (const a of arbitrary) console.log(`    ${a}`);
}
