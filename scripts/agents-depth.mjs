/**
 * The /agents half of "depth is a number".
 *
 * Line-based rather than anchored on a literal block: the previous attempt
 * hand-counted the indentation and got 20 spaces where the file has 18, which
 * fails as an unhelpful "not found". Locating by content and splicing by
 * index cannot be wrong about whitespace.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

const p = "apps/dashboard/app/agents/page.tsx";
const raw = readFileSync(p, "utf8");
const crlf = raw.includes(CRLF);
const lines = raw.split(CRLF).join(LF).split(LF);

function findLine(re, what) {
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error(`not found: ${what}`);
  return i;
}

// --- 1. the stale comment about NON-BREAKING spaces -----------------------
const cStart = findLine(/The hierarchy, drawn\./, "tree comment");
const cEnd = findLine(/HTML and the tree renders flat\. \*\/\}/, "tree comment end");
if (cEnd < cStart) throw new Error("comment markers out of order");
const indent = lines[cStart].match(/^\s*/)[0];
lines.splice(
  cStart,
  cEnd - cStart + 1,
  `${indent}{/* The hierarchy, drawn with REAL padding.`,
  `${indent}    Depth used to arrive as U+00A0 characters inside the label,`,
  `${indent}    which is why it broke whenever anyone typed a plain space -`,
  `${indent}    and why agent names carried that invisible padding into the`,
  `${indent}    prose warning further up this page. */}`,
);

// --- 2. indent the row by depth -------------------------------------------
const rowIdx = findLine(
  /^\s*<div className="flex items-center gap-2\.5 min-w-0">$/,
  "row container",
);
const rowIndent = lines[rowIdx].match(/^\s*/)[0];
lines.splice(
  rowIdx,
  1,
  `${rowIndent}<div`,
  `${rowIndent}  className="flex items-center gap-2.5 min-w-0"`,
  `${rowIndent}  style={{ paddingLeft: \`\${(a.depth ?? 0) * 1.1}rem\` }}`,
  `${rowIndent}>`,
);

let s = lines.join(LF);

// --- 3. the prose list must carry no tree characters ----------------------
const PROSE_FROM = '{noAllowlist.map((a) => (a.displayName ?? a.agentId).trim()).join(", ")}';
const PROSE_TO = '{noAllowlist.map((a) => a.displayName ?? a.agentId).join(", ")}';
if (s.includes(PROSE_FROM)) s = s.replace(PROSE_FROM, PROSE_TO);
else console.log("    (prose list already clean)");

writeFileSync(p, crlf ? s.split(LF).join(CRLF) : s);
console.log(`  /agents indents by depth; stale comment replaced (CRLF: ${crlf})`);
