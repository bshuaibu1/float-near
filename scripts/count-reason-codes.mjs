/**
 * How many ReasonCode variants the contract can actually produce.
 *
 * NO REGEX ESCAPES. Two earlier attempts at this reported "0 live", which is
 * absurd on its face — the contract plainly writes `ReasonCode::NoSuchApproval`.
 * The cause both times was a `\b` word-boundary collapsing into a literal
 * backspace byte on its way through the shell, so the matcher could not match
 * anything and said so as "nothing is live". Zero matches and "the matcher
 * cannot match" are the same output.
 *
 * So this uses plain string splitting, and asserts a positive control BEFORE
 * trusting any count.
 */
import { readFileSync } from "node:fs";

const src = `${readFileSync("contracts/vault/src/types.rs", "utf8")}\n${readFileSync(
  "contracts/vault/src/lib.rs",
  "utf8",
)}`;

const block = /enum ReasonCode\s*\{([\s\S]*?)\n\}/.exec(src);
if (!block) throw new Error("ReasonCode enum not found");
const variants = [...block[1].matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*,/gm)].map((m) => m[1]);

/** Occurrences of `ReasonCode::<name>` followed by a non-identifier char. */
const uses = (name) => {
  const needle = `ReasonCode::${name}`;
  let n = 0;
  let i = src.indexOf(needle);
  while (i !== -1) {
    const after = src[i + needle.length] ?? "";
    // Guards against `DailyBudget` also counting `ParentDailyBudget`-style
    // longer names that merely start the same way.
    if (!/[A-Za-z0-9_]/.test(after)) n += 1;
    i = src.indexOf(needle, i + 1);
  }
  return n;
};

// ---- POSITIVE CONTROL. I have read this line; if the matcher cannot see it,
// every count below is worthless and must not be reported.
const control = uses("NoSuchApproval");
if (control < 1) {
  throw new Error(
    `matcher is broken: ReasonCode::NoSuchApproval occurs in the source but the ` +
      `matcher found ${control}. Refusing to report counts from a matcher that ` +
      `cannot see a known-present value.`,
  );
}
// And a NEGATIVE control, so "sees everything" is excluded too.
const absent = uses("ThisVariantDoesNotExist");
if (absent !== 0) throw new Error(`matcher over-matches: got ${absent} for an absent name`);

const live = variants.filter((v) => uses(v) > 0);
const dead = variants.filter((v) => uses(v) === 0);

console.log(`control: ReasonCode::NoSuchApproval seen ${control}x, absent name seen 0x — matcher OK`);
console.log(`total variants:     ${variants.length}`);
console.log(`live (constructed): ${live.length}`);
console.log(`never constructed:  ${dead.length}`);
console.log(`  ${dead.join(", ")}`);
