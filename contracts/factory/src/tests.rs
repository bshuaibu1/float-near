use super::*;

/// The whole no-backend design rests on this being deterministic and injective.
///
/// A dashboard computes the vault id from the owner's account id client-side.
/// NEAR has no RPC to list an account's sub-accounts, so if this were not
/// derivable we would need a registry — which means stored state, which means a
/// database holding something not recoverable from the chain.
#[test]
fn derive_prefix_replaces_the_dot_so_the_mapping_stays_injective() {
    // `alice` would collide across every TLD and every parent: alice.near,
    // alice.testnet and alice.pool.near would all want the same vault.
    assert_eq!(derive_prefix("alice.near"), "alice-near");
}

/// AN IMPLICIT ACCOUNT CANNOT HAVE A DERIVED VAULT, and it must be refused up
/// front rather than discovered as a failed promise after a deposit has moved.
///
/// NEAR caps an account id at 64 characters. An implicit account id is a
/// 64-character hex string with no dots, so the derived prefix is already 64
/// and `<prefix>.<factory>` is 75 for a 10-character factory — not a valid
/// account id at all. `create_account` would fail, the batch would revert, and
/// the user would get a refund and no explanation.
///
/// WHAT CARRIES THIS TEST is `AccountId::parse`, not a length check of ours.
/// An explicit `if candidate.len() > 64` existed first; mutating its condition
/// to `false` left this test green, which is how we learned the guard was
/// redundant. Worth recording, because the obvious reading of this test is
/// "we check the length" and we do not.
#[test]
fn vault_id_refuses_an_owner_too_long_to_fit_under_the_factory() {
    let implicit = "a".repeat(64);
    assert_eq!(vault_id(&implicit, "float.near"), None);
}

/// The ordinary case, and the exact string the dashboard must compute.
#[test]
fn vault_id_composes_the_prefix_under_the_factory() {
    assert_eq!(
        vault_id("alice.near", "float.near").map(|a| a.to_string()),
        Some("alice-near.float.near".to_string()),
    );
}
