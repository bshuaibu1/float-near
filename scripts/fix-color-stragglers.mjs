/**
 * The four status colours that survived the migration.
 *
 * Each was embedded inside a LARGER string, which the migration's
 * `"#HEX"` pattern correctly refused to touch:
 *
 *   "1px solid #9F2F2D"   a CSS shorthand
 *   "text-[#9F2F2D]"      a Tailwind arbitrary value
 *   "#346538CC"           the same colour with an alpha suffix
 *
 * Not misses in the regex so much as three different problems wearing the
 * same six characters. Handled one at a time rather than by widening the
 * pattern, which would have started rewriting Tailwind class names.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

const EDITS = [
  {
    file: "apps/dashboard/app/settings/page.tsx",
    from: 'style={{ background: DANGER, color: "#fff", border: "1px solid #9F2F2D" }}',
    to: 'style={{ background: DANGER, color: "#fff", border: `1px solid ${DANGER}` }}',
  },
  {
    file: "apps/dashboard/app/settings/page.tsx",
    from: '<div className="bg-white rounded-lg overflow-hidden" style={{ border: "1px solid #FDEBEC" }}>',
    to: '<div className="bg-white rounded-lg overflow-hidden" style={{ border: `1px solid ${DANGER_BG}` }}>',
  },
  {
    file: "apps/dashboard/app/settings/page.tsx",
    from: '<div className="px-6 py-4" style={{ borderBottom: "1px solid #FDEBEC" }}>',
    to: '<div className="px-6 py-4" style={{ borderBottom: `1px solid ${DANGER_BG}` }}>',
  },
  {
    file: "apps/dashboard/app/settings/page.tsx",
    from: '? { background: SUCCESS_BG, color: SUCCESS, border: "1px solid #EDF3EC" }',
    to: '? { background: SUCCESS_BG, color: SUCCESS, border: `1px solid ${SUCCESS_BG}` }',
  },
  {
    file: "apps/dashboard/app/page.tsx",
    from: '(hasSpend ? "#346538CC" : "#EAEAEA")',
    to: "(hasSpend ? SUCCESS_SOFT : \"#EAEAEA\")",
  },
  {
    // A Tailwind arbitrary value, so it becomes a Tailwind token.
    file: "apps/dashboard/app/agents/page.tsx",
    from: 'tone === "error" ? "text-[#9F2F2D]" : "text-muted"',
    to: 'tone === "error" ? "text-danger" : "text-muted"',
  },
];

const needsImport = {
  "apps/dashboard/app/page.tsx": ["SUCCESS_SOFT"],
};

const byFile = new Map();
for (const e of EDITS) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

for (const [file, edits] of byFile) {
  const raw = readFileSync(file, "utf8");
  const crlf = raw.includes(CRLF);
  let s = raw.split(CRLF).join(LF);
  for (const e of edits) {
    if (!s.includes(e.from)) {
      console.log(`  MISS  ${file}: ${e.from.slice(0, 50)}`);
      continue;
    }
    s = s.replace(e.from, e.to);
  }
  for (const name of needsImport[file] ?? []) {
    const line = s.match(/^import \{([^}]*)\} from "@\/lib\/colors";$/m);
    if (!line) throw new Error(`${file}: no colors import to extend`);
    const names = [...new Set([...line[1].split(",").map((x) => x.trim()), name])].sort();
    s = s.replace(line[0], `import { ${names.join(", ")} } from "@/lib/colors";`);
  }
  writeFileSync(file, crlf ? s.split(LF).join(CRLF) : s);
  console.log(`  ${file.split("/").pop()}: ${edits.length} straggler(s)`);
}
