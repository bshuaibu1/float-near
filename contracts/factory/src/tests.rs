use super::*;
use near_sdk::json_types::Base58CryptoHash;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::mock::MockAction;
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

/// The whole no-backend design rests on this being DETERMINISTIC.
///
/// A dashboard computes the vault id from the owner's account id client-side.
/// NEAR has no RPC to list an account's sub-accounts, so if this were not
/// derivable we would need a registry — which means stored state, which means a
/// database holding something not recoverable from the chain.
///
/// This was named `..._so_the_mapping_stays_injective` while asserting a single
/// mapping, which does not test injectivity — and the mapping is not injective.
/// Renamed to claim only what it checks; the collision has its own test.
#[test]
fn derive_prefix_replaces_the_dot_rather_than_truncating_at_it() {
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

/// What a real caller passes for the vault's root node. The factory forwards
/// these verbatim into the vault's `new`, so the shape matters more than the
/// values: a root with no limits can hold no budget, and a root with no
/// recipients refuses every payment NO_RECIPIENTS_SET.
fn root_limits() -> near_sdk::serde_json::Value {
    near_sdk::serde_json::json!([
        { "token": "usdc.near", "daily_cap": "2040000", "per_tx_cap": "510000" }
    ])
}
fn root_recipients() -> near_sdk::serde_json::Value {
    near_sdk::serde_json::json!(["alice.near"])
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
    let _ = f.create_vault(None, root_limits(), root_recipients());
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
    let _ = f.create_vault(None, root_limits(), root_recipients());
}

/// The kill switch has to work, or a discovered bug cannot be contained.
#[test]
#[should_panic(expected = "PAUSED")]
fn create_vault_refuses_while_paused() {
    let mut f = ready();
    testing_env!(fctx(fowner(), NearToken::from_yoctonear(1)).build());
    f.set_paused(true);
    testing_env!(fctx(alice(), required()).build());
    let _ = f.create_vault(None, root_limits(), root_recipients());
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
    let _ = f.create_vault(None, root_limits(), root_recipients());
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

/// Fake contract bytes. Only the LENGTH matters here — the factory never
/// executes this, it forwards it to a DeployContract action.
fn code(bytes: usize) -> near_sdk::json_types::Base64VecU8 {
    near_sdk::json_types::Base64VecU8(vec![0u8; bytes])
}

/// THE DEPOSIT MUST COVER THE CODE'S OWN STORAGE, and only the caller's
/// argument knows how big that is.
///
/// `create_vault` has a FIXED floor because a global reference costs a flat 214
/// bytes whatever the contract's size. Deploying the code puts the whole
/// artifact on the new account, so the floor has to scale with it: 294 KB is
/// 2.94 NEAR of storage stake on its own.
///
/// Get this wrong and `CreateAccount` succeeds while the account lands below
/// its own storage requirement — `LackBalanceForState` on the next write, which
/// is a bricked vault rather than a failed call.
#[test]
#[should_panic(expected = "DEPOSIT_TOO_SMALL")]
fn create_vault_with_code_refuses_a_deposit_that_ignores_the_code_size() {
    let mut f = ready();
    // Exactly the fixed requirement — enough for the GLOBAL path, nowhere near
    // enough once 100 KB of code has to be stored.
    testing_env!(fctx(alice(), required()).build());
    let _ = f.create_vault_with_code(code(100_000), None, root_limits(), root_recipients());
}

/// Code storage plus the fixed floor is enough.
#[test]
fn create_vault_with_code_accepts_code_storage_plus_the_floor() {
    let mut f = ready();
    let bytes = 100_000u128;
    let needed = NearToken::from_yoctonear(bytes * 10u128.pow(19)).saturating_add(required());
    testing_env!(fctx(alice(), needed).build());
    // Passing is the assertion: no panic means the boundary is inclusive.
    let _ = f.create_vault_with_code(code(100_000), None, root_limits(), root_recipients());
}

/// EMPTY CODE WOULD CREATE A FUNDED ACCOUNT WITH NO CONTRACT.
///
/// `DeployContract` with zero bytes succeeds, and `new` would then fail
/// MethodNotFound — so the batch reverts and the caller is refunded. Correct,
/// but it burns a round trip and reads like a contract bug. Refuse it up front.
#[test]
#[should_panic(expected = "NO_CODE")]
fn create_vault_with_code_refuses_empty_code() {
    let mut f = ready();
    testing_env!(fctx(alice(), NearToken::from_near(1)).build());
    let _ = f.create_vault_with_code(code(0), None, root_limits(), root_recipients());
}

/// The kill switch covers BOTH creation paths, or it is not a kill switch.
#[test]
#[should_panic(expected = "PAUSED")]
fn create_vault_with_code_honours_the_kill_switch() {
    let mut f = ready();
    testing_env!(fctx(fowner(), NearToken::from_yoctonear(1)).build());
    f.set_paused(true);
    testing_env!(fctx(alice(), NearToken::from_near(2)).build());
    let _ = f.create_vault_with_code(code(100_000), None, root_limits(), root_recipients());
}

// ─── the `label` escape hatch, which had no tests at all ─────────────────────

/// AN ARBITRARY LABEL LETS ANY CALLER SQUAT ANY OTHER USER'S VAULT ID.
///
/// `create_vault`'s own doc comment explains that taking the owner as a
/// parameter would let an attacker "squat the derived id of an account they do
/// not control, permanently denying that user the vault the dashboard will
/// look for" — and then `label` hands over exactly that capability, because
/// `begin` interpolates it verbatim with no check that it belongs to the
/// caller.
///
/// It is worse than denial. The vault's `new` is called with
/// `owner = predecessor`, so the squatter OWNS the vault sitting at the
/// victim's expected address. A dashboard that resolves a user's vault by
/// derivation — which is the entire no-backend design, and why `vault_id_for`
/// is a public view — would show the victim an attacker-controlled vault and
/// route their funds into it.
///
/// Unprivileged attacker, unprivileged victim, real capability delta.
/// TWO DEFENCES, and this asserts which one fires.
///
/// `bob.near`'s prefix is `bob-near`, so the charset rule catches it — the
/// hyphen is refused outright. Asserting only "alice did not get bob's id"
/// would stay green if the charset rule were deleted, because rooting would
/// still redirect it; and it would stay green if rooting were deleted, because
/// the charset rule still refuses. A test that passes either way names neither.
#[test]
fn a_label_cannot_take_another_users_derived_vault_id() {
    let f = ready();
    testing_env!(fctx(alice(), NearToken::from_near(2)).build());

    let bobs_prefix = derive_prefix("bob.near");
    assert_eq!(bobs_prefix, "bob-near", "the victim's prefix holds a hyphen");

    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        f.begin(&Some(bobs_prefix), required())
    }));
    assert!(r.is_err(), "alice.near reached bob.near's derived id");
}

/// AND WHEN THE CHARSET RULE CANNOT HELP, rooting still has to.
///
/// A victim with a TOP-LEVEL id has no dot, so its derived prefix has no
/// hyphen and passes the charset check cleanly. This is the case that proves
/// rooting carries real weight rather than being belt-and-braces: delete the
/// prefix rooting and this test goes red on its own.
#[test]
fn a_label_matching_a_top_level_victims_prefix_is_still_redirected() {
    let f = ready();
    testing_env!(fctx(alice(), NearToken::from_near(2)).build());

    // A top-level account: no dot, so derive_prefix is the identity and the
    // label passes [a-z0-9] with nothing to object to.
    let victim = "bobnear";
    assert_eq!(derive_prefix(victim), victim);

    let (owner, vault) = f.begin(&Some(victim.to_string()), required());

    assert_eq!(owner, alice());
    assert_ne!(
        vault.as_str(),
        format!("{}.{}", victim, factory_id()),
        "alice.near took the top-level account `bobnear`'s derived vault id"
    );
    assert_eq!(
        vault.as_str(),
        format!("alice-near-{}.{}", victim, factory_id()),
        "the label must land under the caller's own prefix"
    );
}

/// A LABEL MUST STAY INSIDE THE CALLER'S OWN NAMESPACE.
///
/// The positive half of the rule above: the hatch still has to work, and the
/// id it produces has to be one only this caller could have asked for.
#[test]
fn a_label_lands_under_the_callers_own_prefix() {
    let f = ready();
    testing_env!(fctx(alice(), NearToken::from_near(2)).build());

    let (owner, vault) = f.begin(&Some("two".to_string()), required());

    assert_eq!(owner, alice());
    assert_eq!(
        vault.as_str(),
        format!("{}-two.{}", derive_prefix("alice.near"), factory_id()),
        "a label must be rooted in the caller's derived prefix"
    );
}

/// A LABEL THE DERIVATION COULD NEVER PRODUCE MUST BE REFUSED.
///
/// Rooting the label in the caller's prefix is only sound if the label itself
/// cannot smuggle more structure in. A label containing a hyphen lets the
/// caller reach further: `alice.near` with label `near-bob-near` would build
/// `alice-near-bob-near`, and if an account literally named `alice-near-bob`
/// existed, its derived prefix would be reachable again.
#[test]
fn a_label_with_separators_is_refused() {
    let f = ready();
    testing_env!(fctx(alice(), NearToken::from_near(2)).build());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        f.begin(&Some("near-bob-near".to_string()), required())
    }));
    assert!(r.is_err(), "a label containing a hyphen must be refused");
}

/// THE DERIVATION IS NOT INJECTIVE, despite what its comment claims.
///
/// `derive_prefix` is documented as keeping the mapping INJECTIVE, and the
/// test asserting that only ever checked a single mapping
/// (`alice.near -> alice-near`), which no more proves injectivity than one
/// passing case proves a guard's direction.
///
/// `replace('.', "-")` merges the dot into an alphabet that already contains
/// the hyphen, so `a.b.testnet` and `a-b.testnet` — two different accounts —
/// both land on `a-b-testnet`. Whoever creates first denies the other.
///
/// This is NOT fully fixable while ids stay human-readable: NEAR forbids
/// consecutive separators, so there is no escape sequence available, and the
/// only injective option is a hash prefix that gives up readability. Recorded
/// here as a known, bounded limitation rather than left as a false claim.
#[test]
fn derive_prefix_collides_between_a_dot_and_a_hyphen() {
    assert_eq!(
        derive_prefix("a.b.testnet"),
        derive_prefix("a-b.testnet"),
        "if this ever stops being equal the derivation became injective — \
         update the comment and reconsider whether `label` is still needed"
    );
}

// ─── get_config ──────────────────────────────────────────────────────────────

/// A CLIENT CANNOT COMPUTE THE DEPOSIT WITHOUT READING `required_deposit`.
///
/// The factory exposed `vault_id_for` — so the derivation has exactly one
/// implementation and no client has to copy it — but nothing for the other
/// half of the question. A caller that knows WHERE its vault goes still has to
/// guess WHAT to attach, and the floor is `required_deposit + bytes * 1e19`.
/// Guessing low is not a clean failure: CreateAccount succeeds and the vault
/// lands below its own storage requirement, which bricks it on the next write.
///
/// Every field here is already public on chain — this is a convenience, not a
/// disclosure. `paused` matters too: a client should be able to say "creation
/// is disabled" before taking a user through a wallet signature.
#[test]
fn get_config_reports_everything_a_client_needs_to_build_a_create_call() {
    let f = ready();
    let c = f.get_config();

    assert_eq!(c.owner, fowner());
    assert_eq!(c.network, "mainnet");
    assert_eq!(c.required_deposit, required());
    assert!(!c.paused);
    assert_eq!(c.code_hash, hash(), "the base58 form round-trips");
}

/// The kill switch has to be VISIBLE, not just effective.
#[test]
fn get_config_reflects_the_kill_switch() {
    let mut f = ready();
    testing_env!(fctx(fowner(), NearToken::from_yoctonear(1)).build());
    f.set_paused(true);
    assert!(f.get_config().paused);
}

// ─── the vault needs a signer, or its gas keys strand ────────────────────────

fn a_pk() -> near_sdk::PublicKey {
    "ed25519:DHyH8bhSiKXvQkPMgJ3wkAo1hDuZEaBqAHhPiRnrLbNP".parse().unwrap()
}

/// THE VAULT MUST END UP WITH A FULL-ACCESS KEY, or its gas keys are a trap.
///
/// A factory-created vault had ZERO access keys, which read as a virtue —
/// nothing to steal. It is not, once agents are gas keys on the vault:
///
///   near-sdk can ADD a gas key and FUND it (`promise_batch_action_
///   add_gas_key_with_function_call`, `..._transfer_to_gas_key`) but there is
///   NO withdraw host function at ANY near-sys version — 0.2.14, 0.3.0, 0.4.0
///   all expose exactly three gas-key actions and none of them takes money
///   out. `WithdrawFromGasKey` exists in the protocol but only as an
///   ACCOUNT-SIGNED action.
///
/// So on a keyless vault nothing can ever reclaim a gas key's balance. That is
/// the same stranding bug `create_agent_account` had, moved to a new place,
/// and it is exactly what retiring sub-accounts was meant to eliminate.
///
/// The key is `signer_account_pk()`, NOT a parameter. A parameter could be set
/// to anyone's key; the signer's key is provably the one that authorised this
/// call. And it is provably FULL-ACCESS: this method takes a deposit, and NEAR
/// forbids function-call access keys from attaching one, so the transaction
/// cannot have been signed by a restricted key.
#[test]
fn create_vault_with_code_installs_the_signers_key_as_a_full_access_key() {
    let mut f = ready();
    let mut b = fctx(alice(), NearToken::from_near(2));
    b.signer_account_pk(a_pk());
    testing_env!(b.build());

    let _ = f.create_vault_with_code(code(1_000), None, root_limits(), root_recipients());

    let receipts = near_sdk::test_utils::get_created_receipts();
    let batch = receipts
        .iter()
        .find(|r| r.actions.iter().any(|a| matches!(a, MockAction::CreateAccount { .. })))
        .expect("no receipt contains CreateAccount");

    let added: Vec<_> = batch
        .actions
        .iter()
        .filter_map(|a| match a {
            MockAction::AddKeyWithFullAccess { public_key, .. } => Some(public_key.clone()),
            _ => None,
        })
        .collect();

    assert_eq!(added.len(), 1, "expected exactly one full-access key on the new vault");
    // Compared as strings: the mock reports `near_crypto::PublicKey` while the
    // contract deals in near-sdk's `PublicKey`. Distinct types, same base58
    // form, and the base58 form is what has to match.
    assert_eq!(
        added[0].to_string(),
        a_pk().to_string(),
        "the key installed must be the one that SIGNED",
    );
}

/// The same guarantee on the global path, which is the one that ships.
///
/// Asserted separately rather than trusting that the two paths agree: they
/// already drifted once, when `create_vault` carried its own copy of the pause
/// check, deposit check and label handling instead of calling `begin`.
#[test]
fn create_vault_installs_the_signers_key_as_a_full_access_key() {
    let mut f = ready();
    let mut b = fctx(alice(), NearToken::from_near(2));
    b.signer_account_pk(a_pk());
    testing_env!(b.build());

    let _ = f.create_vault(None, root_limits(), root_recipients());

    let receipts = near_sdk::test_utils::get_created_receipts();
    let batch = receipts
        .iter()
        .find(|r| r.actions.iter().any(|a| matches!(a, MockAction::CreateAccount { .. })))
        .expect("no receipt contains CreateAccount");

    let n = batch
        .actions
        .iter()
        .filter(|a| matches!(a, MockAction::AddKeyWithFullAccess { .. }))
        .count();
    assert_eq!(n, 1, "the global path must install the owner's key too");
}
