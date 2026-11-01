//! The Float vault factory.
//!
//! Exists so a BROWSER WALLET can create a vault by signing one plain
//! `FunctionCall` — the most ordinary transaction on NEAR, which every wallet
//! has handled since day one. The alternative was a transaction carrying
//! `CreateAccount` + `UseGlobalContract` + `FunctionCall` directly, which
//! requires the wallet to serialise a NEP-591 action type; `near-api-js` 7.4.0
//! has it, wallet-selector's `Action` is an alias for that union so it type
//! checks, but nothing proves a given wallet's own transaction builder handles
//! it, and a failure there is invisible until a user clicks sign.
//!
//! See `docs/DESIGN-browser-signing-flow.md`.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId};

/// The vault account id this factory would create for `owner`.
///
/// Deterministic, and that is the point: the dashboard computes the same id
/// client-side with no registry and no database, which is what lets the whole
/// product avoid a backend. NEAR has no RPC to enumerate an account's
/// sub-accounts, so without a deterministic rule "show me my vault" would need
/// stored state.
///
/// Dots become hyphens so the mapping is INJECTIVE over accounts that contain
/// a dot: `alice.near` -> `alice-near`, not `alice`, because `alice.near` and
/// `alice.testnet` and `alice.pool.near` would all collapse to `alice`.
pub fn derive_prefix(owner: &str) -> String {
    owner.replace('.', "-")
}

/// The full vault account id, or `None` if it would not be a legal account.
///
/// Returns an `Option` rather than panicking because this is also a view the
/// dashboard calls: "can this owner have a derived vault" is a question, not an
/// error. The create path turns `None` into a refusal before taking a deposit.
pub fn vault_id(owner: &str, factory: &str) -> Option<AccountId> {
    // `parse` is the ENTIRE validation, deliberately. It enforces NEAR's
    // account-id grammar *and* the 64-character cap.
    //
    // There was an explicit `if candidate.len() > 64 { return None }` here
    // first. A mutation replacing its condition with `false` broke NOTHING —
    // the 64-character-owner test stayed green, because `parse` had already
    // rejected the 75-character id. The guard was dead code and its test was
    // describing a hole rather than closing one, so it is gone.
    format!("{}.{}", derive_prefix(owner), factory).parse().ok()
}

#[near(contract_state)]
pub struct Factory {
    owner: AccountId,
    vaults: LookupMap<AccountId, AccountId>,
}

impl Default for Factory {
    fn default() -> Self {
        env::panic_str("NOT_INITIALIZED")
    }
}

#[cfg(test)]
mod tests;
