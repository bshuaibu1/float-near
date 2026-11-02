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

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8};
use near_sdk::{env, near, AccountId, CryptoHash, Gas, NearToken, Promise};

/// Enough for the vault's `new`, which writes the root node and config.
const GAS_FOR_VAULT_NEW: Gas = Gas::from_tgas(30);
/// Enough for the refund callback, which at most makes one transfer.
const GAS_FOR_REFUND: Gas = Gas::from_tgas(10);

/// The vault account id this factory would create for `owner`.
///
/// Deterministic, and that is the point: the dashboard computes the same id
/// client-side with no registry and no database, which is what lets the whole
/// product avoid a backend. NEAR has no RPC to enumerate an account's
/// sub-accounts, so without a deterministic rule "show me my vault" would need
/// stored state.
///
/// Dots become hyphens rather than being truncated at: `alice.near` ->
/// `alice-near`, not `alice`, because `alice.near` and `alice.testnet` and
/// `alice.pool.near` would all collapse to `alice`.
///
/// THIS IS NOT INJECTIVE, and said so here for a while. `replace('.', "-")`
/// merges the dot into an alphabet that already holds the hyphen, so
/// `a.b.testnet` and `a-b.testnet` both land on `a-b-testnet` and whoever
/// creates first denies the other. The test that claimed to cover injectivity
/// asserted a single mapping, which proves nothing about it.
///
/// It is not fixable while ids stay human-readable: NEAR forbids consecutive
/// separators, so no escape sequence is available, and the only injective
/// alternative is a hash prefix that gives up readability. Bounded and
/// recorded — see `derive_prefix_collides_between_a_dot_and_a_hyphen`.
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

/// The `new` arguments, built once so both creation paths produce an identical
/// vault. The root limits and recipients are forwarded verbatim from the
/// caller: a root with no limits holds no budget, and a root with no recipients
/// refuses every payment NO_RECIPIENTS_SET.
fn new_args(
    owner: &AccountId,
    network: &str,
    root_limits: near_sdk::serde_json::Value,
    root_recipients: near_sdk::serde_json::Value,
) -> Vec<u8> {
    near_sdk::serde_json::json!({
        "owner": owner,
        "network": network,
        "strict_allocation": false,
        "root_limits": root_limits,
        "root_recipients": root_recipients,
    })
    .to_string()
    .into_bytes()
}

/// Everything a client needs to build a create call, in one read.
///
/// `vault_id_for` answers WHERE a vault goes. This answers WHAT to attach and
/// WHETHER creation is open at all — the other half of the question, which a
/// caller previously had to guess. Guessing low is not a clean failure:
/// `CreateAccount` succeeds and the vault lands under its own storage
/// requirement, bricking on the next write.
///
/// Every field is already public in contract state; this exposes no secret, it
/// just saves a client from parsing the trie.
#[near(serializers = [json])]
pub struct FactoryConfig {
    pub owner: AccountId,
    pub code_hash: Base58CryptoHash,
    pub network: String,
    pub required_deposit: NearToken,
    pub paused: bool,
}

/// NO REGISTRY, DELIBERATELY. An `owner -> vault` map was scaffolded here and
/// removed: the id is derivable, so a map would be redundant state whose
/// storage the FACTORY pays for and which grows with every vault created. The
/// derivation is the single source of truth, shared by the contract and the
/// dashboard.
#[near(contract_state)]
pub struct Factory {
    owner: AccountId,
    /// The global contract every new vault references. 32 raw bytes, which is
    /// what `Promise::use_global_contract` takes.
    code_hash: CryptoHash,
    /// Passed through to the vault's `new` — "mainnet" / "testnet".
    network: String,
    /// What a caller must attach to cover the new vault's storage.
    required_deposit: NearToken,
    paused: bool,
}

impl Default for Factory {
    fn default() -> Self {
        env::panic_str("NOT_INITIALIZED")
    }
}

#[near]
impl Factory {
    #[init]
    pub fn new(
        owner: AccountId,
        code_hash: Base58CryptoHash,
        network: String,
        required_deposit: NearToken,
    ) -> Self {
        Self { owner, code_hash: code_hash.into(), network, required_deposit, paused: false }
    }

    /// Owner methods take 1 yoctoNEAR, matching the vault: a NEAR
    /// function-call access key cannot attach a deposit, so these are reachable
    /// only with a full-access key — a wallet confirmation — and never with a
    /// restricted key an agent might hold.
    fn assert_owner(&self) {
        near_sdk::assert_one_yocto();
        if env::predecessor_account_id() != self.owner {
            env::panic_str("OWNER_ONLY: only the factory owner may do that");
        }
    }

    /// Create a vault whose code is PASSED IN rather than referenced globally.
    ///
    /// WHY THIS EXISTS. A wallet refuses a `DeployContract` ACTION requested by
    /// a dApp — measured in Meteor 2026-11-01, Approve greyed out, no override,
    /// and the policy is blanket even when the target is a new sub-account. It
    /// has no such policy about an ordinary method call. So the browser sends
    /// the contract as an ARGUMENT, and the deploy happens in here where no
    /// wallet policy reaches.
    ///
    /// Costs computed from the protocol fee table before building this: 3.0
    /// TGas to deliver 401,380 B of base64 args, ~31 for the batch, ~74 total
    /// against 300 attachable. Size is 25.5% of `max_transaction_size`.
    ///
    /// The trade against `create_vault`: each vault stores its own copy of the
    /// code, ~3.0 NEAR of stake, instead of a 214-byte reference. That is the
    /// price of not needing a published global contract, and it is refundable.
    #[payable]
    pub fn create_vault_with_code(
        &mut self,
        code: Base64VecU8,
        label: Option<String>,
        root_limits: near_sdk::serde_json::Value,
        root_recipients: near_sdk::serde_json::Value,
    ) -> Promise {
        let bytes = code.0.len();
        if bytes == 0 {
            // DeployContract with zero bytes succeeds, and `new` then fails
            // MethodNotFound — the batch reverts and the caller is refunded.
            // Correct, but it burns a round trip and reads like a contract bug.
            env::panic_str("NO_CODE: the contract code argument is empty");
        }
        // THE FLOOR SCALES WITH THE CODE, and only the argument knows its size.
        // `create_vault`'s floor is fixed because a global reference costs a
        // flat 214 bytes whatever the contract's size; here the whole artifact
        // lands on the new account. Underfund it and CreateAccount succeeds
        // while the account sits below its own storage requirement —
        // LackBalanceForState on the next write, a bricked vault rather than a
        // failed call.
        let need = self
            .required_deposit
            .saturating_add(NearToken::from_yoctonear(bytes as u128 * 10u128.pow(19)));
        let (owner, vault) = self.begin(&label, need);
        let deposit = env::attached_deposit();
        Promise::new(vault.clone())
            .create_account()
            .transfer(deposit)
            .deploy_contract(code.0)
            // THE VAULT NEEDS A SIGNER OF ITS OWN. See `create_vault`.
            .add_full_access_key(env::signer_account_pk())
            .function_call(
                "new".to_string(),
                new_args(&owner, &self.network, root_limits, root_recipients),
                NearToken::from_yoctonear(0),
                GAS_FOR_VAULT_NEW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_REFUND)
                    .on_vault_created(owner, vault, deposit),
            )
    }

    /// The checks both creation paths share, and the vault id they agree on.
    ///
    /// `need` differs between them — fixed for a global reference, scaled by
    /// the code size when the code is deployed — so it is a parameter rather
    /// than read from state. Everything else is identical, and duplicating it
    /// is how one path quietly loses the kill switch.
    fn begin(&self, label: &Option<String>, need: NearToken) -> (AccountId, AccountId) {
        if self.paused {
            env::panic_str("PAUSED: vault creation is disabled");
        }
        if env::attached_deposit() < need {
            env::panic_str("DEPOSIT_TOO_SMALL: attach at least the required deposit");
        }
        let owner = env::predecessor_account_id();
        match self.resolve_vault(&owner, label) {
            Some(v) => (owner, v),
            None => env::panic_str("BAD_VAULT_ID: that owner has no legal derived vault id"),
        }
    }

    /// The vault id this caller may ask for, labelled or not.
    ///
    /// A LABEL IS ROOTED IN THE CALLER'S OWN PREFIX, and restricted to
    /// `[a-z0-9]`. Both halves are load-bearing.
    ///
    /// It used to be interpolated verbatim — `format!("{}.{}", label, factory)`
    /// — which made it a universal squatting tool: any caller could pass
    /// `bob-near` and create a vault at exactly the id `bob.near` derives, with
    /// themselves as owner. Since the whole no-backend design resolves a user's
    /// vault BY DERIVATION (that is what `vault_id_for` is for), the victim
    /// would be shown an attacker-owned vault at their own address. Proven in
    /// `a_label_cannot_take_another_users_derived_vault_id`.
    ///
    /// Rooting alone is not enough, hence the charset. A label may not contain
    /// a separator, because `alice.near` labelling itself `near-bob-near` would
    /// rebuild `alice-near-bob-near` and reach outside its namespace again if an
    /// account named `alice-near-bob` existed.
    ///
    /// RESIDUAL, stated rather than papered over: a caller can still reach the
    /// derived prefix of an account whose id is literally
    /// `<their-prefix>-<label>` as a TOP-LEVEL account. Mainnet TLAs are
    /// registrar-gated and long, so this is contrived rather than reachable, but
    /// it is not zero. Closing it completely means not trusting derivation for
    /// identity at all — storing `owner -> vault` in factory state and having
    /// the dashboard read that instead.
    fn resolve_vault(&self, owner: &AccountId, label: &Option<String>) -> Option<AccountId> {
        let factory = env::current_account_id();
        match label {
            None => vault_id(owner.as_str(), factory.as_str()),
            Some(l) => {
                let ok = !l.is_empty()
                    && l.len() <= 16
                    && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
                if !ok {
                    env::panic_str("BAD_LABEL: a label must be 1-16 characters of a-z or 0-9");
                }
                format!("{}-{}.{}", derive_prefix(owner.as_str()), l, factory)
                    .parse()
                    .ok()
            }
        }
    }

    /// Create a vault for the CALLER, referencing a published global contract.
    ///
    /// The owner is `predecessor_account_id()` and is never a parameter. Taking
    /// it as an argument would let anyone create a vault owned by someone else
    /// — harmless on its own, but it would let an attacker squat the derived id
    /// of an account they do not control, permanently denying that user the
    /// vault the dashboard will look for.
    #[payable]
    pub fn create_vault(
        &mut self,
        label: Option<String>,
        root_limits: near_sdk::serde_json::Value,
        root_recipients: near_sdk::serde_json::Value,
    ) -> Promise {
        // `begin`, NOT a second copy of its checks. This path used to duplicate
        // the pause gate, the deposit gate and the label handling inline —
        // which is precisely the drift `begin`'s own doc comment warns about,
        // and it is how the label fix would have landed on one path only. The
        // floor stays a parameter because it differs: fixed here (a global
        // reference costs a flat 214 bytes) and scaled by the code argument in
        // `create_vault_with_code`.
        let deposit = env::attached_deposit();
        let (owner, vault) = self.begin(&label, self.required_deposit);

        // ONE BATCH, so a partial create is impossible: if `new` panics, NEAR
        // reverts the account creation with it rather than leaving an
        // uninitialised account holding the deposit.
        //
        // NOTE: `new` is reachable here only because the vault accepts
        // initialization by its PARENT. A factory holds no key, so it cannot
        // sign as the vault the way create-float does with a setup key.
        Promise::new(vault.clone())
            .create_account()
            .transfer(deposit)
            .use_global_contract(self.code_hash)
            // THE VAULT NEEDS A SIGNER OF ITS OWN, or its gas keys become a
            // trap. Agents are gas keys ON THE VAULT now that sub-accounts are
            // retired, and while near-sdk can ADD and FUND a gas key from
            // inside the contract, there is NO withdraw host function at any
            // near-sys version (0.2.14, 0.3.0, 0.4.0 all expose exactly three
            // gas-key actions, none of which takes money out).
            // `WithdrawFromGasKey` exists in the protocol but only as an
            // ACCOUNT-SIGNED action — so a vault with zero keys could fund gas
            // keys and never reclaim them. That is the `create_agent_account`
            // stranding bug relocated, which is precisely what retiring
            // sub-accounts was meant to end.
            //
            // `signer_account_pk()` rather than a parameter: a parameter could
            // be set to anybody's key, while the signer's key provably
            // authorised this very call. It is also provably FULL-ACCESS,
            // because this method takes a deposit and NEAR forbids
            // function-call keys from attaching one.
            //
            // The capability delta is close to zero. The owner already has an
            // uncapped `withdraw` and can rewrite every cap in the tree, so a
            // key that can also redeploy grants them little they could not
            // already do — and a stolen owner key could drain the vault
            // through `withdraw` regardless.
            .add_full_access_key(env::signer_account_pk())
            .function_call(
                "new".to_string(),
                // ROOT LIMITS AND RECIPIENTS ARE PASSED HERE, not added later.
                //
                // `new` used to leave the vault with zero nodes, and this
                // factory only calls `new` — one browser signature, no
                // follow-up, and it cannot call `add_node` because that is
                // owner-only and the factory is not the owner. So every
                // factory-created vault had nothing to spend against. Found by
                // deploying the REAL vault on testnet; the 33-byte stub used in
                // the factory's own run could not reveal it, because that
                // stub's `new` does nothing.
                //
                // The recipients matter as much as the caps: a root with
                // `None` means "inherit from the nearest ancestor", the root
                // has none, and every payment comes back NO_RECIPIENTS_SET.
                near_sdk::serde_json::json!({
                    "owner": owner,
                    "network": self.network,
                    "strict_allocation": false,
                    "root_limits": root_limits,
                    "root_recipients": root_recipients,
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FOR_VAULT_NEW,
            )
            // WITHOUT THIS THE USER LOSES THEIR DEPOSIT ON FAILURE. The
            // deposit arrives in the FACTORY's balance, and a failed batch
            // returns the transferred amount to the factory — not to the
            // caller. Nothing refunds them automatically.
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_REFUND)
                    .on_vault_created(owner, vault, deposit),
            )
    }

    /// `#[payable]` IS REQUIRED, and unit tests cannot show it.
    ///
    /// `assert_owner` calls `assert_one_yocto`, so these methods must RECEIVE
    /// one yocto — but near-sdk rejects any deposit to a method not marked
    /// `#[payable]`, in the generated `extern "C"` wrapper, before the body
    /// runs. The two together made every owner method unreachable:
    /// "Method set_code_hash doesn't accept deposit".
    ///
    /// Every unit test passed, because they call the Rust method directly and
    /// never go through the wrapper that enforces this. Only a real deploy
    /// could find it — which is exactly what scripts/validate-factory-testnet
    /// is for, and it found it on the first run that got this far.
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    /// Repoint NEW vaults at a different global contract. Existing vaults are
    /// untouched — that is the `CodeHash` property we chose deliberately, so
    /// nobody is upgraded without opting in.
    #[payable]
    pub fn set_code_hash(&mut self, code_hash: Base58CryptoHash) {
        self.assert_owner();
        self.code_hash = code_hash.into();
    }

    #[payable]
    pub fn set_required_deposit(&mut self, required_deposit: NearToken) {
        self.assert_owner();
        self.required_deposit = required_deposit;
    }

    /// The id this factory would create for `owner`. The dashboard calls this
    /// so the derivation has ONE implementation, rather than a client-side copy
    /// that can drift from the contract's.
    pub fn vault_id_for(&self, owner: AccountId) -> Option<AccountId> {
        vault_id(owner.as_str(), env::current_account_id().as_str())
    }

    /// The configuration a client needs to build a create call. See
    /// [`FactoryConfig`].
    pub fn get_config(&self) -> FactoryConfig {
        FactoryConfig {
            owner: self.owner.clone(),
            code_hash: self.code_hash.into(),
            network: self.network.clone(),
            required_deposit: self.required_deposit,
            paused: self.paused,
        }
    }

    /// Refund the caller if the batch failed. Returns whether it succeeded.
    ///
    /// `#[private]`, so only the factory itself can call it — otherwise anyone
    /// could invoke it with an arbitrary `deposit` and drain the factory.
    #[private]
    pub fn on_vault_created(
        &mut self,
        owner: AccountId,
        vault: AccountId,
        deposit: NearToken,
    ) -> bool {
        // `promise_result_checked`, not the deprecated `promise_result`, which
        // reads the whole result into memory and can run out of gas on a large
        // one. The vault's `new` returns nothing, so 0 bytes is the real bound
        // and anything longer means something unexpected happened — which is a
        // failure for refund purposes either way.
        let ok = env::promise_result_checked(0, 0).is_ok();
        if ok {
            env::log_str(&format!("VAULT_CREATED:{}:{}", vault, owner));
            return true;
        }
        // The batch reverted, so the transfer came back to the FACTORY, not to
        // the caller. Send it on, or the user has paid for nothing.
        env::log_str(&format!("VAULT_FAILED:{}:{} refunding", vault, owner));
        // THE DROP IS THE MECHANISM, not a discarded value. near-sdk's
        // `impl Drop for Promise` calls `construct_recursively` (promise.rs:954),
        // so letting this binding fall out of scope is what schedules the
        // transfer. Checked, because if dropping did nothing the refund would
        // silently never happen and the compiler's `must_use` would have been
        // the only warning.
        let _refund = Promise::new(owner).transfer(deposit);
        false
    }
}

#[cfg(test)]
mod tests;
