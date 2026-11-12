/**
 * "Can this vault actually pay, and if not, what do I run?"
 *
 * EXTRACTED SO IT CAN BE TESTED. The wizard's epilogue only prints after a
 * complete, paid, on-chain run — there is no way to execute it in a test, and
 * the message it used to print was wrong for the commonest case: "What to try
 * first: spend from an agent and watch the budget tree charge every level
 * above it", for a vault with no agent bound and no way to bind one from the
 * wizard.
 *
 * That is the asymmetry this exists to close. The BROWSER path binds a paying
 * agent inside the creation transaction; the CLI path cannot (`--agents`
 * refuses, because `create_agent_account` was removed from the contract and the
 * wizard was never wired to virtual agents). So the two front doors disagree
 * about whether a fresh vault can pay, and until now only the browser one said
 * so.
 *
 * Follows the pattern of ./handoff.mjs and ./tree.mjs: a pure function here, a
 * test beside it, and the wizard just prints the result.
 *
 * QUOTES NO FIGURE. An earlier draft said "~0.12 NEAR" against a real 0.1209
 * (reservation + 50 payments of burn), and args.mjs already records what that
 * costs: a user topping up to exactly what the help promised was refused by the
 * affordability gate for want of 0.006 NEAR. Its conclusion applies here --
 * "writing a derived number down by hand is the bug" -- so this points at
 * `float-agent --dry-run`, which computes it.
 */

/**
 * @param {object} i
 * @param {number|null} i.gasKeyCount  NEP-611 gas keys on the vault, or null if
 *   the chain could not be read. NULL IS A THIRD STATE ON PURPOSE — see below.
 * @param {string} i.vault
 * @param {string} i.owner
 * @param {string} i.network
 * @returns {{ canPay: boolean|null, headline: string, command: string|null }}
 */
export function agentAdvice({ gasKeyCount, vault, owner, network }) {
  /**
   * UNKNOWN IS NOT "NO".
   *
   * A failed key read must not print either confident answer. Saying "none
   * bound" sends a working setup off to add a redundant key and spend another
   * 0.12 NEAR; saying "one is bound" hides the single step standing between
   * the user and a payment. Both are worse than admitting the read failed.
   */
  if (gasKeyCount === null) {
    return {
      canPay: null,
      headline: `Could not read ${vault}'s keys, so whether a paying agent is bound is unknown.`,
      command: null,
    };
  }

  if (gasKeyCount > 0) {
    return {
      canPay: true,
      headline: `${gasKeyCount} paying agent ${gasKeyCount === 1 ? "key is" : "keys are"} bound, so this vault can pay.`,
      command: null,
    };
  }

  // The flag is omitted on mainnet because mainnet is every CLI's default, and
  // a command carrying a redundant flag teaches the wrong default.
  const net = network === "mainnet" ? "" : ` --network ${network}`;
  return {
    canPay: false,
    headline: "No agent is bound yet, so this vault cannot pay.",
    command: `npx -p @floatonnear/create-float float-agent --vault ${vault} --owner ${owner}${net}`,
  };
}
