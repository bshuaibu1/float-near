//! Every public view must actually be callable AS a view.
//!
//! WHY THIS FILE EXISTS. `get_node` was shipped to mainnet unusable:
//!
//!     Function call returned an error: "wasm execution failed with error:
//!     HostError(ProhibitedInView { method_name: \"predecessor_account_id\" })"
//!
//! The cause was an orphaned attribute. When the MPC/Base rail was removed on
//! 2026-10-28 the `on_sign_result` callback body was deleted, but its doc
//! comment and its `#[private]` were left behind:
//!
//!     /// Chain Signatures rail. A successful promise means the MPC network
//!     /// returned a SIGNATURE over the Base transaction.
//!     #[private]
//!     // ------------------------------------------------------------- views
//!
//!     pub fn get_node(&self, node_id: NodeId) -> Node {
//!
//! Rust attributes bind to the next ITEM, and an intervening comment is not an
//! item. So `#[private]` silently attached to `get_node`, and `#[private]`
//! expands to an assert on `predecessor_account_id()` — a host function the
//! runtime forbids in a view context.
//!
//! WHY NOTHING CAUGHT IT. Two independent reasons, and both matter:
//!
//! 1. `#[private]` is injected into the generated `extern "C"` wrapper, NOT
//!    into the inner Rust method. The six internal `self.get_node(...)` call
//!    sites in lib.rs are therefore completely unaffected, so no payment path
//!    changed behaviour and nothing looked broken.
//! 2. The unit tests in src/tests.rs call `v.get_node(..)` as a plain Rust
//!    method — 15 call sites — which bypasses the wrapper entirely. They cannot
//!    observe `#[private]` even in principle. Only a real node can.
//!
//! That combination is the general lesson, and it is why this file asserts the
//! VIEW SURFACE as a surface rather than testing one method: a view is reached
//! through generated code that in-process tests never execute, so "the function
//! returns the right value" and "the function can be called" are two different
//! claims. The second one had no coverage at all.
mod common;
use common::*;

use anyhow::Result;
use serde_json::json;

/// The regression, stated as narrowly as possible.
#[tokio::test]
async fn get_node_is_callable_as_a_view() -> Result<()> {
    let e = setup(0, 1_000 * USDC).await?;

    // `.view()` is the whole point. Calling this through a transaction would
    // pass even with `#[private]` when the caller happens to be the contract
    // itself, which is exactly the false green to avoid.
    let node: serde_json::Value = e
        .vault
        .view("get_node")
        .args_json(json!({ "node_id": ROOT }))
        .await?
        .json()?;

    assert_eq!(node["id"], ROOT, "a view that returns the wrong node is no better");
    Ok(())
}

/// The surface, so a future orphaned attribute on a DIFFERENT view is caught.
///
/// Listed explicitly rather than discovered, because there is no way to
/// enumerate a contract's view methods from outside it. A view added without a
/// line here is still unprotected — but the cost of that is one missed method,
/// against a whole-surface break going unnoticed, which is what happened.
#[tokio::test]
async fn no_view_asserts_on_its_caller() -> Result<()> {
    let e = setup(0, 1_000 * USDC).await?;

    // (method, args). Each must succeed in a VIEW context. The assertion is
    // specifically NOT about the returned value — these are checked elsewhere.
    // What is being tested is reachability.
    let calls: Vec<(&str, serde_json::Value)> = vec![
        ("get_config", json!({})),
        ("get_tree", json!({})),
        ("get_node", json!({ "node_id": ROOT })),
        ("get_node_budget", json!({ "node_id": ROOT, "token": e.ft.id() })),
        ("current_day", json!({})),
        ("list_requests", json!({})),
        ("get_request", json!({ "request_id": "nope" })),
    ];

    let mut broken = Vec::new();
    for (method, args) in &calls {
        if let Err(err) = e.vault.view(method).args_json(args.clone()).await {
            let msg = err.to_string();
            // Name the cause when it is the one this file exists for, so the
            // failure reads as a diagnosis instead of a stack trace.
            let hint = if msg.contains("ProhibitedInView") {
                " <- a stray #[private] or an env:: call forbidden in views"
            } else {
                ""
            };
            broken.push(format!("{method}: {msg}{hint}"));
        }
    }

    assert!(
        broken.is_empty(),
        "these public views cannot be called as views:\n  {}",
        broken.join("\n  "),
    );
    Ok(())
}

/// A view and its bulk equivalent must agree.
///
/// `get_tree` kept working while `get_node` did not, so a dashboard reading the
/// tree saw correct data and a dashboard reading one node got an error. Pinning
/// the agreement means neither can drift alone.
#[tokio::test]
async fn get_node_agrees_with_get_tree() -> Result<()> {
    let e = setup(0, 1_000 * USDC).await?;

    let tree: Vec<serde_json::Value> =
        e.vault.view("get_tree").args_json(json!({})).await?.json()?;
    assert!(tree.len() >= 2, "harness should build a tree worth comparing");

    for want in &tree {
        let id = want["id"].as_u64().expect("node id");
        let got: serde_json::Value = e
            .vault
            .view("get_node")
            .args_json(json!({ "node_id": id }))
            .await?
            .json()?;
        assert_eq!(&got, want, "get_node({id}) disagrees with that node in get_tree");
    }
    Ok(())
}
