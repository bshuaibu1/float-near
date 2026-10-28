//! `migrate`'s access control, under a real runtime.
//!
//! WHY THIS IS A SANDBOX TEST AND NOT A UNIT TEST. `#[private]` expands to a
//! `current_account_id() != predecessor_account_id()` check that near-sdk emits
//! into the WASM EXPORT wrapper, not into the inner Rust fn. A unit test calls
//! the inner fn directly and never crosses the check, so a `#[should_panic]`
//! unit test for this does not pass — it fails, because nothing panics. That is
//! how the gap was originally found and why it was left open: the only tier
//! that can see the wrapper is this one, and it needs Linux/WSL.
//!
//! `migrate` is the most dangerous method on the contract. It is
//! `#[init(ignore_state)]`, so unlike `new` it does NOT refuse to run against
//! initialised state — that is the entire point of it. If `#[private]` were
//! ever dropped, any account could call `migrate` on a live vault and overwrite
//! its state with a struct read through the legacy layout.
//!
//! Prerequisite: scripts/build-wasm.sh (under Linux/WSL).

mod common;
use common::*;

use anyhow::Result;
use serde_json::json;

/// A stranger cannot call `migrate`, and is stopped BY `#[private]`.
///
/// Asserting "it failed" would not be enough. `migrate` is also guaranteed to
/// fail for an unrelated reason here — the deployed state is the CURRENT
/// layout, so reading it as `LegacyVault` cannot deserialise. A test that only
/// checked for failure would pass with `#[private]` deleted, carried entirely
/// by the deserialize error.
///
/// So this asserts the specific message, and the companion test below shows the
/// self-call failing with the OTHER message. The pair is what proves which
/// clause rejected the stranger.
#[tokio::test]
async fn a_stranger_cannot_call_migrate() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let stranger = e.worker.dev_create_account().await?;

    let out = stranger
        .call(e.vault.id(), "migrate")
        .args_json(json!({}))
        .max_gas()
        .transact()
        .await?;

    assert!(out.is_failure(), "a stranger must not be able to call migrate");
    let text = format!("{:?}", out.failures());
    println!("--- stranger calling migrate ---\n{text}\n");

    assert!(
        text.contains("Method migrate is private"),
        "the stranger was rejected, but NOT by #[private]. If this reads \
         'Cannot deserialize', the private check is gone and the only thing \
         standing between an arbitrary caller and a state overwrite is the \
         legacy layout failing to parse — which would stop being true the \
         moment anyone deploys a vault whose state still IS the legacy layout. \
         Got: {text}"
    );
    Ok(())
}

/// The owner is also a stranger here, which is the non-obvious half.
///
/// `#[private]` is predecessor == CONTRACT ACCOUNT, not predecessor == owner.
/// Every other mutating method on this vault is owner-gated, so "the owner can
/// do it" is the natural assumption to carry into this one, and it is wrong.
/// A deploy signed by the owner rather than by the vault account would not be
/// able to migrate.
#[tokio::test]
async fn even_the_owner_cannot_call_migrate() -> Result<()> {
    let e = setup(1, CAP * 10).await?;

    let out = e
        .owner
        .call(e.vault.id(), "migrate")
        .args_json(json!({}))
        .max_gas()
        .transact()
        .await?;

    assert!(out.is_failure(), "the owner is not the contract account");
    let text = format!("{:?}", out.failures());
    assert!(
        text.contains("Method migrate is private"),
        "owner was rejected for the wrong reason. Got: {text}"
    );
    Ok(())
}

/// The POSITIVE CONTROL for the two tests above, and the reason they mean
/// anything.
///
/// The vault calling itself PASSES `#[private]` and then fails on something
/// else: the live state is the current layout, so `state_read::<LegacyVault>()`
/// cannot deserialise it. Two different failures from the same call, separated
/// only by who the predecessor was, is what demonstrates the private check is
/// the thing doing the work above rather than the deserialize error masking it.
///
/// This also pins a real safety property in its own right: running `migrate`
/// against already-migrated state must FAIL rather than half-read the struct
/// and write it back. `migrate` is the one method that bypasses the
/// initialised-state guard, so "it refuses to run twice" is load-bearing.
#[tokio::test]
async fn migrate_against_already_migrated_state_fails_on_deserialize_not_on_private() -> Result<()> {
    let e = setup(1, CAP * 10).await?;

    // `Contract::call` signs as the contract account itself, so
    // predecessor == current_account_id and #[private] is satisfied.
    let out = e.vault.call("migrate").args_json(json!({})).max_gas().transact().await?;

    assert!(
        out.is_failure(),
        "migrate ran a SECOND time against current-layout state and did not fail. \
         It bypasses the initialised-state guard by design, so it must refuse here \
         or a re-run silently overwrites live state: {out:#?}"
    );
    let text = format!("{:?}", out.failures());
    println!("--- vault calling migrate on itself ---\n{text}\n");

    assert!(
        !text.contains("Method migrate is private"),
        "the self-call was stopped by #[private], which means predecessor != current \
         for a Contract::call and the two tests above prove nothing. Got: {text}"
    );
    assert!(
        text.contains("deserialize") || text.contains("Cannot deserialize"),
        "expected a state-deserialize failure once past #[private]. Got: {text}"
    );

    // And the vault is unharmed: the failed migrate reverted atomically.
    let cfg: serde_json::Value = e.vault.view("get_config").args_json(json!({})).await?.json()?;
    assert_eq!(cfg["owner"], serde_json::json!(e.owner.id().as_str()), "state damaged");
    assert_eq!(cfg["node_count"], serde_json::json!(3), "node count changed");
    Ok(())
}

/// `get_base_config` is gone, and gone means MethodNotFound rather than a
/// method that returns null.
///
/// Worth asserting separately: a view that returns null and a method that does
/// not exist are indistinguishable through a naive client, which is the exact
/// trap `scripts/verify-upgrade.mjs` documents for the opposite direction.
#[tokio::test]
async fn get_base_config_is_removed_not_merely_empty() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let err = e
        .vault
        .view("get_base_config")
        .args_json(json!({}))
        .await
        .expect_err("get_base_config should no longer exist");
    let text = format!("{err:?}");
    assert!(
        text.contains("MethodNotFound") || text.contains("not found"),
        "expected MethodNotFound for a removed method. Got: {text}"
    );
    Ok(())
}
