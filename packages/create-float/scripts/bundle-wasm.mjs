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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freshnessProblems } from "./freshness.mjs";

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
if (!srcBytes.includes(Buffer.from("panic_utf8"))) {
  fails.push(
    "it does not import panic_utf8, so it was NOT built by cargo-near. Every " +
      "panic would arrive as 'unreachable opcode' with the reason code gone. " +
      "Use `cargo near build`, never plain `cargo build --target wasm32-...`.",
  );
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
const sourceFiles = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith(".rs"))
  .map((f) => ({ path: `contracts/vault/src/${f}`, mtimeMs: statSync(join(SRC_DIR, f)).mtimeMs }));

for (const p of freshnessProblems({
  typesSrc: readFileSync(join(SRC_DIR, "types.rs"), "utf8"),
  wasmBytes: srcBytes,
  wasmMtimeMs: statSync(SRC).mtimeMs,
  sources: sourceFiles,
})) {
  fails.push(
    `${p}\n    The contract is STALE. Rebuild it before publishing:\n` +
      "      cd contracts/vault && cargo near build non-reproducible-wasm --no-abi",
  );
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

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SRC, DEST);

const bytes = readFileSync(DEST);
const sha = createHash("sha256").update(bytes).digest("hex");

// The same storage figure the wizard quotes, derived here rather than hardcoded
// so it cannot drift from the artifact actually being shipped.
const stakeNear = (statSync(DEST).size * 1e19) / 1e24;

console.log(`bundle-wasm: ${(bytes.length / 1024).toFixed(1)} KB -> res/vault.wasm`);
console.log(`  sha256        ${sha}`);
console.log(`  storage stake ${stakeNear.toFixed(3)} NEAR per deployment`);
