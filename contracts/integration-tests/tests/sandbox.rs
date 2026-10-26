//! Sandbox tier — real local NEAR node, real cross-contract calls.
//!
//! Everything here is INVISIBLE to the unit tier, because a unit test cannot
//! schedule a promise and therefore never runs the transfer callback.
//!
//! Prerequisite: scripts/build-wasm.sh

mod common;
use common::*;

/// I3 — one payment must charge the ledger at EVERY level of the chain.
///
/// Kills M4 (pass-two `&chain` -> `&[node_id]`), which the unit tier cannot
/// kill: without the callback, `executed` never moves at all.
#[tokio::test]
async fn i3_single_payment_charges_agent_team_and_root() -> anyhow::Result<()> {
    let e = setup(1, CAP * 10).await?;

    let out = pay(&e.agents[0], &e, "s1", PAY, e.payee.id().as_str()).await?;
    assert!(out.is_success(), "dispatch failed: {out:#?}");

    // Positive control on the instrument: if the mock silently moved nothing,
    // every budget assertion below could still pass for the wrong reason.
    assert_eq!(ft_transfer_count(&e).await?, 1, "the transfer never actually fired");

    let r = request(&e, "s1").await?;
    assert_eq!(r.status, "SETTLED", "unexpected terminal status");
    assert_eq!(
        r.reserved_chain,
        vec![ROOT, TEAM, AGENT0],
        "the charged chain must be root-first and include the leaf"
    );

    for node in [ROOT, TEAM, AGENT0] {
        let b = budget(&e, node, Some(r.reserved_day)).await?;
        assert_eq!(b.executed(), PAY, "level {node} was not charged");
        assert_eq!(b.pending(), 0, "level {node} leaked a reservation");
        assert_eq!(b.available(), CAP - PAY, "level {node} available is wrong");
    }
    Ok(())
}

/// I6 — the highest-value test in the suite.
///
/// A leaked reservation permanently consumes the budget at every level for the
/// rest of the day, silently bricking the agent. Kills M9 (drop the
/// `pending.checked_sub` release) and M10 (drop the idempotency gate).
#[tokio::test]
async fn forced_transfer_failure_releases_the_reservation_at_every_level() -> anyhow::Result<()> {
    let e = setup(1, CAP * 10).await?;
    set_fail_transfers(&e, true).await?;
    assert!(fail_transfers_armed(&e).await?, "the failure hook did not arm");

    // The outer transaction succeeds (the promise was scheduled); the inner
    // ft_transfer panics, and the callback must clean up.
    let out = pay(&e.agents[0], &e, "f1", PAY, e.payee.id().as_str()).await?;

    // Positive controls FIRST. Without these, a mock whose hook silently
    // no-opped would let a LEAKING vault pass: the transfer would succeed,
    // pending would clear via the success branch, and every assertion below
    // would be green for the wrong reason.
    //
    // The control is DIFFERENTIAL rather than message-based. Under this
    // workspace's `panic = "abort"` profile the panic text does not survive
    // into the receipt outcome (it arrives as "WebAssembly trap: An
    // `unreachable` opcode was executed"), so matching a marker string proves
    // nothing. Instead: the identical payment is run later in this test with
    // the latch DISARMED and must succeed. Same agent, same recipient, same
    // token, same amount-shape — the latch is the only variable, which is
    // what makes the failure attributable to the hook.
    assert!(out.is_success(), "outer tx should succeed; the inner transfer fails: {out:#?}");
    assert_eq!(out.receipt_failures().len(), 1, "expected exactly one failed receipt");
    assert_eq!(
        ft_transfer_count(&e).await?,
        0,
        "value moved despite a forced failure"
    );

    let r = request(&e, "f1").await?;
    assert_eq!(r.status, "TRANSFER_FAILED");
    assert_eq!(r.reason_code, "TRANSFER_FAILED");

    for node in [ROOT, TEAM, AGENT0] {
        let b = budget(&e, node, Some(r.reserved_day)).await?;
        assert_eq!(b.pending(), 0, "level {node}: reservation LEAKED");
        assert_eq!(b.executed(), 0, "level {node}: failed transfer booked as spent");
        assert_eq!(b.available(), CAP, "level {node}: budget not restored");
    }

    // Reported-free is not the same as reusable. Disarm, then spend the WHOLE
    // cap to prove the released headroom is real at every level.
    set_fail_transfers(&e, false).await?;
    let again = pay(&e.agents[0], &e, "f2", CAP, e.payee.id().as_str()).await?;
    assert!(again.is_success(), "released budget was not actually reusable: {again:#?}");
    assert_eq!(ft_transfer_count(&e).await?, 1, "the follow-up transfer did not fire");

    let r2 = request(&e, "f2").await?;
    assert_eq!(r2.status, "SETTLED");
    for node in [ROOT, TEAM, AGENT0] {
        let b = budget(&e, node, Some(r2.reserved_day)).await?;
        assert_eq!(b.executed(), CAP, "level {node}: full cap did not settle");
        assert_eq!(b.available(), 0, "level {node}: should now be exhausted");
    }
    Ok(())
}

/// The realistic sibling of I6: an allowlisted recipient that is not
/// registered on the token. The allowlist passes, so a naive implementation
/// reserves and then leaks.
#[tokio::test]
async fn unregistered_recipient_releases_the_reservation() -> anyhow::Result<()> {
    let e = setup(1, CAP * 10).await?;
    e.ft.call("unregister")
        .args_json(serde_json::json!({ "account_id": e.payee.id() }))
        .transact()
        .await?
        .into_result()?;

    let _ = pay(&e.agents[0], &e, "u1", PAY, e.payee.id().as_str()).await?;
    assert_eq!(ft_transfer_count(&e).await?, 0, "transfer should not have moved value");

    let r = request(&e, "u1").await?;
    assert_eq!(r.status, "TRANSFER_FAILED");
    for node in [ROOT, TEAM, AGENT0] {
        let b = budget(&e, node, Some(r.reserved_day)).await?;
        assert_eq!(
            b.pending(),
            0,
            "level {node}: reservation leaked on an unregistered recipient"
        );
        assert_eq!(b.available(), CAP, "level {node}: budget not restored");
    }
    Ok(())
}

/// The stable reason codes are a documented product feature: a caller is
/// supposed to branch on `INVALID_ALLOCATION` rather than parse prose. For
/// rejections returned as VALUES (blocked payments) that is automatic. For
/// rejections raised as PANICS (owner methods) it depends on the build
/// profile, and the unit tier cannot see the difference because unit tests
/// run natively and panic normally with the message intact.
///
/// With `panic = "abort"` in the release profile, the message is destroyed:
/// the receipt outcome reads "WebAssembly trap: An `unreachable` opcode was
/// executed" and the reason code is gone. This test pins that.
#[tokio::test]
async fn reason_code_panics_reach_the_receipt_outcome() -> anyhow::Result<()> {
    let e = setup(1, CAP * 10).await?;

    // An empty label is rejected by add_node with ReasonCode::InvalidConfig.
    let out = e
        .owner
        .call(e.vault.id(), "add_node")
        .args_json(serde_json::json!({
            "parent": serde_json::Value::Null,
            "label": "",
            "limits": [{ "token": e.ft.id(), "daily_cap": "1", "per_tx_cap": "1" }],
            "cooldown_sec": 0,
            "recipients": serde_json::Value::Null,
        }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;

    assert!(out.is_failure(), "an empty label must be rejected");
    let text = format!("{:?}", out.failures());
    assert!(
        text.contains("INVALID_CONFIG"),
        "the reason code did not survive into the receipt outcome. \
         If this reads 'unreachable opcode', panic = \"abort\" is back in \
         the release profile. Got: {text}"
    );
    Ok(())
}

/// The day boundary. Kills M8 (callback `req.reserved_day` -> `self.today()`).
///
/// This is the one invariant that needs a clock, and it is the only test that
/// opts into the short budget window. With a 100 ms day a transfer callback
/// ALWAYS lands in a later bucket than its request, because a NEAR block is
/// ~1.1 s. So:
///   correct code  -> books against reserved_day, i.e. the request's bucket
///   M8 applied    -> decrements `pending` on a later, ZEROED ledger ->
///                    checked_sub underflow -> LEDGER_INVARIANT panic
///
/// Deterministic, and loud rather than silent — which is why the day length is
/// the test variable here instead of a delayed transfer. A delay would need
/// promise yield/resume in the mock and would race against block time.
#[tokio::test]
async fn settlement_is_booked_to_the_reserved_day_not_the_callback_day() -> anyhow::Result<()> {
    let e = setup(1, CAP * 10).await?;
    set_day_len(&e, TEST_DAY_NS).await?;

    let out = pay(&e.agents[0], &e, "d1", PAY, e.payee.id().as_str()).await?;
    assert!(out.is_success(), "dispatch failed: {out:#?}");
    assert_eq!(ft_transfer_count(&e).await?, 1, "the transfer never fired");

    let r = request(&e, "d1").await?;
    assert_eq!(r.status, "SETTLED");
    let d = r.reserved_day;

    // Guard against this test becoming a silent no-op. If the day length were
    // ever long enough that the callback shared the request's bucket, then
    // reserved_day and today() would agree and M8 would be unkillable while
    // every assertion below still passed.
    let now = current_day(&e).await?;
    assert!(
        now > d,
        "the clock did not advance past the reserved day ({now} vs {d}); \
         this test would prove nothing — is TEST_DAY_NS too long?"
    );

    for node in [ROOT, TEAM, AGENT0] {
        let b = budget(&e, node, Some(d)).await?;
        assert_eq!(b.executed(), PAY, "level {node}: not booked to the reserved day");
        assert_eq!(b.pending(), 0, "level {node}: reservation outstanding on the reserved day");
    }

    // Sweep forward rather than checking only d+1: the callback can land
    // several 100 ms buckets later, and narrowing a completeness check to one
    // value is how an under-report reads as clean.
    for k in (d + 1)..=(now + 2) {
        for node in [ROOT, TEAM, AGENT0] {
            let b = budget(&e, node, Some(k)).await?;
            assert_eq!(b.executed(), 0, "level {node}: spend leaked into day {k}");
            assert_eq!(b.pending(), 0, "level {node}: reservation leaked into day {k}");
        }
    }
    Ok(())
}
