import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const BUNDLE = join(PKG, "scripts", "bundle-wasm.mjs");
const PROVENANCE = join(PKG, "res", "vault.sources.json");
const SHIPPED = join(PKG, "res", "vault.wasm");

/**
 * THE DIGEST GUARD HAD A STATE NO REBUILD COULD CLEAR, and it blocked a real
 * release.
 *
 * The provenance record is trusted whenever its `artifactSha256` matches the
 * wasm on disk — which reads like "this record describes how this artifact was
 * built", but does not. `cargo near build` is content-addressed, so two
 * different source trees can produce identical bytes. Change a comment and you
 * get the same wasm from different sources.
 *
 * Then the digest mismatches, the artifact hash still matches the record, the
 * stale digest stays trusted, and the printed remedy — "rebuild" — produces
 * the same bytes and the same record. Red forever.
 *
 * Measured 2026-11-07: res/vault.wasm and a fresh build were both
 * 003568bcea22be80…, byte-identical, while the record said b044ad32d3fe… and
 * the sources said 8c1970e25f3f…. prepack refused, two tests were red, and the
 * release of a float-exit fix was blocked. The binary was never wrong.
 *
 * These tests pin the escape hatch AND its limits. An override that waves
 * everything through would be worse than the deadlock it fixes.
 */

function runBundle(args = [], env = {}) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [BUNDLE, ...args], {
        cwd: PKG,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * A provenance record whose digest cannot match any real source tree, but
 * whose artifact hash DOES match what is shipped — the exact deadlock shape.
 *
 * WRITTEN TO A TEMP FILE, NOT TO res/vault.sources.json. The first version
 * corrupted the tracked record in place and restored it in a `finally`, which
 * looked safe and was not: node:test runs test FILES in parallel, so
 * freshness.test.mjs read the corrupted record mid-flight and its
 * "ACCEPTS the current contract" reachability test went red. The failure was
 * real but belonged to this file.
 */
function withDriftedProvenance(fn) {
  const rec = JSON.parse(readFileSync(PROVENANCE, "utf8"));
  const tmp = join(mkdtempSync(join(tmpdir(), "float-prov-")), "vault.sources.json");
  writeFileSync(tmp, JSON.stringify({ ...rec, sourcesDigest: "0".repeat(64) }, null, 2) + "\n");
  return fn(tmp);
}

test("digest drift alone refuses, and names a remedy that can actually work", () => {
  const r = withDriftedProvenance((prov) => runBundle(["--check"], { BUNDLE_WASM_PROVENANCE: prov }));
  assert.notEqual(r.code, 0, `expected a refusal:\n${r.out}`);
  assert.match(r.out, /built from different source/i);
  // The POINT of the change: it must not tell the operator to rebuild, because
  // a rebuild produces identical bytes and cannot clear this.
  assert.match(r.out, /rebuild cannot fix/i);
  assert.match(r.out, /BUNDLE_WASM_RERECORD=1/);
});

test("the artifact is still described as not-provably-stale, not as stale", () => {
  // Wording matters here: this guard's own history says a check that cries
  // wolf gets overridden. Telling someone their artifact is STALE when every
  // content check passed is the cry-wolf case.
  const r = withDriftedProvenance((prov) =>
    runBundle(["--check"], { BUNDLE_WASM_PROVENANCE: prov }),
  );
  // Assert it REFUSED too. Without this, a run that passed for any reason
  // would satisfy the message check vacuously.
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /not provably stale/i);
});

test("BUNDLE_WASM_RERECORD=1 clears drift and says exactly what it did", () => {
  const r = withDriftedProvenance((prov) => runBundle(["--check"], { BUNDLE_WASM_RERECORD: "1", BUNDLE_WASM_PROVENANCE: prov }));
  assert.equal(r.code, 0, `expected the re-record path to pass:\n${r.out}`);
  assert.match(r.out, /re-recording provenance/i);
  // It must state the artifact did not move — that is the whole justification.
  assert.match(r.out, /artifact unchanged/i);
});

test("RERECORD does NOT bypass a CONTENT failure — the hatch is narrow", () => {
  // THE MOST IMPORTANT TEST HERE. The escape hatch exists only for the one
  // case a rebuild cannot fix. If it also waved through a test-clock build or
  // a plain-cargo build, it would be a general override, and this guard's
  // whole job is to stop exactly those two artifacts reaching npm.
  //
  // WHAT ACTUALLY PROTECTS THIS, established by mutation rather than assumed:
  // NOT the `onlyDigestDrift` condition. Content failures are pushed to
  // `fails` BEFORE the hatch is evaluated, so the hatch structurally cannot
  // reach them — widening `onlyDigestDrift` to `true` leaves this test
  // passing. That is a stronger guarantee than a condition, and this test
  // pins the ORDERING that provides it: move the content checks after the
  // hatch and it goes red.
  //
  // (The first version of this comment claimed the condition carried it. The
  // mutation said otherwise. Recorded because a test whose stated reason is
  // wrong gets "simplified" by the next person to read it.)
  //
  // A test-clock contract exposes set_day_len_ns, which lets an owner shrink a
  // "day" to milliseconds and refill a daily cap a thousand times an hour.
  const tmp = join(mkdtempSync(join(tmpdir(), "float-rerecord-")), "vault.wasm");
  const doctored = Buffer.concat([readFileSync(SHIPPED), Buffer.from("set_day_len_ns")]);
  writeFileSync(tmp, doctored);

  const r = runBundle(["--check"], { BUNDLE_WASM_SRC: tmp, BUNDLE_WASM_RERECORD: "1" });
  assert.notEqual(r.code, 0, `RERECORD waved through a test-clock build:\n${r.out}`);
  assert.match(r.out, /set_day_len_ns/);
});

test("RERECORD with no drift at all is a no-op, not a free pass", () => {
  // With provenance already correct there is nothing to re-record. The flag
  // must not change the verdict or claim it did something.
  const r = runBundle(["--check"], { BUNDLE_WASM_RERECORD: "1" });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /re-recording provenance/i);
});

test("the shipped artifact is never modified by any of this", () => {
  // bundle-wasm has previously replaced the tracked binary as a side effect of
  // a test run; --check exists because of it. Re-assert it here, since these
  // tests deliberately corrupt provenance and run the real script.
  const before = readFileSync(SHIPPED);
  withDriftedProvenance((prov) => runBundle(["--check"], { BUNDLE_WASM_RERECORD: "1", BUNDLE_WASM_PROVENANCE: prov }));
  assert.ok(before.equals(readFileSync(SHIPPED)), "res/vault.wasm was modified by a --check run");
});
