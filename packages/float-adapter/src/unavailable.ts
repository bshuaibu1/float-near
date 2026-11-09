/**
 * Could we not ASK the chain, or did the chain ANSWER?
 *
 * These are different facts and they must never share a code path. `/v1/resolve`
 * ended both of its reads with `.catch(() => null)` / `.catch(() => false)`,
 * so a transient RPC failure was reported as a statement about the user's
 * account:
 *
 *   vault_id_for threw  -> "No legal vault id for that account. An implicit
 *                          account (64 hex characters) cannot have one."
 *   accountExists threw -> "you do not have a vault yet"
 *
 * Both with HTTP 200, so the dashboard proxy — which deliberately does not
 * cache a failure — cached them as answers for the life of the process.
 *
 * MEASURED, NOT IMAGINED. Six identical calls against a running adapter gave
 * four correct answers and two nulls, because the adapter's own background
 * refusal-follower saturates its RPC budget and competes with request
 * handling. The user-visible result is the worst available one: somebody who
 * owns a populated vault is shown the create-one empty state and invited to
 * create a vault that already exists.
 *
 * MESSAGE MATCHING, AND WHY THAT IS ACCEPTABLE HERE. `viewFunction` throws a
 * plain `Error` with a constructed string, and `fetch` throws `TypeError` with
 * a platform string, so there is no status code or error class to branch on
 * without changing both. The strings are pinned by tests, and the failure
 * direction is chosen deliberately: an unrecognised error is treated as an
 * ANSWER, so a new transport failure shows up as a visible wrong answer rather
 * than as a silent infinite retry.
 */

/** Substrings that mean the request never got a verdict from the chain. */
const TRANSPORT = [
  "fetch failed",
  "enotfound",
  "econnrefused",
  "econnreset",
  "etimedout",
  "epipe",
  "socket hang up",
  "aborted",
  "timeout",
  "network",
  "endpoint is deprecated",
  /**
   * THE ONE THAT ACTUALLY BIT US, twice, and the second time in this very
   * file. fastnear answers a throttle with HTTP **200** and a JSON error
   * body, so `r.ok` is true and nothing downstream looks like a transport
   * failure. `accountExists` correctly refuses to guess and throws
   *
   *   could not determine whether X exists: Rate limits exceeded. For higher
   *   rate limits get a subscription at https://fastnear.com
   *
   * which matched NONE of the patterns above — no status code, no "fetch
   * failed" — so it was classified as an ANSWER and became `exists: false`.
   * The live dashboard told the owner of a vault holding 42.25 USDC that they
   * had none, and offered to create one.
   */
  "rate limit",
  "rate limits exceeded",
  "too many requests",
  "429",
  /**
   * The phrase `accountExists` uses when it cannot tell. It only throws when
   * it genuinely does not know — a real absence returns false without
   * throwing — so this wording is always uncertainty, never a verdict.
   */
  "could not determine whether",
];

/**
 * HTTP statuses that mean "ask again later" rather than "your request is
 * wrong". 429 is the one that actually bit us; 5xx is the same category.
 *
 * 400/404 are NOT here on purpose: retrying resends the same bad request, and
 * calling that "unavailable" would hide a real bug behind a retry loop.
 */
const RETRYABLE_HTTP = /returned http (408|425|429|5\d\d)\b/;

export function isUnavailable(e: unknown): boolean {
  const msg =
    e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!msg) return false;
  const m = msg.toLowerCase();

  if (RETRYABLE_HTTP.test(m)) return true;

  // A contract that PANICKED gave us an answer, even though it is an error.
  // Checked before the transport list because a panic message can contain a
  // word like "timeout" from the contract's own text.
  if (m.includes("panicked") || m.includes("wasm execution failed")) return false;

  return TRANSPORT.some((t) => m.includes(t));
}
