//! The cross-chain rail against an UNREGISTERED deposit address.
//!
//! This is the failure that cost the first real mainnet payment. 1Click issues a
//! fresh IMPLICIT account per quote, which has no storage balance on the token,
//! and NEP-141 `ft_transfer` refuses an unregistered receiver:
//!
//!     Smart contract panicked: The account 61c81429…7c0d is not registered
//!
//! Everything else had passed — both signatures, the payee allowlist, the budget
//! reservation. KNOWN-TRADEOFFS §13.
//!
//! WHY THE VAULT REGISTERS IT, rather than an operator daemon. Two independent
//! blockers, both measured rather than assumed:
//!
//!   - ORDERING. `dispatch_payment` builds `ft_transfer -> on_transfer_result`
//!     as one promise chain inside the same transaction as the request. A daemon
//!     watching the chain learns the deposit address only once the transfer is
//!     already in flight, so it can never get ahead of it.
//!   - AUTHORITY. `storage_deposit` requires an attached deposit, and a NEAR
//!     function-call key cannot attach one at all. So an operator-side
//!     registrar needs a FULL-ACCESS key living in a long-running network
//!     service — the opposite of the restricted-key design the rest of this
//!     contract rests on.
//!
//! The vault already holds NEAR and already knows the deposit address, and the
//! quote-signature gate already bounds who can reach this code: only a binding
//! signed by the owner's registered quote key gets this far, so an agent cannot
//! spend the vault's NEAR on registrations at will.
mod common;
use common::*;

use anyhow::Result;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;

/// Deterministic, and distinct from virtual_agent.rs's `[7u8; 32]` so a mix-up
/// between the two keys fails loudly instead of silently verifying.
fn quote_key() -> SigningKey {
    SigningKey::from_bytes(&[11u8; 32])
}

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

// ---- borsh, hand-rolled on purpose.
//
// Same reasoning as virtual_agent.rs: importing the contract's own encoder
// would make the test agree with the contract by construction, so a field
// reorder would break production and pass here.
fn bstr(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut v = (b.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(b);
    v
}
fn bu128(n: u128) -> Vec<u8> {
    n.to_le_bytes().to_vec()
}
fn bu64(n: u64) -> Vec<u8> {
    n.to_le_bytes().to_vec()
}

/// QuoteBinding, from contracts/vault/src/types.rs:406.
/// Order: vault, request_id, token, amount, payee, deposit_address, deadline_ns.
#[allow(clippy::too_many_arguments)]
fn encode_quote(
    vault: &str,
    request_id: &str,
    token: &str,
    amount: u128,
    payee: &str,
    deposit_address: &str,
    deadline_ns: u64,
) -> Vec<u8> {
    let mut v = bstr(vault);
    v.extend(bstr(request_id));
    v.extend(bstr(token));
    v.extend(bu128(amount));
    v.extend(bstr(payee));
    v.extend(bstr(deposit_address));
    v.extend(bu64(deadline_ns));
    v
}

/// Year ~2096 in nanoseconds — comfortably past any sandbox block timestamp.
const FAR_FUTURE_NS: u64 = 4_000_000_000_000_000_000;

/// A deposit address that is deliberately NOT registered on the token, standing
/// in for the fresh implicit account 1Click mints per quote.
const DEPOSIT: &str = "oneclick-deposit.test.near";

async fn arrange(e: &Env) -> Result<()> {
    // The rail is closed until the owner registers a quote signer, so this is
    // also a positive control: if it were skipped, every payment below would be
    // refused with QUOTE_SIGNER_UNSET and the test would prove nothing about
    // registration.
    let raw32 = B64.encode(quote_key().verifying_key().to_bytes());
    e.owner
        .call(e.vault.id(), "set_quote_signer")
        .args_json(json!({ "public_key": raw32 }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    allow_recipients(e, ROOT, vec![e.payee.id().to_string()]).await?;
    Ok(())
}

/// Same as `intents_route`, but for an arbitrary deposit address — 1Click mints
/// a FRESH one per quote, so a drain uses a different address every time and
/// never benefits from an already-registered one.
fn intents_route_to(
    e: &Env,
    request_id: &str,
    amount: u128,
    payee: &str,
    deposit: &str,
) -> serde_json::Value {
    let msg = encode_quote(
        e.vault.id().as_str(),
        request_id,
        e.ft.id().as_str(),
        amount,
        payee,
        deposit,
        FAR_FUTURE_NS,
    );
    let sig = quote_key().sign(&msg);
    json!({
        "intents": {
            "deposit_address": deposit,
            "quote_deadline_ns": FAR_FUTURE_NS.to_string(),
            "signature": B64.encode(sig.to_bytes()),
        }
    })
}

fn intents_route(e: &Env, request_id: &str, amount: u128, payee: &str) -> serde_json::Value {
    let msg = encode_quote(
        e.vault.id().as_str(),
        request_id,
        e.ft.id().as_str(),
        amount,
        payee,
        DEPOSIT,
        FAR_FUTURE_NS,
    );
    let sig = quote_key().sign(&msg);
    json!({
        "intents": {
            "deposit_address": DEPOSIT,
            "quote_deadline_ns": FAR_FUTURE_NS.to_string(),
            "signature": B64.encode(sig.to_bytes()),
        }
    })
}

/// THE REGRESSION. A cross-chain payment must settle even though the deposit
/// address has never been registered on the token.
#[tokio::test]
async fn an_unregistered_deposit_address_is_registered_by_the_vault() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    arrange(&e).await?;

    let payee = e.payee.id().to_string();
    let before: Option<serde_json::Value> = e
        .ft
        .view("storage_balance_of")
        .args_json(json!({ "account_id": DEPOSIT }))
        .await?
        .json()?;
    assert!(before.is_none(), "the deposit address must start unregistered");

    let out = pay_raw_route(
        &e.agents[0],
        &e,
        "intents-reg-1",
        PAY,
        &payee,
        intents_route(&e, "intents-reg-1", PAY, &payee),
    )
    .await?;
    assert!(out.is_success(), "the call itself must not fail: {out:#?}");

    let r = request(&e, "intents-reg-1").await?;
    assert_eq!(
        r.status, "SETTLED",
        "an unregistered deposit address must be registered, not refused: {r:?}"
    );

    // The tokens actually arrived — SETTLED without a balance would mean the
    // callback lied.
    // Read as a String and parsed, matching virtual_agent.rs — the test crate
    // deliberately does not depend on near_sdk, so it cannot agree with the
    // contract's own types by construction.
    let bal: String = e
        .ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": DEPOSIT }))
        .await?
        .json()?;
    assert_eq!(bal.parse::<u128>()?, PAY, "the deposit address should hold the payment");
    Ok(())
}

/// Registering must not become a way for an agent to drain the vault's NEAR:
/// the quote-signature gate runs FIRST, so a bad signature is refused before
/// any registration happens.
#[tokio::test]
async fn a_bad_quote_signature_registers_nothing() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    arrange(&e).await?;
    let payee = e.payee.id().to_string();

    let mut route = intents_route(&e, "intents-reg-2", PAY, &payee);
    // Flip the signature to something valid-shaped but wrong.
    route["intents"]["signature"] = json!(B64.encode([9u8; 64]));

    let out = pay_raw_route(&e.agents[0], &e, "intents-reg-2", PAY, &payee, route).await?;
    assert!(out.is_success(), "a blocked payment is a value, not a failure");

    let still_absent: Option<serde_json::Value> = e
        .ft
        .view("storage_balance_of")
        .args_json(json!({ "account_id": DEPOSIT }))
        .await?
        .json()?;
    assert!(
        still_absent.is_none(),
        "a refused payment must not have paid to register anything"
    );
    Ok(())
}

/// Re-registering an ALREADY registered address must be harmless, because the
/// vault cannot know whether a given address has been seen before.
#[tokio::test]
async fn registering_twice_is_harmless() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    arrange(&e).await?;
    let payee = e.payee.id().to_string();

    // Pre-register it, so the vault's own registration is the second one.
    e.owner
        .call(e.ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": DEPOSIT }))
        .deposit(near_workspaces::types::NearToken::from_millinear(10))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let out = pay_raw_route(
        &e.agents[0],
        &e,
        "intents-reg-3",
        PAY,
        &payee,
        intents_route(&e, "intents-reg-3", PAY, &payee),
    )
    .await?;
    assert!(out.is_success(), "{out:#?}");
    assert_eq!(request(&e, "intents-reg-3").await?.status, "SETTLED");
    Ok(())
}

/// F2 — the vault's NEAR is spent PER TRANSACTION while the budget tree bounds
/// token VALUE, so many small cross-chain payments drain a resource no cap
/// governs.
///
/// This is the executable PoC the self-review said it lacked. The arithmetic
/// and the live measurement were already there (0.1329 NEAR spendable on
/// mainnet, ~106 registrations); what was missing was a test that actually
/// makes N payments and watches the balance fall.
///
/// A fresh deposit address per payment, because that is what 1Click mints — a
/// drain never benefits from an already-registered address.
#[tokio::test]
async fn many_small_payments_drain_near_that_no_cap_bounds() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    arrange(&e).await?;
    let payee = e.payee.id().to_string();

    const N: u128 = 5;
    // 0.01 at 6dp — confirmed quotable against the live 1Click API
    // (amountIn 0.012531), so this is not a dust amount the real rail refuses.
    const TINY: u128 = 10_000;

    let before = e.vault.view_account().await?.balance.as_yoctonear();
    let budget_before = budget(&e, ROOT, None).await?.executed();

    for i in 0..N {
        let rid = format!("drain-{i}");
        let dep = format!("dep{i}.oneclick.test.near");
        let out = pay_raw_route(
            &e.agents[0],
            &e,
            &rid,
            TINY,
            &payee,
            intents_route_to(&e, &rid, TINY, &payee, &dep),
        )
        .await?;
        assert!(out.is_success(), "payment {i} should be accepted: {out:#?}");
        assert_eq!(request(&e, &rid).await?.status, "SETTLED", "payment {i}");
    }

    let after = e.vault.view_account().await?.balance.as_yoctonear();
    let budget_after = budget(&e, ROOT, None).await?.executed();

    let near_spent = before.saturating_sub(after);
    let token_spent = budget_after - budget_before;
    let per_payment = near_spent / N;

    println!(
        "  {N} payments of {TINY} base units:\n\
             token charged to the budget : {token_spent} base units\n\
             NEAR spent by the vault     : {near_spent} yocto ({per_payment} per payment)"
    );

    // The budget saw a trivial amount...
    assert_eq!(token_spent, N * TINY, "the tree charges token value only");

    // ...while the vault paid a substantial FIXED NEAR cost per transaction
    // that no cap governs.
    //
    // THE BOUND HERE IS MEASURED, NOT DERIVED. The first version of this test
    // asserted `>= 0.00125 * 0.9` on the reasoning that 0.00125 is attached per
    // registration, so roughly that much must leave. It failed: the observed
    // net is ~1.104e21 yocto (0.0011 NEAR) per payment, about 12% less than the
    // attached deposit. Some of the attached NEAR evidently comes back through
    // refund accounting; the exact mechanism is not asserted here because it
    // was not measured, only the net effect was.
    //
    // That correction matters to the finding's arithmetic and makes it slightly
    // WORSE: at ~0.0011 rather than 0.00125, the ~0.1329 NEAR spendable on the
    // live mainnet vault funds roughly 120 payments rather than 106.
    let floor = N * 1_000_000_000_000_000_000_000u128; // 0.001 NEAR each
    assert!(
        near_spent >= floor,
        "expected at least {floor} yocto to leave the vault across {N} payments, \
         saw {near_spent}. If this is now far lower, a bound on per-transaction \
         NEAR spend has been added — update this test to assert THAT bound."
    );

    // The finding, stated as the property rather than a number: the NEAR cost
    // does not scale with the amount. Paying one base unit costs the vault the
    // same NEAR as paying the per-tx cap, which is what makes the drain cheap.
    // 1000x the token value here, in NEAR terms, for a payment worth 0.01.
    assert!(
        per_payment >= 1_000_000_000_000_000_000_000u128,
        "each payment costs the vault ~0.0011 NEAR regardless of its size; saw {per_payment}"
    );
    Ok(())
}
