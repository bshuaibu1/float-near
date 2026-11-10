//! Agent key provisioning — the README's central security claim, under test.
//!
//! The claim is three clauses, and each one is a separate assertion here:
//!
//!   1. the agent key can call `request_payment` on THIS vault            (works)
//!   2. it cannot call any OTHER method on this vault                     (blocked)
//!   3. it cannot call any OTHER contract                                 (blocked)
//!   4. it cannot attach a deposit, so it cannot move NEAR directly       (blocked)
//!
//! Reachability is a separate claim from correctness: every other test in this
//! repo hands an agent an unrestricted dev-account key, which is exactly what
//! hides whether the production provisioning path grants the right authority.
//! This file drives the key the contract itself issued, with nothing injected.
//!
//! PROVISIONED BY `add_role`, WHICH IS WHAT SHIPS. This file used to call
//! `create_agent_account` — removed in the virtual-agent change, because every
//! agent sub-account it made STRANDED its funding permanently (10.7752 NEAR
//! across 18 testnet agents, unrecoverable by anyone). The call survived here
//! because near-workspaces takes the method name as a STRING: the test went on
//! compiling, and could only ever fail at runtime with MethodNotFound. Nobody
//! saw it because the whole tier needs Linux and had never been run.
//!
//! WHY NOT JUST DELETE IT. `self_submit.rs` tests the same restriction
//! behaviourally, but it INSTALLS the key itself with the right permission and
//! then checks a call fails — so it proves nothing about what the CONTRACT
//! provisions. This file is the only place that reads the key's permission back
//! off-chain and asserts its shape, which is the claim the README actually
//! makes.
//!
//! Prerequisite: scripts/build-wasm.sh (Linux/WSL).

mod common;
use common::*;

use near_workspaces::types::{AccessKeyPermission, KeyType, NearToken, SecretKey};
use near_workspaces::Account;
use serde_json::json;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// A bare `is_err()` on a rejected transaction is the passing-negative-test
/// trap: the call could be failing for a reason unrelated to the key. Each
/// negative assertion below therefore names the NEAR access-key error variant
/// that is supposed to carry it, so the assertion cannot be satisfied by some
/// other failure.
fn rejected_because<T: std::fmt::Debug, E: std::fmt::Debug>(
    r: &Result<T, E>,
    variant: &str,
    what: &str,
) {
    let e = match r {
        Err(e) => format!("{e:?}"),
        Ok(v) => panic!("{what}: the call was NOT rejected at all: {v:#?}"),
    };
    assert!(
        e.contains(variant),
        "{what}: rejected, but NOT by {variant} — so this assertion is carried \
         by something else and the key restriction is unproven. Actual: {e}"
    );
}


/// Assert a key is pinned to `request_payment` on this vault, and nothing else.
///
/// TWO VARIANTS ARE ACCEPTED because a NEP-611 gas key and a plain
/// function-call key are the same restriction expressed differently, and which
/// one near-workspaces reports depends on its version. The assertion that
/// matters is identical either way: receiver and method. Matching loosely on
/// the variant while checking those strictly keeps the test about the security
/// property rather than about a library's enum.
fn assert_restricted_to_request_payment(perm: &AccessKeyPermission, vault: &str) {
    match perm {
        AccessKeyPermission::FunctionCall(fc) => {
            assert_eq!(fc.receiver_id, vault, "key is not pinned to this vault");
            assert_eq!(
                fc.method_names,
                vec!["request_payment".to_string()],
                "key is not pinned to request_payment alone"
            );
        }
        other => {
            // A gas key prints its receiver and methods in its Debug form.
            let d = format!("{other:?}");
            assert!(d.contains(vault), "key is not pinned to this vault: {d}");
            assert!(
                d.contains("request_payment"),
                "key is not pinned to request_payment: {d}"
            );
            assert!(
                !d.contains("FullAccess"),
                "the provisioned key is FULL ACCESS: {d}"
            );
        }
    }
}

#[tokio::test]
async fn provisioned_agent_key_can_only_call_request_payment_on_this_vault()
-> anyhow::Result<()> {
    // One node, no bound account: `add_role` creates and binds it.
    let e = setup(0, CAP * 10).await?;
    let lim = json!([{ "token": e.ft.id(),
                       "daily_cap": CAP.to_string(),
                       "per_tx_cap": CAP.to_string() }]);

    // The owner generates the keypair; only the PUBLIC half is sent on-chain.
    let sk = SecretKey::from_random(KeyType::ED25519);
    let pk = sk.public_key();

    // `add_role` AUTHORISES BY DEPOSIT, not by assert_owner: a function-call
    // key cannot attach one at all, so an attached balance proves a
    // full-access signature. It also funds the gas key, so below
    // MIN_AGENT_GAS_FUNDING it refuses rather than making an agent that
    // cannot transact.
    let out = e
        .owner
        .call(e.vault.id(), "add_role")
        .args_json(json!({
            "label": "a0",
            "limits": lim,
            "cooldown_sec": 0,
            "recipients": serde_json::Value::Null,
            "public_key": pk.to_string(),
        }))
        .deposit(NearToken::from_millinear(120))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "provisioning failed: {out:#?}");

    // THE KEY LIVES ON THE VAULT, not on a sub-account. That is the whole
    // point of the virtual-agent change: there is no account to strand.
    //
    // Read the permission back OFF-CHAIN rather than trusting the call we
    // just made — this is the only assertion in the repo that checks what the
    // CONTRACT granted, as opposed to what a test installed by hand.
    let keys = e.worker.view_access_keys(e.vault.id()).await?;
    let mine = keys
        .iter()
        .find(|k| k.public_key == pk)
        .unwrap_or_else(|| panic!("add_role did not install the key it was given"));
    assert_restricted_to_request_payment(&mine.access_key.permission, e.vault.id().as_str());

    // The node was bound, so the key has somewhere to spend from. The signer
    // is the VAULT account driven by the agent's restricted key — which is
    // exactly how a real agent transacts.
    let agent = Account::from_secret_key(e.vault.id().clone(), sk, &e.worker);

    // ---- clause 1: the one allowed method works.
    let ok = agent
        .call(e.vault.id(), "request_payment")
        .args_json(json!({
            "request_id": "k1", "token": e.ft.id(),
            "amount": PAY.to_string(), "recipient": e.payee.id(), "memo": "",
        }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(ok.is_success(), "the restricted key could not call its allowed method: {ok:#?}");
    assert_eq!(ft_transfer_count(&e).await?, 1, "the payment did not actually settle");

    // ---- clause 2: no other method on this vault.
    //
    // NOTE: these probes attach NO deposit, on purpose. The first version
    // attached 1 yoctoNEAR (because owner methods require it) and was rejected
    // by DepositWithFunctionCall — the deposit rule fired first and the
    // method-name restriction was never reached. The assertion passed while
    // proving nothing about `method_names`, which is why mutation M15 was
    // caught only by the off-chain key-shape check and not behaviourally.
    // Two overlapping guards means each needs a probe that the other cannot
    // mask.
    let owner_method = agent
        .call(e.vault.id(), "set_node_caps")
        .args_json(json!({ "node_id": ROOT, "limits": [] }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await;
    rejected_because(&owner_method, "MethodNameMismatch", "set_node_caps (no deposit)");

    let other_vault_method = agent
        .call(e.vault.id(), "freeze_node")
        .args_json(json!({ "node_id": ROOT, "frozen": true }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await;
    rejected_because(&other_vault_method, "MethodNameMismatch", "freeze_node (no deposit)");

    // ---- clause 3: no other contract. The token itself is the sharpest
    // case: if the key could call it directly, every budget check is moot
    // because the agent would hold the vault's own transfer authority.
    let other_contract = agent
        .call(e.ft.id(), "ft_transfer")
        .args_json(json!({
            "receiver_id": e.payee.id(), "amount": PAY.to_string(), "memo": null,
        }))
        // Again no deposit, so ReceiverMismatch is what must reject this and
        // not the deposit rule. NEP-141 requires 1 yocto, but that is a
        // CONTRACT requirement and is only reached if the key lets the call
        // through at all.
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await;
    rejected_because(&other_contract, "ReceiverMismatch", "ft_transfer on the token");

    // ---- clause 4: cannot attach a deposit, so it cannot move NEAR at all.
    // This is the only probe that SHOULD be carried by the deposit rule, and
    // it uses the one method the key is allowed to call, so nothing else can
    // reject it first.
    let with_deposit = agent
        .call(e.vault.id(), "request_payment")
        .args_json(json!({
            "request_id": "k2", "token": e.ft.id(),
            "amount": PAY.to_string(), "recipient": e.payee.id(), "memo": "",
        }))
        .deposit(ONE_YOCTO)
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await;
    rejected_because(&with_deposit, "DepositWithFunctionCall", "request_payment with a deposit");

    // Nothing above moved value beyond the one legitimate payment.
    assert_eq!(
        ft_transfer_count(&e).await?,
        1,
        "a blocked path moved value after all"
    );
    Ok(())
}
