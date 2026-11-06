/**
 * The account shortener in the top bar.
 *
 * Lives in lib/ as a test target because the component it sits in cannot be
 * rendered here - the dashboard has no DOM test environment - but the RULE is
 * pure and is the part that was wrong.
 */
import { describe, it, expect } from "vitest";
import { shortAccount } from "./short-account";

describe("shortAccount", () => {
  /**
   * THE REGRESSION. `work12.testnet` was rendered as `work...tnet`: three
   * characters saved, in exchange for hiding both the account name and the
   * network. It was the Ethereum `0x1234...abcd` convention applied to a word.
   */
  it("shows a short NEAR named account in full", () => {
    expect(shortAccount("work12.testnet")).toBe("work12.testnet");
    expect(shortAccount("alice.near")).toBe("alice.near");
    expect(shortAccount("work12.testnet")).not.toContain("...");
  });

  it("keeps the head of a long named account, not its shared suffix", () => {
    const long = "a-very-long-organisation-name.sputnik-dao.near";
    const out = shortAccount(long)!;
    expect(out.startsWith("a-very-long")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(24);
    // the distinguishing part survives; the boilerplate is what goes
    expect(out).not.toContain("sputnik-dao");
  });

  /**
   * The hash convention IS right here: an implicit account is a public key,
   * so head and tail are equally meaningless and the pair is what lets you
   * compare two at a glance.
   */
  it("uses head...tail for an implicit (64-hex) account", () => {
    const implicit = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";
    expect(shortAccount(implicit)).toBe("9879...d6de");
  });

  it("leaves an email-style label alone", () => {
    expect(shortAccount("bashir@example.com")).toBe("bashir@example.com");
  });

  it("returns null for nothing, rather than 'null'", () => {
    expect(shortAccount(null)).toBeNull();
    expect(shortAccount(undefined)).toBeNull();
    expect(shortAccount("")).toBeNull();
  });

  /** A 64-char NAMED account is not implicit - hex is the distinguishing test. */
  it("does not mistake a long named account for an implicit one", () => {
    const named = "z".repeat(55) + ".testnet";
    expect(shortAccount(named)).not.toMatch(/^z{4}\.\.\./);
  });
});
