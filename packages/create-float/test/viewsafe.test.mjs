/**
 * Smoke test for the existence checks that make create-float resumable.
 *
 * Why this file exists. `viewSafe` swallows errors and returns null, which is
 * what lets the wizard ask "does this already exist?" without special-casing
 * every failure. That same swallowing makes a WRONG CALL look identical to an
 * honest "no". near-api-js's `callFunction` takes one object
 * ({contractId, method, args}); called positionally it throws a malformed-
 * request error, viewSafe turns that into null, every existence check answers
 * "nothing is there", and a second run rebuilds a tree that already exists.
 *
 * So the decisive assertion here is not that viewSafe works — it is that the
 * BROKEN call shape produces the same null the healthy one would produce on an
 * empty account. That is the trap, and it is only visible by contrast.
 *
 * Needs network. Skips rather than fails when offline, because a red test for
 * a flaky connection trains people to ignore red tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const LIVE_VAULT = process.env.NEAR_VAULT_CONTRACT ?? "v3.floatvault-12329.testnet";
const provider = new JsonRpcProvider({ url: RPC });

async function viewSafe(contractId, method, args = {}) {
  try {
    return await provider.callFunction({ contractId, method, args });
  } catch {
    return null;
  }
}

// Connectivity is probed at module load, with top-level await, NOT in a
// `before` hook. node:test evaluates a test's `skip` option when the test is
// DEFINED, which happens before any hook runs — so a hook-set flag leaves
// every test skipped, and the run reports "3 tests, 0 pass, 0 fail". That
// reads like success and means nothing executed. Caught exactly that way.
const online = await provider
  .callFunction({ contractId: LIVE_VAULT, method: "get_config", args: {} })
  .then(() => true)
  .catch(() => false);
if (!online) console.log(`# offline or ${LIVE_VAULT} unreachable — skipping network smoke tests`);

test("reads a live contract, so an existence check can answer yes", { skip: !online }, async () => {
  const cfg = await viewSafe(LIVE_VAULT, "get_config");
  assert.ok(cfg, "expected get_config to return data for a deployed vault");
  assert.equal(typeof cfg.owner, "string");
});

test("returns null for an account with no contract", { skip: !online }, async () => {
  // The honest "no". Must be distinguishable from the broken call below only
  // by the fact that the live contract answers.
  const cfg = await viewSafe("floatvault-12329.testnet", "get_config");
  assert.equal(cfg, null);
});

test("the WRONG argument shape is indistinguishable from 'nothing there'", { skip: !online }, async () => {
  // This is the regression. Positional arguments send a malformed request; the
  // catch turns it into null; the wizard concludes the vault is uninitialised
  // and tries to build everything a second time.
  const positional = await (async () => {
    try {
      return await provider.callFunction(LIVE_VAULT, "get_config", {});
    } catch {
      return null;
    }
  })();
  assert.equal(positional, null, "positional args should fail — that is the hazard");

  // And the proof that the correct shape is genuinely different.
  const correct = await viewSafe(LIVE_VAULT, "get_config");
  assert.ok(correct, "the object form must return data where the positional form returned null");
});
