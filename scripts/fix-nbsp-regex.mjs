/**
 * Replace literal U+00A0 characters inside the policies page's regexes with
 * explicit   escapes.
 *
 * Written as a FILE, not `node -e`: the shell mangles a raw NBSP in an
 * argument, which is the same reason the character does not belong in source.
 *
 * Idempotent — reports what it found and exits 0 either way.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
const NB = " ";

const subs = [
  // depthOf: counts three NBSPs per tree level
  { from: `/^((?:${NB})*)└─\\s/`, to: "/^((?:\\u00a0)*)└─\\s/", what: "depthOf" },
  // chipLabel: strips the indent before the branch glyph
  { from: `.replace(/[${NB}]/g, "")`, to: '.replace(/[\\u00a0]/g, "")', what: "chipLabel" },
];

let s = readFileSync(p, "utf8");
let changed = 0;
for (const { from, to, what } of subs) {
  if (s.includes(to)) {
    console.log(`  ${what}: already escaped`);
  } else if (s.includes(from)) {
    s = s.replace(from, to);
    changed++;
    console.log(`  ${what}: literal NBSP -> \\u00a0 escape`);
  } else {
    console.log(`  ${what}: NOT FOUND - neither form present, check the source`);
  }
}
if (changed) writeFileSync(p, s);

const left = s.split(NB).length - 1;
console.log(`  literal NBSPs remaining in the file: ${left}`);
for (const l of s.split("\n")) {
  if (l.includes("u00a0")) console.log("  " + l.trim());
}
