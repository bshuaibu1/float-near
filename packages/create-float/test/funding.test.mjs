import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { codeStakeYocto, vaultFunding, STATE_HEADROOM } from "../bin/funding.mjs";

/**
 * How much NEAR the vault account needs.
 *
 * WHY THIS IS DERIVED AND NOT A CONSTANT. `VAULT_FUNDING` was hardcoded at
 * 3 NEAR, chosen when the contract was 278 KB and its code stake 2.848 — a
 * comfortable 0.152 of headroom for the budget tree's own state.
 *
 * Adding the approval gate grew the contract to 292 KB, so the stake became
 * 2.990 and the headroom collapsed to 0.010 NEAR, which is about one kilobyte
 * of state. A four-node tree does not fit in that. The wizard would have
 * created and funded the account, deployed, and then failed partway through
 * building the tree with a storage error — after the user had already paid.
 *
 * NEAR charges 1 NEAR per 100 KB, so every kilobyte added to the contract is
 * 0.01 NEAR off the headroom. A constant cannot track that. Deriving it from
 * the artifact means the contract can grow without quietly breaking onboarding.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RES_WASM = resolve(HERE, "..", "res", "vault.wasm");

test("code stake is 1e19 yocto PER BYTE, the protocol's actual rate", () => {
  // Stated per byte, not "per 100 KB". The shorthand is off by 2.4%: a binary
  // 100 KiB is 102,400 bytes and costs 1.024 NEAR, not 1. My first version of
  // this test asserted the shorthand and failed against a correct
  // implementation.
  assert.equal(codeStakeYocto(1), 10n ** 19n);
  assert.equal(codeStakeYocto(100_000), 10n ** 24n); // 1 NEAR per 100,000 bytes
  assert.equal(codeStakeYocto(100 * 1024), 1024n * 10n ** 21n); // 1.024 NEAR
});

test("funding always exceeds the code stake by the full headroom", () => {
  for (const kb of [100, 278, 292, 400, 1000]) {
    const bytes = kb * 1024;
    const funding = vaultFunding(bytes);
    const stake = codeStakeYocto(bytes);
    assert.equal(funding - stake, STATE_HEADROOM, `headroom wrong at ${kb} KB`);
    assert.ok(funding > stake, `funding does not cover the stake at ${kb} KB`);
  }
});

test("a bigger contract asks for proportionally more", () => {
  // The property the old constant lacked: growth is tracked, not absorbed.
  assert.ok(vaultFunding(292 * 1024) > vaultFunding(278 * 1024));
  const delta = vaultFunding(292 * 1024) - vaultFunding(278 * 1024);
  // 14 KB at 1 NEAR / 100 KB = 0.14 NEAR.
  assert.equal(delta, codeStakeYocto(14 * 1024));
});

test("the headroom is enough for a real budget tree, not a token amount", () => {
  // 0.35 NEAR is 35 KB of state. The default tree is four nodes plus agent
  // bindings and a request ledger; the collapsed 0.010 (1 KB) was not enough,
  // and that is the failure this file exists to prevent.
  assert.ok(STATE_HEADROOM >= 25n * 10n ** 22n, "headroom below 0.25 NEAR is too tight");
});

test("REAL DATA: the shipped contract is funded with room to spare", () => {
  const bytes = statSync(RES_WASM).size;
  const funding = vaultFunding(bytes);
  const stake = codeStakeYocto(bytes);
  const headroomNear = Number(funding - stake) / 1e24;
  assert.ok(
    headroomNear >= 0.25,
    `only ${headroomNear.toFixed(3)} NEAR of state headroom for a ${(bytes / 1024).toFixed(0)} KB contract`,
  );
});

test("REAL DATA: the wizard does not still hardcode a flat VAULT_FUNDING", () => {
  // The regression that matters. A constant reintroduced here would pass every
  // test above while breaking onboarding the next time the contract grows.
  const wizard = readFileSync(join(HERE, "..", "bin", "create-float.mjs"), "utf8");
  const code = wizard
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /const VAULT_FUNDING = NEAR\(/,
    "VAULT_FUNDING is a flat constant again — it must be derived from the contract size",
  );
  assert.match(code, /vaultFunding\(/, "the wizard does not call vaultFunding");
});

// ---- will an upgrade still fit the account's balance?
//
// Measured 2026-10-31 against the live mainnet vault. The approval gate grew
// the contract 284,572 -> 299,016 bytes, and float.test015.near had:
//
//   balance        2.98807 NEAR
//   storage_usage  290,165 bytes -> locked 2.90165
//   available        0.08642 NEAR
//
// The delta is +14,444 bytes = +0.14444 NEAR of stake, so locked becomes
// 3.04609 against a 2.98807 balance: SHORT BY 0.05802. upgrade-vault.sh had no
// balance check, so it would have sent the deploy and failed mid-flight with
// LackBalanceForState — atomic, so nothing breaks, but it burns gas and reads
// as a broken upgrade on mainnet rather than "top the account up first".
//
// The shortfall is NOT the delta. There was already 0.086 of headroom, so the
// top-up needed is 0.058 plus whatever margin you want — a distinction easy to
// get wrong by quoting the delta, which is what I did before measuring.

import { storageMargin } from "../bin/funding.mjs";

const MAINNET = {
  balance: 2_988_070_000_000_000_000_000_000n,
  storageUsage: 290_165n,
  oldCodeBytes: 284_572n,
  newCodeBytes: 299_016n,
};

test("REAL DATA: the live mainnet upgrade is short, and by how much", () => {
  const m = storageMargin({ ...MAINNET, headroom: 0n });
  assert.equal(m.fits, false);
  // -0.05802 NEAR, to the yocto.
  assert.equal(m.margin, -58_020_000_000_000_000_000_000n);
  assert.equal(m.deltaBytes, 14_444n);
  assert.equal(m.lockedAfter, 3_046_090_000_000_000_000_000_000n);
});

test("the top-up quoted is the SHORTFALL, not the code delta", () => {
  // The distinction that matters: 0.058 to fit, not the 0.144 the code grew by.
  const m = storageMargin({ ...MAINNET, headroom: 0n });
  assert.equal(m.topUp, 58_020_000_000_000_000_000_000n);
  assert.notEqual(m.topUp, m.deltaBytes * 10n ** 19n);
});

test("a requested headroom is added to the top-up", () => {
  const m = storageMargin({ ...MAINNET, headroom: 35n * 10n ** 22n }); // 0.35
  assert.equal(m.topUp, 58_020_000_000_000_000_000_000n + 35n * 10n ** 22n);
  assert.equal(m.fits, false);
});

test("an upgrade that FITS reports a positive margin and no top-up", () => {
  const m = storageMargin({
    balance: 5n * 10n ** 24n,
    storageUsage: 290_165n,
    oldCodeBytes: 284_572n,
    newCodeBytes: 299_016n,
    headroom: 0n,
  });
  assert.equal(m.fits, true);
  assert.equal(m.topUp, 0n);
  assert.ok(m.margin > 0n);
});

test("a SHRINKING contract frees stake rather than demanding it", () => {
  // Negative delta. Without this, a size reduction could be reported as a
  // shortfall by an implementation that only ever adds.
  const m = storageMargin({
    balance: 2_988_070_000_000_000_000_000_000n,
    storageUsage: 290_165n,
    oldCodeBytes: 299_016n,
    newCodeBytes: 284_572n,
    headroom: 0n,
  });
  assert.equal(m.deltaBytes, -14_444n);
  assert.equal(m.fits, true);
  assert.ok(m.margin > 0n);
});

test("an unchanged contract neither frees nor demands anything", () => {
  const m = storageMargin({
    balance: 2_988_070_000_000_000_000_000_000n,
    storageUsage: 290_165n,
    oldCodeBytes: 284_572n,
    newCodeBytes: 284_572n,
    headroom: 0n,
  });
  assert.equal(m.deltaBytes, 0n);
  assert.equal(m.lockedAfter, 290_165n * 10n ** 19n);
  assert.equal(m.fits, true);
});
