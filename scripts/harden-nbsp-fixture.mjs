/**
 * Replace the typed U+00A0 characters in the adapter's dashboard fixture with
 * a BUILT expectation.
 *
 * The assertion passes today because both the fixture and `indent()` use a
 * real no-break space. The hazard is one edit away: retype that line with
 * plain spaces and the test starts demanding plain spaces, blessing a
 * regression that flattens the whole tree in the UI. Nothing would be red.
 *
 * Building the expectation from fromCharCode means the test can only agree
 * with the real character.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "packages/float-adapter/src/handlers.test.ts";
const NB = String.fromCharCode(160);

let s = readFileSync(p, "utf8");

const from =
  'expect(d.agents.map((a) => a.displayName)).toEqual(["root", "└─ research", "' +
  NB.repeat(3) +
  '└─ r1"]);';

const to = [
  "// BUILT, never typed. A pasted U+00A0 here is indistinguishable from a",
  "// plain space; if this line were ever retyped with spaces the test would",
  "// start demanding the flattened output instead of catching it.",
  "const PAD = String.fromCharCode(160);",
  "const GLYPH = String.fromCharCode(0x2514, 0x2500);",
  "expect(d.agents.map((a) => a.displayName)).toEqual([",
  '  "root",',
  '  GLYPH + " research",',
  '  PAD.repeat(3) + GLYPH + " r1",',
  "]);",
].join("\n      ");

if (!s.includes(from)) {
  console.log("  fixture line not found in the expected shape - not touching it");
  process.exit(1);
}
s = s.replace(from, to);
writeFileSync(p, s);
console.log("  fixture now builds its own no-break spaces");
console.log(`  literal U+00A0 left in the file: ${s.split(NB).length - 1}`);
