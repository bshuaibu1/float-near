#!/usr/bin/env node
/**
 * Does every method that demands a yoctoNEAR also ACCEPT one?
 *
 * near-sdk generates an extern-C wrapper per method, and a method without
 * `#[payable]` REJECTS any attached deposit there — before the body runs. So a
 * method that calls `assert_one_yocto()` (directly, or via `assert_owner()`)
 * and is NOT `#[payable]` is UNREACHABLE IN BOTH DIRECTIONS:
 *
 *   with a deposit     "Method X doesn't accept deposit"
 *   without a deposit  "Requires attached deposit of exactly 1 yoctoNEAR"
 *
 * There is no third kind of call. The method can never succeed.
 *
 * THE UNIT TIER CANNOT SEE THIS. Unit tests call the Rust function directly
 * and never cross the generated wrapper, so they pass identically before and
 * after — 10/10 did, the last time this shipped. It has now happened twice:
 * the factory's kill switch, and `bind_virtual_agent`, which was dead in the
 * deployed contract until the integration tier was made runnable and caught it.
 *
 * A SOURCE SCAN, because that is the only tier that sees the attribute.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const FILES = [];
for (const c of ["vault", "factory"]) {
  const d = join("contracts", c, "src");
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith(".rs")) FILES.push(join(d, f));
}
if (FILES.length === 0) {
  console.error("BROKEN: no contract sources found — this check cannot run, which is not a pass.");
  process.exit(1);
}

let scanned = 0;
const unreachable = [];
for (const file of FILES) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /pub fn (\w+)/.exec(lines[i]);
    if (!m) continue;
    scanned++;
    // `#[payable]` may sit a few lines up, behind doc comments.
    const payable = lines
      .slice(Math.max(0, i - 6), i)
      .some((l) => l.includes("#[payable]"));
    // Body: until the next method at the same indent.
    const body = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 80); j++) {
      // ANY method at this indent ends the body, not just a `pub` one.
      // Breaking only on `pub fn` ran straight past the end of the factory's
      // `new` into the PRIVATE `fn assert_owner` defined below it, read that
      // helper's `assert_one_yocto()` as `new`'s own, and reported a healthy
      // initialiser as unreachable. A checker that cries wolf is worse than
      // none: the next real hit gets waved through.
      if (/^    (pub )?fn /.test(lines[j])) break;
      body.push(lines[j]);
    }
    const b = body.join("\n");
    const demands = b.includes("assert_one_yocto()") || b.includes("assert_owner()");
    if (demands && !payable) unreachable.push(`${file}: ${m[1]}`);
  }
}

if (unreachable.length) {
  console.error(
    `BROKEN: ${unreachable.length} method(s) demand a yoctoNEAR but are not #[payable], ` +
      `so they are UNREACHABLE — a deposit is rejected by the wrapper, and no deposit fails ` +
      `assert_one_yocto:`,
  );
  for (const u of unreachable) console.error(`  ${u}`);
  console.error(`  Add #[payable]. Unit tests will NOT catch this: they never cross the wrapper.`);
  process.exit(1);
}
console.log(`payable pairing: ${scanned} method(s) scanned, none unreachable`);
