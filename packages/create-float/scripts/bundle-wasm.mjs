#!/usr/bin/env node
/**
 * Copies the cargo-near contract into res/ so the published package carries it.
 *
 * This exists so that INSTALLING create-float does not require a Rust
 * toolchain. Without it, every user would need `cargo install cargo-near`
 * (which itself needs NASM on Windows) before they could create a wallet —
 * a build dependency has no business in a product's install path.
 *
 * Run by `prepack`, so `npm publish` cannot ship a package without a contract.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freshnessProblems, compiledSources, sourcesDigest } from "./freshness.mjs";
import { importsHostFn } from "./wasm-imports.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
// Overridable so a caller can vet an artifact built somewhere else — a CI
// job with its own target dir, or a release candidate downloaded to be checked
// before it is trusted. The default is the local cargo-near output.
const SRC = process.env.BUNDLE_WASM_SRC
  ? resolve(process.env.BUNDLE_WASM_SRC)
  : resolve(PKG, "..", "..", "target", "near", "vault", "vault.wasm");
const DEST_DIR = join(PKG, "res");
const DEST = join(DEST_DIR, "vault.wasm");

if (!existsSync(SRC)) {
  console.error(
    [
      `bundle-wasm: no contract at ${SRC}`,
      "",
      "Build it first, from the crate directory:",
      "  cd contracts/vault && cargo near build non-reproducible-wasm --no-abi",
      "",
      "--no-abi is required on Windows: the ABI pass builds the contract as a",
      "native DLL, where near-sdk's host functions have no implementation.",
    ].join("\n"),
  );
  process.exit(1);
}

// ---- interrogate the artifact BEFORE shipping it, not after.
//
// deploy-testnet.sh does this for what it deploys, reading clock_mode back off
// chain rather than trusting the build flags. The same reasoning applies here
// and was missing: this script would have copied ANY wasm at that path into a
// published package.
//
// Two things make that a real hazard rather than a theoretical one.
// scripts/build-wasm.sh deliberately builds the vault WITH --features
// test-clock, and a test-clock contract exposes set_day_len_ns, which lets the
// owner shrink the budget window to 100ms — a one-second "day" refills a daily
// cap a thousand times an hour. And a plain `cargo build` produces a wasm that
// runs but loses every panic message, destroying this contract's reason codes.
// Both are silent: the artifact works, and the damage shows up later.
const srcBytes = readFileSync(SRC);
const fails = [];
if (srcBytes.includes(Buffer.from("set_day_len_ns"))) {
  fails.push(
    "it exposes set_day_len_ns, so it was built WITH --features test-clock. " +
      "That lets the owner shrink a 'day' to milliseconds. Rebuild with " +
      "--no-default-features.",
  );
}
// Read from the IMPORT SECTION, not from a byte search.
//
// Honesty about why: the byte search was NOT broken. Measured 2026-10-30, the
// shipped wasm is wasm-opt-stripped and contains "panic_utf8" exactly once --
// at the import entry itself -- so grep and the import section agreed, and a
// genuine plain-cargo build contains the string nowhere at all. This is an
// exactness change, not a bug fix: it asks the question the message claims to
// answer ("does it import") instead of a proxy that happened to be equivalent
// for this artifact. A future build that retains a name or debug section would
// break the proxy silently.
//
// A parse failure is its own failure, never "imports nothing" -- a guard that
// treated an unparseable file as importing nothing would wave garbage through.
try {
  if (!importsHostFn(srcBytes, "panic_utf8")) {
    fails.push(
      "it does not import panic_utf8, so it was NOT built by cargo-near. Every " +
        "panic would arrive as 'unreachable opcode' with the reason code gone -- " +
        "all 44 of this vault's reason codes become indistinguishable from a bug. " +
        "Use `cargo near build`, never plain `cargo build --target wasm32-...`. " +
        "MEASURED: cargo-near 40 env imports, plain cargo 38.",
    );
  }
} catch (e) {
  fails.push(`its import section could not be parsed (${e.message}), so it is not a usable contract.`);
}
// ---- and interrogate it against the SOURCE, not only against itself.
//
// Every check above asks "is this artifact well-formed". None asks "is this
// artifact CURRENT", which is how three generations of wasm came to be on disk
// at once on 2026-10-30 with nothing complaining:
//
//   res/vault.wasm   (what publishing ships)  : no NEAR_BUDGET, no PARENT_COOLDOWN
//   target/.../wasm  (what this script copies) : NEAR_BUDGET,    no PARENT_COOLDOWN
//   contracts/vault/src/                       : both
//
// Publishing then hands real users a vault with no NEAR spending ceiling and a
// cooldown that ignores ancestors, and says `Done.` A stale artifact is worse
// than a missing one: a missing one stops you.
const SRC_DIR = resolve(PKG, "..", "..", "contracts", "vault", "src");
// Only files that can actually reach the artifact. tests.rs is
// `#[cfg(test)] mod tests;` and never compiles into the contract, so editing a
// unit test used to report "the contract is STALE" and recommend a rebuild that
// changes nothing — a guard that cries wolf is one people learn to override.
const compiled = compiledSources({
  files: readdirSync(SRC_DIR).filter((f) => f.endsWith(".rs")),
  libSrc: readFileSync(join(SRC_DIR, "lib.rs"), "utf8"),
});
const sourceFiles = compiled.map((f) => ({
  path: `contracts/vault/src/${f}`,
  mtimeMs: statSync(join(SRC_DIR, f)).mtimeMs,
}));

// The provenance record, keyed by the ARTIFACT's own hash.
//
// `res/vault.sources.json` says "this exact binary was built from these exact
// source bytes". Keyed by artifact sha256 so a check against any wasm can tell
// whether THAT one is current, rather than assuming the record describes
// whatever is being inspected.
//
// This is what lets the mtime check be superseded. mtime gets stuck: a mutation
// pass that writes a file and reverts it leaves identical content with a newer
// timestamp, and `cargo near build` is content-addressed so the rebuild it
// demands is a no-op that cannot move the artifact's mtime.
// Overridable for the same reason BUNDLE_WASM_SRC is: so a check can run
// against a record other than the tracked one.
//
// Without this seam, a test exercising digest drift has to corrupt
// `res/vault.sources.json` IN PLACE — and node:test runs test FILES in
// parallel, so freshness.test.mjs read that corruption mid-flight and failed.
// A test that can only be written by mutating shared state is telling you the
// module needs a seam, not that the test needs a lock.
const PROVENANCE = process.env.BUNDLE_WASM_PROVENANCE
  ? resolve(process.env.BUNDLE_WASM_PROVENANCE)
  : join(DEST_DIR, "vault.sources.json");
const currentDigest = sourcesDigest(
  compiled.map((f) => ({ path: f, content: readFileSync(join(SRC_DIR, f), "utf8") })),
);
const srcSha = createHash("sha256").update(srcBytes).digest("hex");
let recordedDigest;
if (existsSync(PROVENANCE)) {
  try {
    const rec = JSON.parse(readFileSync(PROVENANCE, "utf8"));
    // Only trust it if it describes THIS artifact.
    if (rec.artifactSha256 === srcSha) recordedDigest = rec.sourcesDigest;
  } catch {
    // A corrupt record is no record. Falls back to mtime rather than throwing.
  }
}

const freshness = freshnessProblems({
  typesSrc: readFileSync(join(SRC_DIR, "types.rs"), "utf8"),
  wasmBytes: srcBytes,
  wasmMtimeMs: statSync(SRC).mtimeMs,
  sources: sourceFiles,
  recordedDigest,
  currentDigest,
});

/**
 * A DIGEST MISMATCH THAT A REBUILD CANNOT CLEAR.
 *
 * The provenance record is trusted whenever `artifactSha256` matches the wasm
 * on disk. That reads like "this record describes how this artifact was
 * built", but it does not: `cargo near build` is content-addressed, so TWO
 * DIFFERENT SOURCE TREES CAN PRODUCE IDENTICAL BYTES. Change a comment, a doc
 * string, or any code that does not alter codegen, and you get the same wasm
 * from different sources.
 *
 * Then: the digest mismatches, the artifact hash still matches the record, so
 * the stale digest stays trusted — and the printed remedy, "rebuild", produces
 * the same bytes and changes nothing. The guard is red forever with no action
 * available to clear it.
 *
 * Measured 2026-11-07. `res/vault.wasm` and a fresh build were both
 * `003568bcea22be80…`, 298,819 bytes, byte-identical — while the recorded
 * digest said `b044ad32d3fe…` and the sources said `8c1970e25f3f…`. Two tests
 * were red and `prepack` refused, blocking the release of a `float-exit` fix
 * that tells users their money is recoverable. The binary was never wrong.
 *
 * This is the SECOND time this guard has had a no-remedy state: freshness.mjs
 * records the first, where a reverted mutation left identical content with a
 * newer mtime, and the digest was introduced to fix it. The lesson it wrote
 * down then applies now — "a check that cries wolf is a check people learn to
 * override, and then it is not protecting the publish any more."
 *
 * The fix is NOT to fall back to mtime. A fresh clone equalises every mtime,
 * so mtime would wave a genuinely stale artifact through — that is exactly
 * what the digest exists to catch, and freshness.test.mjs pins it.
 *
 * The fix is to make the real remedy reachable and EXPLICIT. When the ONLY
 * complaint is the digest, the artifact has already passed every content check
 * above — it answers every reason code the source defines, it is not a
 * test-clock build, and it imports panic_utf8. An operator who has just
 * rebuilt and sees identical bytes knows the record is merely out of date, and
 * can say so once, on purpose, in a way that greps.
 */
const onlyDigestDrift =
  freshness.length === 1 && /built from different source/i.test(freshness[0]);
const RERECORD = process.env.BUNDLE_WASM_RERECORD === "1";

if (onlyDigestDrift && RERECORD) {
  // `recordedDigest ?? ""` is not defensive noise. A mutation widening
  // `onlyDigestDrift` ran this branch with recordedDigest UNDEFINED, where
  // `.slice()` THROWS — and the crash swallowed the real refusal (a
  // test-clock artifact), so the script exited non-zero with the actual
  // reason never printed. A guard that fails for the wrong reason teaches
  // the operator the wrong fix, which is this file's recurring theme.
  const was = (recordedDigest ?? "").slice(0, 12) || "nothing recorded";
  console.log(
    `bundle-wasm: re-recording provenance (BUNDLE_WASM_RERECORD=1)\n` +
      `  artifact unchanged at ${srcSha.slice(0, 16)}…, sources moved ` +
      `${was}… -> ${currentDigest.slice(0, 12)}…\n` +
      `  Every content check passed, so the source change did not reach codegen.`,
  );
} else {
  for (const p of freshness) {
    fails.push(
      onlyDigestDrift
        ? `${p}\n` +
          "    Every CONTENT check passed, so this artifact is not provably stale:\n" +
          "    the sources moved without changing the compiled output, which a\n" +
          "    rebuild cannot fix — it produces the same bytes and the same record.\n" +
          "    Rebuild first to confirm the bytes really are unchanged:\n" +
          "      cd contracts/vault && cargo near build non-reproducible-wasm --no-abi\n" +
          "    then, if the artifact hash did NOT move, re-record provenance:\n" +
          "      BUNDLE_WASM_RERECORD=1 node scripts/bundle-wasm.mjs"
        : `${p}\n    The contract is STALE. Rebuild it before publishing:\n` +
          "      cd contracts/vault && cargo near build non-reproducible-wasm --no-abi",
    );
  }
}

if (fails.length) {
  console.error(
    [`bundle-wasm: REFUSING to ship ${SRC}`, "", ...fails.map((f) => `  - ${f}`)].join("\n"),
  );
  process.exit(1);
}

// `--check` validates without copying, so CI (and this package's own test
// suite) can assert the guard is wired without writing a tracked binary as a
// side effect. The first version of the reachability test did exactly that: it
// ran this script, the copy succeeded, and res/vault.wasm was silently replaced
// by a test run.
if (process.argv.includes("--check")) {
  console.log(`bundle-wasm: ${SRC} is current with contracts/vault/src`);
  process.exit(0);
}

// `--assert-current` is `--check` plus the question --check never asks: is the
// file we are about to SHIP the same as the one we just vetted?
//
// This is what `prepack` runs now. It used to run the copying form below, which
// meant `npm publish` SILENTLY REPLACED res/vault.wasm with whatever happened
// to be sitting in target/ — a tracked binary, rewritten as a side effect of
// publishing. The comment above records that exact replacement having already
// happened once, from a test run.
//
// It matters more now than it did then: the bytes in res/vault.wasm are the
// bytes deployed and validated on MAINNET (code hash
// 2CwvTaM6p2kXJLzZioFZwRVGj61B8KefS2EYCFmQznqD). "What we published is what we
// validated" is only true if publishing cannot quietly change it, and
// `cargo near build non-reproducible-wasm` does not promise the same bytes back
// from a rebuild.
//
// --check alone does NOT close this. It vets SRC against the sources and exits
// without ever comparing SRC to DEST, so a STALE committed artifact would ship
// unnoticed. Both directions are failures, so both are named here.
//
// Updating the artifact stays explicit: `npm run bundle-wasm`, then commit the
// new binary and its provenance.
if (process.argv.includes("--assert-current")) {
  const h = (b) => createHash("sha256").update(b).digest("hex");
  if (!existsSync(DEST)) {
    console.error(`bundle-wasm: ${DEST} is missing — run 'npm run bundle-wasm' and commit it`);
    process.exit(1);
  }
  const srcBytes = readFileSync(SRC);
  const destBytes = readFileSync(DEST);
  if (!srcBytes.equals(destBytes)) {
    console.error(
      [
        "bundle-wasm: REFUSING to publish — the shipped artifact is not the built one.",
        "",
        `  built   ${SRC}`,
        `          ${h(srcBytes)}  ${srcBytes.length} bytes`,
        `  shipped ${DEST}`,
        `          ${h(destBytes)}  ${destBytes.length} bytes`,
        "",
        "  Publishing used to overwrite the shipped file here, silently. It does",
        "  not any more, because those bytes are the ones running on mainnet.",
        "",
        "  If the BUILD is what you want: npm run bundle-wasm, then commit",
        "  res/vault.wasm and res/vault.sources.json.",
        "  If the SHIPPED file is what you want: rebuild from the matching source,",
        "  or publish from a clean checkout.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`bundle-wasm: shipped artifact matches the build (sha256 ${h(destBytes).slice(0, 16)}…)`);
  process.exit(0);
}

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SRC, DEST);

const bytes = readFileSync(DEST);
const sha = createHash("sha256").update(bytes).digest("hex");

// Record provenance for what we just shipped, so the next --check can answer
// "built from these bytes?" directly instead of inferring it from timestamps.
writeFileSync(
  PROVENANCE,
  JSON.stringify(
    {
      artifactSha256: sha,
      sourcesDigest: currentDigest,
      sources: compiled,
      note: "Written by bundle-wasm.mjs. Lets the freshness guard answer 'was this artifact built from these sources' without relying on mtime, which gets stuck when content is reverted and is meaningless after a fresh clone.",
    },
    null,
    2,
  ) + "\n",
);

// The same storage figure the wizard quotes, derived here rather than hardcoded
// so it cannot drift from the artifact actually being shipped.
const stakeNear = (statSync(DEST).size * 1e19) / 1e24;

console.log(`bundle-wasm: ${(bytes.length / 1024).toFixed(1)} KB -> res/vault.wasm`);
console.log(`  sha256        ${sha}`);
console.log(`  storage stake ${stakeNear.toFixed(3)} NEAR per deployment`);
