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
 * `removeCredential` runs ONLY after every on-chain step has resolved. If the
 * delete fails, the setup key file must survive -- it is the only thing that can
 * finish the job on a re-run.
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
  if (ops.removeCredential) {
    await ops.removeCredential();
    done.push("remove-credential");
  }
  return done;
}
