//! The SELF-SUBMIT path: an agent holding a key ON THE VAULT, restricted to
//! `request_payment`, that submits its own transactions.
//!
//! WHY THIS TIER MATTERS HERE MORE THAN USUAL. The unit tier runs in near-sdk's
//! test VM, where `signer_account_pk` is whatever `VMContextBuilder` was told
//! to put there. That proves the contract's resolution logic, and proves
//! nothing about whether a real NEAR node will even *let* a key on the vault
//! call `request_payment` — the access-key check, the predecessor, and the
//! signer public key are all protocol-side. Only a node settles that.
//!
//! WHAT IS ALREADY SETTLED ON CHAIN, so this file is about the contract rather
//! than the protocol (docs/SPIKE-gas-keys-2026-10-31.md, mainnet):
//!   - a function-call key whose `receiver_id` is its OWN account is accepted;
//!   - `predecessor_account_id()` and `signer_account_id()` are both the vault,
//!     and `signer_account_pk()` is the key that signed;
//!   - a NEP-611 gas key pays from its own balance, is withdrawable, and two of
//!     them do not contend.
//!
//! ---- STATUS: WRITTEN, NOT RUN.
//!
//! This repo's sandbox tier has never executed: `near-workspaces` needs a Linux
//! `neard` and there is no Windows build (project memory,
//! `integration-tests-cannot-build-on-windows`). WSL here is a viable Ubuntu
//! 24.04 but carries no rust toolchain, and installing one was refused by the
//! permission layer. So every assertion below is UNVERIFIED and should be
//! treated as a specification until someone runs it:
//!
//!     CARGO_TARGET_DIR=$HOME/float-target cargo test -p integration-tests --test self_submit
//!
//! Saying so explicitly because `DEFERRED-agent-key-recovery.md` makes the same
//! point about its own sandbox test — "this one must actually run" — and an
//! unrun test that reads as passing is worse than an absent one.

mod common;

use anyhow::Result;
use common::*;
use near_workspaces::types::{AccessKey, KeyType, NearToken, PublicKey, SecretKey};
use near_workspaces::Account;
use serde_json::json;

/// Deterministic keys, so a failure is reproducible rather than a fresh key per
/// run. Distinct seeds because several tests need two agents that are not each
/// other.
///
/// `SecretKey::from_seed` rather than `ed25519_dalek`, unlike `virtual_agent.rs`
/// next door. That file needs dalek because it CONSTRUCTS a signature over a
/// `VirtualAgentBinding` for `request_payment_signed`. Here the protocol signs,
/// so there is no signature to build — and going through near-workspaces avoids
/// hand-encoding an expanded 64-byte secret into base58, which would have
/// needed a `bs58` dependency this crate does not have.
fn keypair(seed: &str) -> (SecretKey, PublicKey) {
    let sk = SecretKey::from_seed(KeyType::ED25519, seed);
    let pk = sk.public_key();
    (sk, pk)
}

/// Bind a public key to a node, as the owner.
async fn bind(e: &Env, node: u32, pk: &PublicKey) -> Result<()> {
    e.owner
        .call(e.vault.id(), "bind_virtual_agent")
        .args_json(json!({ "node_id": node, "public_key": pk.to_string() }))
        .max_gas()
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Install `pk` as a function-call access key ON THE VAULT, restricted to
/// `request_payment`.
///
/// This is the action only a full-access key holder can take, and it is the
/// second of the two owner actions this path requires — binding alone grants
/// nothing, and installing alone resolves to no node.
async fn install_key_on_vault(e: &Env, pk: &PublicKey) -> Result<()> {
    e.vault
        .as_account()
        .batch(e.vault.id())
        .add_key(
            pk.clone(),
            AccessKey::function_call_access(
                e.vault.id(),
                &["request_payment"],
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// An `Account` whose id is the VAULT and whose signer is the agent's key.
/// Calling through this is what makes `predecessor_account_id()` the vault.
fn as_vault_signed_by(e: &Env, sk: SecretKey) -> Account {
    Account::from_secret_key(e.vault.id().clone(), sk, &e.worker)
}

/// Both owner actions, then an account ready to self-submit.
///
/// BOTH are required and neither alone does anything: binding without
/// installing resolves to a node nothing can reach, and installing without
/// binding reaches the contract and is refused NOT_VIRTUAL_AGENT. That is why
/// this path grants no unprivileged actor anything — it takes a full-access key
/// to install, and an owner call to bind.
async fn self_submitter(e: &Env, node: u32, seed: &str) -> Result<Account> {
    let (sk, pk) = keypair(seed);
    bind(e, node, &pk).await?;
    install_key_on_vault(e, &pk).await?;
    Ok(as_vault_signed_by(e, sk))
}

// =====================================================================

/// THE HEADLINE. A key on the vault, bound to a node, moves real tokens —
/// through the protocol's access-key check, not a mocked context.
#[tokio::test]
async fn a_self_submitted_payment_settles() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;

    let before = ft_transfer_count(&e).await?;
    let signer = self_submitter(&e, AGENT0, "s31").await?;

    let out = pay(&signer, &e, "ss-1", PAY, &payee).await?;
    assert!(out.is_success(), "self-submitted payment failed: {out:#?}");
    assert_eq!(request(&e, "ss-1").await?.status, "SETTLED");
    assert_eq!(
        ft_transfer_count(&e).await?,
        before + 1,
        "no ft_transfer actually happened — the unit tier cannot see this"
    );
    Ok(())
}

/// The protocol check, not the contract's. The key is restricted to
/// `request_payment`, so a different method must be rejected before the
/// contract is even entered.
#[tokio::test]
async fn the_self_submit_key_cannot_reach_another_method() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let signer = self_submitter(&e, AGENT0, "s32").await?;

    let out = signer
        .call(e.vault.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .max_gas()
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await;
    assert!(
        out.is_err() || out.is_ok_and(|r| r.is_failure()),
        "a key pinned to request_payment reached set_paused"
    );
    // And the vault is demonstrably still running.
    let cfg: serde_json::Value = e.vault.view("get_config").args_json(json!({})).await?.json()?;
    assert_eq!(cfg["paused"], false, "the vault got paused anyway");
    Ok(())
}

/// A key installed on the vault but NOT bound resolves to no node.
#[tokio::test]
async fn an_installed_but_unbound_key_is_refused() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;

    // Installed, deliberately NOT bound.
    let (sk, pk) = keypair("s33");
    install_key_on_vault(&e, &pk).await?;
    let signer = as_vault_signed_by(&e, sk);

    let out = pay(&signer, &e, "ss-unbound", PAY, &payee).await?;
    assert!(out.is_failure(), "an unbound key spent: {out:#?}");
    let msg = format!("{:?}", out.into_result().unwrap_err());
    assert!(
        msg.contains("NOT_VIRTUAL_AGENT"),
        "wrong refusal for an unbound key: {msg}"
    );
    Ok(())
}

/// Two keys, two nodes, and they are not interchangeable. If the resolution
/// ignored the signing key both would spend from the same node.
#[tokio::test]
async fn two_self_submitters_resolve_to_their_own_nodes() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;

    // A second leaf under TEAM with a deliberately tiny per-tx cap, so one
    // amount passes for AGENT0 and is refused for it.
    let lim = json!([{ "token": e.ft.id(),
                       "daily_cap": CAP.to_string(),
                       "per_tx_cap": (PAY / 2).to_string() }]);
    let small = add_node(&e.owner, &e.vault, Some(TEAM), "small", lim, None).await?;

    let a = self_submitter(&e, AGENT0, "s34").await?;
    let b = self_submitter(&e, small, "s35").await?;

    // The refusal FIRST: a blocked payment charges nothing, so this keeps the
    // shared parent pool intact for the dispatch below. Doing it the other way
    // round makes the second failure a PARENT_DAILY_BUDGET and the test passes
    // for the wrong clause — which is exactly how the unit version of this test
    // first went wrong.
    let blocked = pay(&b, &e, "ss-b", PAY, &payee).await?;
    assert!(blocked.is_success(), "a refusal is a value, not a failure");
    let j: serde_json::Value = blocked.json()?;
    assert_eq!(j["status"], "BLOCKED", "got {j}");
    assert_eq!(j["reason_code"], "PER_TX_LIMIT", "wrong clause: {j}");

    let ok = pay(&a, &e, "ss-a", PAY, &payee).await?;
    assert!(ok.is_success(), "the other key should have dispatched: {ok:#?}");
    assert_eq!(request(&e, "ss-a").await?.status, "SETTLED");
    Ok(())
}

/// The account path must still work with no key involved — the regression that
/// matters most, since every live agent uses it.
#[tokio::test]
async fn the_agent_account_path_is_untouched() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;

    pay(&e.agents[0], &e, "acct-1", PAY, &payee).await?;
    assert_eq!(request(&e, "acct-1").await?.status, "SETTLED");
    Ok(())
}

/// Both doors into one tree share the parent's pool.
#[tokio::test]
async fn both_paths_contend_for_the_same_parent_budget() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;

    // TEAM's daily cap is the shared pool. Drain most of it through the ACCOUNT
    // path, then ask for the rest plus one through the KEY path.
    let avail = budget(&e, TEAM, None).await?.available();
    let signer = self_submitter(&e, AGENT0, "s36").await?;

    pay(&e.agents[0], &e, "cont-1", avail - PAY, &payee).await?;
    assert_eq!(request(&e, "cont-1").await?.status, "SETTLED");

    let out = pay(&signer, &e, "cont-2", PAY * 2, &payee).await?;
    assert!(out.is_success(), "a refusal is a value");
    let j: serde_json::Value = out.json()?;
    assert_eq!(j["status"], "BLOCKED", "the key path escaped the parent pool: {j}");
    Ok(())
}

/// The pause switch stops the self-submit path too.
#[tokio::test]
async fn pause_stops_a_self_submitter() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;
    let signer = self_submitter(&e, AGENT0, "s37").await?;

    e.owner
        .call(e.vault.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let out = pay(&signer, &e, "ss-paused", PAY, &payee).await?;
    assert!(out.is_success(), "a refusal is a value");
    let j: serde_json::Value = out.json()?;
    assert_eq!(j["reason_code"], "VAULT_PAUSED", "got {j}");
    Ok(())
}

/// Freezing the node the key is bound to stops it.
#[tokio::test]
async fn freeze_stops_a_self_submitter() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;
    let signer = self_submitter(&e, AGENT0, "s38").await?;

    e.owner
        .call(e.vault.id(), "freeze_node")
        .args_json(json!({ "node_id": AGENT0, "frozen": true }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let out = pay(&signer, &e, "ss-frozen", PAY, &payee).await?;
    assert!(out.is_success(), "a refusal is a value");
    let j: serde_json::Value = out.json()?;
    assert_eq!(j["reason_code"], "NODE_FROZEN", "got {j}");
    Ok(())
}

/// The approval gate holds a self-submitted payment, and approving it sends —
/// end to end, with a real `ft_transfer` at the far end.
#[tokio::test]
async fn the_approval_gate_holds_and_then_releases_a_self_submitted_payment() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;
    let signer = self_submitter(&e, AGENT0, "s39").await?;

    e.owner
        .call(e.vault.id(), "set_approval_threshold")
        .args_json(json!({ "node_id": AGENT0, "amount": (PAY / 2).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let before = ft_transfer_count(&e).await?;
    let held = pay(&signer, &e, "ss-hold", PAY, &payee).await?;
    assert!(held.is_success(), "a hold is a value, not a failure");
    let j: serde_json::Value = held.json()?;
    assert_eq!(j["reason_code"], "APPROVAL_REQUIRED", "got {j}");
    assert_eq!(
        ft_transfer_count(&e).await?,
        before,
        "a held payment moved tokens"
    );

    let approved = e
        .owner
        .call(e.vault.id(), "approve_payment")
        .args_json(json!({ "request_id": "ss-hold" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(approved.is_success(), "approval failed: {approved:#?}");
    assert_eq!(request(&e, "ss-hold").await?.status, "SETTLED");
    assert_eq!(
        ft_transfer_count(&e).await?,
        before + 1,
        "approval did not actually transfer"
    );
    Ok(())
}

/// Unbinding closes the door even though the key is still installed on the
/// vault — the two owner actions are independent, and removing either is enough.
#[tokio::test]
async fn unbinding_closes_the_path_while_the_key_remains_installed() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;

    let (sk, pk) = keypair("s40");
    bind(&e, AGENT0, &pk).await?;
    install_key_on_vault(&e, &pk).await?;
    let signer = as_vault_signed_by(&e, sk);

    assert!(pay(&signer, &e, "ub-1", PAY, &payee).await?.is_success());
    assert_eq!(request(&e, "ub-1").await?.status, "SETTLED");

    e.owner
        .call(e.vault.id(), "unbind_virtual_agent")
        .args_json(json!({ "public_key": pk.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let out = pay(&signer, &e, "ub-2", PAY, &payee).await?;
    assert!(out.is_failure(), "an unbound key still spent: {out:#?}");
    let msg = format!("{:?}", out.into_result().unwrap_err());
    assert!(msg.contains("NOT_VIRTUAL_AGENT"), "wrong refusal: {msg}");
    Ok(())
}
