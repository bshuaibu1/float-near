/**
 * Record the colour every element actually renders, per page.
 *
 * A colour refactor is the easiest kind to get silently wrong: the code
 * compiles, the tests pass, and a button is a slightly different red. The only
 * honest proof is a before/after of COMPUTED styles from a real browser.
 *
 *   node scripts/color-snapshot.mjs before
 *   ...make the change...
 *   node scripts/color-snapshot.mjs after
 *   node scripts/color-snapshot.mjs diff
 *
 * Deliberately records every element carrying an inline colour, not a
 * screenshot: a screenshot diff tells you something moved, this tells you
 * which rule changed and from what to what.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const MODE = process.argv[2];
if (!["before", "after", "diff"].includes(MODE)) {
  console.log("  usage: node scripts/color-snapshot.mjs before|after|diff");
  process.exit(1);
}

const OUT = ".demo/color-snapshot";
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

if (MODE === "diff") {
  const a = JSON.parse(readFileSync(`${OUT}/before.json`, "utf8"));
  const b = JSON.parse(readFileSync(`${OUT}/after.json`, "utf8"));
  let changed = 0;
  let same = 0;
  for (const page of Object.keys(a)) {
    const rowsA = a[page] ?? [];
    const rowsB = b[page] ?? [];
    if (rowsA.length !== rowsB.length) {
      console.log(`  ${page}: ELEMENT COUNT CHANGED ${rowsA.length} -> ${rowsB.length}`);
    }
    const n = Math.min(rowsA.length, rowsB.length);
    for (let i = 0; i < n; i++) {
      const x = rowsA[i];
      const y = rowsB[i];
      if (x.color === y.color && x.background === y.background) {
        same++;
        continue;
      }
      changed++;
      console.log(`  ${page}  ${x.tag}.${(x.cls || "").slice(0, 28)}  "${(x.text || "").slice(0, 24)}"`);
      if (x.color !== y.color) console.log(`      color      ${x.color}  ->  ${y.color}`);
      if (x.background !== y.background) console.log(`      background ${x.background}  ->  ${y.background}`);
    }
  }
  console.log("");
  console.log(`  ${same} elements unchanged, ${changed} changed`);
  process.exit(0);
}

// before / after: drive a browser via the preview MCP is not available from a
// plain script, so this prints the expression for the caller to evaluate and
// writes whatever it is handed on stdin.
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) {
  console.log("  no data on stdin - pipe the browser capture into this script");
  process.exit(1);
}
writeFileSync(`${OUT}/${MODE}.json`, input);
const parsed = JSON.parse(input);
const total = Object.values(parsed).reduce((n, rows) => n + rows.length, 0);
console.log(`  wrote ${OUT}/${MODE}.json  (${Object.keys(parsed).length} pages, ${total} elements)`);
