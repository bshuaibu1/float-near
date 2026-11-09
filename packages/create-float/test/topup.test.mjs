import { test } from "node:test";
import assert from "node:assert/strict";

import {
  topUpFor,
  paymentsAfterTopUp,
  gasKeyFunding,
  gasReservation,
  PAYMENT_BURN,
} from "../bin/gas-key.mjs";

/**
 * A TOP-UP IS NOT A SECOND INITIAL FUNDING, and conflating them is the
 * expensive mistake available here.
 *
 * `gasKeyFunding()` is reservation + burn x payments. The reservation is held
 * per in-flight call and refunded a receipt later, so it is charged ONCE for
 * the key's whole life. A key that has already been funded is still holding
 * it. Charging it again on every top-up costs 0.0609 at 60 TGas — about 50x
 * the burn being bought — and would look entirely reasonable in a diff.
 */
test("topping up a healthy key charges only the burn, not another reservation", () => {
  const tgas = 60;
  const healthy = gasKeyFunding({ tgas, payments: 50 }); // freshly funded
  const add = topUpFor({ balance: healthy, tgas, payments: 50 });
  // 50 more payments on top of 50 already funded = exactly 50 payments of burn
  assert.equal(add, PAYMENT_BURN * 50n);
  // And emphatically NOT the full initial figure:
  assert.notEqual(add, gasKeyFunding({ tgas, payments: 50 }));
  assert.ok(add < gasKeyFunding({ tgas, payments: 50 }));
});

test("a DEPLETED key is lifted back over the reservation line", () => {
  // The case `burn x payments` alone would get wrong. Below the reservation a
  // key cannot transact at all, so the top-up must restore it first.
  const tgas = 60;
  const add = topUpFor({ balance: 0n, tgas, payments: 10 });
  assert.equal(add, gasReservation(tgas) + PAYMENT_BURN * 10n);
  assert.ok(add > PAYMENT_BURN * 10n, "must cover the reservation too");
});

test("topping up a rich key still ADDS capacity, it does not shrug", () => {
  // The semantics that were wrong first time round. `topup --payments 10` on
  // a key with 500 left should leave it with 510. Answering "nothing to do"
  // is defensible arithmetic and a useless command.
  const tgas = 60;
  const rich = gasKeyFunding({ tgas, payments: 500 });
  assert.equal(topUpFor({ balance: rich, tgas, payments: 10 }), PAYMENT_BURN * 10n);
});

test("asking for zero more costs zero", () => {
  const tgas = 60;
  const healthy = gasKeyFunding({ tgas, payments: 50 });
  assert.equal(topUpFor({ balance: healthy, tgas, payments: 0 }), 0n);
});

test("paymentsAfterTopUp answers the question a user actually asks", () => {
  const tgas = 60;
  // Starting from empty, adding exactly a 50-payment funding buys 50.
  const amount = gasKeyFunding({ tgas, payments: 50 });
  assert.equal(paymentsAfterTopUp({ balance: 0n, tgas, amount }), 50);
});

test("ZERO is a real answer, not a rounding artefact", () => {
  // Below one reservation the key makes NO calls. Reporting "a few" would
  // promise capability that does not exist: every call fails NotEnoughBalance.
  const tgas = 60;
  assert.equal(paymentsAfterTopUp({ balance: 0n, tgas, amount: 0n }), 0);
  assert.equal(
    paymentsAfterTopUp({ balance: 0n, tgas, amount: gasReservation(tgas) - 1n }),
    0,
  );
  // Exactly the reservation buys zero payments, not one.
  assert.equal(paymentsAfterTopUp({ balance: 0n, tgas, amount: gasReservation(tgas) }), 0);
});

test("the two agree, which is what makes the quote trustworthy", () => {
  // topUpFor says what to add for N MORE; paymentsAfterTopUp says the TOTAL
  // afterwards. So the total must be at least the N that was asked for, plus
  // whatever the key could already do. If these ever disagree, a user is
  // quoted one number and gets another.
  const tgas = 60;
  for (const balance of [0n, gasReservation(tgas), gasKeyFunding({ tgas, payments: 7 })]) {
    const already = paymentsAfterTopUp({ balance, tgas, amount: 0n });
    for (const payments of [1, 10, 250]) {
      const add = topUpFor({ balance, tgas, payments });
      const got = paymentsAfterTopUp({ balance, tgas, amount: add });
      assert.ok(
        got >= already + payments,
        `balance ${balance}, asked +${payments}: had ${already}, got ${got}`,
      );
    }
  }
});

test("refuses a tgas below the vault's dispatch floor, in both directions", () => {
  // Funding below MIN_GAS_FOR_DISPATCH buys nothing: the vault refuses the
  // call with INSUFFICIENT_GAS before anything happens.
  assert.throws(() => topUpFor({ tgas: 49 }), /at least 50/);
  assert.throws(() => paymentsAfterTopUp({ tgas: 49 }), /at least 50/);
});

test("refuses a negative payment count rather than returning a refund", () => {
  assert.throws(() => topUpFor({ payments: -1 }), /negative/);
});
