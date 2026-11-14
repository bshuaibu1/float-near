/**
 * Turn a payment outcome into something a person would actually say.
 *
 * WHY THE SERVER DOES THIS AND NOT THE MODEL. Two reasons, and the second is
 * the one that decides it.
 *
 * First, the old instructions literally said "Report the reason code", so the
 * agent did: a user asking to pay someone got `PARENT_PER_TX_LIMIT` back. That
 * is a correct answer to a question nobody asked. Telling the model "be
 * friendly" instead would help, but phrasing drifts between models, between
 * versions, and between one conversation and the next.
 *
 * Second, and decisively: a USEFUL explanation needs NUMBERS the model does
 * not have. "That's over the limit" is nearly as useless as the raw code. What
 * a person needs is "the most you can send in one payment is 10, and this asked
 * for 15 — try 10 or less". Those figures live in the budget tree, which the
 * payment response never carried. So the server reads them and writes the
 * sentence; the agent relays it.
 *
 * THE CODE IS KEPT, not discarded. Precision about WHICH rule fired is a real
 * asset — `PARENT_DAILY_BUDGET` meaning "a sibling drained the shared pool" is
 * something a flat policy model cannot express, and developers and the pitch
 * both want it. So it stays in the payload under `technical`, out of the way
 * of the sentence a user sees.
 *
 * HOUSE STYLE, since this is product copy:
 *   - one or two short sentences, no jargon, no ALL-CAPS codes
 *   - name the real numbers and the real token symbol
 *   - say what to do next when there IS something to do
 *   - never imply money moved when it did not, and never imply it is gone
 *     when the refusal was free
 */

/** What the contract returned, plus whatever context the handler could gather. */
export interface OutcomeContext {
  status?: string;
  reason_code?: string;
  /** Human-units amount that was requested, e.g. "15". */
  amount: string;
  recipient: string;
  /** Token symbol if known ("USDC"), else a short id. */
  symbol: string;
  /** Per-payment cap in human units, when known. */
  perTxCap?: string | undefined;
  /** Remaining budget today in human units, when known. */
  available?: string | undefined;
  /** Daily cap in human units, when known. */
  dailyCap?: string | undefined;
  /** Seconds left on a cooldown, when known. */
  cooldownLeftSec?: number | undefined;
}

export interface Explanation {
  /** The sentence(s) to say to the user. No codes, no jargon. */
  say: string;
  /** A concrete next step, or null when there is nothing for the user to do. */
  next: string | null;
  /** True when value actually moved. */
  moved: boolean;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "2 minutes", "3 hours" — a duration a person can act on. */
function human(sec: number): string {
  if (sec < 60) return `${sec} ${plural(sec, "second", "seconds")}`;
  const m = Math.ceil(sec / 60);
  if (m < 60) return `${m} ${plural(m, "minute", "minutes")}`;
  const h = Math.ceil(m / 60);
  return `${h} ${plural(h, "hour", "hours")}`;
}

export function explainOutcome(c: OutcomeContext): Explanation {
  const amt = `${c.amount} ${c.symbol}`;
  const code = c.reason_code ?? "";

  // ---- It worked. Say what happened, in that order: what, to whom, what is left.
  if (c.status === "SETTLED" || code === "SETTLED") {
    const left =
      c.available !== undefined
        ? ` There's ${c.available} ${c.symbol} left to spend today.`
        : "";
    return { say: `Sent ${amt} to ${c.recipient}.${left}`, next: null, moved: true };
  }

  // ---- In flight. Do NOT claim it arrived.
  if (c.status === "TRANSFER_PENDING" || code === "TRANSFER_PENDING") {
    return {
      say: `The ${amt} payment to ${c.recipient} is on its way — it hasn't confirmed yet.`,
      next: "Check again in a moment to see whether it completed.",
      moved: true,
    };
  }

  /**
   * ---- Approved by the rules, then the transfer itself failed.
   *
   * Said carefully: the budget was NOT charged, and people assume a failed
   * payment means missing money. The usual cause is a payee not registered on
   * the token, which is a real thing they can fix.
   */
  if (c.status === "TRANSFER_FAILED" || code === "TRANSFER_FAILED") {
    return {
      say:
        `The ${amt} payment to ${c.recipient} didn't go through, so nothing left the vault. ` +
        `Usually that means ${c.recipient} isn't set up to receive ${c.symbol} yet.`,
      next: `Ask ${c.recipient} to register for ${c.symbol}, then try again.`,
      moved: false,
    };
  }

  const nothingMoved = " Nothing was sent.";

  switch (code) {
    // ---- The two limit shapes, which are the ones users actually meet.
    case "PER_TX_LIMIT":
    case "PARENT_PER_TX_LIMIT": {
      const cap = c.perTxCap;
      const whose =
        code === "PARENT_PER_TX_LIMIT"
          ? "a limit set higher up the budget"
          : "this agent's limit";
      return {
        say: cap
          ? `That's too big for one payment — ${whose} caps each payment at ${cap} ${c.symbol}, ` +
            `and this asked for ${c.amount}.${nothingMoved}`
          : `That's more than ${whose} allows in a single payment.${nothingMoved}`,
        next: cap
          ? `Send ${cap} ${c.symbol} or less, or ask the vault owner to raise the per-payment limit.`
          : "Try a smaller amount, or ask the vault owner to raise the per-payment limit.",
        moved: false,
      };
    }

    case "DAILY_BUDGET": {
      const left = c.available;
      return {
        say: left
          ? `That would go past today's spending limit — ${left} ${c.symbol} is left of ` +
            `${c.dailyCap ?? "today's"} ${c.symbol}, and this asked for ${c.amount}.${nothingMoved}`
          : `Today's spending limit is used up.${nothingMoved}`,
        next:
          left && Number(left) > 0
            ? `Send ${left} ${c.symbol} or less, or wait — the limit resets at midnight UTC.`
            : "The limit resets at midnight UTC, or the owner can raise it.",
        moved: false,
      };
    }

    /**
     * The one worth explaining properly, because the obvious reading is wrong:
     * this agent's OWN allowance can look completely free.
     */
    case "PARENT_DAILY_BUDGET":
      return {
        say:
          `This agent still has room, but the shared pool it spends from is used up for today — ` +
          `another agent got there first.${nothingMoved}`,
        next: "The pool resets at midnight UTC, or the owner can raise the shared limit.",
        moved: false,
      };

    case "COOLDOWN":
    case "PARENT_COOLDOWN":
      return {
        say:
          `Payments from here are spaced out, and the next one isn't due yet` +
          `${c.cooldownLeftSec ? ` — about ${human(c.cooldownLeftSec)} to go` : ""}.${nothingMoved}`,
        next: "Try again shortly.",
        moved: false,
      };

    // ---- Owner decisions. The user cannot fix these themselves, so say who can.
    case "NO_RECIPIENTS_SET":
      return {
        say: `This agent isn't cleared to pay anyone yet.${nothingMoved}`,
        next: "The vault owner needs to approve a list of payees first.",
        moved: false,
      };

    case "RECIPIENT_NOT_ALLOWED":
      return {
        say: `${c.recipient} isn't on this agent's approved list of payees.${nothingMoved}`,
        next: "The vault owner decides who can be paid, and can add them.",
        moved: false,
      };

    case "VAULT_PAUSED":
      return {
        say: `The vault is paused, so no payments can go out right now.${nothingMoved}`,
        next: "The vault owner can unpause it.",
        moved: false,
      };

    case "NODE_FROZEN":
      return {
        say: `This agent is frozen, so it can't spend.${nothingMoved}`,
        next: "The vault owner can unfreeze it.",
        moved: false,
      };

    case "TOKEN_NOT_ALLOWED":
      return {
        say: `This agent doesn't have a ${c.symbol} budget.${nothingMoved}`,
        next: `The vault owner can give it one, or pay in a token it does have.`,
        moved: false,
      };

    /**
     * Not a refusal — a pause. Must not read as a failure, and must not read
     * as done either.
     */
    case "APPROVAL_REQUIRED":
      return {
        say:
          `${amt} to ${c.recipient} is large enough to need the owner's sign-off, so it's ` +
          `waiting for them. Nothing has been sent yet.`,
        next: "Ask the vault owner to approve it.",
        moved: false,
      };

    case "APPROVAL_REJECTED":
      return {
        say: `The vault owner turned down the ${amt} payment to ${c.recipient}.${nothingMoved}`,
        next: null,
        moved: false,
      };

    case "DUPLICATE_REQUEST":
      return {
        say: "That exact payment was already submitted, so it wasn't sent twice.",
        next: "Check whether the first one went through before trying again.",
        moved: false,
      };

    case "INVALID_AMOUNT":
      return { say: `${c.amount} isn't a valid amount to send.`, next: "Use an amount above zero.", moved: false };

    case "INVALID_MEMO":
      return {
        say: "The note attached to that payment isn't allowed — it's too long or has odd characters.",
        next: "Shorten the note and try again.",
        moved: false,
      };

    default: {
      /**
       * UNKNOWN CODE: say plainly that it was refused and that nothing moved,
       * and THEN give the code — because an unrecognised code is the one case
       * where the raw value is genuinely the most useful thing a user can pass
       * on to whoever can help. Guessing a friendly sentence for a rule we
       * cannot describe would be worse than admitting it.
       */
      if (!code) {
        return { say: `The ${amt} payment to ${c.recipient} didn't go through.${nothingMoved}`, next: null, moved: false };
      }
      return {
        say: `The payment was refused by the vault's rules, so nothing was sent.`,
        next: `If you need to report this, the reason given was "${code}".`,
        moved: false,
      };
    }
  }
}

/**
 * The user-facing sentence for an UNSIGNED owner payload.
 *
 * WHY PLAN TOOLS NEEDED THIS TOO. `vault_pay` returned `say`/`next_step`/
 * `money_moved` and the plan tools returned `{action, summary, warnings,
 * unsigned_payload, approve_with}` — five technical keys and no sentence. So
 * agents narrated the mechanism: "returns an unsigned payload; the server does
 * not sign; run `near contract call-function`…". All true, and unusable by the
 * person who asked to raise a limit.
 *
 * THE THREE THINGS A PERSON NEEDS HERE, in order:
 *   1. this needs YOU — the agent cannot do it
 *   2. what it will do, in the units they named
 *   3. nothing has happened yet
 *
 * (3) matters most and is the easiest to leave out. An unsigned payload is a
 * *proposal*; an agent that says "I've raised the limit" has lied about state
 * the user is about to be asked to change themselves.
 *
 * `summary` is reused verbatim rather than rewritten. It is built where the
 * amounts and tokens are known, in the units the caller passed, and
 * duplicating that formatting here is how the two drift into disagreeing about
 * a number. It does still say "node 1" — the honest fix for that is better
 * summaries in `payloads.ts`, not a second renderer guessing at them here.
 */
export function planVoice(p: {
  summary: string;
  depositYocto?: string;
  warnings?: string[];
}): { say: string; next: string } {
  const bits: string[] = [];

  // (1) and (2) together, because "needs you" is meaningless without "to do
  // what". Leading with the actor is what stops the agent claiming the credit.
  bits.push(`This one needs you — I can't make this change myself. ${p.summary}.`);

  /**
   * A DEPOSIT IS STATED, ALWAYS, WHEN THERE IS ONE.
   *
   * 1 yoctoNEAR is the NEP-141 anti-phishing deposit — a rounding error that
   * no person should ever be told about. Anything larger is real money leaving
   * their wallet, and a wallet prompt showing an unexplained NEAR figure is
   * the fastest way to make a safe action look like a scam.
   */
  const dep = BigInt(p.depositYocto ?? "0");
  if (dep > 1n) {
    const near = (Number(dep) / 1e24).toFixed(3).replace(/\.?0+$/, "");
    bits.push(`It sends ${near} NEAR with it, which the vault keeps — not a fee.`);
  }

  // (3). Said last so it is the thing left ringing.
  bits.push("Nothing has changed yet.");

  // `warnings` is non-empty only for destructive or hard-to-undo actions, so
  // when one exists it outranks brevity.
  const firstWarning = (p.warnings ?? []).find(
    (w): w is string => typeof w === "string" && !!w.trim(),
  );
  if (firstWarning) bits.push(firstWarning);

  return {
    say: bits.join(" "),
    next: "Approve it in your wallet, then tell me and I'll confirm it went through.",
  };
}
