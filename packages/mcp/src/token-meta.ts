/**
 * What a token is CALLED, and how many decimals it really has.
 *
 * WHY. Caps, balances and errors were all rendered with the raw NEP-141
 * account id, and on mainnet USDC that is
 * `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` — 64
 * hex characters appearing in `vault_tree`, `vault_budget`, the teardown
 * report and every "no limit for that token" message. Nobody reading a budget
 * can tell that is USDC, and two different tokens look identical at a glance
 * until you diff the strings.
 *
 * AND IT FIXES A REAL CORRECTNESS LIMIT, not just readability. `vault_tree`
 * could only humanise the ONE token whose decimals the operator had
 * configured; any other kept base units, because scaling by a guessed
 * exponent prints a figure wrong by orders of magnitude while looking tidy.
 * The chain knows the answer — `ft_metadata` returns it — so the guess was
 * never necessary. Every token can now be rendered correctly.
 *
 * CACHED FOR THE PROCESS LIFETIME. Metadata is immutable in practice (a token
 * that changed its decimals would break every holder), and a budget read
 * should not make an extra round trip per node per token. A failed lookup is
 * cached as `null` too: the common cause is an account that is not a token at
 * all, and retrying that on every render turns one bad id into a storm.
 */
export interface TokenMeta {
  symbol: string;
  decimals: number;
}

type Fetcher = (rpcUrl: string, token: string) => Promise<unknown>;

const cache = new Map<string, TokenMeta | null>();

/** Visible for tests; a process-lifetime cache is otherwise untestable. */
export function clearTokenMetaCache(): void {
  cache.clear();
}

export async function tokenMeta(
  rpcUrl: string,
  token: string,
  view: Fetcher,
): Promise<TokenMeta | null> {
  if (cache.has(token)) return cache.get(token) ?? null;
  let meta: TokenMeta | null = null;
  try {
    const raw = (await view(rpcUrl, token)) as { symbol?: unknown; decimals?: unknown } | null;
    // BOTH FIELDS OR NEITHER. A partial answer is worse than none: a symbol
    // without decimals invites rendering with the configured default, which
    // is the wrong-exponent bug this exists to remove.
    if (
      raw &&
      typeof raw.symbol === "string" &&
      raw.symbol.length > 0 &&
      // REDUNDANT WITH THE NEXT LINE, kept for readability. Mutation-tested:
      // removing this changes nothing because Number.isInteger(undefined) is
      // already false, so `Number.isInteger` is the clause actually carrying
      // the guard. Delete that one and the suite reds; delete this one and it
      // does not.
      typeof raw.decimals === "number" &&
      Number.isInteger(raw.decimals) &&
      raw.decimals >= 0 &&
      raw.decimals <= 24
    ) {
      meta = { symbol: raw.symbol, decimals: raw.decimals };
    }
  } catch {
    meta = null;
  }
  cache.set(token, meta);
  return meta;
}

/**
 * `USDC` where known, the raw id where not — never a symbol alone.
 *
 * The id stays because a symbol is NOT unique: anyone can deploy a token
 * calling itself USDC, and a budget that names only the symbol cannot be
 * checked against the one the user meant. This is money; the identifier has
 * to remain visible.
 */
export function label(token: string, meta: TokenMeta | null): string {
  return meta ? `${meta.symbol} (${token})` : token;
}
