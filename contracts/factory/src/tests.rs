use super::*;
use near_sdk::json_types::Base58CryptoHash;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};

/// The REAL global-contract code hash measured on mainnet, not a placeholder.
/// Using the live value means the test exercises the same 32-byte decode the
/// deployed factory will do, and a format change shows up here.
const HASH: &str = "2CwvTaM6p2kXJLzZioFZwRVGj61B8KefS2EYCFmQznqD";

fn factory_id() -> AccountId {
    "float.near".parse().unwrap()
}
fn fowner() -> AccountId {
    "ops.near".parse().unwrap()
}
fn alice() -> AccountId {
    "alice.near".parse().unwrap()
}

fn hash() -> Base58CryptoHash {
    HASH.parse().unwrap()
}

fn fctx(predecessor: AccountId, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(factory_id())
        .predecessor_account_id(predecessor)
        .attached_deposit(deposit);
    b
}

/// 0.1 NEAR: the measured ask for a vault referencing a global contract —
/// 0.00214 for the reference plus 0.02341 of flat base state, with headroom for
/// request records at 0.00287 each.
fn required() -> NearToken {
    NearToken::from_millinear(100)
}

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

/// `new` records the configuration a vault creation will need.
#[test]
fn new_records_the_owner_and_the_code_hash_it_will_reference() {
    testing_env!(fctx(fowner(), NearToken::from_near(0)).build());
    let f = Factory::new(fowner(), hash(), "mainnet".to_string(), required());
    assert_eq!(f.owner, fowner());
    assert_eq!(f.network, "mainnet");
    assert_eq!(f.required_deposit, required());
    // ROUND TRIP, not a length check. The hash is stored as `CryptoHash`
    // ([u8; 32]), so `len() == 32` is guaranteed by the type and asserting it
    // would prove nothing — the same vacuity that made the earlier explicit
    // length guard dead code. What matters is that the base58 the operator
    // typed is the 32 bytes the promise action will receive.
    assert_eq!(Base58CryptoHash::from(f.code_hash).to_string(), HASH);
}

fn ready() -> Factory {
    testing_env!(fctx(fowner(), NearToken::from_near(0)).build());
    Factory::new(fowner(), hash(), "mainnet".to_string(), required())
}

/// AN UNDERFUNDED CREATE MUST REFUSE, not half-create.
///
/// The deposit covers the new vault's storage. If the batch runs with too
/// little, `CreateAccount` succeeds and the vault lands below its own storage
/// requirement — `LackBalanceForState` on the next write, which is a bricked
/// vault rather than a failed call.
#[test]
#[should_panic(expected = "DEPOSIT_TOO_SMALL")]
fn create_vault_refuses_a_deposit_below_the_requirement() {
    let mut f = ready();
    testing_env!(fctx(alice(), NearToken::from_millinear(99)).build());
    let _ = f.create_vault(None);
}

/// Exactly the requirement is enough. A `<` / `<=` slip here either bricks the
/// boundary case or refuses a correct one, so the boundary gets its own test.
#[test]
fn create_vault_accepts_exactly_the_required_deposit() {
    let mut f = ready();
    testing_env!(fctx(alice(), required()).build());
    // Passing is the assertion: no panic means the boundary is inclusive.
    // Nothing is asserted about the vault existing — the promise has not run,
    // and near-sdk's mock VM does not execute promises at all.
    let _ = f.create_vault(None);
}

/// The kill switch has to work, or a discovered bug cannot be contained.
#[test]
#[should_panic(expected = "PAUSED")]
fn create_vault_refuses_while_paused() {
    let mut f = ready();
    testing_env!(fctx(fowner(), NearToken::from_yoctonear(1)).build());
    f.set_paused(true);
    testing_env!(fctx(alice(), required()).build());
    let _ = f.create_vault(None);
}

/// An owner whose derived id is not a legal account must be told so BEFORE the
/// deposit moves, rather than getting a reverted batch and a refund.
#[test]
#[should_panic(expected = "BAD_VAULT_ID")]
fn create_vault_refuses_an_owner_whose_derived_id_is_illegal() {
    let mut f = ready();
    let implicit: AccountId = "a".repeat(64).parse().unwrap();
    // DELIBERATELY ABOVE the requirement, not exactly on it. This test sat on
    // the boundary first, and mutating the deposit comparison from `<` to `<=`
    // made it fail with DEPOSIT_TOO_SMALL instead of BAD_VAULT_ID — it was
    // only reaching the id check because the deposit check happened to pass.
    // A test named for one guard must not be gated on another.
    testing_env!(fctx(implicit, NearToken::from_near(1)).build());
    let _ = f.create_vault(None);
}

/// Only the owner may repoint new vaults at a different global contract.
#[test]
#[should_panic(expected = "OWNER_ONLY")]
fn set_code_hash_is_owner_only() {
    let mut f = ready();
    testing_env!(fctx(alice(), NearToken::from_yoctonear(1)).build());
    f.set_code_hash(hash());
}

/// EVERY OWNER METHOD MUST BE `#[payable]`, and no runtime test here can check it.
///
/// `assert_owner` calls `assert_one_yocto`, so these methods must RECEIVE one
/// yocto. But near-sdk rejects a deposit to a method not marked `#[payable]`
/// in the generated `extern "C"` wrapper, BEFORE the body runs. The two
/// together make the method permanently unreachable:
/// "Method set_code_hash doesn't accept deposit".
///
/// Every test above passed with the attribute missing, because unit tests call
/// the Rust method directly and never cross the wrapper that enforces it. Only
/// a real deploy found it. So this is a SOURCE scan — the only kind of check
/// that can see a missing attribute.
#[test]
fn every_method_calling_assert_owner_is_payable() {
    let src = include_str!("lib.rs");
    let mut offenders = Vec::new();
    let mut owner_methods = 0;
    let lines: Vec<&str> = src.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if !line.trim_start().starts_with("pub fn ") {
            continue;
        }
        // Does this method's body call assert_owner before the next `pub fn`?
        let body_end = lines[i + 1..]
            .iter()
            .position(|l| l.trim_start().starts_with("pub fn "))
            .map(|p| i + 1 + p)
            .unwrap_or(lines.len());
        if !lines[i..body_end].iter().any(|l| l.contains("self.assert_owner()")) {
            continue;
        }
        owner_methods += 1;
        // Look back over the attributes/doc comment directly above it.
        let payable = lines[..i]
            .iter()
            .rev()
            .take_while(|l| {
                let t = l.trim_start();
                t.starts_with('#') || t.starts_with("///") || t.starts_with("//") || t.is_empty()
            })
            .any(|l| l.trim_start() == "#[payable]");
        if !payable {
            offenders.push(line.trim().to_string());
        }
    }
    // STATE THE EXPECTED COUNT FIRST. A scan that matched nothing would report
    // "no offenders" and look identical to a clean result.
    assert_eq!(
        owner_methods, 3,
        "expected 3 owner methods (set_paused, set_code_hash, set_required_deposit); \
         found {owner_methods} — the scan is probably broken"
    );
    assert_eq!(offenders, Vec::<String>::new(), "these call assert_owner but are not #[payable]");
}
