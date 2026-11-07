/**
 * What a browser can and cannot do when closing a vault.
 *
 * WHY THIS IS A MODULE AND NOT A FEW TERNARIES IN JSX. Every rule here
 * decides whether someone is shown a button that moves real money or deletes
 * an account that cannot be recovered, and two of them are the difference
 * between recovering a balance and burning it. None of that is testable
 * inside a component.
 *
 * THE SHAPE OF THE PROBLEM, from contracts/vault/src/lib.rs and
 * scripts/teardown-vault.mjs. Closing a vault is six steps, and the order is
 * the whole thing — each step destroys the means of doing an earlier one:
 *
 *   1. withdraw the tokens out      OWNER signs. A delete does NOT return
 *                                   fungible tokens; the ledger keeps a row
 *                                   keyed to an account nobody can sign for.
 *   2. withdraw the gas-key balance VAULT signs. A contract cannot do this —
 *                                   there is no withdraw host function.
 *   3. storage_unregister           VAULT signs, against the token.
 *   4. purge_settled                OWNER signs. The only lever that shrinks
 *                                   STATE, and without it the delete is
 *                                   refused outright.
 *   5. deploy the 33-byte stub      VAULT signs, and it is a DeployContract —
 *                                   which wallets REFUSE from a dApp. That
 *                                   refusal is the entire reason vault
 *                                   creation goes through a factory.
 *   6. delete-account               VAULT signs.
 *
 * So a dashboard can reach steps 1 and 4 and nothing else. It must not
 * present a "Close vault" button, because pressing it could not work, and a
 * control that cannot do what it says is worse on this screen than on any
 * other.
 */

/** A token amount as the chain reports it: base units, as a string. */
export type BaseAmount = string | null | undefined;

export type TeardownState = {
  /** Can the owner be offered the withdraw step? */
  canWithdraw: boolean;
  /** Is the vault empty enough for the CLI delete to be worth starting? */
  isEmpty: boolean;
  /**
   * Why the delete step is not offered yet, or null when nothing blocks it.
   * Rendered to the user, so it says what to do rather than what is wrong.
   */
  blocker: string | null;
};

/**
 * Read the vault's token balance into a decision.
 *
 * NULL IS NOT ZERO, and this is the rule that matters most.
 *
 * `/v1/vault-info` returns `vaultTokenBalance: null` when the token contract
 * cannot be read — an RPC failure, a token that does not answer, a vault not
 * registered with it. Treating that as "empty" would green-light a teardown
 * of a vault that is holding money, and the money would be unrecoverable the
 * moment the account is deleted.
 *
 * So an unknown balance BLOCKS. The failure mode of being wrong in the other
 * direction is someone retrying later, which costs nothing.
 *
 * NOT THE DAILY BUDGET EITHER. The root node's remaining daily budget and
 * the vault's actual NEP-141 balance are different quantities — fund 10,000
 * USDC against a 100/day cap and the budget figure still reads 40. The
 * adapter keeps them in separate fields for exactly this reason, and only
 * `vaultTokenBalance` says what the vault is holding.
 */
export function teardownState(vaultTokenBalance: BaseAmount): TeardownState {
  if (vaultTokenBalance === null || vaultTokenBalance === undefined || vaultTokenBalance === "") {
    return {
      canWithdraw: false,
      isEmpty: false,
      blocker:
        "The vault's token balance could not be read, so it is unknown rather than zero. " +
        "Refresh before going further — deleting a vault that still holds tokens loses them.",
    };
  }

  /**
   * PLAIN DECIMAL ONLY, and `BigInt` alone is not that check.
   *
   * `BigInt("0x10")` is 16 — so a hex string is silently reinterpreted
   * rather than rejected. The dangerous case is `BigInt("0x0")`, which is 0,
   * which would report a malformed balance as an EMPTY vault and unlock the
   * delete step. Found by a test that expected "0x10" to be refused and got
   * a different refusal instead.
   *
   * A NEP-141 `ft_balance_of` returns a decimal string. Anything else is not
   * a balance this should act on.
   */
  if (!/^-?\d+$/.test(vaultTokenBalance)) {
    return {
      canWithdraw: false,
      isEmpty: false,
      blocker:
        `The vault's token balance came back as "${vaultTokenBalance}", which is not a number. ` +
        "Nothing here will act on a balance it cannot read.",
    };
  }

  let bal: bigint;
  try {
    bal = BigInt(vaultTokenBalance);
  } catch {
    return {
      canWithdraw: false,
      isEmpty: false,
      blocker:
        `The vault's token balance came back as "${vaultTokenBalance}", which is not a number. ` +
        "Nothing here will act on a balance it cannot read.",
    };
  }

  // `BigInt(0)`, not `0n`. This app targets ES2017, where a BigInt LITERAL
  // is a compile error — and vitest never saw it, because oxc strips types
  // without checking them. Only `tsc` catches this, which is why the
  // typecheck gate runs with --incremental false.
  if (bal < BigInt(0)) {
    return {
      canWithdraw: false,
      isEmpty: false,
      blocker:
        "The vault reports a negative token balance, which cannot happen. " +
        "Nothing here will act on it.",
    };
  }

  if (bal > BigInt(0)) {
    return {
      canWithdraw: true,
      isEmpty: false,
      blocker:
        "This vault still holds tokens. Move them out first — deleting an account does " +
        "not return them.",
    };
  }

  return { canWithdraw: false, isEmpty: true, blocker: null };
}

/**
 * The command that finishes the job, built from the vault the user is
 * actually looking at.
 *
 * HANDED OVER RATHER THAN HIDDEN. The last two steps need the vault as
 * signer and one of them is a DeployContract, so no amount of dashboard work
 * reaches them. Saying so and giving the exact command is the honest end of
 * this flow; a disabled "Close vault" button with a tooltip would be the
 * dishonest one.
 *
 * `NETWORK` is included because the script defaults to testnet and a mainnet
 * teardown run against the wrong network is a confusing no-op at best.
 */
export function teardownCommand(vaultId: string, network: string): string {
  return `NETWORK=${network} VAULT=${vaultId} node scripts/teardown-vault.mjs`;
}
