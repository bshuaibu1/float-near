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
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const SRC = resolve(PKG, "..", "..", "target", "near", "vault", "vault.wasm");
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
if (fails.length) {
  console.error(
    [`bundle-wasm: REFUSING to ship ${SRC}`, "", ...fails.map((f) => `  - ${f}`)].join("\n"),
  );
  process.exit(1);
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
