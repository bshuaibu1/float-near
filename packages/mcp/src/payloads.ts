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

export const ONE_YOCTO = "1";
/** Mirrors `AGENT_ACCOUNT_STORAGE` in the contract: 0.05 NEAR. */
export const AGENT_ACCOUNT_STORAGE_YOCTO = (5n * 10n ** 22n).toString();
/** Mirrors `MIN_AGENT_KEY_ALLOWANCE` in the contract: 0.5 NEAR. */
export const MIN_AGENT_KEY_ALLOWANCE_YOCTO = (5n * 10n ** 23n).toString();

export const DEFAULT_GAS_TGAS = 100;

/**
 * Gas for a Base-routed payment.
 *
 * The contract demands MIN_GAS_FOR_BASE_DISPATCH (230 Tgas) for this rail
 * because MPC signing fans out across the signer network — the default 100
 * would make EVERY Base payment fail with INSUFFICIENT_GAS. That floor is
 * mirrored in shared/contract-constants.json and asserted on both sides, so a
 * change to the contract's requirement cannot silently leave this too low.
 */
export const BASE_GAS_TGAS = 280;

// Mirrors of the contract's bounds. Duplicated so a bad call fails here rather
// than costing gas — and pinned against shared/contract-constants.json by
// constants.test.ts, because a silent drift would turn this validation into a
// lie that the chain then rejects.
export const MAX_TOKENS = 4;
export const MAX_RECIPIENTS = 32;
export const MAX_LABEL_LEN = 48;
export const MAX_SUB_LABEL_LEN = 32;
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

const SUB_LABEL = new RegExp(`^[a-z0-9_-]{1,${MAX_SUB_LABEL_LEN}}$`);

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
        `Prefer create_agent_account, which issues a key restricted to request_payment.`,
    ],
  };
}

export function planCreateAgentAccount(
  vault: string,
  nodeId: number,
  subLabel: string,
  publicKey: string,
  keyAllowanceNear: string,
): OwnerPayload {
  if (!SUB_LABEL.test(subLabel)) {
    throw new Error(
      `invalid sub_label ${JSON.stringify(subLabel)}: 1..=32 chars of [a-z0-9_-]. ` +
        `A dot in particular is refused — the account id is DERIVED as ` +
        `<label>.${vault} so the new account cannot be aimed outside this vault's subtree.`,
    );
  }
  if (!publicKey.startsWith("ed25519:") && !publicKey.startsWith("secp256k1:")) {
    throw new Error("publicKey must be in NEAR form, e.g. ed25519:...");
  }
  const allowance = toBaseUnits(keyAllowanceNear, NEAR_DECIMALS);
  if (allowance < BigInt(MIN_AGENT_KEY_ALLOWANCE_YOCTO)) {
    throw new Error(
      `key allowance ${keyAllowanceNear} NEAR is below the usable floor of ` +
        `${fromBaseUnits(BigInt(MIN_AGENT_KEY_ALLOWANCE_YOCTO), NEAR_DECIMALS)} NEAR. ` +
        `NEAR reserves the FULL prepaid gas of each call against the key up front and ` +
        `refunds the remainder, so an allowance sized to expected burn produces a key ` +
        `that cannot transact at all.`,
    );
  }
  const deposit = allowance + BigInt(AGENT_ACCOUNT_STORAGE_YOCTO);
  const derived = `${subLabel}.${vault}`;
  return {
    receiverId: vault,
    methodName: "create_agent_account",
    args: {
      node_id: nodeId,
      sub_label: subLabel,
      public_key: publicKey,
      key_allowance: allowance.toString(),
    },
    gasTgas: DEFAULT_GAS_TGAS,
    depositYocto: deposit.toString(),
    summary:
      `Create agent account ${derived}, bind it to node ${nodeId}, and give it ONE key ` +
      `that can call only request_payment on ${vault} — it cannot call other methods, ` +
      `cannot call other contracts, and cannot attach a deposit. ` +
      `Funding ${fromBaseUnits(deposit, NEAR_DECIMALS)} NEAR ` +
      `(${keyAllowanceNear} gas allowance + ` +
      `${fromBaseUnits(BigInt(AGENT_ACCOUNT_STORAGE_YOCTO), NEAR_DECIMALS)} account storage).`,
    warnings: [],
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
  create_agent_account: { methodName: "create_agent_account", fn: planCreateAgentAccount },
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
