/**
 * Does web/index.html's markup actually balance?
 *
 * Written as a FILE rather than an inline `node -e` because the inline
 * version silently lied: the backslash escaping for `<div\b` survived bash,
 * then node's `-e` string, then the RegExp constructor differently at each
 * layer, and the check reported 0 opening tags against 33 closing ones. A
 * count that impossible is obviously broken — but a count that is merely
 * WRONG would have read as a passing check.
 *
 * The page is hand-written HTML with no build step and no validator in the
 * loop, so an unclosed <div> renders fine in a forgiving browser and shows
 * up later as a panel that will not hide. This is the cheapest guard against
 * that.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PAGE = resolve(import.meta.dirname, "..", "web", "index.html");
const html = readFileSync(PAGE, "utf8");

// Only the markup. The script block contains `</div>` inside strings and
// comments, which would be counted as real tags.
const start = html.indexOf("<body>");
const end = html.indexOf('<script type="module">');
if (start < 0 || end < 0) {
  console.error("FATAL: could not find <body> or the module script.");
  process.exit(1);
}
const body = html.slice(start, end);

let bad = 0;
for (const tag of ["div", "header", "button", "p", "span"]) {
  const open = body.match(new RegExp(`<${tag}(?=[\\s>])`, "g")) ?? [];
  const close = body.match(new RegExp(`</${tag}>`, "g")) ?? [];
  const ok = open.length === close.length;
  if (!ok) bad++;
  console.log(
    `  <${tag}>`.padEnd(12) + `${open.length} open / ${close.length} close  ${ok ? "ok" : "MISMATCH"}`,
  );
}

// POSITIVE CONTROL. If the patterns matched nothing, every tag would look
// "balanced" at 0 === 0 and this would pass hardest exactly when broken.
const divs = (body.match(/<div(?=[\s>])/g) ?? []).length;
if (divs < 5) {
  console.error(`\nFATAL: only ${divs} <div> found — the matcher is not working.`);
  process.exit(1);
}

// Every id the script reaches for must exist in the markup.
const declared = new Set([...html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]));
const used = [...new Set([...html.matchAll(/\$\("([a-zA-Z0-9_-]+)"\)/g)].map((m) => m[1]))];
const missing = used.filter((i) => !declared.has(i));
console.log(
  `\n  ids: ${used.length} referenced, ${declared.size} declared` +
    (missing.length ? `  MISSING: ${missing.join(", ")}` : "  all present"),
);
if (missing.length) bad++;

process.exitCode = bad ? 1 : 0;
console.log(bad ? `\n${bad} problem(s)` : "\nstructure ok");
