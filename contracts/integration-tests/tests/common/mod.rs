//! Sandbox harness. Run `scripts/build-wasm.sh` first.
#![allow(dead_code)]

use anyhow::{Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde::Deserialize;
use serde_json::json;

pub const USDC: u128 = 1_000_000; // 6 decimals
pub const CAP: u128 = 100 * USDC;
pub const PAY: u128 = 10 * USDC;

// Node ids are assigned sequentially from 0 by `add_node`.
pub const ROOT: u32 = 0;
pub const TEAM: u32 = 1;
pub const AGENT0: u32 = 2;

/// 100 ms "days". A NEAR block is ~1.1 s, so a transfer callback ALWAYS lands
/// at least one day-bucket after its request. That is what makes the
/// day-boundary assertion deterministic instead of a race against block time,
/// and it is why no delay hook is needed in the mock token.
pub const TEST_DAY_NS: u64 = 100_000_000;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Mirrors the contract's JSON surface rather than importing its Rust types,
/// so an internal refactor cannot keep these tests passing by accident.
#[derive(Debug, Deserialize)]
pub struct BudgetView {
    pub node_id: u32,
    pub day: u64,
    pub daily_cap: String,
    pub executed: String,
    pub pending: String,
    pub available: String,
}

impl BudgetView {
    pub fn executed(&self) -> u128 {
        self.executed.parse().expect("executed is a u128 string")
    }
    pub fn pending(&self) -> u128 {
        self.pending.parse().expect("pending is a u128 string")
    }
    pub fn available(&self) -> u128 {
        self.available.parse().expect("available is a u128 string")
    }
}

#[derive(Debug, Deserialize)]
pub struct PaymentOutcomeView {
    pub request_id: String,
    pub node_id: u32,
    pub status: String,
    pub reason_code: String,
}

#[derive(Debug, Deserialize)]
pub struct PaymentRequestView {
    pub request_id: String,
    pub node_id: u32,
    pub amount: String,
    pub reserved_chain: Vec<u32>,
    pub reserved_day: u64,
    pub status: String,
    pub reason_code: String,
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub vault: Contract,
    pub ft: Contract,
    pub owner: Account,
    pub payee: Account,
    pub agents: Vec<Account>,
}

fn wasm(name: &str) -> Result<Vec<u8>> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../res")
        .join(name);
    std::fs::read(&p).with_context(|| {
        format!(
            "missing {}. Run scripts/build-wasm.sh first.",
            p.display()
        )
    })
}

/// `agents` children under one team, each capped at the FULL root cap, so the
/// siblings are `agents`-times overcommitted against a shared pool. `mint` is
/// the vault's starting token balance — pass less than a payment to reach the
/// honest-insufficient-balance failure mode.
pub async fn setup(agents: usize, mint: u128) -> Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let vault = worker.dev_deploy(&wasm("vault_test_clock.wasm")?).await?;
    let ft = worker.dev_deploy(&wasm("mock_ft.wasm")?).await?;

    ft.call("new").transact().await?.into_result()?;

    let owner = worker.dev_create_account().await?;
    let payee = worker.dev_create_account().await?;

    // `new` requires predecessor == the vault account itself, so nobody can
    // initialize a freshly deployed vault with their own owner. A contract
    // self-call satisfies that.
    vault
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "network": "sandbox",
            "strict_allocation": false, // overcommit is the subject under test
        }))
        .transact()
        .await?
        .into_result()?;

    // The day length is left at the PRODUCTION value here, deliberately.
    //
    // A short day must be opt-in per test (see `set_day_len`). Making it the
    // default was wrong in two ways: `current_day()` becomes a moving target
    // between the payments and the assertions, and — far worse — 16 concurrent
    // payments spanning two blocks would land in two different day buckets and
    // therefore get two separate daily budgets. That would make the
    // concurrency test intermittently report ~20 settled against a 10-payment
    // pool: a flaky proof of the project's central claim, which is worse than
    // no proof at all.

    // Everyone who will hold or receive the token must be registered, then
    // the vault is funded.
    for id in [vault.id().as_str(), payee.id().as_str()] {
        ft.call("storage_deposit")
            .args_json(json!({ "account_id": id }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
    }
    ft.call("mint")
        .args_json(json!({ "account_id": vault.id(), "amount": mint.to_string() }))
        .transact()
        .await?
        .into_result()?;

    let lim = |daily: u128, per_tx: u128| {
        json!([{
            "token": ft.id(),
            "daily_cap": daily.to_string(),
            "per_tx_cap": per_tx.to_string(),
        }])
    };

    add_node(&owner, &vault, None, "root", lim(CAP, CAP), Some(vec![payee.id().to_string()]))
        .await?;
    add_node(&owner, &vault, Some(ROOT), "team", lim(CAP, CAP), None).await?;

    let mut accounts = Vec::with_capacity(agents);
    for i in 0..agents {
        let a = worker.dev_create_account().await?;
        let id = add_node(&owner, &vault, Some(TEAM), &format!("a{i}"), lim(CAP, CAP), None)
            .await?;
        owner
            .call(vault.id(), "bind_agent")
            .args_json(json!({ "node_id": id, "account_id": a.id() }))
            .deposit(ONE_YOCTO)
            .transact()
            .await?
            .into_result()?;
        accounts.push(a);
    }

    Ok(Env { worker, vault, ft, owner, payee, agents: accounts })
}

pub async fn add_node(
    owner: &Account,
    vault: &Contract,
    parent: Option<u32>,
    label: &str,
    limits: serde_json::Value,
    recipients: Option<Vec<String>>,
) -> Result<u32> {
    let out = owner
        .call(vault.id(), "add_node")
        .args_json(json!({
            "parent": parent,
            "label": label,
            "limits": limits,
            "cooldown_sec": 0,
            "recipients": recipients,
        }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(out.json()?)
}

/// Returns the raw result so a test can assert on failure as well as success.
pub async fn pay(
    agent: &Account,
    e: &Env,
    request_id: &str,
    amount: u128,
    recipient: &str,
) -> Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(agent
        .call(e.vault.id(), "request_payment")
        .args_json(json!({
            "request_id": request_id,
            "token": e.ft.id(),
            "amount": amount.to_string(),
            "recipient": recipient,
            "memo": "",
        }))
        .max_gas()
        .transact()
        .await?)
}

pub async fn budget(e: &Env, node: u32, day: Option<u64>) -> Result<BudgetView> {
    let v: Option<BudgetView> = e
        .vault
        .view("get_node_budget")
        .args_json(json!({ "node_id": node, "token": e.ft.id(), "day": day }))
        .await?
        .json()?;
    v.with_context(|| format!("no budget view for node {node}"))
}

pub async fn request(e: &Env, request_id: &str) -> Result<PaymentRequestView> {
    let v: Option<PaymentRequestView> = e
        .vault
        .view("get_request")
        .args_json(json!({ "request_id": request_id }))
        .await?
        .json()?;
    v.with_context(|| format!("no stored request {request_id}"))
}

pub async fn ft_transfer_count(e: &Env) -> Result<u64> {
    Ok(e.ft.view("transfer_count").await?.json()?)
}

pub async fn fail_transfers_armed(e: &Env) -> Result<bool> {
    Ok(e.ft.view("fail_transfers_armed").await?.json()?)
}

pub async fn set_fail_transfers(e: &Env, fail: bool) -> Result<()> {
    e.ft.call("set_fail_transfers")
        .args_json(json!({ "fail": fail }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Did this transaction fail *because of our forced-failure hook*?
///
/// The firing receipt panics, so the mock keeps no record of having fired.
/// Matching the panic marker in the outcome is what distinguishes "our hook
/// caused this" from "it failed for some unrelated reason" — the difference
/// between a real positive control and a decorative one.
pub fn failed_via_forced_hook(out: &near_workspaces::result::ExecutionFinalResult) -> bool {
    // The panic lives in a SUB-receipt (the ft_transfer), and the outer
    // transaction still succeeds because the callback handled it. So the
    // top-level Debug does not contain the marker — the receipt failures do.
    out.receipt_failures()
        .iter()
        .any(|f| format!("{f:?}").contains("MOCK_FT_FORCED_FAILURE"))
}

pub async fn current_day(e: &Env) -> Result<u64> {
    Ok(e.vault.view("current_day").await?.json()?)
}

/// Opt-in short budget window. ONLY the day-boundary test should call this:
/// with a 100 ms day a transfer callback always lands in a later bucket than
/// its request, which is what makes that assertion deterministic. Every other
/// test wants a stable day, so they leave the production length alone.
pub async fn set_day_len(e: &Env, ns: u64) -> Result<()> {
    e.owner
        .call(e.vault.id(), "set_day_len_ns")
        .args_json(json!({ "ns": ns }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn purge(e: &Env, before_day: u64, limit: u32) -> Result<u32> {
    Ok(e.owner
        .call(e.vault.id(), "purge_settled")
        .args_json(json!({ "before_day": before_day, "limit": limit }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?)
}
