/**
 * The rules that decide whether someone is shown a control that deletes an
 * account which cannot be recovered.
 *
 * Every assertion here is about money surviving. The expensive direction is
 * always the same: saying a vault is empty when it is not, because the
 * tokens are gone the moment the account is deleted and no sequence of steps
 * recovers them.
 */
import { describe, it, expect } from "vitest";
import { teardownState, teardownCommand } from "./teardown";

describe("teardownState", () => {
  /**
   * THE ONE THAT MATTERS MOST.
   *
   * `/v1/vault-info` returns `vaultTokenBalance: null` when the token
   * contract cannot be read — an RPC failure, a token that does not answer,
   * a vault never registered with it. A falsy check (`!balance`) treats that
   * identically to "0", which green-lights a teardown of a vault that is
   * holding money.
   *
   * Unknown must block. Being wrong the other way costs a refresh.
   */
  it("treats an UNREADABLE balance as blocking, never as empty", () => {
    for (const unknown of [null, undefined, ""]) {
      const s = teardownState(unknown);
      expect(s.isEmpty, `${JSON.stringify(unknown)} was read as empty`).toBe(false);
      expect(s.blocker).toMatch(/unknown rather than zero|could not be read/i);
      // And no withdraw button either: there is nothing to say how much.
      expect(s.canWithdraw).toBe(false);
    }
  });

  it("is empty only on an exact zero", () => {
    const s = teardownState("0");
    expect(s.isEmpty).toBe(true);
    expect(s.blocker).toBeNull();
    // Nothing to withdraw, so that step is not offered.
    expect(s.canWithdraw).toBe(false);
  });

  /**
   * ONE BASE UNIT IS NOT ZERO. At 6 decimals that is 0.000001 USDC — a
   * figure that rounds to "0.00" in every display on the dashboard, which is
   * exactly why the check is on the raw base amount and not on anything a
   * user has read off a screen.
   */
  it("blocks on a balance too small to show", () => {
    const s = teardownState("1");
    expect(s.isEmpty).toBe(false);
    expect(s.canWithdraw).toBe(true);
    expect(s.blocker).toMatch(/still holds tokens/i);
  });

  it("offers the withdraw step whenever there is anything to move", () => {
    for (const bal of ["1", "12500000", "9007199254740993"]) {
      const s = teardownState(bal);
      expect(s.canWithdraw, `${bal} should be withdrawable`).toBe(true);
      expect(s.isEmpty).toBe(false);
    }
  });

  /**
   * DOCUMENTATION, NOT A GUARD — and labelled so rather than left to look
   * stronger than it is.
   *
   * A mutant replacing `BigInt(x)` with `BigInt(Number(x))` SURVIVES this,
   * and that is correct: every output here is decided by `> 0n`, `< 0n` and
   * `=== 0n`, and rounding a huge integer yields a different huge integer,
   * never zero and never a sign flip. No input distinguishes the two, so
   * this test cannot kill that mutant and nothing should pretend otherwise.
   *
   * Exactness matters on the withdraw AMOUNT, where the base-unit string is
   * passed through verbatim — a reparse there leaves dust and the vault
   * never reaches zero. That is pinned in payloads.test.ts, on the function
   * that actually carries the number.
   */
  it("uses BigInt, so a balance past 2^53 is read without rounding", () => {
    const big = "9007199254740993"; // 2^53 + 1
    expect(Number(big).toString()).not.toBe(big); // the cliff is real
    expect(teardownState(big).isEmpty).toBe(false);
  });

  /**
   * Garbage is not zero either — and HEX is the case that made this strict.
   *
   * `BigInt` accepts "0x10" as 16, so a bare BigInt parse does not reject a
   * hex string, it reinterprets one. The dangerous value is "0x0": BigInt
   * reads it as 0, which would report a malformed balance as an EMPTY vault
   * and unlock the delete. A NEP-141 balance is a decimal string, so only
   * that is accepted.
   */
  it("blocks on a balance that is not a plain decimal number", () => {
    for (const bad of ["lots", "12.5", "0x10", "0x0", "1e6", " 1", "1 ", "+1"]) {
      const s = teardownState(bad);
      expect(s.isEmpty, `${bad} was read as empty`).toBe(false);
      expect(s.blocker).toMatch(/not a number/i);
    }
  });

  /** Cannot happen, and is still not treated as empty if it does. */
  it("blocks on a negative balance rather than rationalising it", () => {
    const s = teardownState("-1");
    expect(s.isEmpty).toBe(false);
    expect(s.canWithdraw).toBe(false);
    expect(s.blocker).toMatch(/negative/i);
  });

  /**
   * NO INPUT PRODUCES "empty AND withdrawable". They are opposite answers to
   * the same question, and a state carrying both would let a UI show the
   * delete step beside a non-zero balance.
   */
  it("never reports a vault as both empty and holding something", () => {
    for (const v of [null, undefined, "", "0", "1", "-1", "lots", "0x0", "0x10", "9007199254740993"]) {
      const s = teardownState(v);
      expect(s.isEmpty && s.canWithdraw, `${JSON.stringify(v)} produced both`).toBe(false);
    }
  });

  /** A blocker is shown to a person, so it has to say what to do. */
  it("always explains a block, and never blocks silently", () => {
    for (const v of [null, "", "1", "-1", "lots"]) {
      const s = teardownState(v);
      expect(s.isEmpty).toBe(false);
      expect(s.blocker, `${JSON.stringify(v)} blocked with no reason`).toBeTruthy();
      expect(s.blocker!.length).toBeGreaterThan(20);
    }
  });
});

describe("teardownCommand", () => {
  /**
   * The network is NOT optional. `teardown-vault.mjs` defaults to testnet,
   * so a mainnet teardown copied without it runs against the wrong chain —
   * a confusing no-op if you are lucky.
   */
  it("names the network and the vault", () => {
    const c = teardownCommand("v.fac.near", "mainnet");
    expect(c).toContain("NETWORK=mainnet");
    expect(c).toContain("VAULT=v.fac.near");
    expect(c).toContain("scripts/teardown-vault.mjs");
  });

  /** The script it names has to exist, or this is a dead instruction. */
  it("points at a script that is really there", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const p = resolve(import.meta.dirname, "..", "..", "..", "scripts", "teardown-vault.mjs");
    expect(existsSync(p), `${p} does not exist; the command would be a dead end`).toBe(true);
  });
});
