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
/// carol — never on root's allowlist.
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
    root: NodeId,
    research: NodeId,
    ops: NodeId,
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
    assert_dispatched(v.request_payment("p1".into(), tok(), usdc(500), payee(), "".into(), None));

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
        v.request_payment("p3".into(), tok(), usdc(50), payee(), "".into(), None),
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
    assert_dispatched(v.request_payment("p1".into(), tok(), usdc(500), payee(), "".into(), None));

    testing_env!(ctx(r2(), ZERO, 1).build());
    assert_blocked(
        v.request_payment("p3".into(), tok(), usdc(50), payee(), "".into(), None),
        ReasonCode::ParentDailyBudget,
    );

    let committed_before = v.get_node(t.root).child_sum_for(&tok());

    // Free 50 under root, then grow research by the same 50.
    testing_env!(ctx(owner(), YOCTO, 2).build());
    v.set_node_caps(t.ops, limit(250, 250));
    v.set_node_caps(t.research, limit(550, 550));

    testing_env!(ctx(r2(), ZERO, 3).build());
    assert_dispatched(v.request_payment("p4".into(), tok(), usdc(50), payee(), "".into(), None));

    // Reallocation moves headroom BETWEEN siblings; it must not change how
    // much the parent has committed in total. A bookkeeping slip in
    // `bump_child_sum` would drift this.
    assert_eq!(
        v.get_node(t.root).child_sum_for(&tok()),
        committed_before,
        "root's committed total changed during a sibling reallocation"
    );
    assert_eq!(v.get_node(t.root).child_sum_for(&tok()), usdc(800).0);
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

// =====================================================================
// I5 — per-transaction caps
//
// CLAUSE ISOLATION throughout: daily_cap is 1_000_000 so the daily clause
// cannot fire, no node is frozen, no cooldown is set, and the recipient is
// allowlisted. Only per_tx_cap can reject.
// =====================================================================

#[test]
fn i5_per_tx_boundary_exact_then_one_over() {
    let mut v = new_vault(false);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root =
        v.add_node(None, "root".into(), limit(1_000_000, 1_000_000), 0, Some(vec![payee()]));
    let a = v.add_node(Some(root), "a".into(), limit(1_000_000, 100), 0, None);
    v.bind_agent(a, r1());

    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("ok".into(), tok(), usdc(100), payee(), "".into(), None));
    testing_env!(ctx(r1(), ZERO, 1).build());
    assert_blocked(
        v.request_payment("no".into(), tok(), usdc(101), payee(), "".into(), None),
        ReasonCode::PerTxLimit,
    );
}

/// Within the AGENT's per-tx cap but over an ANCESTOR's. The distinct reason
/// code is the point: `PerTxLimit` here would mean the chain was never walked.
#[test]
fn i5_ancestor_per_tx_binds_with_its_own_reason_code() {
    let mut v = new_vault(false);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(1_000_000, 50), 0, Some(vec![payee()]));
    let a = v.add_node(Some(root), "a".into(), limit(1_000_000, 500), 0, None);
    v.bind_agent(a, r1());

    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_blocked(
        v.request_payment("x".into(), tok(), usdc(100), payee(), "".into(), None),
        ReasonCode::ParentPerTxLimit,
    );
}

// =====================================================================
// I4 — cooldown
// =====================================================================

/// 2-row table on the comparator: at EXACTLY the cooldown it must pass.
/// CLAUSE ISOLATION: caps are 1_000_000, so only cooldown can fire.
#[test]
fn i4_cooldown_blocks_one_second_early_and_passes_at_the_boundary() {
    let mut v = new_vault(false);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root =
        v.add_node(None, "root".into(), limit(1_000_000, 1_000_000), 0, Some(vec![payee()]));
    let a = v.add_node(Some(root), "a".into(), limit(1_000_000, 1_000_000), 60, None);
    v.bind_agent(a, r1());

    testing_env!(ctx(r1(), ZERO, 1_000 * NS_PER_SEC).build());
    assert_dispatched(v.request_payment("c1".into(), tok(), usdc(1), payee(), "".into(), None));

    testing_env!(ctx(r1(), ZERO, 1_059 * NS_PER_SEC).build());
    assert_blocked(
        v.request_payment("c2".into(), tok(), usdc(1), payee(), "".into(), None),
        ReasonCode::Cooldown,
    );

    testing_env!(ctx(r1(), ZERO, 1_060 * NS_PER_SEC).build());
    assert_dispatched(v.request_payment("c3".into(), tok(), usdc(1), payee(), "".into(), None));
}

/// A zero cooldown must not block back-to-back payments in the same block.
#[test]
fn i4_zero_cooldown_permits_two_payments_at_the_same_timestamp() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(r1(), ZERO, 500).build());
    assert_dispatched(v.request_payment("z1".into(), tok(), usdc(1), payee(), "".into(), None));
    testing_env!(ctx(r1(), ZERO, 500).build());
    assert_dispatched(v.request_payment("z2".into(), tok(), usdc(1), payee(), "".into(), None));
}

// =====================================================================
// I7 — allowlist
// =====================================================================

#[test]
fn i7_leaf_inherits_the_nearest_ancestor_allowlist() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("a".into(), tok(), usdc(1), payee(), "".into(), None));
    testing_env!(ctx(r1(), ZERO, 1).build());
    assert_blocked(
        v.request_payment("b".into(), tok(), usdc(1), stranger(), "".into(), None),
        ReasonCode::RecipientNotAllowed,
    );
}

/// A child list REPLACES the inherited one; it does not union with it. Pins a
/// real design decision — without this, either behaviour passes.
#[test]
fn i7_child_allowlist_overrides_rather_than_unions() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.set_recipients(t.n_r1, Some(vec![stranger()]));

    testing_env!(ctx(r1(), ZERO, 1).build());
    assert_dispatched(v.request_payment("c".into(), tok(), usdc(1), stranger(), "".into(), None));
    testing_env!(ctx(r1(), ZERO, 2).build());
    assert_blocked(
        v.request_payment("d".into(), tok(), usdc(1), payee(), "".into(), None),
        ReasonCode::RecipientNotAllowed,
    );

    // The sibling still inherits root's list, so the override is scoped to the
    // node it was set on and did not mutate the ancestor.
    testing_env!(ctx(r2(), ZERO, 3).build());
    assert_dispatched(v.request_payment("e".into(), tok(), usdc(1), payee(), "".into(), None));
}

// =====================================================================
// Freeze, depth, authorization
// =====================================================================

/// Freeze is enforced by walking the ancestor chain on the hot path, NOT by
/// propagating a flag to children. The `!frozen` assertion is what
/// distinguishes those two implementations.
#[test]
fn freeze_on_an_ancestor_blocks_the_leaf_without_propagating() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.freeze_node(t.research, true);
    assert!(!v.get_node(t.n_r1).frozen, "freeze must NOT be written into children");

    testing_env!(ctx(r1(), ZERO, 1).build());
    assert_blocked(
        v.request_payment("f".into(), tok(), usdc(1), payee(), "".into(), None),
        ReasonCode::NodeFrozen,
    );

    // A node outside the frozen subtree is unaffected.
    testing_env!(ctx(owner(), YOCTO, 2).build());
    let o1 = v.add_node(Some(t.ops), "o1".into(), limit(100, 100), 0, None);
    v.bind_agent(o1, stranger());
    testing_env!(ctx(stranger(), ZERO, 3).build());
    assert_dispatched(v.request_payment("g".into(), tok(), usdc(1), payee(), "".into(), None));

    testing_env!(ctx(owner(), YOCTO, 4).build());
    v.freeze_node(t.research, false);
    testing_env!(ctx(r1(), ZERO, 5).build());
    assert_dispatched(v.request_payment("h".into(), tok(), usdc(1), payee(), "".into(), None));
}

#[test]
#[should_panic(expected = "MAX_DEPTH")]
fn depth_beyond_max_is_rejected() {
    // MAX_DEPTH is now 4 (root -> team -> agent -> sub-agent), so the
    // standard fixture's root -> research -> r1 leaves exactly one level
    // spare. Spend it, then prove the next one is refused.
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let sub = v.add_node(Some(t.n_r1), "sub-agent".into(), limit(10, 10), 0, None);
    v.add_node(Some(sub), "too-deep".into(), limit(10, 10), 0, None);
}

#[test]
fn an_agent_can_have_a_sub_agent_beneath_it() {
    // The point of raising MAX_DEPTH: a fourth level now exists, and a
    // payment from it must still work — the hot path walks one more level.
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let sub = v.add_node(Some(t.n_r1), "sub-agent".into(), limit(10, 10), 0, None);
    assert_eq!(v.get_node(sub).path.len(), 3, "root, research, r1");
    assert_eq!(v.get_node(sub).path, vec![t.root, t.research, t.n_r1]);
}

#[test]
fn depth_exactly_at_max_is_allowed() {
    let mut v = new_vault(false);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(100, 100), 0, Some(vec![payee()]));
    let team = v.add_node(Some(root), "team".into(), limit(100, 100), 0, None);
    let leaf = v.add_node(Some(team), "leaf".into(), limit(100, 100), 0, None);
    assert_eq!(v.get_node(leaf).path, vec![root, team], "leaf path is root-first");
}

#[test]
#[should_panic(expected = "NOT_AGENT")]
fn an_unbound_account_cannot_request_a_payment() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(stranger(), ZERO, 0).build());
    let _ = v.request_payment("z".into(), tok(), usdc(1), payee(), "".into(), None);
}

/// Owner methods take exactly 1 yoctoNEAR, which is what makes them
/// unreachable from an agent function-call key (such a key cannot attach any
/// deposit). Pinned behaviourally in the sandbox tier and structurally here.
#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_methods_reject_a_zero_deposit() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), ZERO, 0).build());
    v.set_node_caps(t.ops, limit(10, 10));
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn a_non_owner_cannot_call_an_owner_method() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(stranger(), YOCTO, 0).build());
    v.freeze_node(t.ops, true);
}

// =====================================================================
// purge_settled
//
// Spact's own threat model discloses that stored requests "never shrink; there
// is no pruning yet". This is the pruning — and the thing it must never do is
// delete a request that still holds a reservation, because that would strand
// the `pending` it charged at every level of the chain for the rest of the day
// with nothing left to release it.
// =====================================================================

#[test]
fn purge_settled_never_removes_an_in_flight_request() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("p1".into(), tok(), usdc(1), payee(), "".into(), None));

    // In the unit tier the callback never runs, so this request is parked in
    // TRANSFER_PENDING — exactly the state purge must refuse to touch.
    assert_eq!(v.get_request("p1".into()).unwrap().status, Status::TransferPending);

    testing_env!(ctx(owner(), YOCTO, 1).build());
    // `u64::MAX` as the cutoff makes EVERY request old enough, so only the
    // status check can protect this one.
    let removed = v.purge_settled(u64::MAX, 100);

    assert_eq!(removed, 0, "purge removed an in-flight request");
    assert!(
        v.get_request("p1".into()).is_some(),
        "an in-flight request was deleted; its reservation can never be released"
    );
    assert_eq!(
        v.get_node_budget(t.n_r1, tok(), None).unwrap().pending,
        usdc(1),
        "the reservation held by the in-flight request was disturbed"
    );
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn purge_settled_is_owner_only() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(stranger(), YOCTO, 0).build());
    v.purge_settled(u64::MAX, 10);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn purge_settled_requires_the_owner_deposit() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), ZERO, 0).build());
    v.purge_settled(u64::MAX, 10);
}

/// A zero limit is a no-op rather than an unbounded sweep. Guards the
/// defaulting mistake where "no limit given" silently means "all".
#[test]
fn purge_settled_with_a_zero_limit_removes_nothing() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    assert_eq!(v.purge_settled(u64::MAX, 0), 0);
}

// =====================================================================
// create_agent_account validation
//
// The happy path needs a real account to exist, so it is proven behaviourally
// in the sandbox tier. These pin the rejections, which are cheap panics.
// =====================================================================

fn a_public_key() -> near_sdk::PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}

fn funded(allowance: NearToken) -> NearToken {
    allowance.saturating_add(AGENT_ACCOUNT_STORAGE)
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn create_agent_account_rejects_a_non_owner() {
    let t = tree();
    let mut v = t.v;
    let a = NearToken::from_near(2);
    testing_env!(ctx(stranger(), funded(a), 0).build());
    let _ = v.create_agent_account(t.ops, "x".into(), a_public_key(), a);
}

/// One yoctoNEAR under the floor. The floor exists because a smaller allowance
/// cannot cover prepaid gas, producing a key that is dead on arrival.
#[test]
#[should_panic(expected = "INVALID_CONFIG")]
fn create_agent_account_rejects_an_allowance_below_the_usable_floor() {
    let t = tree();
    let mut v = t.v;
    let a = MIN_AGENT_KEY_ALLOWANCE.saturating_sub(NearToken::from_yoctonear(1));
    testing_env!(ctx(owner(), funded(MIN_AGENT_KEY_ALLOWANCE), 0).build());
    let _ = v.create_agent_account(t.ops, "x".into(), a_public_key(), a);
}

#[test]
fn create_agent_account_accepts_exactly_the_floor() {
    let t = tree();
    let mut v = t.v;
    let a = MIN_AGENT_KEY_ALLOWANCE;
    testing_env!(ctx(owner(), funded(a), 0).build());
    let _ = v.create_agent_account(t.ops, "x".into(), a_public_key(), a);
}

#[test]
#[should_panic(expected = "INVALID_CONFIG")]
fn create_agent_account_rejects_a_deposit_that_does_not_cover_storage() {
    let t = tree();
    let mut v = t.v;
    let a = NearToken::from_near(2);
    testing_env!(ctx(owner(), funded(a).saturating_sub(NearToken::from_yoctonear(1)), 0).build());
    let _ = v.create_agent_account(t.ops, "x".into(), a_public_key(), a);
}

#[test]
#[should_panic(expected = "INVALID_CONFIG")]
fn create_agent_account_rejects_an_uppercase_sub_label() {
    let t = tree();
    let mut v = t.v;
    let a = NearToken::from_near(2);
    testing_env!(ctx(owner(), funded(a), 0).build());
    let _ = v.create_agent_account(t.ops, "Agent".into(), a_public_key(), a);
}

/// A dot would let the caller aim the new account outside this vault's
/// subtree, which is the whole reason the id is derived rather than accepted.
#[test]
#[should_panic(expected = "INVALID_CONFIG")]
fn create_agent_account_rejects_a_dotted_sub_label() {
    let t = tree();
    let mut v = t.v;
    let a = NearToken::from_near(2);
    testing_env!(ctx(owner(), funded(a), 0).build());
    let _ = v.create_agent_account(t.ops, "a.b".into(), a_public_key(), a);
}

#[test]
#[should_panic(expected = "INVALID_CONFIG")]
fn create_agent_account_rejects_a_node_that_already_has_an_account() {
    let t = tree();
    let mut v = t.v;
    let a = NearToken::from_near(2);
    testing_env!(ctx(owner(), funded(a), 0).build());
    // n_r1 is already bound to r1() by the fixture.
    let _ = v.create_agent_account(t.n_r1, "dup".into(), a_public_key(), a);
}

// =====================================================================
// Cross-language drift guard
//
// The MCP server validates locally so a bad call fails before it costs gas or
// a wallet round-trip — which means it DUPLICATES these bounds, which means it
// can drift from the contract silently and turn its own validation into a lie
// the chain then rejects.
//
// Both sides assert against one committed file. The TypeScript half is
// packages/mcp/src/constants.test.ts. Change a bound and BOTH fail until the
// file and both sides agree.
// =====================================================================

#[test]
fn contract_constants_match_the_shared_file() {
    let raw = include_str!("../../../shared/contract-constants.json");
    let c: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(raw).expect("shared/contract-constants.json is valid JSON");

    let num = |k: &str| -> u64 {
        c.get(k)
            .unwrap_or_else(|| panic!("{k} missing from shared/contract-constants.json"))
            .as_u64()
            .unwrap_or_else(|| panic!("{k} is not a number"))
    };
    let text = |k: &str| -> String {
        c.get(k)
            .unwrap_or_else(|| panic!("{k} missing from shared/contract-constants.json"))
            .as_str()
            .unwrap_or_else(|| panic!("{k} is not a string"))
            .to_string()
    };

    assert_eq!(MAX_DEPTH as u64, num("MAX_DEPTH"));
    assert_eq!(MAX_NODES as u64, num("MAX_NODES"));
    assert_eq!(MAX_CHILDREN as u64, num("MAX_CHILDREN"));
    assert_eq!(MAX_TOKENS as u64, num("MAX_TOKENS"));
    assert_eq!(MAX_RECIPIENTS as u64, num("MAX_RECIPIENTS"));
    assert_eq!(MAX_LABEL_LEN as u64, num("MAX_LABEL_LEN"));
    assert_eq!(MAX_SUB_LABEL_LEN as u64, num("MAX_SUB_LABEL_LEN"));
    assert_eq!(MAX_REQUEST_ID_LEN as u64, num("MAX_REQUEST_ID_LEN"));
    assert_eq!(MAX_MEMO_LEN as u64, num("MAX_MEMO_LEN"));
    assert_eq!(MAX_COOLDOWN_SEC as u64, num("MAX_COOLDOWN_SEC"));
    assert_eq!(MAX_PURGE_LIMIT as u64, num("MAX_PURGE_LIMIT"));
    assert_eq!(MAX_LIST_LIMIT as u64, num("MAX_LIST_LIMIT"));
    assert_eq!(MIN_GAS_FOR_DISPATCH.as_tgas(), num("MIN_GAS_FOR_DISPATCH_TGAS"));
    assert_eq!(
        MIN_GAS_FOR_BASE_DISPATCH.as_tgas(),
        num("MIN_GAS_FOR_BASE_DISPATCH_TGAS"),
    );
    assert_eq!(PRODUCTION_DAY_NS, num("PRODUCTION_DAY_NS"));

    // Token amounts as decimal strings: a JSON number cannot hold a
    // yoctoNEAR value, and rounding one into an f64 is exactly the silent
    // drift this guard exists to prevent.
    assert_eq!(
        AGENT_ACCOUNT_STORAGE.as_yoctonear().to_string(),
        text("AGENT_ACCOUNT_STORAGE_YOCTO")
    );
    assert_eq!(
        MIN_AGENT_KEY_ALLOWANCE.as_yoctonear().to_string(),
        text("MIN_AGENT_KEY_ALLOWANCE_YOCTO")
    );
    assert_eq!(AGENT_ALLOWED_METHOD, text("AGENT_ALLOWED_METHOD"));
}

// =====================================================================
// list_requests — the activity feed the dashboard renders
// =====================================================================

#[test]
fn list_requests_is_empty_on_a_fresh_vault() {
    let t = tree();
    assert_eq!(t.v.list_requests(None, None).len(), 0);
}

#[test]
fn list_requests_returns_newest_first() {
    let t = tree();
    let mut v = t.v;
    for i in 0..3u64 {
        testing_env!(ctx(r1(), ZERO, i).build());
        assert_dispatched(v.request_payment(
            format!("q{i}"),
            tok(),
            usdc(1),
            payee(),
            "".into(),
            None,
        ));
    }
    let ids: Vec<String> = v.list_requests(None, None).into_iter().map(|r| r.request_id).collect();
    assert_eq!(ids, vec!["q2", "q1", "q0"], "activity must read newest-first");
}

#[test]
fn list_requests_honours_from_index_and_limit() {
    let t = tree();
    let mut v = t.v;
    for i in 0..5u64 {
        testing_env!(ctx(r1(), ZERO, i).build());
        assert_dispatched(v.request_payment(
            format!("q{i}"),
            tok(),
            usdc(1),
            payee(),
            "".into(),
            None,
        ));
    }
    let page: Vec<String> = v
        .list_requests(Some(1), Some(2))
        .into_iter()
        .map(|r| r.request_id)
        .collect();
    // newest-first is q4,q3,q2,q1,q0 — skip 1, take 2.
    assert_eq!(page, vec!["q3", "q2"]);
}

/// A view that silently returns everything when asked for a huge page is how a
/// dashboard request turns into an unbounded read.
#[test]
fn list_requests_clamps_an_oversized_limit() {
    let t = tree();
    let mut v = t.v;
    for i in 0..3u64 {
        testing_env!(ctx(r1(), ZERO, i).build());
        assert_dispatched(v.request_payment(
            format!("q{i}"),
            tok(),
            usdc(1),
            payee(),
            "".into(),
            None,
        ));
    }
    assert_eq!(v.list_requests(None, Some(u32::MAX)).len(), 3);
    assert!(MAX_LIST_LIMIT <= 100, "the clamp must stay small enough to be a bound");
}

#[test]
fn list_requests_past_the_end_is_empty_not_a_panic() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("q0".into(), tok(), usdc(1), payee(), "".into(), None));
    assert_eq!(v.list_requests(Some(99), Some(10)).len(), 0);
}

/// The dashboard shows a reason code next to every terminal payment, so the
/// field has to survive the view rather than be an internal detail.
#[test]
fn list_requests_carries_the_reason_code_and_charged_chain() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("q0".into(), tok(), usdc(1), payee(), "".into(), None));

    let r = &v.list_requests(None, None)[0];
    assert_eq!(r.reason_code, ReasonCode::TransferPending);
    assert_eq!(r.reserved_chain, vec![t.root, t.research, t.n_r1]);
    assert_eq!(r.recipient, payee());
}

// =====================================================================
// sweep_stuck_pending
//
// This tier is the RIGHT place for it, unusually so: a unit test cannot
// schedule a promise, so the callback never runs and a dispatched request sits
// in TransferPending naturally — which IS the stuck state being swept. The
// sandbox tier would have to fast-forward an hour of blocks to reach it.

/// A reservation older than the age floor is released at EVERY level.
#[test]
fn sweep_releases_a_stuck_reservation_at_every_level() {
    let t = tree();
    let mut v = t.v;

    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("stuck".into(), tok(), usdc(100), payee(), "".into(), None));

    for id in [t.root, t.research, t.n_r1] {
        assert_eq!(
            v.get_node_budget(id, tok(), None).unwrap().pending,
            usdc(100),
            "node {id} should hold the reservation before the sweep"
        );
    }

    // An hour and a nanosecond later, the owner gives up on the callback.
    testing_env!(ctx(owner(), YOCTO, MIN_SWEEP_AGE_NS + 1).build());
    assert_eq!(v.sweep_stuck_pending(10), 1);

    for id in [t.root, t.research, t.n_r1] {
        let b = v.get_node_budget(id, tok(), None).unwrap();
        assert_eq!(b.pending, U128(0), "node {id} never released its reservation");
        // Released, NOT booked: nothing proved the payment happened.
        assert_eq!(b.executed, U128(0), "node {id} booked an unproven spend");
    }

    let r = v.get_request("stuck".into()).unwrap();
    assert_eq!(r.status, Status::TransferFailed);
    // Tagged as an owner intervention rather than reusing TRANSFER_FAILED,
    // otherwise an audit cannot tell the two apart.
    assert_eq!(r.reason_code, ReasonCode::SweptStuck);
}

/// A reservation YOUNGER than the floor is left alone.
///
/// The floor is what stops an owner releasing a live reservation whose callback
/// is about to land, so it needs its own assertion — the test above would pass
/// with no age check at all.
#[test]
fn sweep_leaves_a_young_reservation_alone() {
    let t = tree();
    let mut v = t.v;

    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("fresh".into(), tok(), usdc(100), payee(), "".into(), None));

    // One nanosecond short of the floor.
    testing_env!(ctx(owner(), YOCTO, MIN_SWEEP_AGE_NS - 1).build());
    assert_eq!(v.sweep_stuck_pending(10), 0, "swept a reservation inside the in-flight window");

    assert_eq!(
        v.get_node_budget(t.n_r1, tok(), None).unwrap().pending,
        usdc(100),
        "a young reservation was released"
    );
    assert_eq!(v.get_request("fresh".into()).unwrap().status, Status::TransferPending);
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn sweep_is_owner_only() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(r1(), YOCTO, MIN_SWEEP_AGE_NS + 1).build());
    v.sweep_stuck_pending(10);
}

/// The limit is honoured, so one call cannot run out of gas part-way and leave
/// an unpredictable amount of work done.
#[test]
fn sweep_honours_its_limit() {
    let t = tree();
    let mut v = t.v;

    for i in 0..3u64 {
        testing_env!(ctx(r1(), ZERO, i).build());
        assert_dispatched(v.request_payment(
            format!("s{i}"),
            tok(),
            usdc(10),
            payee(),
            "".into(),
            None,
        ));
    }

    testing_env!(ctx(owner(), YOCTO, MIN_SWEEP_AGE_NS + 10).build());
    assert_eq!(v.sweep_stuck_pending(2), 2, "limit not honoured");
    assert_eq!(v.sweep_stuck_pending(10), 1, "the remainder was not swept on a second pass");
    assert_eq!(v.sweep_stuck_pending(10), 0, "swept something twice");
}

/// A swept request becomes purgeable, which is the other half of the point:
/// `purge_settled` takes only terminal requests, so before the sweep existed a
/// stuck request held its storage forever.
#[test]
fn a_swept_request_can_then_be_purged() {
    let t = tree();
    let mut v = t.v;

    testing_env!(ctx(r1(), ZERO, 0).build());
    assert_dispatched(v.request_payment("stuck".into(), tok(), usdc(10), payee(), "".into(), None));

    testing_env!(ctx(owner(), YOCTO, MIN_SWEEP_AGE_NS + 1).build());
    // Not purgeable while pending, however old it is.
    assert_eq!(v.purge_settled(u64::MAX, 10), 0, "a pending request was purged");

    assert_eq!(v.sweep_stuck_pending(10), 1);
    assert_eq!(v.purge_settled(u64::MAX, 10), 1, "a swept request is still not purgeable");
    assert!(v.get_request("stuck".into()).is_none());
}

// =====================================================================
// I4 — sixteen agents contending for one overcommitted pool
//
// What "exact concurrency" can honestly mean on NEAR.
//
// NEAR executes receipts SEQUENTIALLY within a shard. Contention between
// agents therefore manifests as an arbitrary INTERLEAVING of ordered
// operations, never as simultaneous mutation of the same ledger. So the
// property that has to hold is not "parallel writes are safe" — nothing runs
// in parallel — but rather:
//
//     for ANY interleaving of draws across N agents sharing one
//     overcommitted pool, the pool is never overdrawn.
//
// That is exactly what this tier CAN test, and it is testable here precisely
// BECAUSE execution is sequential. Spawning OS threads would prove nothing
// about the runtime, because the runtime does not do that.
//
// The setup is the adversarial one: sixteen agents EACH allocated the full
// pool, so 1600 USDC of allowance sits above a 100 USDC pool — 16x
// overcommitted. If the ancestor ledger were checked lazily, or cached, or
// updated after dispatch rather than before, some interleaving here would
// overdraw it.
// =====================================================================

/// Deterministic PRNG. `rand` is not a dependency and a test that shuffles
/// differently on every run cannot be bisected when it fails.
fn lcg(state: &mut u64) -> u64 {
    *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    *state >> 33
}

/// One seed = one interleaving = one test.
///
/// near-sdk's mocked blockchain keeps a single storage map for the whole test
/// function, and node ids restart at 0 with each `new_vault`. Looping seeds
/// inside one `#[test]` therefore makes seed N+1's root inherit seed N's
/// ledger — the first version of this test did exactly that and failed with
/// "ledger disagrees with what was dispatched" on the second seed. Separate
/// test functions get separate thread-local storage, so each interleaving
/// starts genuinely clean.
macro_rules! contention_case {
    ($name:ident, $seed:expr) => {
        #[test]
        fn $name() {
            run_contention_case($seed);
        }
    };
}

contention_case!(i4_contention_seed_0, 0);
contention_case!(i4_contention_seed_1, 1);
contention_case!(i4_contention_seed_2, 2);
contention_case!(i4_contention_seed_3, 3);
contention_case!(i4_contention_seed_4, 4);
contention_case!(i4_contention_seed_5, 5);
contention_case!(i4_contention_seed_6, 6);
contention_case!(i4_contention_seed_7, 7);

fn run_contention_case(seed: u64) {
    const AGENTS: usize = 16;
    const POOL: u128 = 100;
    const DRAW: u128 = 10; // 10 draws fit; every one after that must be refused

    let mut v = new_vault(false);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let root = v.add_node(None, "root".into(), limit(POOL, POOL), 0, Some(vec![payee()]));

    let mut nodes = Vec::new();
    for i in 0..AGENTS {
        // Each child is allocated the ENTIRE pool: 16x overcommitted.
        let n = v.add_node(Some(root), format!("a{i}"), limit(POOL, POOL), 0, None);
        let acct: AccountId = format!("a{i}.vault.testnet").parse().unwrap();
        v.bind_agent(n, acct.clone());
        nodes.push(acct);
    }

    let mut rng = seed.wrapping_add(1);
    let mut dispatched = 0u128;
    let mut refused = 0u32;

    for step in 0..(AGENTS * 3) {
        let who = nodes[(lcg(&mut rng) as usize) % AGENTS].clone();
        testing_env!(ctx(who, ZERO, 0).build());
        let out = v.request_payment(
            format!("s{seed}-{step}"),
            tok(),
            usdc(DRAW),
            payee(),
            "".into(),
            None,
        );
        match out {
            PromiseOrValue::Promise(_) => dispatched += DRAW,
            PromiseOrValue::Value(o) => {
                // The ONLY clause that may refuse here is the shared pool.
                // Per-tx, own-daily, freeze, cooldown and allowlist all admit
                // this draw, so any other code means the test is measuring
                // something other than contention.
                assert_eq!(
                    o.reason_code,
                    ReasonCode::ParentDailyBudget,
                    "seed {seed} step {step}: refused by the WRONG clause",
                );
                refused += 1;
            }
        }

        // THE INVARIANT, after EVERY step. An end-only assertion cannot tell
        // "never overdrawn" apart from "overdrawn, then corrected".
        let b = v.get_node_budget(root, tok(), None).unwrap();
        let committed = b.executed.0 + b.pending.0;
        assert!(
            committed <= usdc(POOL).0,
            "seed {seed} step {step}: pool OVERDRAWN — committed {} > cap {}",
            committed,
            usdc(POOL).0,
        );
        assert_eq!(
            committed,
            usdc(dispatched).0,
            "seed {seed} step {step}: ledger disagrees with what was dispatched",
        );
    }

    // Exactly the pool, no more and no less, however the draws interleaved.
    assert_eq!(dispatched, POOL, "seed {seed}: expected the pool fully drawn");
    assert!(refused > 0, "seed {seed}: nothing was refused — the pool never bound");
}

// =====================================================================
// Ownership handover and the owner's exit.
//
// These two capabilities were absent, and their absence compounded: a lost
// owner key froze the vault's configuration forever, and no path existed to
// move tokens out except capped agent payments to allowlisted recipients.
// The tests below pin both the happy path and — more importantly — the
// refusals, since a handover that accepts the wrong caller is worse than no
// handover at all.
// =====================================================================

#[test]
fn ownership_moves_only_after_the_nominee_accepts() {
    let mut v = new_vault(true);

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.propose_owner(Some(payee()));

    // Nominated, but NOT yet owner. This is the whole point of two steps.
    assert_eq!(v.get_pending_owner(), Some(payee()));
    assert_eq!(v.get_config().owner, owner());

    testing_env!(ctx(payee(), YOCTO, 0).build());
    v.accept_ownership();

    assert_eq!(v.get_config().owner, payee());
    assert_eq!(v.get_pending_owner(), None, "nomination must be consumed");
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn a_stranger_cannot_accept_someone_elses_nomination() {
    let mut v = new_vault(true);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.propose_owner(Some(payee()));

    testing_env!(ctx(stranger(), YOCTO, 0).build());
    v.accept_ownership();
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn accepting_with_no_nomination_outstanding_fails() {
    let mut v = new_vault(true);
    testing_env!(ctx(payee(), YOCTO, 0).build());
    v.accept_ownership();
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn a_stranger_cannot_nominate() {
    let mut v = new_vault(true);
    testing_env!(ctx(stranger(), YOCTO, 0).build());
    v.propose_owner(Some(stranger()));
}

#[test]
#[should_panic(expected = "INVALID_CONFIG")]
fn the_vault_cannot_be_nominated_as_its_own_owner() {
    // A vault owning itself makes assert_owner unsatisfiable by any external
    // caller — the precise brick this feature exists to prevent.
    let mut v = new_vault(true);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.propose_owner(Some(vault_id()));
}

#[test]
fn a_nomination_can_be_cancelled_and_then_cannot_be_accepted() {
    let mut v = new_vault(true);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.propose_owner(Some(payee()));
    v.propose_owner(None);
    assert_eq!(v.get_pending_owner(), None);

    // The cancelled nominee must not still be able to take the vault.
    testing_env!(ctx(payee(), YOCTO, 0).build());
    let took_it = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v.accept_ownership();
    }))
    .is_ok();
    assert!(!took_it, "a cancelled nominee accepted ownership");
}

#[test]
fn the_new_owner_can_administer_and_the_old_one_cannot() {
    // Ownership that transfers the title but not the authority would be a
    // cosmetic change. Exercise a real owner-gated call on both sides.
    let t = tree();
    let mut v = t.v;
    let ops = t.ops;

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.propose_owner(Some(payee()));
    testing_env!(ctx(payee(), YOCTO, 0).build());
    v.accept_ownership();

    // New owner: works.
    testing_env!(ctx(payee(), YOCTO, 0).build());
    v.freeze_node(ops, true);

    // Previous owner: must now be refused.
    testing_env!(ctx(owner(), YOCTO, 0).build());
    let still_had_power = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v.freeze_node(ops, false);
    }))
    .is_ok();
    assert!(!still_had_power, "the previous owner retained authority");
}

#[test]
fn withdraw_is_owner_only_and_rejects_zero() {
    let mut v = new_vault(true);

    testing_env!(ctx(stranger(), YOCTO, 0).build());
    let stranger_withdrew = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v.withdraw(tok(), U128(1), stranger());
    }))
    .is_ok();
    assert!(!stranger_withdrew, "a stranger withdrew from the vault");

    testing_env!(ctx(owner(), YOCTO, 0).build());
    let zero_allowed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v.withdraw(tok(), U128(0), owner());
    }))
    .is_ok();
    assert!(!zero_allowed, "a zero-amount withdrawal was accepted");
}

#[test]
fn withdraw_works_while_paused() {
    // An escape hatch a pause can close is not an escape hatch. If this ever
    // starts failing, the owner's exit has been made conditional on the
    // vault's own state, which is how funds get trapped.
    let mut v = new_vault(true);
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.set_paused(true);

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.withdraw(tok(), U128(1), owner());
}

#[test]
fn withdraw_does_not_touch_the_budget_ledger() {
    // The owner's exit is outside the hierarchy on purpose. If a withdrawal
    // consumed daily budget, a large recovery would starve the agents and the
    // drip problem would return by another route.
    let t = tree();
    let mut v = t.v;
    let root = t.root;
    let before = v.get_node_budget(root, tok(), None).unwrap();

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.withdraw(tok(), U128(usdc(900).0), owner());

    let after = v.get_node_budget(root, tok(), None).unwrap();
    assert_eq!(before.executed.0, after.executed.0, "withdrawal consumed executed budget");
    assert_eq!(before.pending.0, after.pending.0, "withdrawal consumed pending budget");
    assert_eq!(before.available.0, after.available.0, "withdrawal consumed available budget");
}

// =====================================================================
// Reclaiming nodes.
//
// `add_node` had no counterpart, so MAX_NODES was a one-way budget: every
// node ever created consumed one of sixty-four slots permanently. Tolerable
// while only the owner creates nodes; fatal the moment anything else can,
// because no amount of freezing or key revocation gives a slot back.
//
// The preconditions matter more than the happy path. Getting one wrong does
// not produce an error — it produces a reservation wedged open forever at
// every level of its chain.
// =====================================================================

#[test]
fn a_removed_node_returns_its_slot_and_its_allocation() {
    let t = tree();
    let mut v = t.v;
    let before = v.get_tree().len();
    let parent_sum_before = v.get_node(t.research).child_sum_for(&tok());

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.freeze_node(t.n_r2, true);
    v.remove_node(t.n_r2);

    assert_eq!(v.get_tree().len(), before - 1, "slot not reclaimed");
    assert!(v.get_tree().iter().all(|n| n.id != t.n_r2));

    // The parent must get its headroom back, or a strict-mode tree can never
    // re-use the allocation and the slot is only half-freed.
    let after = v.get_node(t.research);
    assert!(
        after.child_sum_for(&tok()) < parent_sum_before,
        "parent still reserves the removed child's cap",
    );
    assert_eq!(after.child_count, 1, "child_count not decremented");
}

#[test]
fn the_slot_can_actually_be_reused() {
    // The whole point. If MAX_NODES does not come back down, removal is
    // cosmetic.
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.freeze_node(t.n_r2, true);
    v.remove_node(t.n_r2);
    let fresh = v.add_node(Some(t.research), "r3".into(), limit(50, 10), 0, None);
    assert_ne!(fresh, t.n_r2, "ids must not be reused");
    assert_eq!(v.get_node(fresh).label, "r3");
}

#[test]
#[should_panic(expected = "INVALID_CONFIG")]
fn an_unfrozen_node_cannot_be_removed() {
    // Freezing is what stops new reservations forming. Without it, a payment
    // can be reserved between the emptiness check and the removal.
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.remove_node(t.n_r2);
}

#[test]
#[should_panic(expected = "MAX_CHILDREN")]
fn a_node_with_children_cannot_be_removed() {
    // A descendant keeps this node in its `path`; removing it would leave
    // children charging a level that no longer exists.
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.freeze_node(t.research, true);
    v.remove_node(t.research);
}

#[test]
#[should_panic(expected = "INVALID_CONFIG")]
fn the_root_cannot_be_removed() {
    // It would leave a vault no payment can route through, unrecoverably.
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.freeze_node(t.root, true);
    v.remove_node(t.root);
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn a_stranger_cannot_remove_a_node() {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(stranger(), YOCTO, 0).build());
    v.remove_node(t.n_r2);
}

#[test]
fn removing_a_bound_node_frees_its_account() {
    // Otherwise the account stays in `account_to_node` forever and can never
    // be bound again — the key is orphaned and the account unusable.
    let t = tree();
    let mut v = t.v;
    // The tree fixture already binds r2() to this node.
    testing_env!(ctx(owner(), YOCTO, 0).build());
    assert_eq!(v.get_node(t.n_r2).account, Some(r2()));

    v.freeze_node(t.n_r2, true);
    v.remove_node(t.n_r2);

    // Proven by rebinding the same account to a different node, which the
    // contract refuses while a binding is still held.
    v.bind_agent(t.ops, r2());
    assert_eq!(v.get_node(t.ops).account, Some(r2()));
}

#[test]
fn a_node_with_an_open_reservation_is_not_removable() {
    // The dangerous case. A pending reservation releases by subtracting from
    // this node's ledger; remove the node while one is open and that release
    // happens in a CALLBACK, where a failure strands the reservation at every
    // level of the chain.
    let t = tree();
    let mut v = t.v;
    // r1() is already bound by the fixture.
    // Start a payment but never resolve it: the reservation stays pending.
    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    let _ = v.request_payment(
        "res-open".into(),
        tok(),
        usdc(5),
        payee(),
        String::new(),
        None,
    );

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.freeze_node(t.n_r1, true);
    let removed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v.remove_node(t.n_r1);
    }))
    .is_ok();
    assert!(!removed, "a node with an open reservation was removed");
}

#[test]
fn a_reservation_opened_before_midnight_still_blocks_removal() {
    // `today()` is a fixed window and RESERVATION_TTL is an hour, so a
    // reservation taken late on one day is still open on the next. Checking
    // only today would miss exactly this case and let the node go.
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.set_day_len_ns(1_000_000_000); // 1s "days", so crossing one is cheap

    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    let _ = v.request_payment(
        "res-eve".into(),
        tok(),
        usdc(5),
        payee(),
        String::new(),
        None,
    );

    // Move into the next day, leaving the reservation open on the previous.
    testing_env!(ctx(owner(), YOCTO, 1_500_000_000).build());
    v.freeze_node(t.n_r1, true);
    let removed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v.remove_node(t.n_r1);
    }))
    .is_ok();
    assert!(!removed, "yesterday's open reservation did not block removal");
}

// =====================================================================
// The quote signer.
//
// An Intents payment sends funds to a ONE-TIME deposit address from a solver
// quote. That address can never be on the payee allowlist, and the contract
// cannot verify that paying it pays the allowlisted payee — the
// correspondence exists only inside the quote.
//
// So without this gate the allowlist is decorative: a compromised agent
// quotes a swap paying itself, names that deposit address, and the vault
// funds it while every other check passes. These tests exist to prove the
// gate rejects each way of lying about the binding, not merely that a good
// signature works.
//
// Real ed25519 here, not a fixture blob: the property under test is that
// TAMPERING is caught, which a hardcoded signature cannot demonstrate.
// =====================================================================

use ed25519_dalek::{Signer, SigningKey};

fn signing_key() -> SigningKey {
    // Deterministic, so a failure is reproducible.
    SigningKey::from_bytes(&[7u8; 32])
}

fn signer_pubkey() -> Base64VecU8 {
    Base64VecU8(signing_key().verifying_key().to_bytes().to_vec())
}

fn deposit() -> AccountId {
    "deadbeef-one-time.near".parse().unwrap()
}

/// The EVM payee an Intents payment ultimately lands on.
const EVM_PAYEE: &str = "0x4200000000000000000000000000000000000006";

const DEADLINE: u64 = 10_000_000_000;

/// Sign the binding the contract will reconstruct. Fields are passed
/// individually so a test can deliberately sign the WRONG one.
#[allow(clippy::too_many_arguments)]
fn sign_quote(
    request_id: &str,
    token: &AccountId,
    amount: u128,
    payee: &str,
    deposit_address: &AccountId,
    deadline_ns: u64,
) -> Base64VecU8 {
    let binding = QuoteBinding {
        vault: vault_id(),
        request_id: request_id.to_string(),
        token: token.clone(),
        amount: U128(amount),
        payee: payee.to_string(),
        deposit_address: deposit_address.clone(),
        deadline_ns,
    };
    let msg = near_sdk::borsh::to_vec(&binding).expect("borsh");
    Base64VecU8(signing_key().sign(&msg).to_bytes().to_vec())
}

fn intents_route(dep: &AccountId, deadline: u64, sig: Base64VecU8) -> Route {
    Route::Intents {
        deposit_address: dep.clone(),
        quote_deadline_ns: U64(deadline),
        signature: sig,
    }
}

/// A tree whose root allowlists the EVM payee, with the signer registered.
fn intents_tree() -> Tree {
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.set_recipients(t.root, Some(vec![payee(), EVM_PAYEE.parse().unwrap()]));
    v.set_quote_signer(Some(signer_pubkey()));
    Tree { v, ..t }
}

#[test]
fn a_correctly_signed_quote_dispatches() {
    let t = intents_tree();
    let mut v = t.v;
    let amt = usdc(5);
    let sig = sign_quote("q-ok", &tok(), amt.0, EVM_PAYEE, &deposit(), DEADLINE);

    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    let out = v.request_payment(
        "q-ok".into(),
        tok(),
        amt,
        EVM_PAYEE.parse().unwrap(),
        String::new(),
        Some(intents_route(&deposit(), DEADLINE, sig)),
    );
    match out {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(o) => panic!("a valid quote was blocked: {:?}", o.reason_code),
    }
}

#[test]
fn a_tampered_deposit_address_is_refused() {
    // THE ATTACK. The agent obtains a legitimate quote for the allowlisted
    // payee, then swaps in a deposit address of its own. Everything else —
    // amount, payee, budget, allowlist — still checks out.
    let t = intents_tree();
    let mut v = t.v;
    let amt = usdc(5);
    let honest = sign_quote("q-swap", &tok(), amt.0, EVM_PAYEE, &deposit(), DEADLINE);
    let attacker: AccountId = "attacker-deposit.near".parse().unwrap();

    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    assert_blocked(
        v.request_payment(
            "q-swap".into(),
            tok(),
            amt,
            EVM_PAYEE.parse().unwrap(),
            String::new(),
            Some(intents_route(&attacker, DEADLINE, honest)),
        ),
        ReasonCode::QuoteBadSignature,
    );
}

#[test]
fn a_quote_signed_for_a_different_payee_is_refused() {
    // The mirror of the attack above: a real deposit address, but bound to
    // somebody else's payment.
    let t = intents_tree();
    let mut v = t.v;
    let amt = usdc(5);
    let other = sign_quote("q-payee", &tok(), amt.0, "0xdead", &deposit(), DEADLINE);

    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    assert_blocked(
        v.request_payment(
            "q-payee".into(),
            tok(),
            amt,
            EVM_PAYEE.parse().unwrap(),
            String::new(),
            Some(intents_route(&deposit(), DEADLINE, other)),
        ),
        ReasonCode::QuoteBadSignature,
    );
}

#[test]
fn a_quote_signed_for_a_different_amount_is_refused() {
    // Otherwise an agent reuses a $1 quote to move $500.
    let t = intents_tree();
    let mut v = t.v;
    let sig = sign_quote("q-amt", &tok(), usdc(1).0, EVM_PAYEE, &deposit(), DEADLINE);

    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    assert_blocked(
        v.request_payment(
            "q-amt".into(),
            tok(),
            usdc(5),
            EVM_PAYEE.parse().unwrap(),
            String::new(),
            Some(intents_route(&deposit(), DEADLINE, sig)),
        ),
        ReasonCode::QuoteBadSignature,
    );
}

#[test]
fn a_signature_cannot_be_replayed_onto_another_request() {
    // `request_id` is in the binding, so one quote authorises one payment.
    let t = intents_tree();
    let mut v = t.v;
    let amt = usdc(5);
    let sig = sign_quote("q-first", &tok(), amt.0, EVM_PAYEE, &deposit(), DEADLINE);

    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    assert_blocked(
        v.request_payment(
            "q-second".into(),
            tok(),
            amt,
            EVM_PAYEE.parse().unwrap(),
            String::new(),
            Some(intents_route(&deposit(), DEADLINE, sig)),
        ),
        ReasonCode::QuoteBadSignature,
    );
}

#[test]
fn an_expired_quote_is_refused() {
    // Prices move and deposit addresses expire. Honouring a stale quote
    // sends real money to an address that may no longer settle.
    let t = intents_tree();
    let mut v = t.v;
    let amt = usdc(5);
    let sig = sign_quote("q-old", &tok(), amt.0, EVM_PAYEE, &deposit(), 1_000);

    testing_env!(ctx(r1(), ZERO, 5_000).prepaid_gas(Gas::from_tgas(100)).build());
    assert_blocked(
        v.request_payment(
            "q-old".into(),
            tok(),
            amt,
            EVM_PAYEE.parse().unwrap(),
            String::new(),
            Some(intents_route(&deposit(), 1_000, sig)),
        ),
        ReasonCode::QuoteExpired,
    );
}

#[test]
fn with_no_signer_registered_the_intents_rail_is_closed() {
    // The safe default, and the response to a suspected key compromise:
    // revoke, and every Intents payment is refused with no other
    // coordination needed.
    let t = tree();
    let mut v = t.v;
    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.set_recipients(t.root, Some(vec![EVM_PAYEE.parse().unwrap()]));
    assert!(v.get_quote_signer().is_none());

    let sig = sign_quote("q-nosigner", &tok(), usdc(5).0, EVM_PAYEE, &deposit(), DEADLINE);
    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    assert_blocked(
        v.request_payment(
            "q-nosigner".into(),
            tok(),
            usdc(5),
            EVM_PAYEE.parse().unwrap(),
            String::new(),
            Some(intents_route(&deposit(), DEADLINE, sig)),
        ),
        ReasonCode::QuoteSignerUnset,
    );
}

#[test]
fn a_signature_from_the_wrong_key_is_refused() {
    let t = intents_tree();
    let mut v = t.v;
    let amt = usdc(5);
    let binding = QuoteBinding {
        vault: vault_id(),
        request_id: "q-wrongkey".into(),
        token: tok(),
        amount: amt,
        payee: EVM_PAYEE.to_string(),
        deposit_address: deposit(),
        deadline_ns: DEADLINE,
    };
    let msg = near_sdk::borsh::to_vec(&binding).expect("borsh");
    let impostor = SigningKey::from_bytes(&[9u8; 32]);
    let sig = Base64VecU8(impostor.sign(&msg).to_bytes().to_vec());

    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    assert_blocked(
        v.request_payment(
            "q-wrongkey".into(),
            tok(),
            amt,
            EVM_PAYEE.parse().unwrap(),
            String::new(),
            Some(intents_route(&deposit(), DEADLINE, sig)),
        ),
        ReasonCode::QuoteBadSignature,
    );
}

#[test]
fn the_allowlist_still_applies_to_the_final_payee() {
    // The signature binds the deposit address to a payee; it does not
    // AUTHORISE that payee. A perfectly signed quote for someone not on the
    // list must still be refused, or the signer could bypass the allowlist
    // entirely.
    let t = intents_tree();
    let mut v = t.v;
    let amt = usdc(5);
    let stranger_evm = "0x000000000000000000000000000000000000dead";
    let sig = sign_quote("q-notallowed", &tok(), amt.0, stranger_evm, &deposit(), DEADLINE);

    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    assert_blocked(
        v.request_payment(
            "q-notallowed".into(),
            tok(),
            amt,
            stranger_evm.parse().unwrap(),
            String::new(),
            Some(intents_route(&deposit(), DEADLINE, sig)),
        ),
        ReasonCode::RecipientNotAllowed,
    );
}

#[test]
fn an_intents_payment_is_charged_to_every_level_of_the_tree() {
    // A cross-chain payment must not escape the hierarchy. It is an ordinary
    // NEP-141 transfer underneath, so the same reservation runs — but that is
    // worth pinning, because the whole point of the rail is that it reuses
    // the budget machinery rather than going around it.
    let t = intents_tree();
    let mut v = t.v;
    let root = t.root;
    let before = v.get_node_budget(root, tok(), None).unwrap().pending.0;

    let amt = usdc(5);
    let sig = sign_quote("q-budget", &tok(), amt.0, EVM_PAYEE, &deposit(), DEADLINE);
    testing_env!(ctx(r1(), ZERO, 0).prepaid_gas(Gas::from_tgas(100)).build());
    let _ = v.request_payment(
        "q-budget".into(),
        tok(),
        amt,
        EVM_PAYEE.parse().unwrap(),
        String::new(),
        Some(intents_route(&deposit(), DEADLINE, sig)),
    );

    let after = v.get_node_budget(root, tok(), None).unwrap().pending.0;
    assert_eq!(after - before, amt.0, "the root was not charged for a cross-chain payment");
}

/// The byte-for-byte shape of a signed quote binding.
///
/// The signer is a TypeScript service; the verifier is this contract. They
/// must borsh-encode the binding identically or no signature ever verifies —
/// and the failure is silent and total, indistinguishable from "the key is
/// wrong". This vector is asserted on BOTH sides, so a field reorder or a
/// type change breaks a test instead of the rail.
#[test]
fn quote_binding_borsh_vector() {
    let b = QuoteBinding {
        vault: "v.testnet".parse().unwrap(),
        request_id: "req-1".to_string(),
        token: "usdc.testnet".parse().unwrap(),
        amount: U128(5_000_000),
        payee: "0xabc".to_string(),
        deposit_address: "dep.near".parse().unwrap(),
        deadline_ns: 1_700_000_000_000_000_000,
    };
    let hex: String = near_sdk::borsh::to_vec(&b)
        .expect("borsh")
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect();
    assert_eq!(
        hex,
        "09000000762e746573746e6574050000007265712d310c000000757364632e746573746e6574404b4c00000000000000000000000000050000003078616263080000006465702e6e65617200002a36fe9c9717",
        "borsh encoding changed — packages/mcp/src/quote.test.ts asserts this same vector",
    );
}

/// A signature produced by the TypeScript signer, verified by this contract.
///
/// The borsh vector above proves both sides encode the same bytes. This
/// proves the whole round trip: @noble/curves signs, `env::ed25519_verify`
/// accepts. Without it, an encoding match could still hide a key-format or
/// signature-format mismatch, and the failure mode in production is silent —
/// every cross-chain payment refused, looking exactly like a misconfigured
/// key.
///
/// Regenerate with: node .demo/sigprobe.mjs
#[test]
fn a_signature_from_the_typescript_signer_verifies() {
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    let binding = QuoteBinding {
        vault: "v.testnet".parse().unwrap(),
        request_id: "req-1".to_string(),
        token: "usdc.testnet".parse().unwrap(),
        amount: U128(5_000_000),
        payee: "0xabc".to_string(),
        deposit_address: "dep.near".parse().unwrap(),
        deadline_ns: 1_700_000_000_000_000_000,
    };
    let msg = near_sdk::borsh::to_vec(&binding).expect("borsh");

    let pk: [u8; 32] = unhex("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")
        .try_into()
        .unwrap();
    let sig: [u8; 64] = unhex(
        "57c4402b8d8605c5169e634405b69f2b85affa1951fb788324b8e9701c1b23f1\
         b33e8939d089f1f148759bed5501fe3d446381d24a951f584035146575ba190c",
    )
    .try_into()
    .unwrap();

    testing_env!(ctx(owner(), ZERO, 0).build());
    assert!(
        near_sdk::env::ed25519_verify(&sig, &msg, &pk),
        "the TypeScript signer and this contract disagree",
    );

    // And the negative control: the same signature must NOT verify against a
    // tampered message, or the assertion above proves nothing.
    let mut tampered = msg.clone();
    *tampered.last_mut().unwrap() ^= 0x01;
    assert!(
        !near_sdk::env::ed25519_verify(&sig, &tampered, &pk),
        "verification accepted a tampered message",
    );
}

// =====================================================================
// Virtual agents.
//
// A virtual agent has no NEAR account: it signs a payload off-chain and a
// relayer submits it. That moves authentication out of the protocol and into
// this contract, so the tests below are not "does the happy path work" but
// "what stops the relayer, or anyone holding an old payload, from spending
// twice".
// =====================================================================

fn va_signing_key() -> SigningKey {
    SigningKey::from_bytes(&[11u8; 32])
}

fn va_other_key() -> SigningKey {
    SigningKey::from_bytes(&[12u8; 32])
}

/// near_sdk PublicKey = 1 curve-type byte (0 = ed25519) + 32 raw bytes.
fn va_pubkey(sk: &SigningKey) -> PublicKey {
    let mut bytes = vec![0u8];
    bytes.extend_from_slice(&sk.verifying_key().to_bytes());
    PublicKey::try_from(bytes).expect("ed25519 public key")
}

/// Sign exactly what the contract reconstructs. Fields are passed in so a
/// test can sign one thing and submit another.
#[allow(clippy::too_many_arguments)]
fn sign_va(
    sk: &SigningKey,
    nonce: u64,
    deadline_ns: u64,
    request_id: &str,
    token: &AccountId,
    amount: u128,
    recipient: &AccountId,
    memo: &str,
    route: &Route,
) -> Base64VecU8 {
    let binding = VirtualAgentBinding {
        vault: vault_id(),
        nonce,
        deadline_ns,
        request_id: request_id.to_string(),
        token: token.clone(),
        amount: U128(amount),
        recipient: recipient.clone(),
        memo: memo.to_string(),
        route: route.clone(),
    };
    let msg = near_sdk::borsh::to_vec(&binding).expect("borsh");
    Base64VecU8(sk.sign(&msg).to_bytes().to_vec())
}

/// THE test this whole design exists for.
///
/// `request_id` is deduplicated, which looks like replay protection and is
/// not: `purge_settled` removes terminal requests and frees the id for reuse.
/// Under `request_payment` that is harmless, because NEAR gives every
/// transaction a nonce and the protocol refuses a replay before this contract
/// is reached. A detached signature has no such protection, so without the
/// per-key nonce an old payload becomes spendable again the moment its
/// request record is purged.
///
/// Asserts the rejection comes from NONCE_NOT_FRESH specifically. If it came
/// back DUPLICATE_REQUEST the test would be passing on the guard that is
/// about to be purged away, and would keep passing while the real hole opened.
#[test]
fn a_purged_request_id_does_not_make_a_signed_payload_replayable() {
    let t = tree();
    let mut v = t.v;
    let sk = va_signing_key();

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.bind_virtual_agent(t.n_r1, va_pubkey(&sk));

    let route = Route::NearDirect;
    let sig = sign_va(&sk, 1, DEADLINE, "va-1", &tok(), usdc(100).0, &payee(), "", &route);

    testing_env!(ctx(stranger(), ZERO, 0).build());
    assert_dispatched(v.request_payment_signed(
        "va-1".into(),
        tok(),
        usdc(100),
        payee(),
        "".into(),
        Some(route.clone()),
        va_pubkey(&sk),
        1,
        U64(DEADLINE),
        sig.clone(),
    ));

    // Settle it, so it becomes purgeable.
    testing_env!(ctx(vault_id(), ZERO, 0).build());
    v.on_transfer_result("va-1".into());

    // Purge it. The request_id is now free.
    testing_env!(ctx(owner(), YOCTO, 0).build());
    assert_eq!(v.purge_settled(u64::MAX, 10), 1, "the request was not purged");
    assert!(v.get_request("va-1".into()).is_none(), "request record still present");

    // Replay the IDENTICAL payload. The duplicate-id guard is gone.
    testing_env!(ctx(stranger(), ZERO, 0).build());
    assert_blocked(
        v.request_payment_signed(
            "va-1".into(),
            tok(),
            usdc(100),
            payee(),
            "".into(),
            Some(route),
            va_pubkey(&sk),
            1,
            U64(DEADLINE),
            sig,
        ),
        ReasonCode::NonceNotFresh,
    );
}

/// One signature is worth at most one ATTEMPT, not one success. The nonce is
/// burned before dispatch, so a payload that was validly signed but rejected
/// downstream cannot be resubmitted once the blocking condition clears.
#[test]
fn a_rejected_signed_payload_still_burns_its_nonce() {
    let t = tree();
    let mut v = t.v;
    let sk = va_signing_key();

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.bind_virtual_agent(t.n_r1, va_pubkey(&sk));
    v.freeze_node(t.n_r1, true);

    let route = Route::NearDirect;
    let sig = sign_va(&sk, 1, DEADLINE, "va-f", &tok(), usdc(100).0, &payee(), "", &route);

    testing_env!(ctx(stranger(), ZERO, 0).build());
    assert_blocked(
        v.request_payment_signed(
            "va-f".into(),
            tok(),
            usdc(100),
            payee(),
            "".into(),
            Some(route.clone()),
            va_pubkey(&sk),
            1,
            U64(DEADLINE),
            sig.clone(),
        ),
        ReasonCode::NodeFrozen,
    );

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.freeze_node(t.n_r1, false);
    testing_env!(ctx(stranger(), ZERO, 0).build());
    assert_blocked(
        v.request_payment_signed(
            "va-f".into(),
            tok(),
            usdc(100),
            payee(),
            "".into(),
            Some(route),
            va_pubkey(&sk),
            1,
            U64(DEADLINE),
            sig,
        ),
        ReasonCode::NonceNotFresh,
    );
}

/// Unbinding must not reset the replay guard. If it did, an owner could
/// unbind and rebind a key to make every signature it ever produced valid
/// again.
#[test]
fn rebinding_a_key_does_not_reset_its_nonce() {
    let t = tree();
    let mut v = t.v;
    let sk = va_signing_key();
    let pk = va_pubkey(&sk);

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.bind_virtual_agent(t.n_r1, pk.clone());

    let route = Route::NearDirect;
    let sig = sign_va(&sk, 1, DEADLINE, "va-r", &tok(), usdc(100).0, &payee(), "", &route);
    testing_env!(ctx(stranger(), ZERO, 0).build());
    assert_dispatched(v.request_payment_signed(
        "va-r".into(),
        tok(),
        usdc(100),
        payee(),
        "".into(),
        Some(route.clone()),
        pk.clone(),
        1,
        U64(DEADLINE),
        sig.clone(),
    ));

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.unbind_virtual_agent(pk.clone());
    v.bind_virtual_agent(t.n_r1, pk.clone());
    assert_eq!(
        v.get_virtual_agent_nonce(pk.clone()),
        2,
        "nonce counter was reset by a rebind"
    );

    testing_env!(ctx(stranger(), ZERO, 0).build());
    assert_blocked(
        v.request_payment_signed(
            "va-r2".into(),
            tok(),
            usdc(100),
            payee(),
            "".into(),
            Some(route),
            pk,
            1,
            U64(DEADLINE),
            sig,
        ),
        ReasonCode::NonceNotFresh,
    );
}

/// Many keys, one node -- the whole point of the pivot. Two signers share
/// r1's budget rather than consuming two of the 64 MAX_NODES.
#[test]
fn two_virtual_agents_share_one_nodes_budget() {
    let t = tree();
    let mut v = t.v;
    let a = va_signing_key();
    let b = va_other_key();

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.bind_virtual_agent(t.ops, va_pubkey(&a));
    v.bind_virtual_agent(t.ops, va_pubkey(&b));
    assert_eq!(
        v.get_node(t.ops).account,
        None,
        "a virtual binding must not set node.account"
    );

    let route = Route::NearDirect;
    for (sk, id) in [(&a, "sh-a"), (&b, "sh-b")] {
        let sig = sign_va(sk, 1, DEADLINE, id, &tok(), usdc(150).0, &payee(), "", &route);
        testing_env!(ctx(stranger(), ZERO, 0).build());
        assert_dispatched(v.request_payment_signed(
            id.into(),
            tok(),
            usdc(150),
            payee(),
            "".into(),
            Some(route.clone()),
            va_pubkey(sk),
            1,
            U64(DEADLINE),
            sig,
        ));
    }

    // 300 drawn from a 300 node by two different signers: the SHARED pool was
    // debited, not two independent ones.
    assert_eq!(
        v.get_node_budget(t.ops, tok(), None).unwrap().pending,
        usdc(300)
    );

    // And a third payment is refused by ops' cap, proving they contend.
    let sig = sign_va(&a, 2, DEADLINE, "sh-c", &tok(), usdc(1).0, &payee(), "", &route);
    testing_env!(ctx(stranger(), ZERO, 0).build());
    assert_blocked(
        v.request_payment_signed(
            "sh-c".into(),
            tok(),
            usdc(1),
            payee(),
            "".into(),
            Some(route),
            va_pubkey(&a),
            2,
            U64(DEADLINE),
            sig,
        ),
        ReasonCode::DailyBudget,
    );
}

/// An unbound key has no node to charge, so this is a hard failure.
#[test]
#[should_panic(expected = "NOT_VIRTUAL_AGENT")]
fn an_unbound_key_cannot_spend() {
    let t = tree();
    let mut v = t.v;
    let sk = va_signing_key();
    let route = Route::NearDirect;
    let sig = sign_va(&sk, 1, DEADLINE, "va-u", &tok(), usdc(100).0, &payee(), "", &route);

    testing_env!(ctx(stranger(), ZERO, 0).build());
    v.request_payment_signed(
        "va-u".into(),
        tok(),
        usdc(100),
        payee(),
        "".into(),
        Some(route),
        va_pubkey(&sk),
        1,
        U64(DEADLINE),
        sig,
    );
}

/// A stale signature expires. Bounds what a withheld or leaked payload is
/// worth.
#[test]
fn an_expired_signature_is_refused() {
    let t = tree();
    let mut v = t.v;
    let sk = va_signing_key();

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.bind_virtual_agent(t.n_r1, va_pubkey(&sk));

    let route = Route::NearDirect;
    let sig = sign_va(&sk, 1, DEADLINE, "va-e", &tok(), usdc(100).0, &payee(), "", &route);

    testing_env!(ctx(stranger(), ZERO, DEADLINE + 1).build());
    assert_blocked(
        v.request_payment_signed(
            "va-e".into(),
            tok(),
            usdc(100),
            payee(),
            "".into(),
            Some(route),
            va_pubkey(&sk),
            1,
            U64(DEADLINE),
            sig,
        ),
        ReasonCode::AgentSignatureExpired,
    );
}

/// Tampering with a signed field is caught. The relayer is untrusted, so each
/// field it could rewrite is checked individually -- a single "wrong amount"
/// case would not show that the OTHERS are covered.
#[test]
fn tampering_with_any_signed_field_is_refused() {
    let t = tree();
    let mut v = t.v;
    let sk = va_signing_key();

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.bind_virtual_agent(t.n_r1, va_pubkey(&sk));

    // Signed once, honestly.
    let route = Route::NearDirect;
    let sig = sign_va(&sk, 1, DEADLINE, "va-t", &tok(), usdc(100).0, &payee(), "ok", &route);

    // Each submission alters exactly ONE field away from what was signed.
    let cases: Vec<(&str, U128, AccountId, String)> = vec![
        ("va-t", usdc(999), payee(), "ok".into()),   // amount
        ("va-t", usdc(100), stranger(), "ok".into()), // recipient
        ("va-t", usdc(100), payee(), "tampered".into()), // memo
        ("other", usdc(100), payee(), "ok".into()),  // request_id
    ];
    for (rid, amount, recipient, memo) in cases {
        testing_env!(ctx(stranger(), ZERO, 0).build());
        assert_blocked(
            v.request_payment_signed(
                rid.into(),
                tok(),
                amount,
                recipient,
                memo,
                Some(route.clone()),
                va_pubkey(&sk),
                1,
                U64(DEADLINE),
                sig.clone(),
            ),
            ReasonCode::BadAgentSignature,
        );
    }
}

/// A signature from a key that is bound, but not the key named in the call,
/// must not pass. Guards against checking "some bound key signed this".
#[test]
fn another_bound_keys_signature_is_refused() {
    let t = tree();
    let mut v = t.v;
    let a = va_signing_key();
    let b = va_other_key();

    testing_env!(ctx(owner(), YOCTO, 0).build());
    v.bind_virtual_agent(t.n_r1, va_pubkey(&a));
    v.bind_virtual_agent(t.n_r1, va_pubkey(&b));

    let route = Route::NearDirect;
    // b signs, but the call names a's key.
    let sig = sign_va(&b, 1, DEADLINE, "va-x", &tok(), usdc(100).0, &payee(), "", &route);

    testing_env!(ctx(stranger(), ZERO, 0).build());
    assert_blocked(
        v.request_payment_signed(
            "va-x".into(),
            tok(),
            usdc(100),
            payee(),
            "".into(),
            Some(route),
            va_pubkey(&a),
            1,
            U64(DEADLINE),
            sig,
        ),
        ReasonCode::BadAgentSignature,
    );
}

