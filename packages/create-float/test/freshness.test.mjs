import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { missingCodes, staleSources, freshnessProblems } from "../scripts/freshness.mjs";

/**
 * The guard that stops `npm publish` shipping a contract older than the source.
 *
 * Measured 2026-10-30, which is why this exists: THREE generations of artifact
 * were on disk at once and nothing compared them.
 *
 *   res/vault.wasm    (what publishing would ship) : no NEAR_BUDGET, no PARENT_COOLDOWN
 *   target/.../vault.wasm (what prepack copies)    : NEAR_BUDGET,    no PARENT_COOLDOWN
 *   contracts/vault/src/lib.rs                     : both
 *
 * bundle-wasm.mjs already interrogated the artifact for a test-clock symbol and
 * for panic_utf8 — but never against the SOURCE, so it would have passed a wasm
 * missing two reason codes straight into a published package.
 *
 * Two independent checks, because each misses what the other catches:
 *   - CONTENT is ground truth (the reason codes a contract answers with are
 *     strings inside its own bytes) but blind to a change that adds no code.
 *   - MTIME catches any edit at all, but is a side-channel and can be defeated.
 * The lesson is [[revision-file-lies-about-what-is-deployed]]: ground truth for
 * "what is this artifact" is the artifact itself, never a file claiming to
 * describe it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const TYPES_RS = join(REPO, "contracts", "vault", "src", "types.rs");
const RES_WASM = join(HERE, "..", "res", "vault.wasm");

// ---- missingCodes: content, the ground-truth check

test("missingCodes reports a reason code the source defines and the wasm lacks", () => {
  const src = 'NearBudget => "NEAR_BUDGET",\nCooldown => "COOLDOWN",';
  const wasm = Buffer.from("...COOLDOWN...");
  assert.deepEqual(missingCodes(src, wasm), ["NEAR_BUDGET"]);
});

test("missingCodes is empty when the wasm answers every code in the source", () => {
  const src = 'NearBudget => "NEAR_BUDGET",\nCooldown => "COOLDOWN",';
  const wasm = Buffer.from("xx NEAR_BUDGET yy COOLDOWN zz");
  assert.deepEqual(missingCodes(src, wasm), []);
});

test("missingCodes ignores lowercase and mixed-case arms — reason codes are SHOUTED", () => {
  // `=> "near"` is a label, not a reason code. Matching it would make the guard
  // fire on strings that never appear in the wasm as codes.
  const src = 'Rail => "intents",\nNearBudget => "NEAR_BUDGET",';
  const wasm = Buffer.from("NEAR_BUDGET");
  assert.deepEqual(missingCodes(src, wasm), []);
});

test("REAL DATA: the shipped res/vault.wasm answers EVERY reason code the real source defines", () => {
  // A synthetic fixture cannot validate a claim about a real artifact, so this
  // drives the actual bundled wasm against the actual source enum.
  //
  // This assertion is deliberately the INVARIANT rather than the bug. The first
  // version asserted the opposite — that res/ was *caught* as stale, which was
  // true on 2026-10-30 and is exactly the condition the rebuild fixes. A test
  // that encodes today's defect goes red forever once the defect is repaired,
  // and teaches nothing in between. This one fails whenever the contract is
  // edited and res/ is not re-bundled, which is the thing actually worth
  // guarding.
  const missing = missingCodes(readFileSync(TYPES_RS, "utf8"), readFileSync(RES_WASM));
  assert.deepEqual(
    missing,
    [],
    `res/vault.wasm is behind contracts/vault/src — missing ${missing.join(", ")}. ` +
      `Rebuild with cargo-near, then: npm run bundle-wasm`,
  );
});

test("REAL DATA: the source really does define 44 codes, so the parser is not silently matching nothing", () => {
  // Positive control. A parser returning [] would make every freshness check
  // pass, and "no missing codes" is indistinguishable from "found no codes".
  const src = readFileSync(TYPES_RS, "utf8");
  const all = missingCodes(src, Buffer.alloc(0));
  assert.equal(all.length, 44, `parsed ${all.length} codes from types.rs, expected 44`);
});

// ---- staleSources: mtime, the backstop

test("staleSources flags a source file newer than the wasm", () => {
  const sources = [
    { path: "lib.rs", mtimeMs: 2000 },
    { path: "types.rs", mtimeMs: 500 },
  ];
  assert.deepEqual(staleSources(1000, sources), ["lib.rs"]);
});

test("staleSources is empty when the wasm is newer than everything", () => {
  const sources = [{ path: "lib.rs", mtimeMs: 10 }];
  assert.deepEqual(staleSources(1000, sources), []);
});

test("a source modified in the same millisecond as the build is NOT stale", () => {
  // Strictly-newer, not newer-or-equal. A coarse filesystem clock would
  // otherwise fail every build on a fast machine.
  assert.deepEqual(staleSources(1000, [{ path: "lib.rs", mtimeMs: 1000 }]), []);
});

// ---- the two combined

test("freshnessProblems describes BOTH failures, not just the first", () => {
  const problems = freshnessProblems({
    typesSrc: 'NearBudget => "NEAR_BUDGET",',
    wasmBytes: Buffer.alloc(0),
    wasmMtimeMs: 100,
    sources: [{ path: "lib.rs", mtimeMs: 900 }],
  });
  const joined = problems.join("\n");
  assert.match(joined, /NEAR_BUDGET/);
  assert.match(joined, /lib\.rs/);
});

test("freshnessProblems is empty for a genuinely fresh build", () => {
  assert.deepEqual(
    freshnessProblems({
      typesSrc: 'NearBudget => "NEAR_BUDGET",',
      wasmBytes: Buffer.from("NEAR_BUDGET"),
      wasmMtimeMs: 900,
      sources: [{ path: "lib.rs", mtimeMs: 100 }],
    }),
    [],
  );
});

// ---- reachability (tdd-extras Rule 5)
//
// Every test above constructs the guard itself, so none can see whether
// bundle-wasm.mjs CALLS it. This one drives the real script and asserts it
// refuses today's stale target/ artifact.

function runBundleWasm(srcPath) {
  // --check, NOT a bare run: a bare run COPIES, and the first version of this
  // test silently replaced the tracked res/vault.wasm as a side effect of
  // asserting. A test that mutates the repo to prove a point is a worse problem
  // than the one it is proving.
  const script = join(HERE, "..", "scripts", "bundle-wasm.mjs");
  try {
    const stdout = execFileSync(process.execPath, [script, "--check"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BUNDLE_WASM_SRC: srcPath },
    });
    return { code: 0, output: stdout };
  } catch (e) {
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("REACHABILITY: bundle-wasm.mjs itself refuses an artifact missing a reason code", () => {
  // Points the real script at a stale artifact built FROM a real one, rather
  // than at the repo's own wasm. Asserting "the repo is currently stale" would
  // pass today and fail permanently after the rebuild that fixes it — the same
  // transience trap as the real-data test above.
  //
  // The probe is a genuine cargo-near wasm with one reason code overwritten by
  // equal-length filler, so it stays byte-valid and keeps panic_utf8: the ONLY
  // thing wrong with it is that it is behind the source. (tdd-extras 7b — the
  // probe is lifted from a real sample, not typed.)
  const real = readFileSync(RES_WASM);
  const at = real.indexOf(Buffer.from("PARENT_COOLDOWN"));
  assert.notEqual(at, -1, "res/vault.wasm has no PARENT_COOLDOWN to blank — rebuild it first");
  const stale = Buffer.from(real);
  stale.fill(0x58, at, at + "PARENT_COOLDOWN".length); // 'X' * 15

  const tmp = join(mkdtempSync(join(tmpdir(), "float-stale-")), "vault.wasm");
  writeFileSync(tmp, stale);

  const { code, output } = runBundleWasm(tmp);
  assert.notEqual(code, 0, `bundle-wasm exited 0 on an artifact missing a code:\n${output}`);
  assert.match(output, /PARENT_COOLDOWN/);
  assert.match(output, /STALE|rebuild/i);
});

test("REACHABILITY: and ACCEPTS the current contract, so the guard is not simply always-fail", () => {
  // The negative control. Without this, a guard hardcoded to `exit(1)` would
  // satisfy the test above — and tdd-extras 7a warns that a passing refusal
  // test proves nothing about which clause carries it.
  const { code, output } = runBundleWasm(RES_WASM);
  assert.equal(code, 0, `bundle-wasm rejected the current contract:\n${output}`);
});
