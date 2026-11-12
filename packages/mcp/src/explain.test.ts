import { describe, it, expect } from "vitest";
import { explainOutcome } from "./explain.js";

/**
 * This is product COPY, so the tests are about what a person is told.
 *
 * The bar that matters and is easy to lose: no ALL-CAPS reason code may reach
 * the sentence, and the sentence must never imply money moved when it did not.
 */

const BASE = { amount: "15", recipient: "test015.near", symbol: "USDC" };

/**
 * A leaked reason code, as distinct from a TOKEN SYMBOL.
 *
 * The first version was `/\b[A-Z][A-Z_]{3,}\b/` and it flagged "USDC" — six
 * tests failed on sentences that were perfectly fine. The symbol BELONGS in the
 * copy ("Sent 0.25 USDC"); the code does not. An UNDERSCORE is what actually
 * separates the two, so that is what this matches.
 *
 * Codes without underscores (SETTLED, COOLDOWN) slip past it, so every case
 * ALSO asserts its own specific code is absent. The pair covers both shapes and
 * neither alone does.
 */
const LOOKS_LIKE_A_CODE = /\b[A-Z]{2,}_[A-Z_]+\b/;

describe("no raw reason code reaches the user-facing sentence", () => {
  const CODES = [
    "PER_TX_LIMIT",
    "PARENT_PER_TX_LIMIT",
    "DAILY_BUDGET",
    "PARENT_DAILY_BUDGET",
    "COOLDOWN",
    "PARENT_COOLDOWN",
    "NO_RECIPIENTS_SET",
    "RECIPIENT_NOT_ALLOWED",
    "VAULT_PAUSED",
    "NODE_FROZEN",
    "TOKEN_NOT_ALLOWED",
    "APPROVAL_REQUIRED",
    "APPROVAL_REJECTED",
    "DUPLICATE_REQUEST",
    "INVALID_AMOUNT",
    "INVALID_MEMO",
    "SETTLED",
    "TRANSFER_FAILED",
    "TRANSFER_PENDING",
  ];

  /**
   * EVERY CODE IN BOTH BRANCHES.
   *
   * The first version passed only the bare context, so `perTxCap` and
   * `available` were undefined and every message took its FALLBACK branch. The
   * branches that quote real numbers — the ones a user actually sees — were
   * never checked for leaks at all. A mutation that put
   * "PARENT_PER_TX_LIMIT:" straight into the with-cap sentence passed all 31
   * tests.
   *
   * So each code runs twice: once with nothing known, once with every figure
   * populated.
   */
  const CONTEXTS = [
    ["no figures known", {}],
    ["figures known", { perTxCap: "10", available: "0.5", dailyCap: "25", cooldownLeftSec: 90 }],
  ] as const;

  for (const code of CODES) {
    for (const [label, extra] of CONTEXTS) {
      it(`${code} is explained without printing the code (${label})`, () => {
        const e = explainOutcome({ ...BASE, ...extra, status: "BLOCKED", reason_code: code });
        expect(e.say).not.toMatch(LOOKS_LIKE_A_CODE);
        // Catches the underscore-free codes the regex cannot see (SETTLED, COOLDOWN).
        expect(e.say, `the code itself leaked into the sentence for ${code}`).not.toContain(code);
        // `next_step` is shown to the user too, so it is held to the same bar —
        // except for the unknown-code case, where offering the raw value is the
        // deliberate and most useful behaviour.
        if (e.next && code !== "SOME_NEW_RULE") {
          expect(e.next, `the code leaked into next_step for ${code}`).not.toContain(code);
        }
        expect(e.say.length).toBeGreaterThan(10);
        // Short. The user asked for "not a long string of technical jargon".
        expect(e.say.length, `too long for ${code}: ${e.say}`).toBeLessThan(240);
      });
    }
  }
});

describe("the limit cases name the real numbers", () => {
  it("per-payment limit says the cap and what was asked", () => {
    const e = explainOutcome({
      ...BASE,
      status: "BLOCKED",
      reason_code: "PARENT_PER_TX_LIMIT",
      perTxCap: "10",
    });
    expect(e.say).toContain("10 USDC");
    expect(e.say).toContain("15");
    expect(e.next).toContain("10 USDC or less");
    // "That's over the limit" is barely better than the code itself.
    expect(e.moved).toBe(false);
  });

  it("falls back gracefully when the cap could not be read", () => {
    const e = explainOutcome({ ...BASE, status: "BLOCKED", reason_code: "PER_TX_LIMIT" });
    expect(e.say).not.toMatch(LOOKS_LIKE_A_CODE);
    expect(e.next).toBeTruthy();
  });

  it("daily budget offers the remaining amount as the next step", () => {
    const e = explainOutcome({
      ...BASE,
      status: "BLOCKED",
      reason_code: "DAILY_BUDGET",
      available: "0.5",
      dailyCap: "25",
    });
    expect(e.say).toContain("0.5 USDC");
    expect(e.next).toContain("0.5 USDC or less");
    expect(e.next).toContain("midnight UTC");
  });

  it("a spent-out daily budget does not suggest sending zero", () => {
    const e = explainOutcome({
      ...BASE,
      status: "BLOCKED",
      reason_code: "DAILY_BUDGET",
      available: "0",
      dailyCap: "25",
    });
    expect(e.next).not.toContain("0 USDC or less");
    expect(e.next).toContain("midnight UTC");
  });
});

describe("PARENT_DAILY_BUDGET explains the counter-intuitive part", () => {
  it("says the agent's own room is fine but the shared pool is not", () => {
    const e = explainOutcome({ ...BASE, status: "BLOCKED", reason_code: "PARENT_DAILY_BUDGET" });
    // The whole point: the agent's OWN allowance can look free, so a user who
    // checks their budget and sees room is otherwise left thinking it is broken.
    expect(e.say).toMatch(/still has room/i);
    expect(e.say).toMatch(/shared/i);
  });
});

describe("nothing claims money moved when it did not", () => {
  it("every refusal says nothing was sent and reports moved=false", () => {
    for (const code of ["PER_TX_LIMIT", "DAILY_BUDGET", "VAULT_PAUSED", "NODE_FROZEN"]) {
      const e = explainOutcome({ ...BASE, status: "BLOCKED", reason_code: code });
      expect(e.moved, code).toBe(false);
      expect(e.say, code).toMatch(/nothing was sent/i);
    }
  });

  it("TRANSFER_FAILED reassures that the money is still there", () => {
    const e = explainOutcome({ ...BASE, status: "TRANSFER_FAILED", reason_code: "TRANSFER_FAILED" });
    expect(e.say).toMatch(/nothing left the vault/i);
    expect(e.moved).toBe(false);
  });

  it("APPROVAL_REQUIRED reads as waiting, not as failure or success", () => {
    const e = explainOutcome({ ...BASE, status: "BLOCKED", reason_code: "APPROVAL_REQUIRED" });
    expect(e.say).toMatch(/waiting/i);
    expect(e.say).toMatch(/nothing has been sent/i);
    expect(e.moved).toBe(false);
  });

  it("TRANSFER_PENDING does not claim it arrived", () => {
    const e = explainOutcome({ ...BASE, status: "TRANSFER_PENDING" });
    expect(e.say).toMatch(/on its way|hasn't confirmed/i);
    expect(e.say).not.toMatch(/\bsent 15 USDC to\b/i);
  });
});

describe("success says what happened, plainly", () => {
  it("names the amount, the payee, and what is left", () => {
    const e = explainOutcome({
      amount: "0.25",
      recipient: "test015.near",
      symbol: "USDC",
      status: "SETTLED",
      reason_code: "SETTLED",
      available: "24.75",
    });
    expect(e.say).toBe("Sent 0.25 USDC to test015.near. There's 24.75 USDC left to spend today.");
    expect(e.moved).toBe(true);
    expect(e.next).toBeNull();
  });

  it("still works when the remaining budget could not be read", () => {
    const e = explainOutcome({ ...BASE, status: "SETTLED", amount: "0.25" });
    expect(e.say).toBe("Sent 0.25 USDC to test015.near.");
    expect(e.moved).toBe(true);
  });
});

/**
 * An unrecognised code is the ONE place the raw value is the most useful thing
 * the user can pass on. Inventing a friendly sentence for a rule we cannot
 * describe would be worse than admitting we do not recognise it.
 */
describe("an unknown code is handled honestly", () => {
  it("explains plainly, then offers the code for reporting", () => {
    const e = explainOutcome({ ...BASE, status: "BLOCKED", reason_code: "SOME_NEW_RULE" });
    expect(e.say).not.toMatch(LOOKS_LIKE_A_CODE);
    expect(e.say).toMatch(/nothing was sent/i);
    expect(e.next).toContain("SOME_NEW_RULE");
  });
});
