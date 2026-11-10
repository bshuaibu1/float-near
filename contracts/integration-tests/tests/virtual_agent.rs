//! Sandbox tier for the virtual-agent rail — real node, real host crypto.
//!
//! WHY THIS FILE EXISTS. `request_payment_signed` is authorised entirely by
//! `env::ed25519_verify`, a HOST function. The unit tier exercises it against
//! near-sdk's MOCKED blockchain, so a passing unit test says the mock accepts
//! the signature, not that `neard` does. The project's own workspace manifest
//! makes the general form of this point: "The unit tier cannot catch this:
//! unit tests run natively." Until this file existed, the only tier running a
//! real runtime never called the signed path at all — the symbols were in the
//! wasm and unreachable from any test.
//!
//! The borsh encoding below is deliberately HAND-ROLLED rather than imported.
//! The unit tier signs by calling `near_sdk::borsh::to_vec` on the real
//! `VirtualAgentBinding`, so it agrees with the contract by construction and
//! could never detect a mistake in it. Re-deriving the bytes here makes this a
//! third independent witness, alongside the Rust derive and the JS encoder in
//! `packages/create-float/bin/float-relay.mjs`.
//!
//! That independence needs a positive control, because a one-byte encoding
//! error is INDISTINGUISHABLE from a wrong key — both just fail to verify. So
//! the suite is read as a pair: `a_signed_payment_settles_through_the_callback`
//! proves a correct encoding verifies, and the tampering tests prove
//! verification actually rejects. Either alone could pass for the wrong reason.
//!
//! Prerequisite: scripts/build-wasm.sh (run it under Linux/WSL).

mod common;

use anyhow::{Context, Result};
use base64::Engine;
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::types::{Gas, KeyType, NearToken, PublicKey};
use near_workspaces::{Account, Contract};
use serde_json::json;

/// The node the virtual agent spends from. `setup(1, ..)` builds
/// root -> team -> a0, so binding at AGENT0 exercises the full ancestor walk
/// rather than the cheap single-level case.
const VA_NODE: u32 = AGENT0;

/// Deterministic, so a failure is reproducible rather than a new key each run.
fn agent_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

/// A DIFFERENT key, for proving a signature from an unbound signer is refused.
fn other_key() -> SigningKey {
    SigningKey::from_bytes(&[8u8; 32])
}

/// `ed25519:<base58>`, the form the contract's `PublicKey` parses from JSON.
/// Built via near-workspaces rather than a hand-rolled base58 encoder.
fn pubkey_str(sk: &SigningKey) -> Result<String> {
    let pk = PublicKey::try_from_parts(KeyType::ED25519, &sk.verifying_key().to_bytes())
        .context("32 raw ed25519 bytes should always form a PublicKey")?;
    Ok(pk.to_string())
}

// ---------------------------------------------------------------- borsh
//
// Field order is load-bearing and MUST track `VirtualAgentBinding` in
// contracts/vault/src/types.rs:
//   vault, nonce, deadline_ns, request_id, token, amount, recipient, memo, route

/// borsh String: u32 LE byte length, then UTF-8. `AccountId` encodes as String.
fn b_str(s: &str, out: &mut Vec<u8>) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// borsh u128, little-endian. near-sdk's `U128` serialises as the bare 16 bytes.
fn b_u128(v: u128, out: &mut Vec<u8>) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Everything a signature commits to. Mirrors the contract's struct field for
/// field so a test can sign one thing and submit another.
#[derive(Clone)]
struct Binding {
    vault: String,
    nonce: u64,
    deadline_ns: u64,
    request_id: String,
    token: String,
    amount: u128,
    recipient: String,
    memo: String,
}

impl Binding {
    /// The exact bytes the contract reconstructs and verifies against.
    fn encode(&self) -> Vec<u8> {
        let mut o = Vec::new();
        b_str(&self.vault, &mut o);
        o.extend_from_slice(&self.nonce.to_le_bytes());
        o.extend_from_slice(&self.deadline_ns.to_le_bytes());
        b_str(&self.request_id, &mut o);
        b_str(&self.token, &mut o);
        b_u128(self.amount, &mut o);
        b_str(&self.recipient, &mut o);
        b_str(&self.memo, &mut o);
        // `Route` is a borsh enum: variant tag as u8, by POSITION.
        // `NearDirect` is index 0 and carries no fields. A future variant must
        // be APPENDED — renumbering would silently reinterpret every signature.
        o.push(0u8);
        o
    }

    fn sign(&self, sk: &SigningKey) -> String {
        let sig = sk.sign(&self.encode());
        base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
    }
}

/// A deadline far enough out that a slow sandbox cannot expire it.
async fn binding(e: &Env, request_id: &str, nonce: u64, amount: u128) -> Result<Binding> {
    let now_ns = e.worker.view_block().await?.timestamp();
    Ok(Binding {
        vault: e.vault.id().to_string(),
        nonce,
        deadline_ns: now_ns + 3_600 * 1_000_000_000,
        request_id: request_id.to_string(),
        token: e.ft.id().to_string(),
        amount,
        recipient: e.payee.id().to_string(),
        memo: String::new(),
    })
}

// ---------------------------------------------------------------- calls

async fn bind_va(owner: &Account, vault: &Contract, node_id: u32, pk: &str) -> Result<()> {
    owner
        .call(vault.id(), "bind_virtual_agent")
        .args_json(json!({ "node_id": node_id, "public_key": pk }))
        .max_gas()
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Submit a signed payload. `relayer` is deliberately a parameter: authority
/// comes from the signature, so this must work from an account that is neither
/// the owner nor a bound agent.
async fn relay(
    relayer: &Account,
    e: &Env,
    b: &Binding,
    pk: &str,
    signature: &str,
    gas: Option<Gas>,
) -> Result<near_workspaces::result::ExecutionFinalResult> {
    let mut call = relayer
        .call(e.vault.id(), "request_payment_signed")
        .args_json(json!({
            "request_id": b.request_id,
            "token": b.token,
            "amount": b.amount.to_string(),
            "recipient": b.recipient,
            "memo": b.memo,
            "route": serde_json::Value::Null, // NearDirect
            "public_key": pk,
            "nonce": b.nonce,
            "deadline_ns": b.deadline_ns.to_string(),
            "signature": signature,
        }));
    call = match gas {
        Some(g) => call.gas(g),
        None => call.max_gas(),
    };
    Ok(call.transact().await?)
}

async fn va_nonce(e: &Env, pk: &str) -> Result<u64> {
    Ok(e.vault
        .view("get_virtual_agent_nonce")
        .args_json(json!({ "public_key": pk }))
        .await?
        .json()?)
}

async fn va_node(e: &Env, pk: &str) -> Result<Option<u32>> {
    Ok(e.vault
        .view("get_virtual_agent_node")
        .args_json(json!({ "public_key": pk }))
        .await?
        .json()?)
}

async fn ft_balance(e: &Env, account_id: &str) -> Result<u128> {
    let s: String = e
        .ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": account_id }))
        .await?
        .json()?;
    Ok(s.parse()?)
}

/// `MIN_GAS_FOR_DISPATCH`, read from the shared file rather than hardcoded, so
/// a change to the floor moves this test with it instead of leaving it asserting
/// a stale number. The same file is asserted against by the contract's own
/// `contract_constants_match_the_shared_file`.
fn min_gas_for_dispatch_tgas() -> u64 {
    let raw = include_str!("../../../shared/contract-constants.json");
    let v: serde_json::Value = serde_json::from_str(raw).expect("shared constants are valid JSON");
    v["MIN_GAS_FOR_DISPATCH_TGAS"]
        .as_u64()
        .expect("MIN_GAS_FOR_DISPATCH_TGAS is a number")
}

/// The reason code, read off the returned outcome rather than off an event log.
fn outcome(out: &near_workspaces::result::ExecutionFinalResult) -> Result<PaymentOutcomeView> {
    Ok(out.clone().into_result()?.json()?)
}

// ================================================================== tests

/// THE ROUND TRIP. A key with no NEAR account signs; an unrelated account
/// relays; the payment settles through the transfer callback.
///
/// Also the positive control for the hand-rolled borsh encoder: a correct
/// encoding is the only way `env::ed25519_verify` returns true here.
#[tokio::test]
async fn a_signed_payment_settles_through_the_callback() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let sk = agent_key();
    let pk = pubkey_str(&sk)?;

    bind_va(&e.owner, &e.vault, VA_NODE, &pk).await?;
    assert_eq!(va_node(&e, &pk).await?, Some(VA_NODE), "binding did not take");
    assert_eq!(va_nonce(&e, &pk).await?, 1, "a fresh key's first usable nonce is 1");

    // The relayer is a THIRD party: not the owner, not a bound agent. If
    // authority leaked from the caller rather than the signature, this fails.
    let relayer = e.worker.dev_create_account().await?;
    let payee_before = ft_balance(&e, e.payee.id().as_str()).await?;
    let transfers_before = ft_transfer_count(&e).await?;

    let b = binding(&e, "va-settle", 1, PAY).await?;
    let out = relay(&relayer, &e, &b, &pk, &b.sign(&sk), None).await?;
    assert!(out.is_success(), "a validly signed payment failed: {out:#?}");

    let o = outcome(&out)?;
    assert_eq!(o.reason_code, "SETTLED", "unexpected reason code: {o:?}");
    assert_eq!(o.node_id, VA_NODE, "charged the wrong node");

    // Positive control on the instrument: without this, every assertion below
    // could pass while no token ever moved.
    assert_eq!(
        ft_transfer_count(&e).await? - transfers_before,
        1,
        "the ft_transfer never actually fired"
    );
    assert_eq!(
        ft_balance(&e, e.payee.id().as_str()).await? - payee_before,
        PAY,
        "the payee was not paid"
    );

    // SETTLED is written ONLY by on_transfer_result -> resolve_reservation, so
    // reading it off stored state is what proves the CALLBACK ran. The unit
    // tier cannot reach this: it never schedules the promise.
    let r = request(&e, "va-settle").await?;
    assert_eq!(r.status, "SETTLED", "stored status is not terminal-settled");
    assert_eq!(
        r.reserved_chain,
        vec![ROOT, TEAM, VA_NODE],
        "the signed path must charge every ancestor, like the account path"
    );

    // And every reservation released — a leaked `pending` would silently
    // consume budget at each level forever.
    for node in [ROOT, TEAM, VA_NODE] {
        let bud = budget(&e, node, None).await?;
        assert_eq!(bud.pending(), 0, "node {node} leaked a reservation");
        assert_eq!(bud.executed(), PAY, "node {node} booked the wrong amount");
    }

    assert_eq!(va_nonce(&e, &pk).await?, 2, "the nonce did not advance on-chain");
    Ok(())
}

/// Replay. The IDENTICAL payload, submitted twice.
///
/// `float-relay.mjs`'s `relay()` pre-checks the nonce client-side and throws
/// before paying gas, so replaying through it would only prove the JS guard
/// works. That guard is a cost control, not the security boundary. This submits
/// directly, so what refuses it is the contract.
#[tokio::test]
async fn a_replayed_signature_is_refused_by_the_contract() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let sk = agent_key();
    let pk = pubkey_str(&sk)?;
    bind_va(&e.owner, &e.vault, VA_NODE, &pk).await?;

    let relayer = e.worker.dev_create_account().await?;
    let b = binding(&e, "va-replay", 1, PAY).await?;
    let sig = b.sign(&sk);

    let first = relay(&relayer, &e, &b, &pk, &sig, None).await?;
    assert_eq!(outcome(&first)?.reason_code, "SETTLED", "the first use must succeed");
    let transfers_after_first = ft_transfer_count(&e).await?;
    let payee_after_first = ft_balance(&e, e.payee.id().as_str()).await?;

    // Byte-identical resubmission.
    let second = relay(&relayer, &e, &b, &pk, &sig, None).await?;
    assert!(second.is_success(), "a refusal is a value, not a panic: {second:#?}");
    let o = outcome(&second)?;
    assert_eq!(o.status, "BLOCKED", "a replay must be refused");
    assert_eq!(
        o.reason_code, "NONCE_NOT_FRESH",
        "refused for the wrong reason, so this test is not pinning the replay guard"
    );

    assert_eq!(
        ft_transfer_count(&e).await?,
        transfers_after_first,
        "the replay fired a SECOND transfer"
    );
    assert_eq!(
        ft_balance(&e, e.payee.id().as_str()).await?,
        payee_after_first,
        "the replay moved tokens"
    );
    Ok(())
}

/// The relayer may censor but must not be able to rewrite. Each row signs one
/// payload and submits a DIFFERENT one, which must be refused.
///
/// This is the test that proves `env::ed25519_verify` actually verifies under a
/// real runtime rather than rubber-stamping — and, together with the settle
/// test, that the hand-rolled borsh covers every field it claims to.
#[tokio::test]
async fn a_relayer_cannot_rewrite_any_signed_field() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let sk = agent_key();
    let pk = pubkey_str(&sk)?;
    bind_va(&e.owner, &e.vault, VA_NODE, &pk).await?;
    let relayer = e.worker.dev_create_account().await?;
    let thief = e.worker.dev_create_account().await?;

    let signed = binding(&e, "va-tamper", 1, PAY).await?;
    let sig = signed.sign(&sk);

    // Each case mutates exactly one field of what is SUBMITTED, leaving the
    // signature over the original. One field per row, so a pass cannot be
    // carried by a different clause than the one named.
    let mut amount_up = signed.clone();
    amount_up.amount = PAY * 2;

    let mut redirected = signed.clone();
    redirected.recipient = thief.id().to_string();

    let mut renamed = signed.clone();
    renamed.request_id = "va-tamper-other".to_string();

    let mut renonced = signed.clone();
    renonced.nonce = 2;

    let mut extended = signed.clone();
    extended.deadline_ns = signed.deadline_ns + 1;

    for (field, tampered) in [
        ("amount", amount_up),
        ("recipient", redirected),
        ("request_id", renamed),
        ("nonce", renonced),
        ("deadline_ns", extended),
    ] {
        let out = relay(&relayer, &e, &tampered, &pk, &sig, None).await?;
        assert!(out.is_success(), "a refusal is a value, not a panic ({field}): {out:#?}");
        let o = outcome(&out)?;
        assert_eq!(
            o.reason_code, "BAD_AGENT_SIGNATURE",
            "rewriting `{field}` was NOT caught by the signature; the binding does not cover it"
        );
        assert_eq!(ft_transfer_count(&e).await?, 0, "a tampered payload moved tokens ({field})");
        // Asserted DIRECTLY, not left to the positive row below: the signature
        // check sits before the nonce burn precisely so that an unauthenticated
        // caller cannot grief an agent by burning its nonces with garbage.
        assert_eq!(
            va_nonce(&e, &pk).await?,
            1,
            "a rejected `{field}` tamper burned the nonce — garbage signatures can now \
             grief an agent's replay guard"
        );
    }

    // The signature is still good for what it actually signed. Without this
    // row, every assertion above could pass because the payload was broken in
    // some unrelated way rather than because tampering was detected.
    let out = relay(&relayer, &e, &signed, &pk, &sig, None).await?;
    assert_eq!(
        outcome(&out)?.reason_code,
        "SETTLED",
        "the untampered payload must still settle, or the rows above prove nothing"
    );
    Ok(())
}

/// A signature from a key that was never bound, and from a bound key's twin.
/// `NOT_VIRTUAL_AGENT` is a PANIC, not a blocked value: with no node to
/// attribute the refusal to there is nothing to record.
#[tokio::test]
async fn an_unbound_key_cannot_spend() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let bound = agent_key();
    let stranger = other_key();
    let bound_pk = pubkey_str(&bound)?;
    let stranger_pk = pubkey_str(&stranger)?;
    bind_va(&e.owner, &e.vault, VA_NODE, &bound_pk).await?;
    assert_eq!(va_node(&e, &stranger_pk).await?, None, "the stranger must not be bound");

    let relayer = e.worker.dev_create_account().await?;
    let b = binding(&e, "va-unbound", 1, PAY).await?;

    // Correctly signed by the stranger, for itself.
    let out = relay(&relayer, &e, &b, &stranger_pk, &b.sign(&stranger), None).await?;
    assert!(out.is_failure(), "an unbound signer must not spend");
    let text = format!("{:?}", out.failures());
    assert!(
        text.contains("NOT_VIRTUAL_AGENT"),
        "wrong refusal, or the reason code did not survive into the receipt. Got: {text}"
    );

    // And the stranger's signature presented under the BOUND key's identity.
    let out = relay(&relayer, &e, &b, &bound_pk, &b.sign(&stranger), None).await?;
    assert_eq!(
        outcome(&out)?.reason_code,
        "BAD_AGENT_SIGNATURE",
        "a signature by the wrong key was accepted for a bound pubkey"
    );
    assert_eq!(ft_transfer_count(&e).await?, 0, "nothing should have moved");
    Ok(())
}

/// The gas floor, from both sides, under REAL gas metering.
///
/// This pins the comparator direction — `<`, not `<=`. A floor that rejected
/// its own boundary value would move the real minimum one gas unit above the
/// constant that documents it, while every doc still said 50. The unit tier
/// checks this against near-sdk's mock; only a real node proves what `neard`
/// charges. Matches testnet 2026-10-28: 50 Tgas settles, 49 panics.
///
/// It also pins the subtler half: the `InsufficientGas` path PANICS, which
/// reverts the nonce burn, so an under-gassed submission must leave the
/// payload replayable. If that nonce were consumed, a malicious relayer could
/// destroy an agent's signed payloads by deliberately under-gassing them.
#[tokio::test]
async fn the_gas_floor_admits_its_own_boundary_and_refuses_below_it() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let sk = agent_key();
    let pk = pubkey_str(&sk)?;
    bind_va(&e.owner, &e.vault, VA_NODE, &pk).await?;
    let relayer = e.worker.dev_create_account().await?;

    let floor = min_gas_for_dispatch_tgas();
    let b = binding(&e, "va-gas", 1, PAY).await?;
    let sig = b.sign(&sk);

    // --- one Tgas BELOW the floor: refused, and nothing consumed.
    let under = relay(&relayer, &e, &b, &pk, &sig, Some(Gas::from_tgas(floor - 1))).await?;
    assert!(under.is_failure(), "{} Tgas is below the floor and must be refused", floor - 1);
    let text = format!("{:?}", under.failures());
    assert!(
        text.contains("INSUFFICIENT_GAS"),
        "refused for the wrong reason at {} Tgas. Got: {text}",
        floor - 1
    );
    assert_eq!(
        va_nonce(&e, &pk).await?,
        1,
        "the panic must revert the nonce burn, or an under-gassed relay destroys the payload"
    );
    assert_eq!(ft_transfer_count(&e).await?, 0, "nothing should have moved");

    // --- at EXACTLY the floor: the identical payload dispatches and settles.
    let at = relay(&relayer, &e, &b, &pk, &sig, Some(Gas::from_tgas(floor))).await?;
    assert!(at.is_success(), "exactly {floor} Tgas must dispatch: {at:#?}");
    assert_eq!(
        outcome(&at)?.reason_code,
        "SETTLED",
        "exactly {floor} Tgas is adequately funded and must settle"
    );
    assert_eq!(ft_transfer_count(&e).await?, 1, "the transfer never fired at the floor");
    assert_eq!(va_nonce(&e, &pk).await?, 2, "a settled payment must advance the nonce");
    Ok(())
}

/// Many keys may map to ONE node, with INDEPENDENT replay guards. If the nonce
/// counter were per-node rather than per-key, one agent in a swarm would
/// invalidate its siblings' signed payloads.
#[tokio::test]
async fn two_keys_on_one_node_share_a_budget_but_not_a_nonce() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let a = agent_key();
    let b_key = other_key();
    let pk_a = pubkey_str(&a)?;
    let pk_b = pubkey_str(&b_key)?;

    bind_va(&e.owner, &e.vault, VA_NODE, &pk_a).await?;
    bind_va(&e.owner, &e.vault, VA_NODE, &pk_b).await?;
    assert_eq!(va_node(&e, &pk_a).await?, Some(VA_NODE));
    assert_eq!(va_node(&e, &pk_b).await?, Some(VA_NODE), "many-to-one binding failed");

    let relayer = e.worker.dev_create_account().await?;

    let ba = binding(&e, "va-many-a", 1, PAY).await?;
    assert_eq!(outcome(&relay(&relayer, &e, &ba, &pk_a, &ba.sign(&a), None).await?)?.reason_code,
        "SETTLED");

    // A's nonce moved; B's must not have.
    assert_eq!(va_nonce(&e, &pk_a).await?, 2, "A's nonce should have advanced");
    assert_eq!(
        va_nonce(&e, &pk_b).await?,
        1,
        "B's nonce moved when A spent — the replay guard is shared, so one agent can \
         invalidate another's payloads"
    );

    // So B's nonce 1 is still usable, even though A already consumed nonce 1.
    let bb = binding(&e, "va-many-b", 1, PAY).await?;
    assert_eq!(
        outcome(&relay(&relayer, &e, &bb, &pk_b, &bb.sign(&b_key), None).await?)?.reason_code,
        "SETTLED",
        "B could not use its own nonce 1 after A used A's"
    );

    // One shared pool: the node and its ancestors carry BOTH payments.
    for node in [ROOT, TEAM, VA_NODE] {
        assert_eq!(
            budget(&e, node, None).await?.executed(),
            PAY * 2,
            "node {node} did not book both agents' spend against one pool"
        );
    }
    Ok(())
}

/// Revoking a key must not reset its replay guard. If it did, an owner could
/// unbind and rebind to make every signature that key ever produced valid
/// again. Measured on testnet: the nonce entry is retained on purpose, which
/// is also why unbinding reclaims only part of the per-agent storage.
#[tokio::test]
async fn rebinding_a_revoked_key_does_not_reset_its_nonce() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let sk = agent_key();
    let pk = pubkey_str(&sk)?;
    bind_va(&e.owner, &e.vault, VA_NODE, &pk).await?;

    let relayer = e.worker.dev_create_account().await?;
    let first = binding(&e, "va-rebind-1", 1, PAY).await?;
    let sig = first.sign(&sk);
    assert_eq!(outcome(&relay(&relayer, &e, &first, &pk, &sig, None).await?)?.reason_code,
        "SETTLED");
    assert_eq!(va_nonce(&e, &pk).await?, 2);

    e.owner
        .call(e.vault.id(), "unbind_virtual_agent")
        .args_json(json!({ "public_key": pk }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(va_node(&e, &pk).await?, None, "unbind did not clear the node mapping");
    assert_eq!(
        va_nonce(&e, &pk).await?,
        2,
        "unbinding RESET the replay guard — every signature this key ever made is valid again"
    );

    bind_va(&e.owner, &e.vault, VA_NODE, &pk).await?;
    assert_eq!(va_nonce(&e, &pk).await?, 2, "rebinding reset the replay guard");

    // The original payload must still be dead after the unbind/rebind cycle.
    let out = relay(&relayer, &e, &first, &pk, &sig, None).await?;
    assert_eq!(
        outcome(&out)?.reason_code,
        "NONCE_NOT_FRESH",
        "a pre-revocation signature became replayable after rebinding"
    );
    Ok(())
}

/// An expired signature is refused, and refusing it must not consume the
/// nonce: the deadline check sits BEFORE the burn, so a payload that merely
/// sat too long in a relayer's queue can be re-signed rather than being
/// silently worth nothing.
#[tokio::test]
async fn an_expired_signature_is_refused_without_burning_the_nonce() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let sk = agent_key();
    let pk = pubkey_str(&sk)?;
    bind_va(&e.owner, &e.vault, VA_NODE, &pk).await?;
    let relayer = e.worker.dev_create_account().await?;

    let mut b = binding(&e, "va-expired", 1, PAY).await?;
    b.deadline_ns = 1; // a timestamp the sandbox is already far past
    let out = relay(&relayer, &e, &b, &pk, &b.sign(&sk), None).await?;
    assert!(out.is_success(), "a refusal is a value, not a panic: {out:#?}");
    assert_eq!(
        outcome(&out)?.reason_code,
        "AGENT_SIGNATURE_EXPIRED",
        "an expired deadline was not the reason for refusal"
    );
    assert_eq!(va_nonce(&e, &pk).await?, 1, "an expired payload burned the nonce");
    assert_eq!(ft_transfer_count(&e).await?, 0, "nothing should have moved");
    Ok(())
}
