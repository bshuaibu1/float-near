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
      repointCredential: op("repointCredential"),
    },
  };
}

const ROTATE = { action: "rotate", steps: ["add-owner", "remove-setup"] };

test("EXECUTED ORDER: the owner key is added before the setup key is removed", async () => {
  const r = recorder();
  await applyRotation(ROTATE, r.ops);
  assert.deepEqual(r.calls, ["addOwnerKey", "removeSetupKey", "repointCredential"]);
});

test("EXECUTED ORDER: the credential file goes last, after the chain has agreed", async () => {
  const r = recorder();
  await applyRotation(ROTATE, r.ops);
  assert.equal(r.calls.at(-1), "repointCredential");
});

test("a failed key REMOVAL leaves the credential file alone", async () => {
  // The recovery property, and the reason the file is touched LAST.
  //
  // If remove-setup failed, the file still holds the setup key — the only copy
  // of the only key that can finish the job on a re-run. Repointing it to the
  // owner here would be worse than deleting it: the next run would compute the
  // setup public key FROM that file, see it equal to the owner's, conclude the
  // rotation is already done, and leave a live full-access key on the vault
  // that nobody holds and no run will ever remove.
  const r = recorder({ failOn: "removeSetupKey" });
  await assert.rejects(() => applyRotation(ROTATE, r.ops), /removeSetupKey failed/);
  assert.deepEqual(r.calls, ["addOwnerKey", "removeSetupKey"]);
  assert.ok(!r.calls.includes("repointCredential"), "credential rewritten after a failed rotation");
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

// ---- the credential file is REPOINTED, not deleted
//
// THE PROTOCOL FACT THIS ALL RESTS ON. A DeployContract action applies to the
// SIGNER's own account, so a deploy transaction's signer_id must equal its
// receiver_id. There is therefore no way to upgrade the vault signed as the
// owner account: the only key that can ever deploy to `vault.owner.near` is a
// full-access key sitting ON `vault.owner.near`.
//
// near-cli-rs's legacy keychain finds that key by filename —
// ~/.near-credentials/<network>/<ACCOUNT>.json — and `near contract deploy
// <vault> ... sign-with-legacy-keychain` therefore reads the file named after
// the VAULT. So after rotation that file must contain the OWNER's keypair under
// the VAULT's account_id. Duplicating the secret is not a shortcut; it is the
// only representation near-cli can use.
//
// MEASURED 2026-10-31, the cost of getting this wrong: the mainnet upgrade of
// float.test015.near failed three times signing with ed25519:Bb9qZA8..., the
// DEAD setup key, still sitting in float.test015.near.json after a hand
// rotation removed it from the account. I had called that file "inert". It is
// not inert — it is exactly how near-cli chooses the signing key. The fix was
// to rewrite it with the owner's key, which is what this function now does
// automatically.
//
// Deleting the file instead (what the wizard used to do) fails differently and
// just as fatally: near-cli reports no key for the vault and the upgrade path
// is dead until someone reconstructs the file by hand.

import { repointedCredential } from "../bin/rotate-key.mjs";

const VAULT = "v1.alice.near";
const OWNER_SK = "ed25519:ownerSecretKeyZZZ";

test("the repointed file is named for the VAULT and carries the OWNER's key", () => {
  const c = repointedCredential({
    vault: VAULT,
    ownerPublicKey: OWNER,
    ownerPrivateKey: OWNER_SK,
  });
  // account_id is the vault, NOT the owner. A deploy's signer must equal its
  // receiver, so a file claiming the owner's account_id would be useless here.
  assert.equal(c.account_id, VAULT);
  assert.equal(c.public_key, OWNER);
  assert.equal(c.private_key, OWNER_SK);
});

test("the repointed file carries exactly the three fields near-cli reads", () => {
  // Extra fields are not harmless: near-cli-rs deserialises this file, and the
  // setup key must not survive anywhere inside it.
  const c = repointedCredential({ vault: VAULT, ownerPublicKey: OWNER, ownerPrivateKey: OWNER_SK });
  assert.deepEqual(Object.keys(c).sort(), ["account_id", "private_key", "public_key"]);
  assert.ok(!JSON.stringify(c).includes(SETUP), "the setup key survived into the repointed file");
});

test("a missing private key is refused rather than written as undefined", () => {
  // JSON.stringify drops an undefined value, so this would silently produce
  // {"account_id":...,"public_key":...} — a file near-cli reads as malformed,
  // at the end of a run that otherwise reported success.
  for (const sk of [undefined, null, ""]) {
    assert.throws(
      () => repointedCredential({ vault: VAULT, ownerPublicKey: OWNER, ownerPrivateKey: sk }),
      /private key/i,
      `accepted a ${JSON.stringify(sk)} private key`,
    );
  }
});

test("a missing vault or public key is refused too", () => {
  assert.throws(() => repointedCredential({ ownerPublicKey: OWNER, ownerPrivateKey: OWNER_SK }), /vault/i);
  assert.throws(() => repointedCredential({ vault: VAULT, ownerPrivateKey: OWNER_SK }), /public key/i);
});

test("WIRING: the wizard repoints the credential and never deletes it", () => {
  assert.ok(
    /repointedCredential/.test(code),
    "the wizard does not call repointedCredential — rotation would leave a dead credential file",
  );
  // Deliberately NOT /rmSync\(credPath\(vault\)\)/ — that was the first version
  // and it is the tdd-extras 7b trap: it matches one spelling of the construct
  // and silently passes on `rmSync(credPath(vault), { force: true })`,
  // `unlinkSync(credPath(vault))`, or any whitespace. The forms below are the
  // ones node's fs API actually offers for deleting a path.
  for (const re of [
    /(rmSync|unlinkSync|rm|unlink)\s*\(\s*credPath\s*\(\s*vault\s*\)/,
    /\brmSync\b/, // the import itself: nothing in this wizard should delete files
  ]) {
    assert.ok(
      !re.test(code),
      `the wizard still deletes the vault credential file (${re}), which breaks every later upgrade`,
    );
  }
});

// ---- the guard for a vault rotated BEFORE this fix existed
//
// float.test015.near was rotated by hand, so its credential file holds a key
// that is no longer on the account. Repointing on rotation does nothing for it.
// upgrade-vault.sh therefore checks the signing key against the account's live
// key list BEFORE spending minutes on a build — the three failed attempts on
// 2026-10-31 each died at the very last step, after a full cargo-near build.

import { signerVerdict } from "../bin/rotate-key.mjs";

test("a credential whose key IS full-access on the vault can deploy", () => {
  const v = signerVerdict({
    vault: VAULT,
    credential: { account_id: VAULT, public_key: OWNER, private_key: OWNER_SK },
    keys: [FA(OWNER)],
  });
  assert.equal(v.ok, true);
});

test("THE TRAP: a credential holding a key that is no longer on the account", () => {
  // Exactly float.test015.near after the hand rotation. The file is present and
  // well-formed, so every check short of comparing it against the live key list
  // passes, and near-cli fails at the signing step minutes later.
  const v = signerVerdict({
    vault: VAULT,
    credential: { account_id: VAULT, public_key: SETUP, private_key: "ed25519:deadSetupKey" },
    keys: [FA(OWNER)],
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no longer|not on/i);
  // The message must say which key and what to do, or it is just the near-cli
  // error again with extra steps.
  assert.ok(v.reason.includes(SETUP), "the verdict does not name the dead key");
  assert.match(v.fix, /rotate-key|credential|re-?point/i);
});

test("a FUNCTION-CALL key cannot deploy, and is reported as such", () => {
  // Distinct from the dead-key case: the key is live, it just cannot carry a
  // DeployContract action. Same near-cli failure, different fix.
  const v = signerVerdict({
    vault: VAULT,
    credential: { account_id: VAULT, public_key: OWNER, private_key: OWNER_SK },
    keys: [FC(OWNER)],
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /full-access/i);
});

test("a missing credential file is reported as missing, not as a dead key", () => {
  const v = signerVerdict({ vault: VAULT, credential: null, keys: [FA(OWNER)] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no credential|not found|missing/i);
});

test("a credential for a DIFFERENT account is caught before it is used", () => {
  // near-cli keys the file by filename, so a file for the owner dropped in as
  // the vault's would be used to sign and rejected on chain.
  const v = signerVerdict({
    vault: VAULT,
    credential: { account_id: "alice.near", public_key: OWNER, private_key: OWNER_SK },
    keys: [FA(OWNER)],
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /account_id|different account/i);
});

test("a credential with no private key is refused", () => {
  const v = signerVerdict({
    vault: VAULT,
    credential: { account_id: VAULT, public_key: OWNER },
    keys: [FA(OWNER)],
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /private key/i);
});

test("an empty key list is a dead-key verdict, never an ok one", () => {
  // viewAccessKeyList on a key-less account returns []. Defaulting that to ok
  // would send the deploy at the one account guaranteed to reject it.
  const v = signerVerdict({
    vault: VAULT,
    credential: { account_id: VAULT, public_key: OWNER, private_key: OWNER_SK },
    keys: [],
  });
  assert.equal(v.ok, false);
});
