/**
 * Replace status hex literals with the named constants in lib/colors.ts.
 *
 * Mechanical and reversible. Two groups, deliberately separated:
 *
 *   EXACT   a rename only - the rendered colour is byte-identical
 *   UNIFY   five ambers collapse to one, so SOME PIXELS CHANGE
 *
 * The script reports the two counts separately so the diff can be read
 * honestly rather than as "just a refactor".
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

// value -> constant name. Case-insensitive match, both quote styles.
const EXACT = {
  "#9F2F2D": "DANGER",
  "#FDEBEC": "DANGER_BG",
  "#346538": "SUCCESS",
  "#EDF3EC": "SUCCESS_BG",
  "#A8A29E": "NEUTRAL",
};

const UNIFY = {
  "#92400E": "WARN",
  "#9A5F1A": "WARN",
  "#B45309": "WARN",
  "#7A5B14": "WARN",
  "#B97B10": "WARN",
  "#FEF6E7": "WARN_BG",
  "#FEF3E2": "WARN_BG",
  "#FFF8E6": "WARN_BG",
  "#FEF3C7": "WARN_BG",
};

const ALL = { ...EXACT, ...UNIFY };

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

let exactCount = 0;
let unifyCount = 0;
const touched = [];

for (const file of [...walk("apps/dashboard/app"), ...walk("apps/dashboard/components")]) {
  const raw = readFileSync(file, "utf8");
  const crlf = raw.includes(CRLF);
  let s = raw.split(CRLF).join(LF);
  const used = new Set();

  for (const [hex, name] of Object.entries(ALL)) {
    // Only inside a string literal, which is how every one of these appears.
    const re = new RegExp(`(["'])${hex}\\1`, "gi");
    const before = s;
    s = s.replace(re, () => {
      used.add(name);
      if (EXACT[hex]) exactCount++;
      else unifyCount++;
      return name;
    });
    if (before !== s && !EXACT[hex]) {
      // noop - counted above
    }
  }

  if (!used.size) continue;

  // Add the import, merging with one that already exists.
  const names = [...used].sort();
  const existing = s.match(/^import \{([^}]*)\} from "@\/lib\/colors";$/m);
  if (existing) {
    const merged = [...new Set([...existing[1].split(",").map((x) => x.trim()).filter(Boolean), ...names])].sort();
    s = s.replace(existing[0], `import { ${merged.join(", ")} } from "@/lib/colors";`);
  } else {
    const lastImport = [...s.matchAll(/^import .*$/gm)].pop();
    if (!lastImport) throw new Error(`${file}: no import to anchor to`);
    s = s.replace(
      lastImport[0],
      `${lastImport[0]}${LF}import { ${names.join(", ")} } from "@/lib/colors";`,
    );
  }

  writeFileSync(file, crlf ? s.split(LF).join(CRLF) : s);
  touched.push(`${file.replace(/\\/g, "/")}  (${names.join(", ")})`);
}

console.log(`  ${exactCount} EXACT replacements  - rendered colour unchanged`);
console.log(`  ${unifyCount} UNIFY replacements  - five ambers collapse to one, pixels change`);
console.log(`  ${touched.length} files touched:`);
for (const t of touched) console.log(`    ${t}`);
