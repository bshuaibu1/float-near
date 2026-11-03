import { describe, expect, it } from "vitest";

import { buildCreatePlan, CONTRACT_BYTES, FACTORY_BY_NETWORK } from "./create.js";

/**
 * The create plan is the ONE place this server talks to a user who does not
 * have a vault yet, so everything it reports has to be true before they sign.
 *
 * Note what is NOT tested here and could not be: the vault id. That comes from
 * the factory's own `vault_id_for` view, deliberately, so there is no second
 * implementation of the derivation to drift. These tests cover the arithmetic
 * and the refusals around it.
 */

const base = {
  owner: "alice.near",
  vaultId: "alice-near.float.near",
  factory: "float.near",
  network: "mainnet" as const,
  requiredDepositYocto: (10n ** 23n).toString(), // 0.1
  paused: false,
  appUrl: "https://app.usefloat.xyz",
};

describe("buildCreatePlan", () => {
  it("asks for the required deposit plus storage for every byte of the contract", () => {
    const p = buildCreatePlan(base);
    // 0.1 + 301033 * 1e19
    const expected = 10n ** 23n + BigInt(CONTRACT_BYTES) * 10n ** 19n;
    expect(p.depositYocto).toBe(expected.toString());
  });

  it("reports the deposit in NEAR, because nobody reads yoctoNEAR", () => {
    const p = buildCreatePlan(base);
    expect(p.depositNear).toMatch(/^3\.\d+$/);
  });

  /**
   * THE GAS RESERVATION IS PART OF WHAT A USER MUST HOLD, and leaving it out
   * of the quoted figure is exactly what rejected the first real mainnet-style
   * attempt in a wallet:
   *
   *   does not have enough balance 3.5234 for operation costing 3.674061500357969
   *
   * The deposit was 3.3703; the missing 0.3037 was the 300 TGas reservation at
   * the maximum gas price. A plan that quotes only the deposit sends the user
   * to a wallet that refuses them.
   */
  it("quotes a total that includes the gas reservation, not just the deposit", () => {
    const p = buildCreatePlan(base);
    const deposit = BigInt(p.depositYocto);
    const total = BigInt(p.totalRequiredYocto);
    expect(total).toBeGreaterThan(deposit);
    // 200 TGas * 1e9 = 0.2 NEAR
    expect(total - deposit).toBe(200n * 10n ** 12n * 10n ** 9n);
  });

  it("puts the owner on the url so the page does not have to guess", () => {
    const p = buildCreatePlan(base);
    const u = new URL(p.url);
    expect(u.searchParams.get("owner")).toBe("alice.near");
    expect(u.searchParams.get("factory")).toBe("float.near");
    expect(u.searchParams.get("network")).toBe("mainnet");
  });

  /** A paused factory must be reported BEFORE a user is sent to a wallet. */
  it("refuses when the factory is paused", () => {
    expect(() => buildCreatePlan({ ...base, paused: true })).toThrow(/paused/i);
  });

  /**
   * An implicit account has no derived vault: its id is already 64 characters
   * with no dots, so `<prefix>.<factory>` cannot be a legal account id. The
   * factory returns null from `vault_id_for` rather than panicking, and this
   * has to become a readable refusal rather than a url containing "null".
   */
  it("refuses when the factory says the owner has no legal vault id", () => {
    expect(() => buildCreatePlan({ ...base, vaultId: null })).toThrow(/no legal vault id/i);
  });

  /**
   * A vault that already exists must not be offered for creation — the batch
   * would fail on CreateAccount after the user had signed and committed.
   */
  it("refuses when the vault already exists", () => {
    expect(() => buildCreatePlan({ ...base, exists: true })).toThrow(/already exists/i);
  });

  /** The server never signs this. Say so, in the payload. */
  it("states that nothing here holds a key", () => {
    const p = buildCreatePlan(base);
    expect(p.note).toMatch(/never|not.*sign|your own wallet/i);
  });
});

describe("FACTORY_BY_NETWORK", () => {
  /**
   * A mainnet default must never be a guess. An unset mainnet factory has to
   * read as absent so the tool asks for one, rather than silently pointing a
   * real user with real NEAR at an account that may not be ours.
   */
  it("has a testnet default and no invented mainnet one", () => {
    expect(FACTORY_BY_NETWORK.testnet).toBe("fac.floatv4.testnet");
    expect(FACTORY_BY_NETWORK.mainnet ?? null).toBeNull();
  });
});

describe("buildCreatePlan without a known owner", () => {
  /**
   * AN AGENT MEETING A NEW USER DOES NOT KNOW THEIR NEAR ACCOUNT.
   *
   * The tool required `owner`, so the only way to produce a link was to ask
   * for an account id first — which assumes the user knows it, can type it
   * correctly, and has one at all. For someone being onboarded that is three
   * assumptions before anything useful happens.
   *
   * The page already derives everything from the CONNECTED wallet, so a link
   * with no owner is not a degraded link: it is the one that asks the wallet
   * instead of asking the human. What it cannot do is name the vault address
   * or check whether one already exists, and it must say so rather than
   * printing a plausible blank.
   */
  const anon = { ...base, owner: null as unknown as string, vaultId: null };

  it("still produces a usable link", () => {
    const p = buildCreatePlan({ ...anon, ownerKnown: false });
    expect(p.url).toContain("factory=float.near");
    expect(p.url).toContain("network=mainnet");
  });

  /**
   * NO ?owner= WHEN WE DO NOT KNOW ONE. The page refuses when the parameter
   * disagrees with the connected wallet, so emitting a guessed or blank owner
   * would turn every link into a refusal.
   */
  it("omits the owner parameter entirely", () => {
    const p = buildCreatePlan({ ...anon, ownerKnown: false });
    expect(new URL(p.url).searchParams.has("owner")).toBe(false);
  });

  /** The deposit does not depend on who the owner is — it is the code size. */
  it("still quotes the real deposit and the reservation", () => {
    const p = buildCreatePlan({ ...anon, ownerKnown: false });
    const expected = 10n ** 23n + BigInt(CONTRACT_BYTES) * 10n ** 19n;
    expect(p.depositYocto).toBe(expected.toString());
    expect(BigInt(p.totalRequiredYocto) - BigInt(p.depositYocto)).toBe(
      200n * 10n ** 12n * 10n ** 9n,
    );
  });

  /**
   * It must NOT invent a vault address. Deriving one needs the owner, and a
   * blank or guessed id rendered next to a real deposit figure reads as fact.
   */
  it("says the address is not known yet instead of inventing one", () => {
    const p = buildCreatePlan({ ...anon, ownerKnown: false });
    expect(p.vault).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/wallet you connect|not known|decided when/i);
  });

  /**
   * And it cannot have checked for an existing vault, so it must not imply it
   * did — a user with a vault already would otherwise be walked into a failed
   * transaction.
   */
  it("warns that an existing vault could not be checked for", () => {
    const p = buildCreatePlan({ ...anon, ownerKnown: false });
    expect(p.warnings.join(" ")).toMatch(/already have|existing/i);
  });

  /** With an owner, nothing changes: the precise path still names the vault. */
  it("still names the vault when the owner IS known", () => {
    const p = buildCreatePlan(base);
    expect(p.vault).toBe("alice-near.float.near");
    expect(new URL(p.url).searchParams.get("owner")).toBe("alice.near");
  });
});
