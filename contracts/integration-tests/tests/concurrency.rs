//! The claim this project exists to make.
//!
//! N agents, each individually capped at the FULL root cap, all paying at the
//! same moment. The shared parent pool must hold EXACTLY, not approximately.
//!
//! Why on-chain and not in an enclave: NEAR executes receipts targeting the
//! same account sequentially, so request N+1 reads the ledger after request N
//! committed to it. There is no read-then-increment window to lose. A policy
//! engine whose cumulative counter is supplied by an external gateway has no
//! such guarantee — concurrent requests can each read the same pre-spend value
//! and all pass.
//!
//! Prerequisite: scripts/build-wasm.sh (run under Linux/WSL).

mod common;
use common::*;

const AGENTS: usize = 16;

#[tokio::test]
async fn concurrency_parent_cap_is_exact_under_simultaneous_children() -> anyhow::Result<()> {
    // Each of the 16 agents is capped at the full root cap: 16x overcommit.
    let e = setup(AGENTS, CAP * 100).await?;

    // PREDICTED BEFORE RUNNING. Asserted as an equality, never `<=`: a run
    // where zero payments settle also satisfies "the cap was not exceeded",
    // which is the fake-coverage trap this equality exists to close.
    let expected_settled = (CAP / PAY) as usize; // 10
    let expected_blocked = AGENTS - expected_settled; // 6

    // Build every future first, then await them together, so the transactions
    // are genuinely in flight at the same time rather than serialised by the
    // test harness.
    let futures: Vec<_> = e
        .agents
        .iter()
        .enumerate()
        .map(|(i, a)| {
            a.call(e.vault.id(), "request_payment")
                .args_json(serde_json::json!({
                    "request_id": format!("c{i}"),
                    "token": e.ft.id(),
                    "amount": PAY.to_string(),
                    "recipient": e.payee.id(),
                    "memo": "",
                }))
                .max_gas()
                .transact()
        })
        .collect();

    let results = futures::future::join_all(futures).await;
    assert_eq!(results.len(), AGENTS, "not every attempt was submitted");

    let mut settled = 0usize;
    let mut blocked = 0usize;
    for (i, r) in results.into_iter().enumerate() {
        let out = r?;
        assert!(out.is_success(), "attempt c{i} errored outright: {out:#?}");
        let o: PaymentOutcomeView = out.json()?;
        match o.status.as_str() {
            "SETTLED" => settled += 1,
            "BLOCKED" => {
                // chain is [root, team, agent]; pass one checks root first, and
                // root is not the caller's node, so the ancestor code is the
                // correct one. DAILY_BUDGET here would mean the agent's own cap
                // bound instead, i.e. the pool was never the constraint.
                assert_eq!(
                    o.reason_code, "PARENT_DAILY_BUDGET",
                    "c{i} blocked by the wrong clause"
                );
                blocked += 1;
            }
            other => panic!("c{i} unexpected terminal status {other}: {o:?}"),
        }
    }

    assert_eq!(settled, expected_settled, "expected exactly {expected_settled} settled");
    assert_eq!(blocked, expected_blocked, "expected exactly {expected_blocked} blocked");

    // Positive control on the instrument: the settled payments must have
    // actually moved value. Without this, a vault that blocked everything
    // would still satisfy "the cap was not exceeded".
    assert_eq!(
        ft_transfer_count(&e).await?,
        expected_settled as u64,
        "token transfers do not match the settled count"
    );

    // Read the day the payments were actually charged to, and prove they all
    // shared ONE bucket. If they had spanned two day buckets they would have
    // drawn on two separate daily budgets, and "exactly 100" would be an
    // artifact of the window rather than a property of the pool.
    let mut days = std::collections::BTreeSet::new();
    for i in 0..AGENTS {
        if let Ok(r) = request(&e, &format!("c{i}")).await {
            days.insert(r.reserved_day);
        }
    }
    assert_eq!(
        days.len(),
        1,
        "settled payments spanned {} day buckets, so the cap was not a single pool",
        days.len()
    );
    let day = *days.iter().next().expect("one day");

    let root = budget(&e, ROOT, Some(day)).await?;
    assert_eq!(root.executed(), CAP, "root cap breached or under-filled");
    assert_eq!(root.pending(), 0, "reservations still outstanding");
    assert_eq!(root.available(), 0);

    let team = budget(&e, TEAM, Some(day)).await?;
    assert_eq!(team.executed(), CAP, "team total disagrees with root");

    // Cross-level conservation. Catches charging the leaf but not the
    // ancestors, and vice versa — a failure mode no single-level assertion
    // can see.
    let mut sum = 0u128;
    for i in 0..AGENTS {
        sum += budget(&e, AGENT0 + i as u32, Some(day)).await?.executed();
    }
    assert_eq!(sum, root.executed(), "sum of per-agent spend != root spend");
    Ok(())
}

/// The naive architecture, for the comparison chart. Each agent gets its OWN
/// pool equal to the shared cap and no ancestor is charged — which is what an
/// off-chain per-agent counter with no shared accounting does.
///
/// This is not a mutation of the vault; it is a second configuration of it,
/// so the chart compares two real runs rather than one run and an assertion.
#[tokio::test]
async fn without_a_shared_pool_the_same_16_agents_overspend_16x() -> anyhow::Result<()> {
    let e = setup(AGENTS, CAP * 100).await?;

    // Raise root and team far above the sum of children, so no ancestor can
    // ever bind. Each agent is then limited only by its own cap.
    let huge = CAP * 1_000;
    for node in [ROOT, TEAM] {
        e.owner
            .call(e.vault.id(), "set_node_caps")
            .args_json(serde_json::json!({
                "node_id": node,
                "limits": [{ "token": e.ft.id(),
                             "daily_cap": huge.to_string(),
                             "per_tx_cap": huge.to_string() }],
            }))
            .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }

    let futures: Vec<_> = e
        .agents
        .iter()
        .enumerate()
        .map(|(i, a)| {
            a.call(e.vault.id(), "request_payment")
                .args_json(serde_json::json!({
                    "request_id": format!("n{i}"),
                    "token": e.ft.id(),
                    "amount": PAY.to_string(),
                    "recipient": e.payee.id(),
                    "memo": "",
                }))
                .max_gas()
                .transact()
        })
        .collect();
    for r in futures::future::join_all(futures).await {
        r?.into_result()?;
    }

    // All 16 settle: 160 USDC spent against what was a 100 USDC pool.
    assert_eq!(ft_transfer_count(&e).await?, AGENTS as u64);
    let day = request(&e, "n0").await?.reserved_day;
    let spent = budget(&e, ROOT, Some(day)).await?.executed();
    assert_eq!(
        spent,
        PAY * AGENTS as u128,
        "the no-shared-pool configuration should spend the full 16x"
    );
    assert!(spent > CAP, "this configuration is supposed to overspend the pool");
    Ok(())
}
