/**
 * Brace colour constants that landed in JSX attribute position.
 *
 * The migration replaced any `"#346538"` string literal, which also matched
 * JSX attributes:
 *
 *     stroke="#346538"   ->   stroke=SUCCESS     (invalid JSX)
 *     stroke="#346538"   ->   stroke={SUCCESS}   (what was meant)
 *
 * A reminder that a find-and-replace across markup is not the simple
 * operation it looks like: the same quoted token means different things in
 * an expression and in an attribute.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

// Longest first, so SUCCESS_BG is not partially matched as SUCCESS.
const NAMES = ["DANGER_BG", "SUCCESS_BG", "WARN_BG", "DANGER", "SUCCESS", "WARN", "NEUTRAL"];

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

let braced = 0;
const files = [];

for (const file of [...walk("apps/dashboard/app"), ...walk("apps/dashboard/components")]) {
  const raw = readFileSync(file, "utf8");
  const crlf = raw.includes(CRLF);
  let s = raw.split(CRLF).join(LF);
  const before = s;

  for (const name of NAMES) {
    // ` attr=NAME` not already followed by more identifier characters.
    s = s.replace(new RegExp(`(\\s[a-zA-Z-]+)=${name}(?![A-Za-z0-9_])`, "g"), (_m, attr) => {
      braced++;
      return `${attr}={${name}}`;
    });
  }

  if (s !== before) {
    writeFileSync(file, crlf ? s.split(LF).join(CRLF) : s);
    files.push(file.split("\\").join("/"));
  }
}

console.log(`  ${braced} JSX attribute(s) braced across ${files.length} file(s)`);
for (const f of files) console.log(`    ${f}`);
