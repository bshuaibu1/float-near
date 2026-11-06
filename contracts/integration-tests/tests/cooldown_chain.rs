//! F3 — a cooldown set on a PARENT must bound its children.
//!
//! `dispatch_payment` iterates `chain` for every other check: frozen, token
//! allowed, per-tx cap, daily budget. Cooldown alone read `node_id` only, so a
//! rate limit on a parent was bypassed by paying from a child, and with two
//! sibling leaves the parent's intended interval was halved.
//!
//! Both halves had to move together. Checking the chain while still recording
//! `last_paid_ns` for the paying node alone would leave an ancestor's timestamp
//! permanently stale, so its cooldown would never fire and the fix would look
//! applied while changing nothing.
mod common;
use common::*;

use anyhow::Result;
use serde_json::json;

async fn set_cooldown(e: &Env, node: u32, secs: u32) -> Result<()> {
    e.owner
        .call(e.vault.id(), "set_cooldown")
        .args_json(json!({ "node_id": node, "cooldown_sec": secs }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// THE REGRESSION. A cooldown on the parent bounds a payment from the child.
#[tokio::test]
async fn a_parents_cooldown_bounds_its_child() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;

    // TEAM is AGENT0's parent. The agent's own node has no cooldown at all, so
    // anything that blocks the second payment can only have come from above.
    set_cooldown(&e, TEAM, 3600).await?;

    pay(&e.agents[0], &e, "cd-1", PAY, &payee).await?;
    assert_eq!(request(&e, "cd-1").await?.status, "SETTLED", "the first must pass");

    let out = pay(&e.agents[0], &e, "cd-2", PAY, &payee).await?;
    assert!(out.is_success(), "a refusal is a value, not a failure");
    let json: serde_json::Value = out.json()?;
    assert_eq!(json["status"], "BLOCKED", "got {json}");
    assert_eq!(
        json["reason_code"], "PARENT_COOLDOWN",
        "a parent's cooldown must be distinguishable from the node's own: {json}"
    );
    Ok(())
}

/// The node's OWN cooldown still reports as its own, not as a parent's.
#[tokio::test]
async fn a_nodes_own_cooldown_is_still_reported_as_its_own() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;

    set_cooldown(&e, AGENT0, 3600).await?;

    pay(&e.agents[0], &e, "own-1", PAY, &payee).await?;
    assert_eq!(request(&e, "own-1").await?.status, "SETTLED");

    let out = pay(&e.agents[0], &e, "own-2", PAY, &payee).await?;
    let json: serde_json::Value = out.json()?;
    assert_eq!(json["reason_code"], "COOLDOWN", "got {json}");
    Ok(())
}

/// With no cooldown set anywhere, nothing changes. The guard must not become a
/// rate limit that was never asked for.
#[tokio::test]
async fn no_cooldown_anywhere_means_no_throttle() -> Result<()> {
    let e = setup(1, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;

    for i in 0..3u32 {
        let rid = format!("free-{i}");
        pay(&e.agents[0], &e, &rid, PAY, &payee).await?;
        assert_eq!(request(&e, &rid).await?.status, "SETTLED", "payment {i}");
    }
    Ok(())
}

/// SIBLINGS SHARE THE PARENT'S INTERVAL. This is the case that makes the fix
/// worth having: before it, two leaves under one parent each paid freely and
/// halved the interval the owner thought they had set.
#[tokio::test]
async fn siblings_share_their_parents_cooldown() -> Result<()> {
    // Two agents, both under TEAM.
    let e = setup(2, CAP * 10).await?;
    let payee = e.payee.id().to_string();
    allow_recipients(&e, ROOT, vec![payee.clone()]).await?;
    set_cooldown(&e, TEAM, 3600).await?;

    pay(&e.agents[0], &e, "sib-1", PAY, &payee).await?;
    assert_eq!(request(&e, "sib-1").await?.status, "SETTLED");

    // A DIFFERENT agent, a different node, same parent.
    let out = pay(&e.agents[1], &e, "sib-2", PAY, &payee).await?;
    let json: serde_json::Value = out.json()?;
    assert_eq!(
        json["reason_code"], "PARENT_COOLDOWN",
        "a sibling must not reset the parent's interval: {json}"
    );
    Ok(())
}
