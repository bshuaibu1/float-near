//! Unit tier.
//!
//! WHAT THIS TIER CAN PROVE: allocation containment (I1), per-node caps (I2),
//! per-tx (I5), cooldown (I4), allowlist (I7), freeze, depth, authorization.
//!
//! WHAT IT CANNOT PROVE: a unit test cannot schedule a promise, so the
//! callback never runs here. The chain charge is observable (as `pending`),
//! but reservation RELEASE (I6), failed-transfer recovery (I8), the day
//! boundary, and concurrency exactness are all invisible to this tier and
//! live in contracts/integration-tests against a real sandbox node.
#![cfg(test)]

use crate::types::*;
use crate::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken};

const YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO: NearToken = NearToken::from_yoctonear(0);

/// USDC has 6 decimals. Every amount goes through this so a decimal slip is a
/// visible constant rather than a silently-passing assertion.
fn usdc(n: u128) -> U128 {
    U128(n * 1_000_000)
}

fn vault_id() -> AccountId {
    "vault.test.near".parse().unwrap()
}
fn tok() -> AccountId {
    "usdc.test.near".parse().unwrap()
}
fn owner() -> AccountId {
    accounts(0) // alice
}
fn payee() -> AccountId {
    accounts(1) // bob — allowlisted on root
}
/// carol — never allowlisted. Consumed by the I7 allowlist tests (day 10).
#[allow(dead_code)]
fn stranger() -> AccountId {
    accounts(2)
}
fn r1() -> AccountId {
    "r1.vault.test.near".parse().unwrap()
}
fn r2() -> AccountId {
    "r2.vault.test.near".parse().unwrap()
}

fn limit(daily: u128, per_tx: u128) -> Vec<TokenLimit> {
    vec![TokenLimit {
        token: tok(),
        daily_cap: usdc(daily),
        per_tx_cap: usdc(per_tx),
    }]
}

fn ctx(predecessor: AccountId, deposit: NearToken, ts_ns: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault_id())
        .predecessor_account_id(predecessor)
        .attached_deposit(deposit)
        .block_timestamp(ts_ns)
        .prepaid_gas(Gas::from_tgas(100));
    b
}

fn new_vault(strict: bool) -> Vault {
    testing_env!(ctx(vault_id(), ZERO, 0).build());
    Vault::new(owner(), "sandbox".to_string(), strict)
}

/// root(1000) ─ research(500) ─ r1(500), r2(300)
///            └ ops(300)
///
/// r1 + r2 = 800 > research 500, so the siblings are OVERCOMMITTED against a
/// shared pool. r1's cap deliberately equals the whole research pool so a
/// single r1 payment can exhaust the parent WITHOUT touching r2's own budget
/// — that is what makes the clause isolation in the parent-binds test exact.
///
/// Recipients are set ONLY on root, so allowlist inheritance is exercised by
/// the default fixture rather than needing a dedicated setup.
struct Tree {
    v: Vault,
    /// `root` and `n_r1` are consumed by the freeze and I5-chain tests (day 10).
    #[allow(dead_code)]
    root: NodeId,
    research: NodeId,
    ops: NodeId,
    #[allow(dead_code)]
    n_r1: NodeId,
    n_r2: NodeId,
}

fn tree() -> Tree {
    let mut v = new_vault(false);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(1000, 1000), 0, Some(vec![payee()]));
    let research = v.add_node(Some(root), "research".into(), limit(500, 500), 0, None);
    let ops = v.add_node(Some(root), "ops".into(), limit(300, 300), 0, None);
    let n_r1 = v.add_node(Some(research), "r1".into(), limit(500, 500), 0, None);
    let n_r2 = v.add_node(Some(research), "r2".into(), limit(300, 300), 0, None);
    v.bind_agent(n_r1, r1());
    v.bind_agent(n_r2, r2());
    Tree { v, root, research, ops, n_r1, n_r2 }
}

/// Every negative test funnels through this so the assertion is on the EXACT
/// reason code. Asserting merely "it was blocked" is what lets a mutation
/// survive: the test can be carried by a clause other than the one it names.
fn assert_blocked(out: PromiseOrValue<PaymentOutcome>, want: ReasonCode) {
    match out {
        PromiseOrValue::Value(o) => {
            assert_eq!(o.status, Status::Blocked, "expected Blocked, got {:?}", o.status);
            assert_eq!(
                o.reason_code, want,
                "blocked by the WRONG clause: wanted {:?}, got {:?}",
                want, o.reason_code
            );
        }
        PromiseOrValue::Promise(_) => panic!("expected {want:?}, but the payment dispatched"),
    }
}

fn assert_dispatched(out: PromiseOrValue<PaymentOutcome>) {
    assert!(
        matches!(out, PromiseOrValue::Promise(_)),
        "expected dispatch, but the payment was blocked"
    );
}

// =====================================================================
// I1 — allocation containment
//
// 2-row numeric table on the comparator. Pattern-matching the SHAPE of a
// containment check proves nothing about its DIRECTION, so the boundary is
// pinned from both sides:
//     sum == parent  -> MUST be allowed
//     sum  > parent  -> MUST be rejected
// =====================================================================

#[test]
fn i1_sigma_children_equal_to_parent_is_allowed() {
    let mut v = new_vault(true);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(1000, 1000), 0, Some(vec![payee()]));
    v.add_node(Some(root), "a".into(), limit(600, 600), 0, None);
    v.add_node(Some(root), "b".into(), limit(400, 400), 0, None); // 600 + 400 == 1000

    assert_eq!(v.get_node(root).child_sum_for(&tok()), usdc(1000).0);
    assert_eq!(v.get_node(root).child_count, 2);
}

#[test]
#[should_panic(expected = "INVALID_ALLOCATION")]
fn i1_sigma_children_one_unit_over_parent_is_rejected() {
    let mut v = new_vault(true);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(1000, 1000), 0, Some(vec![payee()]));
    v.add_node(Some(root), "a".into(), limit(600, 600), 0, None);
    // 600 + 401 == 1001 > 1000. One unit over.
    v.add_node(Some(root), "b".into(), limit(401, 401), 0, None);
}

/// The direction that gets forgotten: containment must be re-checked when the
/// PARENT moves, not only when a child is added.
#[test]
#[should_panic(expected = "INVALID_ALLOCATION")]
fn i1_lowering_parent_below_existing_children_is_rejected() {
    let mut v = new_vault(true);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(1000, 1000), 0, Some(vec![payee()]));
    v.add_node(Some(root), "a".into(), limit(600, 600), 0, None);
    v.add_node(Some(root), "b".into(), limit(400, 400), 0, None); // sum == 1000
    v.set_node_caps(root, limit(999, 999)); // would strand 1 unit
}

/// I1 upward: RAISING a child above what its parent can cover is rejected.
///
/// Written because mutation M2b survived — disabling the against-parent guard
/// in `set_node_caps` left all 8 other tests green. The lowering test next to
/// this one exercises the against-CHILDREN guard instead (the root has no
/// parent), so the upward direction was asserted nowhere while a comment
/// claimed containment was checked "in both directions".
#[test]
#[should_panic(expected = "INVALID_ALLOCATION")]
fn i1_raising_a_child_above_the_parents_headroom_is_rejected() {
    let mut v = new_vault(true);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(1000, 1000), 0, Some(vec![payee()]));
    let a = v.add_node(Some(root), "a".into(), limit(600, 600), 0, None);
    v.add_node(Some(root), "b".into(), limit(400, 400), 0, None); // sum == 1000, no headroom

    // 1000 - 600 + 601 = 1001 > 1000. One unit over, from below.
    v.set_node_caps(a, limit(601, 601));
}

/// The matching allowed row, so the boundary is pinned from both sides rather
/// than only the rejecting one.
#[test]
fn i1_raising_a_child_exactly_into_the_parents_headroom_is_allowed() {
    let mut v = new_vault(true);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(1000, 1000), 0, Some(vec![payee()]));
    let a = v.add_node(Some(root), "a".into(), limit(600, 600), 0, None);
    v.add_node(Some(root), "b".into(), limit(300, 300), 0, None); // sum == 900, 100 spare

    v.set_node_caps(a, limit(700, 700)); // 900 - 600 + 700 == 1000 exactly
    assert_eq!(v.get_node(root).child_sum_for(&tok()), usdc(1000).0);
}

#[test]
fn i1_overcommit_mode_permits_sigma_children_above_parent() {
    let mut v = new_vault(false);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(100, 100), 0, Some(vec![payee()]));
    v.add_node(Some(root), "a".into(), limit(100, 100), 0, None);
    v.add_node(Some(root), "b".into(), limit(100, 100), 0, None); // 200 > 100: allowed

    assert_eq!(v.get_node(root).child_sum_for(&tok()), usdc(200).0);
}

// =====================================================================
// I2/I3 — the parent pool binds even when the child has headroom
//
// This is the differentiator in unit form. It is also the deliberate
// disagreement case: the child ledger and the ancestor ledger are placed in
// conflict, which no single-pool design can express.
//
// Note there is no settle step. `available = cap - (executed + pending)`, so
// two unsettled reservations exhaust the pool on their own — which means this
// tier needs no test-only settle hook at all.
// =====================================================================

#[test]
fn i3_parent_daily_binds_while_child_still_has_headroom() {
    let t = tree();
    let mut v = t.v;

    // Exhaust research(500) with ONE r1 payment, so r2 is untouched.
    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("p1".into(), tok(), usdc(500), payee(), "".into()));

    // CLAUSE ISOLATION: r2 has spent nothing. Its own daily_cap (300) and
    // per_tx_cap (300) both admit a 50 payment, it is not frozen, has no
    // cooldown, and the recipient is allowlisted. The ONLY clause that can
    // reject what follows is the ancestor's daily ledger.
    assert_eq!(
        v.get_node_budget(t.research, tok(), None).unwrap().available,
        usdc(0),
        "research pool should be exhausted by r1's reservation"
    );
    assert_eq!(
        v.get_node_budget(t.n_r2, tok(), None).unwrap().available,
        usdc(300),
        "r2's own budget must be completely untouched"
    );

    testing_env!(ctx(r2(), ZERO, 1).build());
    assert_blocked(
        v.request_payment("p3".into(), tok(), usdc(50), payee(), "".into()),
        ReasonCode::ParentDailyBudget, // NOT DailyBudget: the level matters
    );
}

/// The reallocation half of the same story: moving cap between siblings
/// reopens a blocked child without touching the root total.
#[test]
fn i1_reallocation_reopens_a_blocked_child() {
    let t = tree();
    let mut v = t.v;

    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("p1".into(), tok(), usdc(500), payee(), "".into()));

    testing_env!(ctx(r2(), ZERO, 1).build());
    assert_blocked(
        v.request_payment("p3".into(), tok(), usdc(50), payee(), "".into()),
        ReasonCode::ParentDailyBudget,
    );

    // Free 50 under root, then grow research by the same 50. Root's children
    // sum stays at 800 <= 1000, so the root total never moves.
    testing_env!(ctx(owner(), YOCTO, 2).build());
    v.set_node_caps(t.ops, limit(250, 250));
    v.set_node_caps(t.research, limit(550, 550));

    testing_env!(ctx(r2(), ZERO, 3).build());
    assert_dispatched(v.request_payment("p4".into(), tok(), usdc(50), payee(), "".into()));
}

// =====================================================================
// Pure functions and the shipping guard
// =====================================================================

/// A lowered cap can leave used > cap. `available` must saturate to 0 — not
/// wrap, not panic. u128 subtraction wraps silently in release builds.
#[test]
fn available_saturates_when_a_lowered_cap_is_already_exceeded() {
    let led = DailyLedger { executed: usdc(80).0, pending: usdc(40).0 };
    assert_eq!(available(usdc(100).0, &led), 0);
}

/// Runs under `cargo test --no-default-features`. Proves the production build
/// has no way to shorten its own budget window. scripts/deploy-testnet.sh
/// gates on the same string after deploying.
#[cfg(not(feature = "test-clock"))]
#[test]
fn production_build_reports_production_clock_and_a_real_day() {
    let v = new_vault(true);
    assert_eq!(v.clock_mode(), "production");
    assert_eq!(v.day_len_ns(), PRODUCTION_DAY_NS);
    assert_eq!(PRODUCTION_DAY_NS, 86_400_000_000_000);
}
