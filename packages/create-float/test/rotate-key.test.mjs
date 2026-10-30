import { test } from "node:test";
import assert from "node:assert/strict";

import { rotationPlan } from "../bin/rotate-key.mjs";

/**
 * Rotating the vault's full-access key to the owner's public key.
 *
 * WHY THIS EXISTS. create-float generated a full-access key FOR THE VAULT
 * ACCOUNT and wrote it to ~/.near-credentials, where it stayed forever. That
 * key is strictly more powerful than the owner key: a full-access key on the
 * vault can issue a FunctionCall AS the vault, including calling the token's
 * own `ft_transfer` directly —
 *
 *     usdc.ft_transfer(attacker, <entire balance>)
 *
 * — with no contract logic involved, which bypasses every cap, the recipient
 * allowlist, the cooldowns, the NEAR ceiling and the pause switch. It can also
 * DeployContract to replace the contract outright, or DeleteAccount.
 *
 * So the repo's central claim — "a function-call key cannot attach a deposit,
 * so every movement of value is contract logic" — was false while that key
 * existed on disk.
 *
 * THE FIX is not to delete it (that would make the contract permanently
 * un-upgradeable, premature while fixes are still pending) but to hand it to
 * the owner's wallet: add the owner's public key as full-access, then remove
 * the generated one. The vault stays upgradeable, and "protect the owner's
 * wallet" becomes the only thing a user must do.
 *
 * ORDERING IS THE WHOLE SAFETY PROPERTY. near-api-js sends addFullAccessKey
 * and deleteKey as SEPARATE transactions, so there is no atomicity to lean on:
 *
 *   add then delete : a failure between them leaves BOTH keys — today's state
 *                     plus one. Re-running completes it. Safe.
 *   delete then add : a failure between them leaves NO full-access key on the
 *                     vault. The contract keeps running but can never be
 *                     upgraded again, and nothing can restore it.
 *
 * One direction is recoverable and the other is permanent, so the planner is
 * built so it cannot express the permanent one.
 */

const FA = (pk) => ({ public_key: pk, access_key: { permission: "FullAccess" } });
const FC = (pk) => ({
  public_key: pk,
  access_key: { permission: { FunctionCall: { receiver_id: "x", method_names: [] } } },
});

const OWNER = "ed25519:ownerKeyAAA";
const SETUP = "ed25519:setupKeyBBB";

test("a fresh vault still holding the setup key is rotated: add THEN remove", () => {
  const p = rotationPlan({ keys: [FA(SETUP)], ownerPublicKey: OWNER, setupPublicKey: SETUP });
  assert.equal(p.action, "rotate");
  assert.deepEqual(p.steps, ["add-owner", "remove-setup"]);
});

test("the owner key is ALWAYS added before the setup key is removed", () => {
  // The invariant, asserted on the sequence itself rather than on a comment.
  for (const keys of [[FA(SETUP)], [FA(SETUP), FA(OWNER)], [FA(SETUP), FC(OWNER)]]) {
    const p = rotationPlan({ keys, ownerPublicKey: OWNER, setupPublicKey: SETUP });
    if (p.action !== "rotate") continue;
    const add = p.steps.indexOf("add-owner");
    const rm = p.steps.indexOf("remove-setup");
    if (rm >= 0 && add >= 0) assert.ok(add < rm, `remove before add for keys ${JSON.stringify(keys)}`);
  }
});

test("a half-finished rotation is completed, not restarted", () => {
  // add-owner landed, remove-setup did not. Re-running must only remove.
  const p = rotationPlan({ keys: [FA(SETUP), FA(OWNER)], ownerPublicKey: OWNER, setupPublicKey: SETUP });
  assert.equal(p.action, "rotate");
  assert.deepEqual(p.steps, ["remove-setup"]);
});

test("an already-rotated vault is left alone — the wizard is resumable", () => {
  const p = rotationPlan({ keys: [FA(OWNER)], ownerPublicKey: OWNER, setupPublicKey: SETUP });
  assert.equal(p.action, "done");
});

test("NEVER removes the setup key when the owner has no FULL-ACCESS key", () => {
  // The catastrophic case. A FunctionCall key for the owner is not enough: it
  // cannot DeployContract, so removing the setup key would strand the vault.
  const p = rotationPlan({ keys: [FA(SETUP), FC(OWNER)], ownerPublicKey: OWNER, setupPublicKey: SETUP });
  assert.equal(p.action, "rotate");
  assert.equal(p.steps[0], "add-owner", "must add a real full-access key first");
  assert.deepEqual(p.steps, ["add-owner", "remove-setup"]);
});

test("refuses to act when it controls no full-access key at all", () => {
  // Nothing to sign with, so proposing a change would just fail on chain —
  // better to say so than to attempt it.
  const p = rotationPlan({ keys: [FC(OWNER)], ownerPublicKey: OWNER, setupPublicKey: SETUP });
  assert.equal(p.action, "blocked");
  assert.match(p.reason, /full-access/i);
});

test("an empty key list is blocked, not treated as already-done", () => {
  // "No keys" and "rotation complete" must never look the same: the first means
  // the vault is already un-upgradeable and the user needs to know.
  const p = rotationPlan({ keys: [], ownerPublicKey: OWNER, setupPublicKey: SETUP });
  assert.equal(p.action, "blocked");
});

test("other keys on the account are never touched", () => {
  // A vault may legitimately carry extra keys the operator added. Rotation is
  // about two specific ones.
  const other = "ed25519:someoneElseCCC";
  const p = rotationPlan({
    keys: [FA(SETUP), FA(other)],
    ownerPublicKey: OWNER,
    setupPublicKey: SETUP,
  });
  assert.deepEqual(p.steps, ["add-owner", "remove-setup"]);
  assert.ok(!JSON.stringify(p).includes(other), "plan mentions a key it has no business touching");
});

test("owner and setup being the SAME key is already done, and never removed", () => {
  // Degenerate but reachable if someone passes --owner's key as the setup key.
  // Removing it would strand the vault while looking like a successful tidy-up.
  const p = rotationPlan({ keys: [FA(OWNER)], ownerPublicKey: OWNER, setupPublicKey: OWNER });
  assert.equal(p.action, "done");
});

// ---- wiring (tdd-extras Rule 5), with its limitation stated
//
// Every test above constructs rotationPlan itself, so none can see whether the
// wizard CALLS it — short-circuiting the call survived the whole suite. Driving
// main() to step 9 requires creating accounts and spending NEAR, so this is a
// STRUCTURAL proxy: weaker than running it, strictly better than nothing.
//
// The second test here is the one the planner cannot give me. A correct planner
// is useless if the CALL SITE sends deleteKey first, and that ordering is the
// difference between a recoverable failure and a permanently un-upgradeable
// vault.

import { readFileSync as rf } from "node:fs";
import { join as j } from "node:path";

const WIZARD = rf(j(import.meta.dirname, "..", "bin", "create-float.mjs"), "utf8");
const code = WIZARD.split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

test("WIRING: the wizard imports and calls rotationPlan", () => {
  assert.match(code, /import \{[^}]*rotationPlan[^}]*\} from "\.\/rotate-key\.mjs"/);
  assert.match(code, /rotationPlan\(\{\s*keys/, "the wizard does not call rotationPlan");
});


// ---- the order, EXECUTED rather than read
//
// Replaces two structural tests a mutation pass exposed as worthless:
// short-circuiting the planner left the call TEXT intact and survived, while
// swapping two behaviour-neutral if/else branches failed. A false negative and
// a false positive out of the same technique.
//
// These drive applyRotation with recording stubs, so the assertion is about
// what actually happens, in what sequence, and what is skipped on failure.

import { applyRotation } from "../bin/rotate-key.mjs";

function recorder({ failOn } = {}) {
  const calls = [];
  const op = (name) => async () => {
    calls.push(name);
    if (failOn === name) throw new Error(`${name} failed`);
  };
  return {
    calls,
    ops: {
      addOwnerKey: op("addOwnerKey"),
      removeSetupKey: op("removeSetupKey"),
      removeCredential: op("removeCredential"),
    },
  };
}

const ROTATE = { action: "rotate", steps: ["add-owner", "remove-setup"] };

test("EXECUTED ORDER: the owner key is added before the setup key is removed", async () => {
  const r = recorder();
  await applyRotation(ROTATE, r.ops);
  assert.deepEqual(r.calls, ["addOwnerKey", "removeSetupKey", "removeCredential"]);
});

test("EXECUTED ORDER: the credential file goes last, after the chain has agreed", async () => {
  const r = recorder();
  await applyRotation(ROTATE, r.ops);
  assert.equal(r.calls.at(-1), "removeCredential");
});

test("a failed key REMOVAL leaves the credential file alone", async () => {
  // The recovery property. Delete the file after a failed removal and the vault
  // keeps a full-access key nobody holds a copy of, which no re-run can remove.
  const r = recorder({ failOn: "removeSetupKey" });
  await assert.rejects(() => applyRotation(ROTATE, r.ops), /removeSetupKey failed/);
  assert.deepEqual(r.calls, ["addOwnerKey", "removeSetupKey"]);
  assert.ok(!r.calls.includes("removeCredential"), "credential deleted after a failed rotation");
});

test("a failed ADD stops before any removal is attempted", async () => {
  const r = recorder({ failOn: "addOwnerKey" });
  await assert.rejects(() => applyRotation(ROTATE, r.ops));
  assert.deepEqual(r.calls, ["addOwnerKey"]);
});

test("a non-rotate plan touches nothing at all", async () => {
  for (const plan of [{ action: "done" }, { action: "blocked", reason: "x" }]) {
    const r = recorder();
    assert.deepEqual(await applyRotation(plan, r.ops), []);
    assert.deepEqual(r.calls, []);
  }
});
