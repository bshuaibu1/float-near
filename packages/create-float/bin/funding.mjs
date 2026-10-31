/**
 * How much NEAR a new vault account needs, derived from the contract itself.
 *
 * `VAULT_FUNDING` used to be a flat `NEAR(3)`, chosen when the contract was
 * 278 KB and its code stake 2.848 — a comfortable 0.152 NEAR of headroom for
 * the budget tree's own state.
 *
 * Adding the approval gate grew the contract to 292 KB. The stake became 2.990
 * and the headroom collapsed to 0.010 NEAR, roughly one kilobyte of state. A
 * four-node tree does not fit in that, so the wizard would have created the
 * account, funded it, deployed, and then failed partway through building the
 * tree with a storage error — after the user had already paid for all of it.
 *
 * NEAR charges 1e19 yocto per byte, so every kilobyte added to the contract
 * takes ~0.01 NEAR off the headroom. No constant can track that. Deriving the figure
 * means the contract can grow without quietly breaking onboarding, and the
 * wizard's printed bill stays true.
 */

/**
 * The protocol's storage price: 1e19 yoctoNEAR PER BYTE.
 *
 * Stated per byte on purpose. The usual shorthand "1 NEAR per 100 KB" is off
 * by 2.4% because a binary 100 KiB is 102,400 bytes and costs 1.024 NEAR.
 */
export function codeStakeYocto(bytes) {
  return BigInt(bytes) * 10n ** 19n;
}

/**
 * Room above the code stake for the vault's OWN state.
 *
 * 0.35 NEAR is ~35 KB: the default tree's nodes, agent and virtual-agent
 * bindings, the per-day ledgers, and a working request history. Deliberately
 * generous — it is refundable, and the failure it prevents happens after the
 * user has spent money.
 */
export const STATE_HEADROOM = 35n * 10n ** 22n; // 0.35 NEAR

/** What to transfer when creating the vault account. */
export function vaultFunding(wasmBytes) {
  return codeStakeYocto(wasmBytes) + STATE_HEADROOM;
}
