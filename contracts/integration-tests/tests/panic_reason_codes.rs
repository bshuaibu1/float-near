//! M21, executed as a differential test: does the BUILD COMMAND decide whether
//! this contract's panic reason codes survive to the receipt?
//!
//! `sandbox.rs::reason_code_panics_reach_the_receipt_outcome` already proves
//! the reason code survives in the artifact we ship. What it cannot show is
//! that the build command is what makes the difference — it only ever sees one
//! artifact, so a regression in how the wasm is produced would leave it green
//! while every panic degraded to an opaque trap.
//!
//! This file deploys BOTH artifacts into one sandbox and triggers the SAME
//! panic on each, so the comparison is differential rather than absolute. The
//! repo needed that because it carried two contradictory claims about this
//! exact question (workspace Cargo.toml + MUTATIONS.md M21 vs commit c732cbe),
//! and no test could adjudicate them.
//!
//! Build both with scripts/m21-plain-vs-cargo-near.sh. They live in res/m21/
//! rather than res/ because build-wasm.sh opens with `rm -f res/*.wasm`: at the
//! top level they would be deleted by the next ordinary build and these tests
//! would silently start skipping while still reporting as passed. A
//! subdirectory survives that glob, so once built they keep being exercised.
//!
//! Skipping (rather than failing) when absent is deliberate — a fresh clone has
//! not built them, and build-wasm.sh produces only the correct artifact on
//! purpose. The skip prints loudly for the same reason the paths moved: a quiet
//! skip inside a green run is indistinguishable from coverage.

mod common;

use anyhow::Result;
use near_workspaces::types::NearToken;
use serde_json::json;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

fn res(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../res/m21").join(name)
}

/// Loud, because a skip that reads as a pass is the failure mode this whole
/// file exists to guard against.
fn skip(what: &str) {
    eprintln!(
        "\n######################################################################\n\
         # SKIPPED: {what}\n\
         # NOT TESTED. Build the artifacts first:\n\
         #   wsl -d Ubuntu -- bash scripts/m21-plain-vs-cargo-near.sh\n\
         ######################################################################\n"
    );
}

/// Deploy `wasm`, initialise it, then trigger a reason-code panic and return
/// the failure text exactly as a caller would observe it.
///
/// The panic used is `add_node` with an empty label, which the contract
/// rejects via `fail(ReasonCode::InvalidConfig, ..)` -- a plain `env::panic_str`
/// with no promise involved, so nothing but the panic path is under test.
async fn panic_text_from(wasm_name: &str) -> Result<Option<String>> {
    let path = res(wasm_name);
    if !path.exists() {
        return Ok(None);
    }
    let worker = near_workspaces::sandbox().await?;
    let vault = worker.dev_deploy(&std::fs::read(&path)?).await?;
    let owner = worker.dev_create_account().await?;

    vault
        .call("new")
        .args_json(json!({ "owner": owner.id(), "network": "sandbox", "strict_allocation": false }))
        .transact()
        .await?
        .into_result()?;

    let out = owner
        .call(vault.id(), "add_node")
        .args_json(json!({
            "parent": serde_json::Value::Null,
            "label": "",                       // rejected: 1..=48 chars
            "limits": [{ "token": "ft.test.near", "daily_cap": "1", "per_tx_cap": "1" }],
            "cooldown_sec": 0,
            "recipients": serde_json::Value::Null,
        }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?;

    assert!(out.is_failure(), "{wasm_name}: an empty label must be rejected");
    Ok(Some(format!("{:?}", out.failures())))
}

/// The artifact we actually ship keeps its reason codes. This duplicates the
/// existing sandbox assertion on purpose: it is the control for the row below,
/// and a control that lives in another file can be changed without anyone
/// noticing the pair came apart.
#[tokio::test]
async fn cargo_near_build_keeps_the_reason_code() -> Result<()> {
    let Some(text) = panic_text_from("vault_cargo_near.wasm").await? else {
        skip("cargo_near_build_keeps_the_reason_code (res/m21/vault_cargo_near.wasm absent)");
        return Ok(());
    };
    println!("--- cargo-near build failure text ---\n{text}\n");
    assert!(
        text.contains("INVALID_CONFIG"),
        "the reason code did not survive the cargo-near build. Got: {text}"
    );
    assert!(
        !text.contains("unreachable"),
        "the cargo-near build produced an opaque trap. Got: {text}"
    );
    Ok(())
}

/// THE DECISIVE ROW. Same source, same profile, same toolchain, same panic --
/// only the build command differs.
///
/// Deliberately written to REPORT rather than to assume: it asserts only that
/// the two artifacts behave DIFFERENTLY, and prints which way. Had it asserted
/// "the plain build loses the message" it would have encoded the claim under
/// test as its own premise, and a passing run would have proved nothing about
/// which of the repo's two contradictory statements was right.
#[tokio::test]
async fn the_build_command_decides_whether_reason_codes_survive() -> Result<()> {
    let (Some(plain), Some(correct)) = (
        panic_text_from("vault_plain.wasm").await?,
        panic_text_from("vault_cargo_near.wasm").await?,
    ) else {
        skip("the_build_command_decides_whether_reason_codes_survive (both artifacts needed)");
        return Ok(());
    };

    let plain_has_code = plain.contains("INVALID_CONFIG");
    let plain_has_trap = plain.contains("unreachable");
    let correct_has_code = correct.contains("INVALID_CONFIG");

    println!("=== plain `cargo build --target wasm32-unknown-unknown` ===");
    println!("{plain}");
    println!("    reason code present : {plain_has_code}");
    println!("    opaque trap present : {plain_has_trap}");
    println!("=== `cargo near build` ===");
    println!("    reason code present : {correct_has_code}");

    assert!(correct_has_code, "the control regressed; investigate that before this row");

    if plain_has_code {
        println!(
            "\nVERDICT: the plain build ALSO reports the reason code. The claim that a \
             plain build destroys panic messages is NOT reproducible on near-sdk 5.29.1 \
             with this profile. c732cbe is right; the Cargo.toml comment and M21 are stale."
        );
    } else {
        println!(
            "\nVERDICT: the plain build LOSES the reason code (opaque trap: {plain_has_trap}). \
             The Cargo.toml comment and M21 are right; c732cbe's import-count check was \
             measuring the wrong thing."
        );
    }

    assert_ne!(
        plain_has_code, correct_has_code,
        "both builds behave IDENTICALLY on the panic path, so the build command is not \
         what decides reason-code survival. Whichever doc claims it does is wrong."
    );
    Ok(())
}
