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
