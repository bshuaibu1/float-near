#!/usr/bin/env node
/**
 * Refuses an upgrade whose signing key cannot sign it.
 *
 * WHY THIS RUNS BEFORE THE BUILD. A DeployContract action applies to the
 * signer's own account, so a deploy transaction's signer_id must equal its
 * receiver_id — the vault can only ever be upgraded by a full-access key ON the
 * vault. near-cli-rs's legacy keychain finds that key by FILENAME, so
 * `near contract deploy <vault> ... sign-with-legacy-keychain` reads
 * ~/.near-credentials/<network>/<VAULT>.json and signs with whatever is in it.
 *
 * If that file holds a key the account no longer carries, everything looks fine
 * until the very last step. Measured 2026-10-31: the mainnet upgrade of
 * float.test015.near failed three times signing with ed25519:Bb9qZA8..., the
 * setup key a hand rotation had removed from the account and left on disk. Each
 * attempt paid a full cargo-near build first.
 *
 * So this check is cheap, it is decisive, and it goes first.
 *
 *   node scripts/check-signer-key.mjs <vault> <network> [rpcUrl]
 *
 * Exit 0 if the key can sign, 1 with the fix if it cannot, 2 on bad usage.
 *
 * ---- WHY main() RETURNS A CODE INSTEAD OF CALLING process.exit.
 *
 * The first version ended with `process.exit(0)` after the RPC read, exactly
 * like check-upgrade-margin.mjs does. It aborted every single time on
 * node 24.14 / Windows:
 *
 *   VERDICT  can sign a deploy to float.test015.near
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
 *   exit code -1073740791        (0xC0000409)
 *
 * process.exit tears the loop down while viewAccessKeyList's handle is still
 * closing. The verdict was CORRECT and printed; only the exit code was wrong —
 * and the caller is `if ! node scripts/check-signer-key.mjs`, which reads any
 * non-zero as "cannot sign". A guard that always refuses is as broken as no
 * guard, and it would have refused with a green message on screen.
 *
 * Setting process.exitCode lets the loop drain on its own.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import { signerVerdict } from "../packages/create-float/bin/rotate-key.mjs";

async function main([vault, network, rpc]) {
  if (!vault || !network) {
    console.error("usage: node scripts/check-signer-key.mjs <vault> <network> [rpc]");
    return 2;
  }

  const credDir = process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials");
  const credFile = join(credDir, network, `${vault}.json`);

  // Read as a file, not as a shape we assume. Malformed JSON is a distinct
  // failure from a dead key and must not be reported as one.
  let credential = null;
  if (existsSync(credFile)) {
    try {
      credential = JSON.parse(readFileSync(credFile, "utf8"));
    } catch (e) {
      console.error(`  FATAL  ${credFile} is not valid JSON: ${e.message}`);
      return 1;
    }
  }

  const url =
    rpc ?? (network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
  const p = new JsonRpcProvider({ url });

  // The LIVE key list is the only thing that settles this. The credential file
  // is present and well-formed in the failure case, so every cheaper check
  // passes and near-cli fails minutes later at the signing step.
  let keys = [];
  try {
    ({ keys } = await p.viewAccessKeyList({ accountId: vault }));
  } catch (e) {
    console.error(`  FATAL  could not read the key list for ${vault}: ${e.message}`);
    return 1;
  }

  const v = signerVerdict({ vault, credential, keys });

  console.log(`  credential      ${existsSync(credFile) ? credFile : `(absent) ${credFile}`}`);
  console.log(`  signer key      ${credential?.public_key ?? "(none)"}`);
  console.log(`  keys on account ${keys.length}`);
  for (const k of keys) {
    const full = k.access_key?.permission === "FullAccess";
    console.log(`    ${full ? "FULL" : "fn  "}  ${k.public_key}`);
  }

  if (v.ok) {
    console.log(`  VERDICT         can sign a deploy to ${vault}`);
    return 0;
  }
  console.error("");
  console.error("  VERDICT         CANNOT SIGN A DEPLOY");
  console.error(`  ${v.reason}`);
  console.error("");
  console.error(`  ${v.fix}`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
