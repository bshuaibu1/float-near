//! The Chain Signatures rail.
//!
//! What these tests are FOR: proving the cross-chain path did not open a hole
//! around the budget tree. The hierarchical check and the reservation lifecycle
//! are shared code (`resolve_reservation`), so the claim to establish is that
//! the new rail actually goes through them — and that a refusal costs nothing
//! and signs nothing.
//!
//! What they deliberately do NOT establish: that the signature is valid, or
//! that the transaction would be accepted on Base. The signer is a mock and
//! nothing is relayed. The contract proves authorization and signature; Base
//! settlement is unobserved, which is why `SIGNED` is a distinct status from
//! `SETTLED`.

mod common;
use anyhow::Result;
use common::*;

/// Happy path: the Base rail settles the reservation and signs a transaction
/// the VAULT built from the amount and payee it authorized.
#[tokio::test]
async fn base_route_signs_and_converts_pending_to_executed() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    // The EVM payee goes on the SAME allowlist as a NEAR payee.
    allow_recipients(&e, ROOT, vec![e.payee.id().to_string(), EVM_PAYEE.to_string()]).await?;

    assert_eq!(sign_count(&e).await?, 0, "nothing signed before the request");

    let out = pay_base(&e.agents[0], &e, "b1", PAY, EVM_PAYEE).await?;
    assert!(out.is_success(), "base payment failed: {out:#?}");

    // The signer was actually asked, exactly once.
    assert_eq!(sign_count(&e).await?, 1, "the vault did not request a signature");
    assert_eq!(
        signed_path(&e, 0).await?.as_deref(),
        Some("base-1"),
        "signed under a path the owner did not configure",
    );

    // A 32-byte hash, not a passed-through blob.
    let payload = payload_hex(&e, 0).await?.expect("a recorded payload");
    assert_eq!(payload.len(), 64, "payload must be a 32-byte hash: {payload}");

    let r = request(&e, "b1").await?;
    assert_eq!(r.status, "SETTLED");
    // SIGNED, not SETTLED: the vault proved authorization + signature. It
    // cannot observe whether the transaction landed on Base.
    assert_eq!(r.reason_code, "SIGNED");

    // The reservation was CONSUMED, at every level of the chain, on the
    // reserved day — the same lifecycle the NEP-141 rail uses, because it is
    // the same code.
    for node in [ROOT, TEAM, AGENT0] {
        let b = budget(&e, node, Some(r.reserved_day)).await?;
        assert_eq!(b.pending(), 0, "node {node} still holds a reservation");
        assert_eq!(b.executed(), PAY, "node {node} did not book the spend");
    }

    // The NEAR rail was not involved. If the Base route also fired an
    // ft_transfer, the payment would be made twice.
    assert_eq!(ft_transfer_count(&e).await?, 0, "the base route moved NEP-141 tokens");
    Ok(())
}

/// Blocked: a Base payment refused by the shared parent pool signs NOTHING.
///
/// This is the test that matters. If the cross-chain rail could reach the
/// signer before the hierarchical check, the budget tree would be decorative
/// for exactly the payments that leave the chain — an attacker's preferred
/// route. So the assertion is not merely that the request was refused, but
/// that the MPC contract was never called and no budget moved.
#[tokio::test]
async fn a_base_payment_blocked_by_the_parent_pool_never_reaches_the_signer() -> Result<()> {
    // Two agents, each capped at the FULL root cap, sharing one root pool.
    let e = setup(2, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![e.payee.id().to_string(), EVM_PAYEE.to_string()]).await?;

    // Agent 0 drains the shared pool over the Base rail.
    let first = pay_base(&e.agents[0], &e, "b1", CAP, EVM_PAYEE).await?;
    assert!(first.is_success(), "first base payment failed: {first:#?}");
    assert_eq!(sign_count(&e).await?, 1);

    // Agent 1 still has its OWN full cap untouched — the entire point of the
    // hierarchy is that this is refused anyway.
    let a1 = AGENT0 + 1;
    let own = budget(&e, a1, None).await?;
    assert_eq!(own.executed(), 0, "agent 1 should have spent nothing yet");
    assert_eq!(own.available(), CAP, "agent 1 should hold its full own cap");

    let out = pay_base(&e.agents[1], &e, "b2", PAY, EVM_PAYEE).await?;
    assert!(out.is_success(), "the block should be a returned outcome, not a failure");
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.status, "BLOCKED");
    assert_eq!(
        o.reason_code, "PARENT_DAILY_BUDGET",
        "blocked for the wrong reason, so this proves nothing about the pool",
    );

    // THE assertion: the signer was never reached.
    assert_eq!(
        sign_count(&e).await?,
        1,
        "a blocked base payment still asked the MPC network to sign",
    );

    // And nothing was charged anywhere.
    for node in [ROOT, TEAM, a1] {
        let b = budget(&e, node, None).await?;
        assert_eq!(b.pending(), 0, "node {node} holds a reservation for a blocked payment");
    }
    assert_eq!(budget(&e, a1, None).await?.executed(), 0, "a blocked payment was booked");
    Ok(())
}

/// A refusing signer releases the reservation at every level — I6 for the
/// cross-chain rail.
///
/// Included because the happy path alone cannot distinguish "the reservation
/// resolves correctly" from "the reservation is consumed unconditionally".
#[tokio::test]
async fn a_failed_signature_releases_the_reservation_at_every_level() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![e.payee.id().to_string(), EVM_PAYEE.to_string()]).await?;

    set_fail_signing(&e, true).await?;
    let out = pay_base(&e.agents[0], &e, "b1", PAY, EVM_PAYEE).await?;
    assert!(out.is_success(), "the callback should absorb the signer's refusal");

    // Positive control: it failed because of OUR hook, not for some other
    // reason that would make this assertion accidental.
    assert!(
        out.receipt_failures().iter().any(|f| format!("{f:?}").contains("MOCK_MPC_REFUSED")),
        "did not fail via the forced-refusal hook: {out:#?}",
    );

    let r = request(&e, "b1").await?;
    assert_eq!(r.status, "TRANSFER_FAILED");
    assert_eq!(r.reason_code, "SIGNATURE_FAILED");

    for node in [ROOT, TEAM, AGENT0] {
        let b = budget(&e, node, Some(r.reserved_day)).await?;
        assert_eq!(b.pending(), 0, "node {node} never released its reservation");
        assert_eq!(b.executed(), 0, "node {node} booked a payment that was never signed");
        assert_eq!(b.available(), CAP, "node {node} lost budget to a failed signature");
    }
    Ok(())
}

/// The rail is CLOSED until the owner opens it.
///
/// A fresh deploy must not be able to sign a cross-chain transaction, and the
/// refusal must happen before anything is charged.
#[tokio::test]
async fn the_base_rail_is_closed_until_the_owner_opens_it() -> Result<()> {
    let e = setup(1, CAP).await?;
    // open_base_rail deliberately NOT called.
    allow_recipients(&e, ROOT, vec![e.payee.id().to_string(), EVM_PAYEE.to_string()]).await?;

    let out = pay_base(&e.agents[0], &e, "b1", PAY, EVM_PAYEE).await?;
    assert!(out.is_success());
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "BASE_RAIL_CLOSED");
    assert_eq!(sign_count(&e).await?, 0);
    assert_eq!(budget(&e, ROOT, None).await?.pending(), 0, "charged on a closed rail");
    Ok(())
}

/// A payee that is not on the allowlist is refused on the Base rail too, and
/// is refused as NOT-ALLOWED rather than as malformed.
///
/// This pins the ordering: the allowlist runs before the rail-specific shape
/// check, so the cross-chain rail cannot be used to probe which addresses
/// parse.
#[tokio::test]
async fn an_unallowlisted_evm_payee_is_refused_before_the_signer() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    // EVM_PAYEE is deliberately NOT allowlisted.

    let out = pay_base(&e.agents[0], &e, "b1", PAY, EVM_PAYEE).await?;
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "RECIPIENT_NOT_ALLOWED");
    assert_eq!(sign_count(&e).await?, 0, "asked the signer for an unallowlisted payee");
    Ok(())
}

/// A malformed EVM address is refused, and only reports as malformed once it
/// is past the allowlist.
#[tokio::test]
async fn a_malformed_evm_address_is_refused() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    // Uppercase hex: a valid NEAR account id, and allowlisted, but not a
    // canonical lowercase EVM address. Rejected so that one address cannot
    // become two distinct allowlist entries.
    let mixed = "0x4200000000000000000000000000000000000006x";
    allow_recipients(&e, ROOT, vec![mixed.to_string()]).await?;

    let out = pay_base(&e.agents[0], &e, "b1", PAY, mixed).await?;
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "INVALID_EVM_ADDRESS");
    assert_eq!(sign_count(&e).await?, 0);
    assert_eq!(budget(&e, ROOT, None).await?.pending(), 0);
    Ok(())
}

/// The signed bytes are BOUND to the authorized payment.
///
/// The hash is opaque to the test, so what is checked is the property that
/// matters: change the amount, and the bytes the vault asks to have signed
/// change. If they did not, the signature would not be tied to what the budget
/// tree approved, and the whole construction would be decorative.
#[tokio::test]
async fn the_signed_payload_changes_with_the_authorized_amount() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![EVM_PAYEE.to_string()]).await?;

    pay_base(&e.agents[0], &e, "b1", PAY, EVM_PAYEE).await?.into_result()?;
    pay_base(&e.agents[0], &e, "b2", PAY + 1, EVM_PAYEE).await?.into_result()?;

    let first = payload_hex(&e, 0).await?.expect("first payload");
    let second = payload_hex(&e, 1).await?.expect("second payload");
    assert_ne!(
        first, second,
        "the same bytes were signed for two different amounts, so the \
         signature is not bound to the authorized payment",
    );
    Ok(())
}

/// The signed bytes are bound to the authorized PAYEE, not just the amount.
///
/// Written because mutation M22 proved it was needed. Hardcoding the
/// destination inside the calldata — so the vault signs a transfer to an
/// attacker address no matter who was authorized — left all 17 tests green.
/// That is the single worst bug this rail can have: the budget tree and the
/// allowlist both pass, and the signature pays someone else. The amount-varies
/// test could not see it because every test used one payee.
#[tokio::test]
async fn the_signed_payload_changes_with_the_authorized_payee() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![EVM_PAYEE.to_string(), EVM_PAYEE_2.to_string()]).await?;

    // Same amount, same nonce, same fees — ONLY the payee differs.
    pay_base(&e.agents[0], &e, "b1", PAY, EVM_PAYEE).await?.into_result()?;
    pay_base(&e.agents[0], &e, "b2", PAY, EVM_PAYEE_2).await?.into_result()?;

    let first = payload_hex(&e, 0).await?.expect("first payload");
    let second = payload_hex(&e, 1).await?.expect("second payload");
    assert_ne!(
        first, second,
        "the same bytes were signed for two DIFFERENT payees, so the vault is          not signing the payment it authorized — it is signing a destination          the caller cannot see and the budget tree cannot constrain",
    );
    Ok(())
}

/// The MCP server's NEAR-rail wire format is accepted by the contract.
///
/// `buildRoute("near")` emits the bare string `"near_direct"`. Every other test
/// either omits `route` or passes the struct variant, so nothing established
/// that serde accepts the unit variant in that form. A mismatch here would make
/// every MCP payment fail at deserialisation — after the TypeScript tests
/// passed, because they only check what the client produces, not what the
/// contract accepts.
#[tokio::test]
async fn the_mcp_near_rail_wire_format_deserialises() -> Result<()> {
    let e = setup(1, CAP).await?;

    let out = pay_raw_route(
        &e.agents[0],
        &e,
        "w1",
        PAY,
        e.payee.id().as_str(),
        serde_json::json!("near_direct"),
    )
    .await?;
    assert!(out.is_success(), "contract rejected the MCP's near-rail route: {out:#?}");

    let r = request(&e, "w1").await?;
    assert_eq!(r.status, "SETTLED");
    // It really took the NEAR rail, rather than being accepted and ignored.
    assert_eq!(r.reason_code, "SETTLED", "explicit near_direct did not settle as NEP-141");
    assert_eq!(ft_transfer_count(&e).await?, 1, "no NEP-141 transfer happened");
    assert_eq!(sign_count(&e).await?, 0, "the near rail reached the signer");
    Ok(())
}
