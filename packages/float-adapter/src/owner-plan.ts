import {
  planAddRole,
  planFreezeNode,
  planSetCooldown,
  planSetNodeCaps,
  planSetPaused,
  planSetRecipients,
  planSetStrictAllocation,
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
   * Create an agent: a child budget node plus a gas key on the vault.
   *
   * `publicKey` is required and `fundingYocto` has no default - see the
   * note at the top of this file.
   */
  | {
      action: "addRole";
      label: string;
      dailyCap: string;
      perTxCap: string;
      cooldownSec?: number;
      recipients?: string[] | null;
      publicKey: string;
      fundingYocto: string;
    };

/**
 * The action name is not one we serve.
 *
 * A SEPARATE type from a bad argument, because the HTTP layer has to tell
 * them apart: it used to catch every throw from here and report
 * `unknown action: <name>`, so an underfunded gas key or a mistyped public
 * key was reported as a method that does not exist - the one explanation
 * that cannot lead the caller to a fix.
 */
export class UnknownActionError extends Error {
  constructor(action: string) {
    super(`unknown action: ${action}`);
    this.name = "UnknownActionError";
  }
}

export type OwnerPlanEnv = { vault: string; token: string; decimals: number };

export function planOwnerAction(b: OwnerPlanRequest, env: OwnerPlanEnv) {
  switch (b.action) {
    case "caps":
      // HUMAN units, with decimals — `planSetNodeCaps` scales them itself via
      // limitsToArgs. Calling toBaseUnits here too would scale twice and turn
      // a 100 USDC cap into 100 million USDC, which is not a cap at all.
      return planSetNodeCaps(env.vault, b.nodeId, [
        {
          token: env.token,
          dailyCap: b.dailyCap ?? "0",
          perTxCap: b.perTxCap ?? "0",
          decimals: env.decimals,
        },
      ]);
    case "cooldown":
      return planSetCooldown(env.vault, b.nodeId, b.cooldownSec ?? 0);
    case "recipients":
      // `?? null` is load-bearing: an absent list means INHERIT. Defaulting to
      // `[]` would panic `validate_recipients`, which demands "1..=32
      // recipients, or None to inherit".
      return planSetRecipients(env.vault, b.nodeId, b.recipients ?? null);
    case "freeze":
      return planFreezeNode(env.vault, b.nodeId, b.frozen ?? false);
    case "pause":
      // Vault-wide. Takes no nodeId, because it stops every payment at every
      // level rather than muting one agent.
      return planSetPaused(env.vault, b.paused ?? false);
    case "allocation":
      return planSetStrictAllocation(env.vault, b.strict ?? false);
    case "addRole":
      // planAddRole validates the label, the key format, the cooldown,
      // the recipients and the 0.06 NEAR gas-key floor, and throws with a
      // message meant for a human. Re-checking here would be a second
      // place for those rules to drift out of step with the contract.
      return planAddRole(
        env.vault,
        b.label,
        [
          {
            token: env.token,
            dailyCap: b.dailyCap,
            perTxCap: b.perTxCap,
            decimals: env.decimals,
          },
        ],
        b.cooldownSec ?? 0,
        // `?? null` is load-bearing: absent means INHERIT, and an empty
        // array panics `validate_recipients`.
        b.recipients ?? null,
        b.publicKey,
        b.fundingYocto,
      );
    default:
      throw new UnknownActionError(String((b as { action: string }).action));
  }
}
