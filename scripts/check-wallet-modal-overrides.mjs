/**
 * Do the wallet-modal overrides in web/index.html still mean anything?
 *
 * The page restyles `@near-wallet-selector/modal-ui` through that package's
 * own CSS custom properties, at a PINNED version. Those names are the
 * version's API, and nothing enforces them:
 *
 *   - a property we set that the sheet never READS is dead. `--border` is
 *     already like this upstream — declared, then used nowhere — so this is
 *     not hypothetical.
 *   - a version bump that renames or drops a property leaves the modal
 *     silently stock. The page still works. That is why it would go
 *     unnoticed: the failure is cosmetic and the thing it breaks is trust at
 *     the moment someone connects a wallet.
 *
 * Written as a file rather than an inline `node -e` because the escaping for
 * `var\(` did not survive bash -> node -e -> RegExp, and the check died with
 * "Unterminated group". An inline check that throws is lucky; one that merely
 * mismatches reads as a pass.
 *
 *   node scripts/check-wallet-modal-overrides.mjs
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PAGE = resolve(ROOT, "web", "index.html");
const CACHE = resolve(ROOT, ".demo", "wallet-selector.css");

const html = readFileSync(PAGE, "utf8");

// The version is whatever the page actually loads — read it, never assume.
const link = html.match(/@near-wallet-selector\/modal-ui@([\d.]+)\/styles\.css/);
if (!link) {
  console.error("FATAL: web/index.html does not link the wallet-selector stylesheet.");
  process.exit(1);
}
const version = link[1];
const url = `https://esm.sh/@near-wallet-selector/modal-ui@${version}/styles.css`;

let css;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  css = await res.text();
  mkdirSync(resolve(ROOT, ".demo"), { recursive: true });
  writeFileSync(CACHE, css);
} catch (e) {
  if (!existsSync(CACHE)) {
    console.error(`FATAL: cannot fetch ${url} and no cached copy at ${CACHE}`);
    console.error(`  ${e.message}`);
    process.exit(1);
  }
  // Say so. A cached sheet cannot detect a version bump, which is the main
  // thing this check exists for.
  console.warn(`  WARNING: using cached stylesheet — offline check, cannot see upstream changes`);
  css = readFileSync(CACHE, "utf8");
}

console.log(`  modal-ui@${version}  (${css.length} bytes)`);

// Our override block.
const start = html.indexOf("#near-wallet-selector-modal {");
if (start < 0) {
  console.error("FATAL: no #near-wallet-selector-modal override block found in the page.");
  process.exit(1);
}
const block = html.slice(start, html.indexOf("}", start));
const ours = [...new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))];

// POSITIVE CONTROL. If the block parsed to nothing, every assertion below
// would vacuously pass.
if (ours.length < 5) {
  console.error(`FATAL: only ${ours.length} properties parsed from the override block.`);
  process.exit(1);
}

// BEING READ IS THE ONLY TEST THAT MATTERS. Whether the sheet also DECLARES
// a property is irrelevant, and an earlier version of this check got that
// backwards — it demanded both, and then flagged all eleven real override
// hooks as dead.
//
// The `--wallet-selector-*` family is deliberately never declared upstream:
// those names exist only to be set by a consumer, and the sheet reads them as
// the first fallback —
//
//     var(--wallet-selector-selected-wallet-bg, var(--selected-wallet-bg))
//
// so "not declared, used" is exactly what a working hook looks like. The
// genuinely dead ones are the opposite shape: declared as an internal default
// and then never read, like `--border`.
let dead = 0;
for (const v of ours) {
  // Fallback-aware: `var(--x)` and `var(--x, #fff)` both count as a use.
  const used = new RegExp(`var\\(\\s*${v}\\s*[,)]`).test(css);
  if (!used) {
    const declared = new RegExp(`${v}\\s*:`).test(css);
    console.log(
      `  DEAD  ${v.padEnd(42)} ${declared ? "declared as an internal default but never read" : "unknown to this version"}`,
    );
    dead++;
  }
}

// And the classes we reach for directly, where the sheet exposes no variable.
const classes = [...new Set([...html.matchAll(/\.nws-modal-wrapper \.nws-modal(?: \.([a-z-]+))?/g)]
  .map((m) => m[1])
  .filter(Boolean))];
let missing = 0;
for (const c of classes) {
  if (!css.includes(`.${c}`)) {
    console.log(`  MISSING CLASS  .${c} is targeted by the page but absent upstream`);
    missing++;
  }
}

console.log();
if (dead || missing) {
  console.log(
    `${dead} dead propert${dead === 1 ? "y" : "ies"}, ${missing} missing class(es) of ${ours.length} + ${classes.length} checked.`,
  );
  console.log(`Remove them, or re-read the stylesheet for the names this version uses.`);
  process.exitCode = 1;
} else {
  console.log(`all ${ours.length} properties and ${classes.length} classes are real in modal-ui@${version}`);
}
