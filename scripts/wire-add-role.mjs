/**
 * Expose `add_role` through the adapter's owner-plan.
 *
 * `planAddRole` has existed in the MCP since the fleet work, but the adapter
 * never offered it - so the dashboard had no way to prepare an
 * agent-creation transaction, and the only path was the MCP tool.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 * 1. It does not generate the keypair. The caller creates it locally and
 *    passes the PUBLIC half. The secret has to land on the machine that will
 *    run the agent; an adapter that minted or relayed it would make this
 *    product custodial, which is the thing it exists to avoid.
 *
 * 2. It does not default the funding. Every other action here has a safe
 *    default, but the deposit on `add_role` IS the new agent's entire
 *    spending allowance for gas - guessing it would quietly decide how much
 *    of the owner's NEAR to move.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const p = "packages/float-adapter/src/owner-plan.ts";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// --- import ---------------------------------------------------------------
must(
  "  planFreezeNode,",
  "  planAddRole," + LF + "  planFreezeNode,",
  "import",
);

// --- the request type -----------------------------------------------------
must(
  '  | { action: "allocation"; strict?: boolean };',
  [
    '  | { action: "allocation"; strict?: boolean }',
    "  /**",
    "   * Create an agent: a child budget node plus a gas key on the vault.",
    "   *",
    "   * `publicKey` is required and `fundingYocto` has no default - see the",
    "   * note at the top of this file.",
    "   */",
    "  | {",
    '      action: "addRole";',
    "      label: string;",
    "      dailyCap: string;",
    "      perTxCap: string;",
    "      cooldownSec?: number;",
    "      recipients?: string[] | null;",
    "      publicKey: string;",
    "      fundingYocto: string;",
    "    };",
  ].join(LF),
  "request type",
);

// --- the case -------------------------------------------------------------
must(
  [
    '    case "allocation":',
    "      return planSetStrictAllocation(env.vault, b.strict ?? false);",
  ].join(LF),
  [
    '    case "allocation":',
    "      return planSetStrictAllocation(env.vault, b.strict ?? false);",
    '    case "addRole":',
    "      // planAddRole validates the label, the key format, the cooldown,",
    "      // the recipients and the 0.06 NEAR gas-key floor, and throws with a",
    "      // message meant for a human. Re-checking here would be a second",
    "      // place for those rules to drift out of step with the contract.",
    "      return planAddRole(",
    "        env.vault,",
    "        b.label,",
    "        [",
    "          {",
    "            token: env.token,",
    "            dailyCap: b.dailyCap,",
    "            perTxCap: b.perTxCap,",
    "            decimals: env.decimals,",
    "          },",
    "        ],",
    "        b.cooldownSec ?? 0,",
    "        // `?? null` is load-bearing: absent means INHERIT, and an empty",
    "        // array panics `validate_recipients`.",
    "        b.recipients ?? null,",
    "        b.publicKey,",
    "        b.fundingYocto,",
    "      );",
  ].join(LF),
  "case",
);

writeFileSync(p, s);
console.log("  add_role wired into planOwnerAction");
