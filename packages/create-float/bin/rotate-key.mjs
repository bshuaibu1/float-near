/**
 * Hand the vault's full-access key to the owner's wallet.
 *
 * THE PROBLEM. create-float generated a full-access key FOR THE VAULT ACCOUNT
 * and wrote it to ~/.near-credentials, permanently. That key is strictly more
 * powerful than the owner key: a full-access key on the vault can issue a
 * FunctionCall AS the vault, including calling the token contract directly —
 *
 *     usdc.ft_transfer(attacker, <entire balance>)
 *
 * — with no vault logic involved, bypassing every cap, the recipient allowlist,
 * the cooldowns, the NEAR ceiling and the pause switch. It can also
 * DeployContract to replace the contract, or DeleteAccount outright.
 *
 * So this repo's central claim — "a function-call key cannot attach a deposit,
 * so every movement of value is contract logic" — was false while that key sat
 * on disk. Every security discussion was about the owner key and the agent
 * keys, while the most dangerous key in the system was disclosed in a single
 * `ok("key saved to ...")` line and framed as a convenience.
 *
 * THE FIX is not deletion. An account with no full-access key can never
 * DeployContract again, which would make the vault permanently un-upgradeable —
 * premature while fixes are still pending deployment. Instead the key is handed
 * to the owner: add the owner's public key as full-access, then remove the
 * generated one. Upgrades become a wallet signature, and "protect the owner's
 * wallet" becomes the only thing a user has to get right.
 *
 * ORDERING IS THE SAFETY PROPERTY, and there is no atomicity to lean on:
 * near-api-js sends addFullAccessKey and deleteKey as separate transactions.
 *
 *   add then delete : a failure in between leaves BOTH keys — today's state
 *                     plus one. A re-run completes it. Recoverable.
 *   delete then add : a failure in between leaves NO full-access key. The
 *                     contract keeps serving, but can never be upgraded, and
 *                     nothing on or off chain can restore it. Permanent.
 *
 * One direction is recoverable and the other is not, so this planner is built
 * so it cannot express the second one: "remove-setup" is only ever emitted
 * after the owner's full-access key is confirmed present or queued to be added.
 */

/** Is this entry a FULL-ACCESS key? `permission` is "FullAccess" or {FunctionCall}. */
function isFullAccess(entry) {
  return entry?.access_key?.permission === "FullAccess";
}

/**
 * What to do about the vault's keys.
 *
 * @param keys  getAccessKeyList().keys — [{ public_key, access_key:{permission} }]
 * @returns {{action:"rotate",steps:string[]}|{action:"done"}|{action:"blocked",reason:string}}
 */
export function rotationPlan({ keys, ownerPublicKey, setupPublicKey }) {
  const list = Array.isArray(keys) ? keys : [];

  const ownerHasFullAccess = list.some((k) => k.public_key === ownerPublicKey && isFullAccess(k));
  const setupPresent = list.some((k) => k.public_key === setupPublicKey);
  const setupIsFullAccess = list.some((k) => k.public_key === setupPublicKey && isFullAccess(k));

  // The owner's key IS the setup key. Removing it would strand the vault while
  // looking like a successful tidy-up, so there is nothing to do.
  if (ownerPublicKey === setupPublicKey) {
    return ownerHasFullAccess
      ? { action: "done" }
      : { action: "blocked", reason: "the owner key is not a full-access key on the vault" };
  }

  // Nothing to sign a change with. "No keys" must never be reported as
  // "already rotated": it means the vault is ALREADY un-upgradeable and the
  // user needs to be told, not reassured.
  if (!setupIsFullAccess && !ownerHasFullAccess) {
    return {
      action: "blocked",
      reason:
        "the vault has no full-access key this wizard controls, so its key cannot be rotated. " +
        "If the vault was created elsewhere, rotate it with whatever key does control it.",
    };
  }

  if (ownerHasFullAccess && !setupPresent) return { action: "done" };

  const steps = [];
  if (!ownerHasFullAccess) steps.push("add-owner");
  // Only reachable once the owner's key is present or queued above — which is
  // what makes the irrecoverable ordering unrepresentable.
  if (setupPresent) steps.push("remove-setup");

  return steps.length ? { action: "rotate", steps } : { action: "done" };
}

/**
 * Execute a plan, in order, through injected operations.
 *
 * Exists so the ORDER can be asserted at runtime rather than by reading the
 * source. A structural check on the call site proved worthless: a mutation that
 * short-circuited the planner left the call text intact and survived, while
 * swapping two behaviour-neutral if/else branches failed the test. One was a
 * false negative and the other a false positive, from the same technique.
 *
 * `repointCredential` runs ONLY after every on-chain step has resolved. If the
 * removal failed, the setup key file must survive untouched -- it is the only
 * thing that can finish the job on a re-run, and rewriting it there would be
 * worse than deleting it: the next run would derive the setup public key FROM
 * that file, find it equal to the owner's, conclude the rotation was already
 * done, and leave a live full-access key on the vault that nobody holds.
 */
export async function applyRotation(plan, ops) {
  const done = [];
  if (plan.action !== "rotate") return done;
  for (const s of plan.steps) {
    if (s === "add-owner") {
      await ops.addOwnerKey();
      done.push("add-owner");
    } else if (s === "remove-setup") {
      await ops.removeSetupKey();
      done.push("remove-setup");
    }
  }
  if (ops.repointCredential) {
    await ops.repointCredential();
    done.push("repoint-credential");
  }
  return done;
}

/**
 * The credential file to leave behind, pointing at the OWNER's key.
 *
 * THE PROTOCOL FACT. A DeployContract action applies to the signer's own
 * account, so a deploy transaction's signer_id must equal its receiver_id.
 * There is no way to upgrade `vault.owner.near` signed as `owner.near`: the
 * only key that can ever deploy to the vault is a full-access key sitting ON
 * the vault. After rotation that is the owner's key.
 *
 * near-cli-rs's legacy keychain finds a signing key by FILENAME —
 * ~/.near-credentials/<network>/<account>.json — so `near contract deploy
 * <vault> ... sign-with-legacy-keychain` reads the file named after the VAULT.
 * Hence the file keeps the vault's account_id and gains the owner's keypair.
 * Duplicating the secret is not a shortcut; it is the only representation
 * near-cli can use, and the secret already sits in the same directory under the
 * owner's own filename, so nothing new is exposed.
 *
 * WHAT THIS REPLACES, and what it cost. The wizard used to DELETE this file.
 * Done by hand on mainnet it is worse still: the file survives holding the key
 * that was just removed from the account. Measured 2026-10-31 — the mainnet
 * upgrade of float.test015.near failed three times signing with the dead
 * ed25519:Bb9qZA8..., after a full cargo-near build each time. That file had
 * been described as "inert"; it is in fact how near-cli picks the signer.
 */
export function repointedCredential({ vault, ownerPublicKey, ownerPrivateKey }) {
  if (!vault) throw new Error("repointedCredential needs the vault account id");
  if (!ownerPublicKey) throw new Error("repointedCredential needs the owner's public key");
  // Checked rather than trusted: JSON.stringify DROPS an undefined value, so a
  // missing secret would write {"account_id":...,"public_key":...} — a file
  // near-cli reads as malformed, at the end of a run that reported success.
  if (!ownerPrivateKey) throw new Error("repointedCredential needs the owner's private key");
  return { account_id: vault, public_key: ownerPublicKey, private_key: ownerPrivateKey };
}

/**
 * Can this credential file actually sign a deploy to this vault?
 *
 * Exists for the vaults rotated BEFORE repointedCredential did. Repointing on
 * rotation does nothing for an account someone rotated by hand, whose file
 * still holds a key that is no longer on it.
 *
 * Checked against the account's LIVE key list, which is the only thing that
 * settles it — the file is present and well-formed in the failure case, so
 * every cheaper check passes and near-cli fails at the signing step. Run this
 * BEFORE the build: the three failed attempts on 2026-10-31 each died at the
 * last step, after minutes of cargo-near.
 */
export function signerVerdict({ vault, credential, keys }) {
  const fix =
    `rotate-key / create-float now repoints this file automatically. To fix it by hand, write ` +
    `~/.near-credentials/<network>/${vault}.json as ` +
    `{"account_id":"${vault}","public_key":"<owner pk>","private_key":"<owner sk>"} ` +
    `using a key that IS full-access on ${vault}.`;
  const no = (reason) => ({ ok: false, reason, fix });

  if (!credential) return no(`no credential file for ${vault}`);
  if (credential.account_id && credential.account_id !== vault) {
    return no(`the credential file names account_id ${credential.account_id}, not ${vault}`);
  }
  const sk = credential.private_key ?? credential.secret_key;
  if (!sk) return no(`the credential file for ${vault} has no private key`);
  if (!credential.public_key) return no(`the credential file for ${vault} has no public key`);

  const list = Array.isArray(keys) ? keys : [];
  const entry = list.find((k) => k.public_key === credential.public_key);
  if (!entry) {
    return no(
      `the credential file's key ${credential.public_key} is no longer on ${vault} — ` +
        `it was removed from the account but left on disk, so every deploy will fail at signing`,
    );
  }
  if (!isFullAccess(entry)) {
    return no(
      `${credential.public_key} is on ${vault} but is not a full-access key, and a deploy ` +
        `cannot be signed by a function-call key`,
    );
  }
  return { ok: true, publicKey: credential.public_key };
}
