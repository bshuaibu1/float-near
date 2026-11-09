import {
  planAddRole,
  planFreezeNode,
  planPurgeSettled,
  planSetCooldown,
  planSetNodeCaps,
  planSetPaused,
  planSetRecipients,
  planSetStrictAllocation,
  planWithdraw,
} from "@floatonnear/mcp/payloads";

/**
 * Every owner action the dashboard can prepare.
 *
 * This lived as a switch inline in the request handler, which meant it was
 * unreachable from a test — and that is how `pause` and `allocation` came to
 * be rendered as dead readout text on the Policies page despite both having
 * contract setters and both being checked on every single payment.
 *
 * It stays a PURE function: no signing, no network, no key. The adapter only
 * ever holds an agent key, which can call `request_payment` and nothing else,
 * so an owner method can only ever be *described* here and signed in the
 * owner's own wallet.
 */
export type OwnerPlanRequest =
  | { action: "caps"; nodeId: number; dailyCap?: string; perTxCap?: string }
  | { action: "cooldown"; nodeId: number; cooldownSec?: number }
  | { action: "recipients"; nodeId: number; recipients?: string[] | null }
  | { action: "freeze"; nodeId: number; frozen?: boolean }
  | { action: "pause"; paused?: boolean }
  | { action: "allocation"; strict?: boolean }
  /**
   * The two teardown steps a BROWSER SIGNATURE CAN REACH.
   *
   * Closing a vault is six steps (see scripts/teardown-vault.mjs) and four of
   * them need the VAULT as signer, not the owner: the gas-key withdrawal, the
   * token's `storage_unregister`, the 33-byte stub deploy and the
   * `DeleteAccount` itself. A wallet refuses `DeployContract` from a dApp —
   * which is the entire reason vault CREATION goes through a factory — so a
   * dashboard cannot finish a teardown and must not pretend to.
   *
   * These two it can do, and they are the two that matter most:
   *
   *   withdraw   deleting an account does NOT return fungible tokens, so
   *              moving them out first is the difference between recovering
   *              a balance and burning it
   *   purge      the only lever that shrinks STATE, and without it the
   *              delete is refused outright
   */
  | { action: "withdraw"; token?: string; amountBase?: string; receiverId?: string }
  | { action: "purge"; beforeDay?: number; limit?: number }
  /**
   * Give an agent key spending authority, AFTER the vault already exists.
   *
   * `add_role` is the method and `bind_virtual_agent` is not, which is not
   * obvious and matters. Binding alone grants authority and leaves the key
   * unable to transact: it still needs installing as a NEP-611 gas key ON
   * the vault, and that `AddKey` would need the VAULT as signer — the same
   * wall the teardown runs into.
   *
   * `add_role` does the whole thing in one owner-signed call, and the
   * contract says why in its own comment: "THE KEY IS ADDED TO THIS
   * ACCOUNT, BY THIS ACCOUNT. That is the only way an AddKey can reach the
   * vault from a browser signature." The attached deposit funds the gas key
   * and the vault nets zero.
   *
   * The cost is that it creates a NEW node under root rather than attaching
   * to an existing one. That is the honest trade: the alternative is not
   * "attach to an existing node", it is "cannot be done from a browser".
   */
  | {
      action: "role";
      label?: string;
      dailyCap?: string;
      perTxCap?: string;
      cooldownSec?: number;
      recipients?: string[] | null;
      publicKey?: string;
      fundingYocto?: string;
    };

/**
 * The action name is not one we serve.
 *
 * A SEPARATE type from a bad argument, because the HTTP layer has to tell
 * them apart: it used to catch every throw from here and report
 * `unknown action: <name>`, so a negative cooldown or a duplicate recipient
 * was reported as a method that does not exist - the one explanation that
 * cannot lead the caller to a fix.
 */
export class UnknownActionError extends Error {
  constructor(action: string) {
    super(`unknown action: ${action}`);
    this.name = "UnknownActionError";
  }
}

export type OwnerPlanEnv = { vault: string; token: string; decimals: number };

/**
 * A node-scoped action must name its node.
 *
 * THE TYPE SAYS `nodeId: number` AND THAT PROVES NOTHING AT RUNTIME. The body
 * arrives as JSON and is cast, so a request that simply omits the field type-
 * checks all the way through. Measured live on 2026-11-09:
 * `{"action":"freeze"}` returned HTTP 200 with `args: {"frozen": false}` and
 * the summary "Unfreeze node undefined" — `JSON.stringify` drops an undefined
 * value, so `node_id` vanished from the args and from the CLI string, and the
 * user was handed a confident command for a node that does not exist.
 *
 * It reverts rather than doing damage: `freeze_node(node_id: NodeId, ..)` uses
 * `NodeId = u32` with no `#[serde(default)]`, so near-sdk fails to deserialize
 * instead of falling back to `ROOT_NODE = 0`. Wasted gas and a confusing
 * failure, not a silently frozen root.
 *
 * `!== "number"`, NOT `!b.nodeId`. Root is node 0 and 0 is falsy, so the
 * obvious guard would refuse the node most likely to be frozen or re-capped.
 * `NaN` is excluded too, because `JSON.parse` cannot produce it but a hand-
 * built caller can, and `node_id: NaN` serialises to `null`.
 */
function requireNode(b: { nodeId?: unknown; action: string }): number {
  if (typeof b.nodeId !== "number" || !Number.isInteger(b.nodeId) || b.nodeId < 0) {
    throw new Error(
      `action '${b.action}' needs nodeId: a non-negative integer naming the node to change. ` +
        `Root is nodeId 0. Omitting it would build a command with no node_id at all, ` +
        `which the contract refuses after the owner has already signed it.`,
    );
  }
  return b.nodeId;
}

export function planOwnerAction(b: OwnerPlanRequest, env: OwnerPlanEnv) {
  switch (b.action) {
    case "caps":
      // HUMAN units, with decimals — `planSetNodeCaps` scales them itself via
      // limitsToArgs. Calling toBaseUnits here too would scale twice and turn
      // a 100 USDC cap into 100 million USDC, which is not a cap at all.
      return planSetNodeCaps(env.vault, requireNode(b), [
        {
          token: env.token,
          dailyCap: b.dailyCap ?? "0",
          perTxCap: b.perTxCap ?? "0",
          decimals: env.decimals,
        },
      ]);
    case "cooldown":
      return planSetCooldown(env.vault, requireNode(b), b.cooldownSec ?? 0);
    case "recipients":
      // `?? null` is load-bearing: an absent list means INHERIT. Defaulting to
      // `[]` would panic `validate_recipients`, which demands "1..=32
      // recipients, or None to inherit".
      return planSetRecipients(env.vault, requireNode(b), b.recipients ?? null);
    case "freeze":
      return planFreezeNode(env.vault, requireNode(b), b.frozen ?? false);
    case "pause":
      // Vault-wide. Takes no nodeId, because it stops every payment at every
      // level rather than muting one agent.
      return planSetPaused(env.vault, b.paused ?? false);
    case "allocation":
      return planSetStrictAllocation(env.vault, b.strict ?? false);
    case "withdraw":
      // BASE UNITS, and no default. An amount is the one argument that must
      // never be guessed: `?? "0"` would be refused by the contract, and any
      // other fallback would move a quantity nobody asked for.
      if (!b.amountBase) throw new Error("withdraw needs amountBase, in base units");
      if (!b.receiverId) throw new Error("withdraw needs receiverId");
      return planWithdraw(
        env.vault,
        b.token ?? env.token,
        b.amountBase,
        b.receiverId,
        env.decimals,
      );
    case "role":
      // NOTHING IS DEFAULTED that the user has to confirm. A label, a key
      // and a funding amount are all things an owner approves in a wallet,
      // and a guessed one would be approved by someone who never chose it.
      if (!b.label) throw new Error("role needs a label");
      if (!b.publicKey) throw new Error("role needs the agent's publicKey");
      if (!b.fundingYocto) throw new Error("role needs fundingYocto for the gas key");
      return planAddRole(
        env.vault,
        b.label,
        [
          {
            token: env.token,
            dailyCap: b.dailyCap ?? "0",
            perTxCap: b.perTxCap ?? "0",
            decimals: env.decimals,
          },
        ],
        b.cooldownSec ?? 0,
        b.recipients ?? null,
        b.publicKey,
        b.fundingYocto,
      );
    case "purge":
      // `before_day` is read from the contract's own `current_day` by the
      // caller and passed as current_day + 1 — records are removed strictly
      // BEFORE it. Defaulting it here would invent a cutoff.
      if (typeof b.beforeDay !== "number") throw new Error("purge needs beforeDay");
      return planPurgeSettled(env.vault, b.beforeDay, b.limit ?? 100);
    default:
      throw new UnknownActionError(String((b as { action: string }).action));
  }
}
