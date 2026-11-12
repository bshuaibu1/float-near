/**
 * Check the figures published in FLOAT.md against the contract source.
 *
 * IN A FILE, NOT `node -e`. Three times this session a backslash escape
 * collapsed on its way through the shell and produced a matcher that could not
 * match anything: `\b` became a backspace byte, `\s` became a literal "s".
 * Both times the output was a clean uniform "nothing found", which reads
 * exactly like a real finding. A matcher that cannot match and a subject that
 * is absent are the same output.
 *
 * So: controls first, and a uniform-failure guard that refuses to report.
 */
import { readFileSync } from "node:fs";

const src = [
  readFileSync("contracts/vault/src/lib.rs", "utf8"),
  readFileSync("contracts/vault/src/types.rs", "utf8"),
].join("\n");

/** What FLOAT.md Part 4 ("THE HARD LIMITS") claims. Keep in sync with the doc. */
const PUBLISHED = {
  MAX_DEPTH: 4,
  MAX_NODES: 64,
  MAX_CHILDREN: 16,
  MAX_TOKENS: 4,
  MAX_RECIPIENTS: 32,
  MAX_LABEL_LEN: 48,
  MAX_REQUEST_ID_LEN: 64,
  MAX_MEMO_LEN: 256,
  MAX_COOLDOWN_SEC: 604800,
  MAX_LIST_LIMIT: 50,
  MAX_PURGE_LIMIT: 100,
};

/**
 * Read `const NAME: ty = <int>;` without hand-rolling an escape.
 *
 * EVALUATES A PRODUCT, because the source writes durations the readable way:
 * `MAX_COOLDOWN_SEC: u32 = 7 * 24 * 60 * 60`. Stripping non-digits turned that
 * into "7246060" and reported the doc as wrong when the doc said 604800 and was
 * right. A checker that mangles its subject accuses the subject.
 */
function constValue(name) {
  const at = src.indexOf(`const ${name}`);
  if (at === -1) return null;
  const eq = src.indexOf("=", at);
  const end = src.indexOf(";", eq);
  if (eq === -1 || end === -1) return null;

  const expr = src
    .slice(eq + 1, end)
    .split("//")[0] // drop a trailing comment
    .replace(/_/g, "")
    .trim();

  // Only integers and `*` — anything else is not something to guess at.
  if (!/^[0-9]+(\s*\*\s*[0-9]+)*$/.test(expr)) return null;
  return expr.split("*").reduce((acc, part) => acc * Number(part.trim()), 1);
}

// ---- CONTROLS, before any count is trusted.
if (constValue("MAX_DEPTH") === null) {
  throw new Error("control failed: MAX_DEPTH not readable — the matcher is broken, not the source");
}
if (constValue("THIS_CONST_DOES_NOT_EXIST") !== null) {
  throw new Error("control failed: matcher invented a value for an absent constant");
}

const rows = Object.entries(PUBLISHED).map(([name, doc]) => {
  const actual = constValue(name);
  return { name, doc, actual, ok: actual === doc };
});

// ---- UNIFORM-FAILURE GUARD. If every row fails, suspect the check.
const bad = rows.filter((r) => !r.ok);
if (bad.length === rows.length && rows.length > 1) {
  throw new Error(
    `every one of ${rows.length} figures mismatched, which is far more likely to be a broken ` +
      `check than a doc that is wrong about everything. Refusing to report.`,
  );
}

for (const r of rows) {
  console.log(
    `  ${r.ok ? "ok  " : "BAD "} ${r.name.padEnd(20)} doc=${String(r.doc).padEnd(8)}src=${r.actual ?? "absent"}`,
  );
}
console.log(
  bad.length === 0
    ? `\nall ${rows.length} published figures match the contract`
    : `\n${bad.length} of ${rows.length} figures disagree with the contract`,
);
if (bad.length) process.exitCode = 1;
