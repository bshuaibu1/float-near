/**
 * Did the cross-chain payment actually arrive?
 *
 * Three ways this has already gone wrong, each on a real mainnet payment, and
 * each is a state this function keeps separate:
 *
 *   1. A FAILED QUERY IS NOT A ZERO. `eth_getLogs` over a wide range answers
 *      HTTP 429, and reading that as `.result ?? []` turned a failed query into
 *      "0 inbound transfers" — reported as evidence the payment had not
 *      arrived, while the transfer sat inside the scanned range the whole time.
 *   2. TOO EARLY IS NOT SHORT. Sampling once immediately after paying reported
 *      SHORT for a payment still in flight; the solver's own estimate was 22s.
 *   3. A BALANCE DELTA IS NOT EVIDENCE when anything else can touch the
 *      account. The payee moved 0.65 USDC out between two readings, so the
 *      delta read -0.65 for a payment that delivered 0.10 exactly.
 *
 * Hence: the transfer EVENT is authoritative, the balance delta is
 * corroboration at best, and `null` (query failed) never collapses into `[]`
 * (nothing found). Those demand different responses — retry the query, wait, or
 * investigate — and a verifier that cannot tell them apart will confidently
 * pick the wrong one.
 *
 * @param inbound  array of {amount: bigint} transfers TO the payee since the
 *                 payment, or NULL when the chain could not be read.
 * @param etaMs    the solver's own estimate plus slack. Bounding the wait by
 *                 what the counterparty promised beats a number picked here.
 */
export function deliveryVerdict({
  inbound,
  expected,
  beforeBalance,
  afterBalance,
  elapsedMs = 0,
  etaMs = 90_000,
}) {
  if (inbound == null) {
    return {
      state: "unknown",
      delivered: null,
      note:
        "the chain could not be read, which is NOT evidence of non-delivery — " +
        "retry, or check a block explorer directly",
    };
  }

  const delivered = inbound.reduce((a, t) => a + BigInt(t.amount), 0n);
  const want = BigInt(expected);
  const pastEta = elapsedMs > etaMs;

  if (delivered >= want) {
    // The event is authoritative. A balance that disagrees means something ELSE
    // moved funds — worth saying, never worth overriding the event with.
    let note;
    if (beforeBalance != null && afterBalance != null) {
      const delta = BigInt(afterBalance) - BigInt(beforeBalance);
      if (delta !== delivered) {
        note =
          `the balance moved by ${delta} while ${delivered} was delivered — ` +
          "something other than this payment touched the account, so the " +
          "balance delta is not a reading of this payment";
      }
    }
    return { state: "delivered", delivered, ...(note ? { note } : {}) };
  }

  // Nothing yet, or not enough yet. Inside the solver's window that is simply
  // early; past it, the two cases differ and so should the message.
  if (!pastEta) return { state: "pending", delivered };
  if (delivered === 0n) {
    return {
      state: "not-seen",
      delivered,
      note: "past the solver's estimate with nothing received — investigate rather than keep waiting",
    };
  }
  return {
    state: "short",
    delivered,
    note: "less arrived than the quote promised, which is a problem with the fill",
  };
}

/** One line per verdict, in the wording each state actually warrants. */
export function deliveryLine(v, fmt = (n) => String(n)) {
  switch (v.state) {
    case "delivered":
      return `DELIVERED ${fmt(v.delivered)}${v.note ? `  (${v.note})` : ""}`;
    case "pending":
      return `not yet — ${fmt(v.delivered)} so far, still inside the solver's estimate`;
    case "short":
      return `SHORT FILL — only ${fmt(v.delivered)} arrived. ${v.note}`;
    case "not-seen":
      return `NOTHING RECEIVED. ${v.note}`;
    default:
      return `UNKNOWN — ${v.note}`;
  }
}
