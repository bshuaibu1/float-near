#!/usr/bin/env node
/**
 * Is this code hash ALREADY a global contract on this network?
 *
 * Exit 0 = published, 1 = absent, 2 = usage error.
 *
 * WHY IT IS A FILE AND NOT A `node -e` ONE-LINER. It was inlined in
 * confirm-global-rate-mainnet.sh and used `process.exit()` after a `fetch`,
 * which on Windows tears down the event loop with a handle still closing:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
 *
 * It printed that during the real mainnet run. THIRD instance of this class in
 * this repo — check-signer-key.mjs, create-float's top-level catch (which
 * shipped as a 0.3.2 fix), and now the guard I had just finished arguing was
 * worth more than it looked.
 *
 * It was cosmetic there only by luck. The abort replaces the exit code with
 * -1073740791, and the caller is `if node ...`. For the ABSENT case both the
 * real code (1) and the native crash are non-zero, so the branch is the same.
 * For the PUBLISHED case the real code is 0 and the crash is not — so the
 * guard would have reported "not published" for a hash that WAS published,
 * republished it, measured ~nothing, and reported that as a REFUTATION of the
 * 10x rate. A guard that fails toward a false refutation is worse than absent.
 *
 * So: process.exitCode, and the loop drains on its own.
 */
const [hash, network = "mainnet"] = process.argv.slice(2);
const RPC =
  network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com";

if (!hash) {
  console.error("usage: global-is-published.mjs <code-hash-base58> [mainnet|testnet]");
  process.exitCode = 2;
} else {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "query",
      params: { request_type: "view_global_contract_code", finality: "final", code_hash: hash },
    }),
  });
  const j = await r.json();
  if (j.result) {
    const size = Buffer.from(j.result.code_base64, "base64").length;
    console.log(`published on ${network}: ${size} bytes`);
    process.exitCode = 0;
  } else {
    // Distinguish "genuinely absent" from "the query did not work", because
    // they are the same output to a caller that only reads the exit code.
    const name = j.error?.cause?.name ?? j.error?.name ?? "UNKNOWN";
    if (name !== "NO_GLOBAL_CONTRACT_CODE") {
      console.error(`UNEXPECTED RPC error (${name}) — cannot conclude absence`);
      console.error(JSON.stringify(j.error).slice(0, 300));
      process.exitCode = 2;
    } else {
      console.log(`absent on ${network}`);
      process.exitCode = 1;
    }
  }
}
