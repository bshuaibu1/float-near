import { test } from "node:test";
import assert from "node:assert/strict";

import { gasReservation, gasKeyFunding, signerChoice, PAYMENT_BURN } from "../bin/gas-key.mjs";

/**
 * A gas key that cannot cover ONE reservation can never transact.
 *
 * NEAR reserves `prepaid_gas x 1e9` up front — 1e9 is the MAX gas price, ten
 * times the current 1e8 — and refunds the unused part a receipt later. So the
 * key's balance must exceed the whole reservation even though the real burn is
 * ~350x smaller. Measured on mainnet 2026-11-01: a 60 TGas call reserved
 * 0.0609 and burned 0.000925.
 *
 * Fund below the reservation and every call fails with NotEnoughBalance, which
 * reads as a broken agent rather than an underfunded one.
 */
test("the reservation is prepaid_gas x 1e9, not x the current price", () => {
  // 60 TGas = 6e13 gas. x 1e9 = 6e22 yocto = 0.06 NEAR.
  assert.equal(gasReservation(60), 60n * 10n ** 12n * 10n ** 9n);
  assert.equal(Number(gasReservation(60)) / 1e24, 0.06);
});

test("funding always exceeds one reservation, or the agent cannot pay at all", () => {
  for (const tgas of [50, 60, 100]) {
    const f = gasKeyFunding({ tgas, payments: 1 });
    assert.ok(
      f > gasReservation(tgas),
      `${tgas} TGas: funded ${f} but one call reserves ${gasReservation(tgas)}`,
    );
  }
});

test("funding scales with the payments it is meant to cover", () => {
  const ten = gasKeyFunding({ tgas: 60, payments: 10 });
  const hundred = gasKeyFunding({ tgas: 60, payments: 100 });
  assert.ok(hundred > ten, "more payments must cost more");
  // The DIFFERENCE is burn only — the reservation is returned each time, so it
  // is charged once however many payments are funded.
  assert.equal(hundred - ten, PAYMENT_BURN * 90n);
});

/**
 * WHICH CREDENTIAL SIGNS AS THE VAULT? Measured, because it differs by vault.
 *
 * Adding a gas key is an AddKey action ON the vault, so it must be signed by a
 * full-access key OF the vault. create-float ends by adding the owner's key to
 * the vault and deleting the temporary setup key, so for a wizard-made vault
 * the OWNER's credential signs for it.
 *
 * That is not universal. Checked 2026-11-01:
 *   mainnet float.test015.near  — owner's key IS on the vault
 *   testnet approve.floatv4     — it is NOT; the vault holds a separate key
 *
 * The testnet vault was upgraded from an older deployment rather than built by
 * the wizard. Assuming the owner's key would have failed there with an opaque
 * signing error, so the choice is resolved explicitly and reported.
 */
test("signerChoice prefers the owner's key when it is on the vault", () => {
  assert.equal(
    signerChoice({ ownerPublicKey: "ed25519:AAA", vaultKeys: ["ed25519:AAA"], hasVaultCredential: false }),
    "owner",
  );
});

test("signerChoice falls back to a vault credential when the owner's key is absent", () => {
  assert.equal(
    signerChoice({ ownerPublicKey: "ed25519:AAA", vaultKeys: ["ed25519:ZZZ"], hasVaultCredential: true }),
    "vault",
  );
});

test("signerChoice reports NONE rather than guessing", () => {
  // The failure mode this prevents: signing with a key the vault does not
  // carry, which comes back as InvalidAccessKeyError and reads like a bug in
  // the contract rather than a missing credential.
  assert.equal(
    signerChoice({ ownerPublicKey: "ed25519:AAA", vaultKeys: ["ed25519:ZZZ"], hasVaultCredential: false }),
    "none",
  );
});

/**
 * float-agent's `--help` must never UNDERSTATE the funding.
 *
 * It said "About 0.06 NEAR" — the RESERVATION alone, not the funding. The
 * default is `gasKeyFunding()` = reservation + burn x 50 = 0.12, so the help
 * was wrong by 2x and a user topping up to the documented figure would fund a
 * key that cannot cover even one call.
 *
 * That is the same failure create-float 0.3.2 shipped to fix, reintroduced by
 * writing a derived number down by hand. One-sided, like its sibling: the help
 * may round UP, never down. An overstatement costs nothing — the balance is
 * withdrawable — while an understatement produces a broken agent.
 */
test("REAL SOURCE: float-agent's help never quotes less than gasKeyFunding()", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "bin", "float-agent.mjs"), "utf8");

  const real = Number(gasKeyFunding()) / 1e24;
  // Every NEAR figure the help text quotes, from the usage() template.
  const usage = src.slice(src.indexOf("export function usage()"), src.indexOf("const argv ="));
  const quoted = [...usage.matchAll(/\b(\d+\.\d+)\s*NEAR/g)].map((m) => Number(m[1]));
  // STATE THE EXPECTATION FIRST: a literal figure here would mean the derived
  // one was replaced by hand, which is the bug. Zero literals is correct.
  assert.equal(
    quoted.length,
    0,
    `usage() hardcodes ${quoted} NEAR; it must derive from gasKeyFunding() instead`,
  );
  assert.match(usage, /\$\{defaultAsk\(\)\}/, "usage() must interpolate the derived ask");
  assert.ok(real > 0.1 && real < 0.2, `sanity: gasKeyFunding() is ${real}, outside the expected band`);
});
