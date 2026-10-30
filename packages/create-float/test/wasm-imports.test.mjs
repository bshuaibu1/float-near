import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { funcImports, importsHostFn } from "../scripts/wasm-imports.mjs";

/**
 * Does this wasm IMPORT a host function, as opposed to merely containing its
 * name somewhere in the bytes?
 *
 * The distinction decides whether a contract's 44 reason codes survive. Built
 * by cargo-near, `panic_str` calls `sys::panic_utf8` and a panic arrives as
 * "INVALID_CONFIG: label ...". Built by plain cargo, the local branch is
 * compiled instead and the same panic arrives as "WebAssembly trap: An
 * `unreachable` opcode was executed" — every reason code gone.
 *
 * MEASURED 2026-10-30 on this contract, after building both ways:
 *
 *   cargo near build      40 env imports, incl. panic_utf8 and sha256
 *   plain cargo build     38 env imports, panic_utf8 and sha256 ABSENT
 *
 * Two corrections to what the repo previously believed, both of which cost me
 * a wrong conclusion in this session:
 *
 *  1. `target/wasm32-unknown-unknown/release/vault.wasm` is NOT a plain-cargo
 *     artifact. It is cargo-near's own intermediate — cargo-near builds there
 *     first (with --cfg near) and then wasm-opts into target/near/vault/. Its
 *     import set is identical to the final one, so comparing those two paths
 *     "proves" the two build modes are the same. They are not; I had simply
 *     compared cargo-near against itself.
 *  2. A byte search for "panic_utf8" is NOT unreliable for this contract, as a
 *     comment claimed. The shipped wasm is wasm-opt-stripped and contains the
 *     string exactly ONCE, at the import-section entry itself, so grep and the
 *     import section agree. The grep is a proxy that happens to be exact here;
 *     the check below answers the question directly instead.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CARGO_NEAR_WASM = join(HERE, "..", "res", "vault.wasm");

/** A real cargo-near wasm with ONLY its import-section entry renamed. */
function withoutPanicImport() {
  const real = readFileSync(CARGO_NEAR_WASM);
  // The import entry is encoded `0x03 "env" 0x0a "panic_utf8"`. Searching for
  // that exact signature rather than the bare name means this edits the import
  // section and nothing else.
  const sig = Buffer.concat([
    Buffer.from([3]),
    Buffer.from("env"),
    Buffer.from([10]),
    Buffer.from("panic_utf8"),
  ]);
  const at = real.indexOf(sig);
  assert.notEqual(at, -1, "could not find the panic_utf8 import entry in res/vault.wasm");
  const out = Buffer.from(real);
  // Equal-length rename, so every later offset in the module stays valid.
  out.write("panic_utf7", at + sig.length - 10, "utf8");
  return out;
}

test("REAL DATA: the shipped contract imports 40 env functions including panic_utf8", () => {
  const imps = funcImports(readFileSync(CARGO_NEAR_WASM));
  const env = imps.filter((i) => i.module === "env");
  assert.equal(env.length, 40, `expected 40 env imports, got ${env.length}`);
  for (const fn of ["panic_utf8", "sha256"]) {
    assert.ok(
      env.some((i) => i.field === fn),
      `the shipped contract does not import ${fn}`,
    );
  }
});

test("importsHostFn is true for a function the module really imports", () => {
  assert.equal(importsHostFn(readFileSync(CARGO_NEAR_WASM), "panic_utf8"), true);
});

test("importsHostFn is false once the IMPORT is gone, on a real 278 KB module", () => {
  // The probe is a genuine cargo-near wasm with one import renamed, not a
  // hand-built toy — tdd-extras 7b.
  assert.equal(importsHostFn(withoutPanicImport(), "panic_utf8"), false);
});

/**
 * The same real module, still not importing panic_utf8, but CARRYING the name
 * in a custom section — where a name table or debug info would put it in a
 * build that kept them. Valid wasm; custom sections are ignored by runtimes.
 */
function carryingNameWithoutImport() {
  const base = withoutPanicImport();
  const name = Buffer.from(".debug_str");
  const payload = Buffer.from("panic_utf8");
  const content = Buffer.concat([Buffer.from([name.length]), name, payload]);
  return Buffer.concat([base, Buffer.from([0x00, content.length]), content]);
}

test("importsHostFn is false for a module that CARRIES the name without importing it", () => {
  // The ONLY input that tells "reads the import section" apart from "searches
  // the bytes", and the reason it is worth a test: every other probe in this
  // file has the name absent from the bytes too (withoutPanicImport renames it
  // to panic_utf7), so a byte search answers all of them correctly.
  //
  // MEASURED 2026-10-30: with importsHostFn changed to keep the parse but
  // return `buf.includes(field)`, the other 11 tests here stay GREEN. The
  // apparent catch is incidental — removing the importsHostFn CALL also removes
  // the parse, which fires the "cannot PARSE" test instead, so that one proves
  // the parse happens, not that the answer comes from the import section.
  const probe = carryingNameWithoutImport();
  assert.equal(probe.includes(Buffer.from("panic_utf8")), true, "probe lost the bytes");
  assert.equal(funcImports(probe).some((i) => i.field === "panic_utf8"), false, "probe imports it");
  assert.equal(importsHostFn(probe, "panic_utf8"), false);
});

test("REACHABILITY: bundle-wasm REFUSES a contract that only MENTIONS panic_utf8", () => {
  // And the same input through the real publish guard, so the call site is
  // pinned as well as the function.
  const tmp = join(mkdtempSync(join(tmpdir(), "float-mentions-")), "vault.wasm");
  writeFileSync(tmp, carryingNameWithoutImport());

  let code = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [join(HERE, "..", "scripts", "bundle-wasm.mjs"), "--check"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BUNDLE_WASM_SRC: tmp },
    });
  } catch (e) {
    code = e.status ?? 1;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  assert.notEqual(code, 0, `bundle-wasm accepted a wasm that only mentions panic_utf8:\n${output}`);
  assert.match(output, /does not import panic_utf8/, output);
});

test("importsHostFn is false for a host function no NEAR contract imports", () => {
  // Negative control: without this, a function hardcoded to return true would
  // pass both tests above.
  assert.equal(importsHostFn(readFileSync(CARGO_NEAR_WASM), "no_such_host_fn"), false);
});

test("a non-wasm buffer is rejected, not silently reported as importing nothing", () => {
  // "imports nothing" and "could not be parsed" must not look the same: the
  // first would make the publish guard pass garbage.
  assert.throws(() => funcImports(Buffer.from("not a wasm module at all")), /not wasm/);
});

// ---- the real defect
//
// scripts/wasm-imports.mjs ran its CLI at module scope and called
// process.exit(1) when argv was empty, so ANY consumer importing it was
// terminated. args.mjs carries a comment about this exact failure having
// happened before with parseArgs. Measured 2026-10-30: importing it printed
// "usage: ..." and exited 1.

test("REACHABILITY: the root CLI script can be IMPORTED without exiting", () => {
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", "await import('./scripts/wasm-imports.mjs'); console.log('SAFE');"],
    { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(out, /SAFE/);
  assert.doesNotMatch(out, /usage:/, "importing the module ran its CLI");
});

test("REACHABILITY: bundle-wasm REFUSES a contract that does not import panic_utf8", () => {
  // Drives the real publish guard, not the parser. Uses --check so nothing is
  // copied over the tracked res/vault.wasm, and BUNDLE_WASM_SRC to point it at
  // the doctored module.
  const tmp = join(mkdtempSync(join(tmpdir(), "float-nopanic-")), "vault.wasm");
  writeFileSync(tmp, withoutPanicImport());

  let code = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [join(HERE, "..", "scripts", "bundle-wasm.mjs"), "--check"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BUNDLE_WASM_SRC: tmp },
    });
  } catch (e) {
    code = e.status ?? 1;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.notEqual(code, 0, `bundle-wasm accepted a contract with no panic_utf8 import:\n${output}`);
  // Assert the SPECIFIC reason. The freshness checks can also fail a doctored
  // artifact, and "it refused" for the wrong reason would prove nothing.
  assert.match(output, /panic_utf8/);
  assert.match(output, /cargo near build/);
});

test("REACHABILITY: bundle-wasm ACCEPTS the real cargo-near contract", () => {
  const out = execFileSync(
    process.execPath,
    [join(HERE, "..", "scripts", "bundle-wasm.mjs"), "--check"],
    {
      cwd: join(HERE, ".."),
      encoding: "utf8",
      env: { ...process.env, BUNDLE_WASM_SRC: CARGO_NEAR_WASM },
    },
  );
  assert.match(out, /is current with/);
});

test("funcImports excludes imports that are not FUNCTIONS", () => {
  // Written while the mutation that removed the kind filter was still applied
  // (tdd-extras 7a). Dropping that filter survived every other test, because
  // all 40 of this contract's imports happen to be functions — so the filter
  // was asserted nowhere while a comment implied it mattered.
  //
  // It matters because a memory/global/table import can carry ANY name,
  // including a host function's. Without the filter, "does it import
  // panic_utf8" could be answered yes by a memory segment that merely shares
  // the name, and the publish guard would wave through a contract whose panics
  // are destroyed.
  const mod = Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d]), // magic
    Buffer.from([0x01, 0x00, 0x00, 0x00]), // version 1
    // type section: one type, () -> ()
    Buffer.from([0x01, 0x04, 0x01, 0x60, 0x00, 0x00]),
    // import section: a MEMORY import, then a FUNC import
    Buffer.from([0x02, 0x20, 0x02]),
    Buffer.from([0x03]), Buffer.from("env"), Buffer.from([0x06]), Buffer.from("memory"),
    Buffer.from([0x02, 0x00, 0x01]), // kind=memory, flags=0, min=1
    Buffer.from([0x03]), Buffer.from("env"), Buffer.from([0x0a]), Buffer.from("panic_utf8"),
    Buffer.from([0x00, 0x00]), // kind=func, typeidx=0
  ]);

  const funcs = funcImports(mod);
  assert.equal(funcs.length, 1, `expected 1 function import, got ${funcs.length}`);
  assert.equal(funcs[0].field, "panic_utf8");
  assert.ok(
    !funcs.some((i) => i.field === "memory"),
    "a memory import was reported as a function import",
  );
});

test("REACHABILITY: bundle-wasm refuses an artifact it cannot PARSE, with that reason", () => {
  // Also written against a live mutation: silencing the catch survived
  // everything, because the only parse-failure test drove the parser directly
  // and never the guard. "Could not be parsed" must not be reachable as
  // "imports nothing" — that is how garbage gets published.
  const tmp = join(mkdtempSync(join(tmpdir(), "float-garbage-")), "vault.wasm");
  writeFileSync(tmp, Buffer.from("this is definitely not a wasm module"));

  let code = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [join(HERE, "..", "scripts", "bundle-wasm.mjs"), "--check"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BUNDLE_WASM_SRC: tmp },
    });
  } catch (e) {
    code = e.status ?? 1;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.notEqual(code, 0, `bundle-wasm accepted a non-wasm file:\n${output}`);
  // The specific reason. A doctored file also trips the freshness checks, and
  // refusing for the wrong reason would leave this hole open.
  assert.match(output, /could not be parsed/);
});

test("REACHABILITY: the root CLI still works when RUN directly", () => {
  // The other half. Making the module importable by deleting its CLI would
  // satisfy the test above and break the tool.
  const out = execFileSync(process.execPath, ["scripts/wasm-imports.mjs", CARGO_NEAR_WASM], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.match(out, /function imports: 40/);
  assert.match(out, /panic_utf8/);
});
