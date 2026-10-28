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
