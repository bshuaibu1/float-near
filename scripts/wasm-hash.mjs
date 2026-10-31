#!/usr/bin/env node
/**
 * A wasm's global-contract code hash: sha256, base58-encoded.
 *
 * Exists so measure-global-contract.sh can run unattended. Its first version
 * printed the two hashes and asked the operator to copy them into the B and D
 * deploys by hand, which meant the script never produced a result on its own.
 *
 * VERIFIED against the CLI rather than assumed: `near contract deploy-as-global`
 * reports its own "Wasm code hash", and for .demo/tiny.wasm this prints the
 * identical string (Dc2pgEiwZSBLYCrhMA41TJfJphDzzNHZKzordnLVemJv). That match
 * on a known case is what licenses trusting it on the padded one.
 */
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2";
import { base58 } from "@scure/base";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/wasm-hash.mjs <wasm>");
  process.exitCode = 2;
} else {
  console.log(base58.encode(sha256(new Uint8Array(readFileSync(file)))));
}
