import { test } from "node:test";
import assert from "node:assert/strict";
import { planTokenSetup } from "../bin/token-setup.mjs";

/**
 * The two steps the wizard used to tell users it "cannot do for you".
 *
 * It could. It holds the owner's full-access key, it already transfers 3 NEAR
 * to create the vault, and it already calls `ft_metadata` on the token at
 * step 2. Nothing about `storage_deposit` or `ft_transfer` is beyond it — the
 * sentence was simply never revisited.
 *
 * INPUTS ARE REAL-SHAPED, measured off mainnet on 2026-10-29 rather than
 * invented:
 *   storage_balance_of(unregistered) -> null
 *   storage_balance_bounds           -> { min: "1250000000000000000000", max: same }
 *   ft_balance_of(test015.near)      -> "10867454"   (10.867454 at 6dp)
 * A fixture that guessed `0` for an unregistered account, or an object, would
 * have frozen the wrong branch: `null` is what the token actually returns, and
 * only `null` distinguishes "not registered" from "registered with 0 available".
 */

const MIN = "1250000000000000000000"; // 0.00125 NEAR, both min AND max on real USDC
const base = {
  token: "usdc.near",
  vault: "v.me.near",
  decimals: 6,
  storageMin: MIN,
  registered: null,
  ownerBalance: "10867454",
  fundAmount: null,
};

test("an unregistered vault is registered, and that costs the bounds minimum", () => {
  const p = planTokenSetup({ ...base });
  assert.equal(p.register, true);
  assert.equal(p.registerDeposit, BigInt(MIN));
});

test("an ALREADY registered vault is not registered again", () => {
  // Resuming must not re-pay. storage_balance_of returns an object once
  // registered — this is the shape the real token returns.
  const p = planTokenSetup({ ...base, registered: { total: MIN, available: "0" } });
  assert.equal(p.register, false);
  assert.equal(p.registerDeposit, 0n);
});

test("a requested amount becomes base units, exactly", () => {
  const p = planTokenSetup({ ...base, fundAmount: "1.5" });
  assert.equal(p.transfer, 1_500_000n);
});

test("no amount means register only — funding stays opt-in", () => {
  // Moving someone's money because they ran a setup wizard is not a default.
  const p = planTokenSetup({ ...base, fundAmount: null });
  assert.equal(p.transfer, null);
  assert.equal(p.register, true);
});

test("an amount of 0 is the same as none, not a zero-value transfer", () => {
  const p = planTokenSetup({ ...base, fundAmount: "0" });
  assert.equal(p.transfer, null);
});

test("funding more than the owner holds is REFUSED before anything is sent", () => {
  // 10.867454 is the real measured balance. 20 is not available.
  assert.throws(
    () => planTokenSetup({ ...base, fundAmount: "20" }),
    /holds only 10\.867454/,
  );
});

test("funding exactly the whole balance is allowed", () => {
  const p = planTokenSetup({ ...base, fundAmount: "10.867454" });
  assert.equal(p.transfer, 10_867_454n);
});

test("an owner holding nothing cannot fund, and is told rather than failed", () => {
  const p = planTokenSetup({ ...base, ownerBalance: "0", fundAmount: null });
  assert.equal(p.transfer, null);
  assert.match(p.warnings.join(" "), /holds no usdc\.near/i);
});

test("over-precision is refused rather than rounded", () => {
  // Same rule as the budget caps: rounding 0.0000001 to 0 on a 6dp token is a
  // silent change of intent.
  assert.throws(() => planTokenSetup({ ...base, fundAmount: "1.0000001" }), /decimal places/);
});

test("a non-numeric amount is refused", () => {
  for (const bad of ["abc", "-1", "1e6", ""]) {
    assert.throws(
      () => planTokenSetup({ ...base, fundAmount: bad }),
      /not a positive decimal/,
      `"${bad}"`,
    );
  }
});

test("the NEAR cost of registering is reported so the affordability gate can include it", () => {
  // The wizard refuses a plan it cannot afford. If registration is invisible to
  // that sum, a run can pass the gate and then fail with the vault already made.
  const p = planTokenSetup({ ...base });
  assert.equal(p.nearCost, BigInt(MIN));
  const q = planTokenSetup({ ...base, registered: { total: MIN, available: "0" } });
  assert.equal(q.nearCost, 0n);
});

test("the plan says what it will DO, in the order it will happen", () => {
  const p = planTokenSetup({ ...base, fundAmount: "2.5" });
  assert.deepEqual(p.steps, [
    { action: "storage_deposit", account: "v.me.near", deposit: BigInt(MIN) },
    { action: "ft_transfer", to: "v.me.near", amount: 2_500_000n },
  ]);
});

test("registration comes FIRST — a transfer to an unregistered account fails", () => {
  // Measured the hard way on mainnet: ft_transfer to an unregistered account
  // panics with "The account ... is not registered". Order is load-bearing,
  // so it is asserted rather than left to the caller.
  const p = planTokenSetup({ ...base, fundAmount: "1" });
  assert.equal(p.steps[0].action, "storage_deposit");
  assert.equal(p.steps[1].action, "ft_transfer");
});

test("an already-registered vault's plan is just the transfer", () => {
  const p = planTokenSetup({
    ...base,
    registered: { total: MIN, available: "0" },
    fundAmount: "1",
  });
  assert.deepEqual(p.steps, [{ action: "ft_transfer", to: "v.me.near", amount: 1_000_000n }]);
});

// ---- the closing text, which is the half the user actually reads
//
// The wizard told every user "the wizard cannot do these for you" and printed
// two near-cli commands. That sentence was false, and on Windows those commands
// fail unless the JSON's inner quotes are backslash-escaped — which nothing
// said. These assert the text follows what actually happened.

import { fundingNotice } from "../bin/token-setup.mjs";

const ctx = { token: "usdc.near", vault: "v.me.near", owner: "me.near", network: "mainnet" };

test("when the wizard registered AND funded, nothing is left to do by hand", () => {
  const lines = fundingNotice(
    { register: true, transfer: 2_500_000n, warnings: [] },
    { ...ctx, decimals: 6 },
  ).join("\n");
  assert.doesNotMatch(lines, /cannot do/i);
  assert.doesNotMatch(lines, /storage_deposit/);
  assert.match(lines, /2\.500000/);
});

test("when it registered but was not asked to fund, ONE command is left — not two", () => {
  const lines = fundingNotice(
    { register: true, transfer: null, warnings: [] },
    { ...ctx, decimals: 6 },
  ).join("\n");
  // Registration is done, so telling the user to run it again is wrong.
  assert.doesNotMatch(lines, /storage_deposit/);
  assert.match(lines, /ft_transfer/);
});

test("the leftover command is escaped for the shell that actually broke", () => {
  // PowerShell 5.1 strips embedded double quotes when handing argv to a native
  // exe, so the unescaped form arrives as {account_id:v.me.near} and near-cli
  // answers "key must be a string". Measured on 2026-10-28.
  const lines = fundingNotice(
    { register: true, transfer: null, warnings: [] },
    { ...ctx, decimals: 6 },
  ).join("\n");
  assert.match(lines, /\\"receiver_id\\"/, "inner quotes must be backslash-escaped");
});

test("an owner holding none is told why, not handed a command that will fail", () => {
  const lines = fundingNotice(
    { register: true, transfer: null, warnings: ["the owner holds no usdc.near, so ..."] },
    { ...ctx, decimals: 6 },
  ).join("\n");
  assert.match(lines, /holds no usdc\.near/);
});

test("an owner with NOTHING is not handed a command that cannot work", () => {
  // Found by rendering the notice and reading it, not by an assertion: the
  // "owner holds none" case printed the warning AND the ft_transfer command
  // underneath it. That command fails for precisely the reason just stated —
  // the same defect being fixed, reintroduced one line lower.
  const p = planTokenSetup({
    token: "usdc.near", vault: "v.me.near", decimals: 6,
    storageMin: MIN, registered: null, ownerBalance: "0", fundAmount: null,
  });
  const lines = fundingNotice(p, { ...ctx, decimals: 6 }).join("\n");
  assert.doesNotMatch(lines, /ft_transfer/, "do not print a command the owner cannot run");
  assert.match(lines, /holds no usdc\.near/);
  assert.match(lines, /--fund/, "still tell them how, once they have some");
});
