/**
 * Tailwind arbitrary values -> the tokens that already hold the same colour.
 *
 *   hover:bg-[#FBFBFA]  ->  hover:bg-canvas
 *   border-[#EAEAEA]    ->  border-line
 *   border-t-[#111111]  ->  border-t-ink
 *
 * Safe because tailwind.config.ts already defines canvas/line/ink as exactly
 * those hexes - the generated CSS is byte-identical. Done as its own pass
 * rather than inside the inline-style migration because class names and
 * style objects fail differently: a wrong class is silently inert, whereas a
 * wrong style value is a type error.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

const MAP = [
  ["bg-[#FBFBFA]", "bg-canvas"],
  ["bg-[#FFFFFF]", "bg-card"],
  ["border-[#EAEAEA]", "border-line"],
  ["border-t-[#111111]", "border-t-ink"],
  ["text-[#111111]", "text-ink"],
  ["text-[#787774]", "text-muted"],
];

function walk(dir) {
  let out = [];
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".next")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.tsx$/.test(n)) out.push(p);
  }
  return out;
}

let total = 0;
const files = [];
for (const file of [...walk("apps/dashboard/app"), ...walk("apps/dashboard/components")]) {
  const raw = readFileSync(file, "utf8");
  const crlf = raw.includes(CRLF);
  let s = raw.split(CRLF).join(LF);
  const before = s;
  for (const [from, to] of MAP) {
    const parts = s.split(from);
    if (parts.length > 1) {
      total += parts.length - 1;
      s = parts.join(to);
    }
  }
  if (s !== before) {
    writeFileSync(file, crlf ? s.split(LF).join(CRLF) : s);
    files.push(file.split("\\").join("/"));
  }
}
console.log(`  ${total} arbitrary value(s) replaced across ${files.length} file(s)`);
for (const f of files) console.log(`    ${f}`);
