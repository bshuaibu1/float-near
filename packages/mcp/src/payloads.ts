/**
 * Owner-method payload builders.
 *
 * Owner methods are NEVER signed by this server. It builds an unsigned payload
 * and hands it back for the human to approve in their own wallet, so the MCP
 * server is not in the trust path for anything that changes policy. The only
 * thing it signs is `request_payment`, with an agent key that is
 * cryptographically restricted to exactly that method on exactly this vault.
 *
 * Validation is duplicated here on purpose. The contract rejects all of these
 * too, but failing locally costs no gas and no wallet round-trip, and the
 * message can explain *why* a bound exists.
 */

import { toBaseUnits, fromBaseUnits } from "./amounts.js";


/** A node id must be a non-negative integer; there is no node -1. */
function assertNodeId(nodeId: number): void {
  if (!Number.isInteger(nodeId) || nodeId < 0) {
    throw new Error(`node id must be a non-negative integer, got ${nodeId}`);
  }
}

/**
 * Shape-check a public key before it reaches a wallet.
 *
 * Deliberately not a full base58 decode — the contract does that and rejects
 * a malformed key. This catches the empty string and the obvious typo locally,
 * where it costs nothing instead of a wallet round-trip.
 */
function assertPublicKey(publicKey: string): void {
  if (!/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,}$/.test(publicKey)) {
    throw new Error(
      `not a public key: ${JSON.stringify(publicKey)}. ` +
        `Expected "ed25519:<base58>" or "secp256k1:<base58>".`,
    );
  }
}

export const ONE_YOCTO = "1";

/**
 * Gas attached to a payment, for every route.
 *
 * Clears the contract's only floor — MIN_GAS_FOR_DISPATCH, 50 Tgas — with ~10x
 * headroom over the ~9.3 Tgas a MAX_DEPTH payment actually burns. That floor is
 * mirrored in shared/contract-constants.json and asserted on both sides, so a
 * change to the contract's requirement cannot silently leave this too low.
 */
export const DEFAULT_GAS_TGAS = 100;

// Mirrors of the contract's bounds. Duplicated so a bad call fails here rather
// than costing gas — and pinned against shared/contract-constants.json by
// constants.test.ts, because a silent drift would turn this validation into a
// lie that the chain then rejects.
export const MAX_TOKENS = 4;
export const MAX_RECIPIENTS = 32;
export const MAX_LABEL_LEN = 48;
export const MAX_COOLDOWN_SEC = 7 * 24 * 60 * 60;
export const MAX_PURGE_LIMIT = 100;

export interface HumanTokenLimit {
  token: string;
  dailyCap: string;
  perTxCap: string;
  decimals: number;
}

export interface OwnerPayload {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gasTgas: number;
  depositYocto: string;
  /** What the human is being asked to approve, in human units. */
  summary: string;
  /** Non-empty only when the action is destructive or hard to undo. */
  warnings: string[];
}

const NEAR_DECIMALS = 24;

function limitsToArgs(limits: HumanTokenLimit[]): unknown[] {
  if (limits.length === 0) throw new Error("at least one token limit is required");
  if (limits.length > MAX_TOKENS) {
    throw new Error(`at most ${MAX_TOKENS} token limits per node (MAX_TOKENS)`);
  }
  const seen = new Set<string>();
  for (const l of limits) {
    if (seen.has(l.token)) throw new Error(`duplicate token ${l.token}`);
    seen.add(l.token);
  }
  return limits.map((l) => {
    const daily = toBaseUnits(l.dailyCap, l.decimals);
    const perTx = toBaseUnits(l.perTxCap, l.decimals);
    if (daily === 0n || perTx === 0n) {
      throw new Error(`caps must be positive (token ${l.token})`);
    }
    if (perTx > daily) {
      throw new Error(
        `per-tx cap ${l.perTxCap} exceeds the daily cap ${l.dailyCap} for ${l.token}; ` +
          `the contract requires per_tx_cap <= daily_cap`,
      );
    }
    // snake_case and U128-as-string: the contract's ABI, and a JSON number
    // would lose precision above 2^53.
    return { token: l.token, daily_cap: daily.toString(), per_tx_cap: perTx.toString() };
  });
}

/** Human units in the summary, always. Base units here are how a 1000x slip gets approved. */
function describeLimits(limits: HumanTokenLimit[]): string {
  return limits
    .map((l) => `${l.token}: ${l.dailyCap}/day, max ${l.perTxCap}/payment`)
    .join("; ");
}


function assertRecipients(recipients: string[] | null): void {
  if (recipients === null) return;
  if (recipients.length === 0) {
    throw new Error("recipients must be a non-empty list, or null to inherit the parent's");
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new Error(`at most ${MAX_RECIPIENTS} recipients per node (MAX_RECIPIENTS)`);
  }
  if (new Set(recipients).size !== recipients.length) {
    throw new Error("duplicate recipient");
  }
}

function assertCooldown(cooldownSec: number): void {
  if (!Number.isInteger(cooldownSec) || cooldownSec < 0) {
    throw new Error("cooldownSec must be a non-negative integer");
  }
  if (cooldownSec > MAX_COOLDOWN_SEC) {
    throw new Error(`cooldown must be at most ${MAX_COOLDOWN_SEC}s (MAX_COOLDOWN_SEC)`);
  }
}

export function planAddNode(
  vault: string,
  parent: number | null,
  label: string,
  limits: HumanTokenLimit[],
  cooldownSec: number,
  recipients: string[] | null,
): OwnerPayload {
  if (!label || label.length > MAX_LABEL_LEN) {
    throw new Error(`label must be 1..=${MAX_LABEL_LEN} characters (MAX_LABEL_LEN)`);
  }
  assertCooldown(cooldownSec);
  assertRecipients(recipients);
  return {
    receiverId: vault,
    methodName: "add_node",
    args: {
      parent,
      label,
      limits: limitsToArgs(limits),
      cooldown_sec: cooldownSec,
      recipients,
    },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary:
      `Create budget node "${label}" ${parent === null ? "as the ROOT" : `under node ${parent}`}` +
      ` with ${describeLimits(limits)}` +
      (cooldownSec ? `, ${cooldownSec}s cooldown between payments` : "") +
      (recipients ? `, paying only: ${recipients.join(", ")}` : `, inheriting the payee allowlist`),
    warnings: [],
  };
}

export function planSetNodeCaps(
  vault: string,
  nodeId: number,
  limits: HumanTokenLimit[],
): OwnerPayload {
  return {
    receiverId: vault,
    methodName: "set_node_caps",
    args: { node_id: nodeId, limits: limitsToArgs(limits) },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: `Set node ${nodeId} caps to ${describeLimits(limits)}`,
    warnings: [],
  };
}

export function planBindAgent(vault: string, nodeId: number, accountId: string): OwnerPayload {
  return {
    receiverId: vault,
    methodName: "bind_agent",
    args: { node_id: nodeId, account_id: accountId },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: `Let ${accountId} spend from node ${nodeId}`,
    warnings: [
      `${accountId} is an EXISTING account whose keys you do not control. ` +
        `It can call request_payment with the full authority of node ${nodeId}.`,
      `Prefer a VIRTUAL agent (bind_virtual_agent): it binds one key you generate ` +
        `rather than a whole account, costs ~168 bytes, and strands nothing.`,
    ],
  };
}

export function planBindVirtualAgent(
  vault: string,
  nodeId: number,
  publicKey: string,
): OwnerPayload {
  assertNodeId(nodeId);
  assertPublicKey(publicKey);
  return {
    receiverId: vault,
    methodName: "bind_virtual_agent",
    args: { node_id: nodeId, public_key: publicKey },
    gasTgas: DEFAULT_GAS_TGAS,
    // ONE YOCTO, not a funding amount. `bind_virtual_agent` calls
    // `assert_owner()` -> `assert_one_yocto()`. Nothing is funded here, which
    // is the whole point of moving off sub-accounts.
    depositYocto: ONE_YOCTO,
    summary: `Let the key ${publicKey.slice(0, 22)}… spend from node ${nodeId}`,
    warnings: [
      `A node may hold more than one key — binding another does not replace this one.`,
      `This grants spending authority only. The key still needs gas: install it as ` +
        `a NEP-611 gas key on the vault and fund it. That balance is recoverable.`,
    ],
  };
}

/**
 * Revoke a virtual agent's authority.
 *
 * Frees the 82-byte `pubkey_to_node` entry. The 86-byte `pubkey_to_nonce`
 * entry is RETAINED deliberately and never reclaimed — confirmed live, where
 * next_nonce stayed at 2 instead of resetting to 1. Dropping it would let
 * unbind-then-rebind reset the nonce and reopen the replay window, so about
 * half the binding's storage is intentionally unrecoverable.
 */
export function planUnbindVirtualAgent(vault: string, publicKey: string): OwnerPayload {
  assertPublicKey(publicKey);
  return {
    receiverId: vault,
    methodName: "unbind_virtual_agent",
    args: { public_key: publicKey },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: `Revoke the key ${publicKey.slice(0, 22)}…`,
    warnings: [
      `The replay nonce for this key is kept forever, on purpose: resetting it ` +
        `would let an unbind/rebind replay old signed payloads. About half the ` +
        `binding's storage is therefore not reclaimed.`,
      `Gas still sitting in this key's NEP-611 gas key is NOT returned by ` +
        `unbinding. Withdraw from the gas key first, or it stays there.`,
    ],
  };
}

export function planSetRecipients(
  vault: string,
  nodeId: number,
  recipients: string[] | null,
): OwnerPayload {
  assertRecipients(recipients);
  return {
    receiverId: vault,
    methodName: "set_recipients",
    args: { node_id: nodeId, recipients },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: recipients
      ? `Node ${nodeId} may pay only: ${recipients.join(", ")}`
      : `Node ${nodeId} inherits its payee allowlist from the nearest ancestor that sets one`,
    warnings: recipients
      ? [
          `This REPLACES the inherited allowlist for node ${nodeId} and its descendants; ` +
            `it does not add to it. Payees it currently inherits will stop being payable.`,
        ]
      : [],
  };
}

export function planSetCooldown(vault: string, nodeId: number, cooldownSec: number): OwnerPayload {
  assertCooldown(cooldownSec);
  return {
    receiverId: vault,
    methodName: "set_cooldown",
    args: { node_id: nodeId, cooldown_sec: cooldownSec },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: cooldownSec
      ? `Node ${nodeId} must wait ${cooldownSec}s between payments`
      : `Remove the cooldown on node ${nodeId}`,
    warnings: [],
  };
}

export function planFreezeNode(vault: string, nodeId: number, frozen: boolean): OwnerPayload {
  return {
    receiverId: vault,
    methodName: "freeze_node",
    args: { node_id: nodeId, frozen },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: frozen ? `Freeze node ${nodeId}` : `Unfreeze node ${nodeId}`,
    warnings: frozen
      ? [`This blocks payments from node ${nodeId} AND every node in its subtree.`]
      : [],
  };
}

export function planSetPaused(vault: string, paused: boolean): OwnerPayload {
  return {
    receiverId: vault,
    methodName: "set_paused",
    args: { paused },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: paused ? `PAUSE the whole vault` : `Resume the vault`,
    warnings: paused ? [`This will halt every agent payment until you resume it.`] : [],
  };
}

export function planSetStrictAllocation(vault: string, strict: boolean): OwnerPayload {
  return {
    receiverId: vault,
    methodName: "set_strict_allocation",
    args: { strict },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: strict
      ? `Require the sum of child caps to fit inside each parent cap (no overcommit)`
      : `Allow overcommit: child caps may sum above the parent, and children then ` +
        `contend first-come-first-served for the shared parent pool`,
    warnings: [],
  };
}

export function planPurgeSettled(vault: string, beforeDay: number, limit: number): OwnerPayload {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PURGE_LIMIT) {
    throw new Error(`limit must be an integer in 0..=${MAX_PURGE_LIMIT} (MAX_PURGE_LIMIT)`);
  }
  return {
    receiverId: vault,
    methodName: "purge_settled",
    args: { before_day: beforeDay, limit },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: `Delete up to ${limit} settled or failed payment records reserved before UTC day ${beforeDay}`,
    warnings: [
      `Irreversible: this deletes payment HISTORY. Spend totals are NOT refunded, ` +
        `but a deleted request id becomes reusable, so a client retrying an id older ` +
        `than day ${beforeDay} would be paid a second time.`,
    ],
  };
}

/** Registry used by the MCP server, and asserted against the contract's method list. */
export const OWNER_PLANNERS = {
  add_node: { methodName: "add_node", fn: planAddNode },
  set_node_caps: { methodName: "set_node_caps", fn: planSetNodeCaps },
  bind_agent: { methodName: "bind_agent", fn: planBindAgent },
  bind_virtual_agent: { methodName: "bind_virtual_agent", fn: planBindVirtualAgent },
  unbind_virtual_agent: { methodName: "unbind_virtual_agent", fn: planUnbindVirtualAgent },
  set_recipients: { methodName: "set_recipients", fn: planSetRecipients },
  set_cooldown: { methodName: "set_cooldown", fn: planSetCooldown },
  freeze_node: { methodName: "freeze_node", fn: planFreezeNode },
  set_paused: { methodName: "set_paused", fn: planSetPaused },
  set_strict_allocation: { methodName: "set_strict_allocation", fn: planSetStrictAllocation },
  purge_settled: { methodName: "purge_settled", fn: planPurgeSettled },
} as const;

/** A ready-to-run command, so approving does not require trusting this server. */
export function toCliCommand(p: OwnerPayload, network = "testnet"): string {
  return (
    `near contract call-function as-transaction ${p.receiverId} ${p.methodName} ` +
    `json-args '${JSON.stringify(p.args)}' prepaid-gas '${p.gasTgas}.0 Tgas' ` +
    `attached-deposit '${p.depositYocto} yoctoNEAR' ` +
    `sign-as <YOUR-OWNER-ACCOUNT> network-config ${network} sign-with-keychain send`
  );
}

/**
 * Require the owner to approve payments above `amount` at this node.
 *
 * A threshold is a gate INSIDE the caps: it can only make the vault more
 * conservative, never less, so there is no value of it that moves more money
 * than the budget tree already allowed. `null` removes it.
 *
 * ---- `amount` IS HUMAN UNITS, and it used to be base units.
 *
 * Breaking change, 2026-10-31, made the same day the tool was published and
 * before anyone used it. The parameter was `amountBase` and took raw base
 * units, which made it the ONLY tool in this module on that convention:
 *
 *   vault_pay.amount                   human   "12.50"
 *   planSetNodeCaps dailyCap/perTxCap  human   (the zod schema says so)
 *   planSetApprovalThreshold           BASE    <- the odd one out
 *
 * And it is the one that configures a safety gate, so it FAILED OPEN. An owner
 * thinking in human units who passed a figure at or above the per-tx cap in
 * base units got a threshold ABOVE every cap in the tree: the gate never fires,
 * nothing is ever held, and the transaction succeeds — so the owner believes the
 * control is on. Measured against the live mainnet vault (per-tx cap 510000
 * base = 0.51 USDC): "1000000" meaning "a million" yields a 1.0 USDC threshold,
 * above every cap.
 *
 * The other direction fails closed and is merely annoying ("1" meaning 1 USDC
 * became 0.000001, so everything got held), which is why only one direction is
 * dangerous and why this is worth a breaking change rather than a doc fix.
 *
 * `toBaseUnits` throws rather than truncating excess precision — correct here:
 * silently rounding 0.1234567 would set a threshold the owner did not choose.
 */
export function planSetApprovalThreshold(
  vault: string,
  nodeId: number,
  amount: string | null,
  decimals: number,
): OwnerPayload {
  const base = amount === null ? null : toBaseUnits(amount, decimals).toString();
  return {
    receiverId: vault,
    methodName: "set_approval_threshold",
    args: { node_id: nodeId, amount: base },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    // Human units in the summary too. The old line read "Payments above
    // 1000000 (base units)", which is unreadable in precisely the moment the
    // owner is checking the plan before signing it.
    summary: amount
      ? `Payments above ${amount} from node ${nodeId} will need your approval`
      : `Remove the approval threshold on node ${nodeId} — payments up to the caps run unattended`,
    warnings: amount
      ? []
      : ["After this, nothing at this node waits for a human: only the caps apply."],
  };
}

/**
 * Execute a held payment.
 *
 * Every limit is re-checked at approval time, so this can still be refused --
 * by a cap tightened while it waited, or by an Intents quote that expired. That
 * is the honest outcome and the warning says so.
 */
export function planApprovePayment(vault: string, requestId: string): OwnerPayload {
  return {
    receiverId: vault,
    methodName: "approve_payment",
    args: { request_id: requestId },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: `Approve and send held payment ${requestId}`,
    warnings: [
      "This MOVES MONEY. Check the amount and payee with vault_pending_approval first.",
      "Limits are re-checked now, so it can still be refused — a cap lowered since the request, or a cross-chain quote that has expired.",
    ],
  };
}

/** Decline a held payment. The ticket is discarded and nothing moves. */
export function planRejectPayment(vault: string, requestId: string): OwnerPayload {
  return {
    receiverId: vault,
    methodName: "reject_payment",
    args: { request_id: requestId },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: ONE_YOCTO,
    summary: `Reject held payment ${requestId}`,
    warnings: ["The agent must request again if it still needs the money."],
  };
}
