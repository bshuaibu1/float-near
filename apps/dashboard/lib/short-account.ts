/**
 * The signed-in account, shortened ONLY when shortening helps.
 *
 * This used to be `slice(0,4) + "..." + slice(-4)` for everything, which is
 * the Ethereum convention: `0x1234...abcd`. It is right for a hash, where the
 * head and tail are equally meaningless and the point is to let you compare
 * two of them at a glance.
 *
 * It is wrong for a NEAR NAMED account, which is a readable word. It rendered
 * `work12.testnet` - fourteen characters - as `work...tnet`, which is eleven.
 * Three characters saved, in exchange for hiding which account you are signed
 * in as and keeping "tnet", the tail of a network suffix every account on this
 * network shares. The two things a user might want to check, the name and the
 * network, were the two things removed.
 *
 * So the rule follows the account TYPE:
 *   - implicit (64 hex chars, a public key): head+tail, the hash convention
 *   - named, short: in full
 *   - named, long: keep the head, which is the part that distinguishes it
 */
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

/** Longest named account shown in full. `alice.sputnik-dao.near` is 22. */
const FULL_NAME_MAX = 24;

export function shortAccount(account: string | null | undefined): string | null {
  if (!account) return null;
  if (account.includes("@")) return account;
  if (IMPLICIT_ACCOUNT.test(account)) {
    return `${account.slice(0, 4)}...${account.slice(-4)}`;
  }
  if (account.length <= FULL_NAME_MAX) return account;
  // Named but long: the head identifies it, the suffix is shared boilerplate.
  return `${account.slice(0, FULL_NAME_MAX - 1)}…`;
}
