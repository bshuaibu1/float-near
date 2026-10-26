//! The gas ceiling on the Base rail.
//!
//! This covers the ONE path by which an agent could move value OUTSIDE the
//! ERC-20 budget. The budget tree constrains USDC; it says nothing about the
//! native ETH the vault's derived Base address must hold to pay for gas. And
//! the agent supplies the fee fields — so with no ceiling, an inflated
//! `gas_limit * max_fee_per_gas` produces a validly-signed transaction that
//! burns that ETH. The leash would hold on the token and leak on the fee.
//!
//! The bound is on the PRODUCT. The most a 1559 transaction can ever cost is
//! `gas_limit * max_fee_per_gas`; the network charges
//! `gas_used * (base_fee + min(priority, max_fee - base_fee))`, which is always
//! less than or equal to that. Capping each field independently would leave
//! their product unbounded in combination, which is what
//! `a_modest_fee_with_an_enormous_gas_limit_is_refused` exists to catch.

mod common;
use anyhow::Result;
use common::*;

/// A fee within the ceiling is signed normally.
///
/// The control for every test below: without it, a ceiling of zero would make
/// them all pass while the rail was simply broken.
#[tokio::test]
async fn a_fee_within_the_ceiling_is_signed() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![EVM_PAYEE.to_string()]).await?;

    // 100_000 gas * 20 gwei = 0.002 ETH, well under the 0.01 ETH ceiling.
    let out = pay_base_fees(
        &e.agents[0], &e, "f1", PAY, EVM_PAYEE, 100_000, 20_000_000_000, 1_000_000_000,
    )
    .await?;
    assert!(out.is_success(), "{out:#?}");
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "SIGNED", "an ordinary fee was refused");
    assert_eq!(sign_count(&e).await?, 1);
    Ok(())
}

/// Exactly AT the ceiling passes; one wei over is refused.
///
/// Asserted from both sides because an off-by-one in the comparator (`<` where
/// `<=` was meant) is otherwise invisible — every realistic fee sits far from
/// the limit, so no other test would ever touch the boundary.
#[tokio::test]
async fn the_ceiling_boundary_is_exact() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![EVM_PAYEE.to_string()]).await?;

    let gas: u64 = 100_000;
    let at = FEE_CEILING_WEI / u128::from(gas); // product == ceiling exactly

    let out = pay_base_fees(&e.agents[0], &e, "at", PAY, EVM_PAYEE, gas, at, 1).await?;
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "SIGNED", "a fee exactly at the ceiling was refused");

    let out = pay_base_fees(&e.agents[0], &e, "over", PAY, EVM_PAYEE, gas, at + 1, 1).await?;
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "FEE_CEILING_EXCEEDED", "one wei over the ceiling was signed");
    Ok(())
}

/// An inflated gas price is refused, signs nothing, and charges nothing.
#[tokio::test]
async fn an_inflated_gas_fee_is_refused_before_the_signer() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![EVM_PAYEE.to_string()]).await?;

    // 1 ETH per gas unit. Perfectly signable, and would drain the gas balance.
    let out = pay_base_fees(
        &e.agents[0], &e, "f2", PAY, EVM_PAYEE, 1_000_000, 1_000_000_000_000_000_000, 1,
    )
    .await?;
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "FEE_CEILING_EXCEEDED");
    assert_eq!(sign_count(&e).await?, 0, "the vault signed a fee-draining transaction");
    assert_eq!(budget(&e, ROOT, None).await?.pending(), 0, "charged for a refused fee");
    Ok(())
}

/// The ceiling applies to the PRODUCT, so a modest gas price with an enormous
/// gas limit is still refused.
///
/// This is the case a per-field cap would wave through: each value alone looks
/// unremarkable, and only the product reveals the drain.
#[tokio::test]
async fn a_modest_fee_with_an_enormous_gas_limit_is_refused() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![EVM_PAYEE.to_string()]).await?;

    // 20 gwei is an ordinary gas price and 30M is a whole-block gas limit.
    // Product = 0.6 ETH, sixty times the ceiling.
    let out = pay_base_fees(
        &e.agents[0], &e, "f3", PAY, EVM_PAYEE, 30_000_000, 20_000_000_000, 1,
    )
    .await?;
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "FEE_CEILING_EXCEEDED");
    assert_eq!(sign_count(&e).await?, 0);
    Ok(())
}

/// An overflowing product is refused, not wrapped.
///
/// THE OVERFLOW IS THE ATTACK, not an arithmetic footnote: a wrapping multiply
/// turns an enormous fee into a SMALL number that sails under the ceiling, and
/// the vault then signs the most expensive transaction it can construct.
///
/// The inputs are chosen, not lazy. Mutation M26 replaced `checked_mul` with
/// `wrapping_mul` and this test still passed, because the obvious pair
/// (`u64::MAX`, `u128::MAX`) wraps to `2^128 - 2^64 + 1` — astronomically
/// ABOVE the ceiling, so the refusal happened for the wrong reason and proved
/// nothing. `2^63 * 2^65 = 2^128`, which wraps to exactly ZERO: the one shape
/// where a wrapping multiply reads as "free" and the guard waves it through.
#[tokio::test]
async fn an_overflowing_fee_product_is_refused_not_wrapped() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![EVM_PAYEE.to_string()]).await?;

    // 2^63 gas * 2^65 wei = 2^128 == 0 (mod 2^128).
    let gas: u64 = 1u64 << 63;
    let fee: u128 = 1u128 << 65;
    assert_eq!(
        u128::from(gas).wrapping_mul(fee),
        0,
        "these inputs must wrap to zero or this test is not testing the overflow",
    );

    let out = pay_base_fees(&e.agents[0], &e, "f4", PAY, EVM_PAYEE, gas, fee, 1).await?;
    assert!(out.is_success(), "the contract should refuse, not panic: {out:#?}");
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(
        o.reason_code, "FEE_CEILING_EXCEEDED",
        "a fee product that wraps to zero was accepted as being under the ceiling",
    );
    assert_eq!(sign_count(&e).await?, 0);
    assert_eq!(budget(&e, ROOT, None).await?.pending(), 0);

    // The both-maxed pair too, which refuses via the ordinary comparison. Kept
    // so the test covers both overflow shapes rather than trading one for the
    // other.
    let out =
        pay_base_fees(&e.agents[0], &e, "f4b", PAY, EVM_PAYEE, u64::MAX, u128::MAX, 1).await?;
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "FEE_CEILING_EXCEEDED");
    assert_eq!(sign_count(&e).await?, 0);
    Ok(())
}

/// A priority fee above the max fee is malformed under EIP-1559.
///
/// Base would reject such a transaction, so refusing it here means the vault
/// does not spend a signature request — and the vault's own NEAR — on
/// something that can never land.
#[tokio::test]
async fn a_priority_fee_above_the_max_fee_is_refused() -> Result<()> {
    let e = setup(1, CAP).await?;
    open_base_rail(&e).await?;
    allow_recipients(&e, ROOT, vec![EVM_PAYEE.to_string()]).await?;

    let out = pay_base_fees(&e.agents[0], &e, "f5", PAY, EVM_PAYEE, 100_000, 1_000, 2_000).await?;
    let o: PaymentOutcomeView = out.json()?;
    assert_eq!(o.reason_code, "INVALID_FEE_FIELDS");
    assert_eq!(sign_count(&e).await?, 0, "spent a signature on a malformed transaction");
    Ok(())
}

/// The owner cannot set a zero ceiling, which would close the rail while the
/// config still read as open.
#[tokio::test]
async fn a_zero_ceiling_is_rejected_rather_than_silently_closing_the_rail() -> Result<()> {
    use serde_json::json;
    let e = setup(1, CAP).await?;

    let out = e
        .owner
        .call(e.vault.id(), "set_base_config")
        .args_json(json!({
            "config": {
                "mpc_contract": e.mpc.id(),
                "usdc_address": BASE_USDC,
                "chain_id": 84532,
                "derivation_path": "base-1",
                "domain_id": 0,
                "max_tx_fee_wei": "0",
            }
        }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await?;

    assert!(out.is_failure(), "a zero ceiling was accepted: {out:#?}");
    assert!(
        format!("{:?}", out.into_result().unwrap_err()).contains("FEE_CEILING_EXCEEDED"),
        "rejected for the wrong reason",
    );
    Ok(())
}
