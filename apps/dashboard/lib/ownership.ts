/**
 * Does the vault on screen belong to the wallet looking at it?
 *
 * THE ADAPTER SERVES ONE VAULT AND IGNORES WHO IS ASKING. `NEAR_VAULT_CONTRACT`
 * names it; the dashboard sends `?owner=<wallet>` and nothing reads it. So
 * connecting any wallet rendered whatever vault the adapter was pointed at,
 * with nothing on the page saying it belonged to someone else. The numbers
 * looked like yours.
 *
 * NOTHING LEAKS, and that distinction matters for how loudly to say this. A
 * vault's balance, tree and history are public on chain and readable by anyone
 * with no key at all — the dashboard is a viewer for data that was never
 * private. The damage is that a person ACTS on figures that are not theirs:
 * funding a balance they do not own, or concluding their agent overspent when
 * it was somebody else's agent.
 *
 * Pure, and in lib/ rather than inline in the page, because the condition is
 * the whole guard and a condition nobody can test is a guard nobody can trust.
 */

export type OwnershipVerdict =
  /** Show the dashboard. */
  | { show: true }
  /** Replace the dashboard; `vaultOwner` is who actually owns it. */
  | { show: false; connected: string; vaultOwner: string };

export function ownershipVerdict(input: {
  /** The connected wallet, or null before one is connected. */
  connected?: string | null;
  /** The vault's own `get_config.owner`, as the adapter reports it. */
  vaultOwner?: string | null;
}): OwnershipVerdict {
  const connected = input.connected?.trim();
  const vaultOwner = input.vaultOwner?.trim();

  /**
   * UNKNOWN IS NOT A MISMATCH, in either direction.
   *
   * Before a wallet is connected there is nobody to compare against, and the
   * page already refuses to fetch. If the adapter is unreachable or did not
   * report an owner, we do not know whose vault this is — and blocking on
   * "could not check" would make every adapter hiccup look like a theft
   * warning, which is how a real warning gets trained away.
   */
  if (!connected || !vaultOwner) return { show: true };

  /**
   * NEAR account ids are lowercase by protocol rule, but a wallet or a URL
   * can hand back mixed case. Comparing raw would call a match a mismatch and
   * lock someone out of their own vault, which is worse than the bug this
   * fixes.
   */
  if (connected.toLowerCase() === vaultOwner.toLowerCase()) return { show: true };

  return { show: false, connected, vaultOwner };
}
