//! Hierarchical on-chain spending budgets for AI agent treasuries.
//!
//! A parent budget allocates sub-budgets to child agents. Every cumulative
//! limit is enforced inside the contract before any value leaves it, so the
//! limits hold exactly under concurrent requests: NEAR executes receipts
//! targeting the same account sequentially, so request N+1 reads the ledger
//! after request N committed to it. There is no read-then-increment window.
//!
//! Unaudited hackathon prototype. Testnet only.

pub mod types;

mod evm;

#[cfg(test)]
mod tests;

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, AccountId, Allowance, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};

pub use crate::types::*;

pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
pub const GAS_FOR_TRANSFER_CALLBACK: Gas = Gas::from_tgas(10);
/// Checked up front so a call cannot reserve budget and then run out of gas
/// part-way through dispatch.
pub const MIN_GAS_FOR_DISPATCH: Gas = Gas::from_tgas(50);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// `ft_transfer` returns nothing; anything longer is an unexpected token.
const MAX_PROMISE_RESULT_LEN: usize = 256;
/// An MPC signature response is a small struct (big_r, s, recovery_id); this
/// bounds what the signature callback will copy, for the same out-of-gas
/// reason as MAX_PROMISE_RESULT_LEN.
const MAX_MPC_RESULT_LEN: usize = 1024;

pub const PRODUCTION_DAY_NS: u64 = 86_400 * NS_PER_SEC;

/// Floor for the agent account's own storage staking, on top of whatever gas
/// allowance the owner grants its key.
pub const AGENT_ACCOUNT_STORAGE: NearToken = NearToken::from_millinear(50);
/// Lower bound on a usable key allowance.
///
/// MEASURED, not guessed: an earlier version hardcoded 0.05 NEAR and the key
/// was dead on arrival — `NotEnoughBalance { balance: 0.2 NEAR, cost: 1.0009
/// NEAR }`. NEAR reserves the FULL prepaid gas against the signer up front and
/// refunds the unused part afterwards, so a 300 Tgas call needs ~1 NEAR of
/// headroom even though it burns a small fraction of that. An allowance sized
/// to expected burn rather than to prepaid gas produces a key that cannot
/// transact at all.
pub const MIN_AGENT_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(500);
/// The ONLY method an agent key may call. Anything added here widens the
/// agent's authority, so it is a single const rather than a parameter.
pub const AGENT_ALLOWED_METHOD: &str = "request_payment";
pub const GAS_FOR_CREATE_CALLBACK: Gas = Gas::from_tgas(10);

/// Gas for the MPC sign call.
///
/// MEASURED, not guessed: v1.signer-prod.testnet's own `config` reports
/// `sign_call_gas_attachment_requirement_tera_gas: 15`, and a live sign call
/// at 100 Tgas returned a real secp256k1 signature. 100 keeps a wide margin
/// over the stated requirement while leaving room under NEAR's 300 Tgas cap —
/// an under-funded sign call that runs out of gas never returns to the
/// callback, which would leave the reservation held at every level.
pub const GAS_FOR_MPC_SIGN: Gas = Gas::from_tgas(100);
pub const GAS_FOR_SIGNATURE_CALLBACK: Gas = Gas::from_tgas(10);
/// The Base rail demands more prepaid gas than the NEAR rail. Checked BEFORE
/// anything is charged.
pub const MIN_GAS_FOR_BASE_DISPATCH: Gas = Gas::from_tgas(130);
/// Upper bound on a single purge sweep, so one call cannot exhaust gas
/// part-way and leave an unpredictable amount of work done.
pub const MAX_PURGE_LIMIT: u32 = 100;
/// Minimum age before a pending reservation may be swept.
///
/// A NEAR receipt chain settles in seconds, so an hour is far outside any
/// legitimate in-flight window. It is a CONSTANT and not a parameter on
/// purpose: an owner who could pass zero could sweep a live reservation whose
/// callback is about to land.
pub const MIN_SWEEP_AGE_NS: u64 = 3_600 * NS_PER_SEC;
pub const MAX_SUB_LABEL_LEN: usize = 32;
pub const MAX_ACCOUNT_ID_LEN: usize = 64;

/// The `sign` entry point of the Chain Signatures MPC contract.
#[ext_contract(ext_mpc)]
#[allow(dead_code)]
trait MpcSigner {
    fn sign(&mut self, request: SignRequest) -> near_sdk::Promise;
}

/// What `v1.signer-prod.testnet` actually expects, read off its embedded ABI
/// and confirmed by a live `sign` call on 2026-10-26.
///
/// The older `{payload: [u8;32], key_version}` shape still deserialises there
/// via a documented backward-compatible alias, but it is DEPRECATED. This uses
/// the current field names so the rail does not depend on a compatibility path
/// that may be dropped.
///
/// `payload_v2` is the 32-byte hash as hex — and the whole design hinges on the
/// vault computing that hash itself rather than accepting one.
#[near(serializers = [json])]
pub struct SignRequest {
    pub payload_v2: Payload,
    pub path: String,
    pub domain_id: u64,
}

/// Externally tagged, which serialises to `{"Ecdsa": "<64 hex>"}`.
///
/// Only the ECDSA arm exists here: Base verifies secp256k1, and the signer's
/// Eddsa arm would return a signature no EVM chain can check.
#[near(serializers = [json])]
pub enum Payload {
    Ecdsa(String),
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleTokenCore {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Nodes,
    Ledgers,
    LastPaid,
    AccountToNode,
    Requests,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    network: String,
    paused: bool,
    /// true  = enforce I1 (sum of child caps <= parent cap)
    /// false = overcommit: children contend for a shared parent pool.
    ///         This is the case that races, and the case under test.
    strict_allocation: bool,
    /// `None` means the Base rail is CLOSED. Default on a fresh deploy, so the
    /// vault cannot sign a cross-chain transaction until the owner opens the
    /// rail and names the token contract it is allowed to call.
    base_config: Option<BaseConfig>,

    nodes: LookupMap<NodeId, Node>,
    /// Bounded by MAX_NODES so `get_tree` stays a single view call.
    node_order: Vec<NodeId>,
    account_to_node: LookupMap<AccountId, NodeId>,
    next_node_id: NodeId,

    /// THE hot-path map. (node, token, utc_day) -> {executed, pending}.
    /// The `node` dimension is the hierarchy; collapsing this key to
    /// (token, day) turns this contract into a single-pool vault.
    ledgers: LookupMap<(NodeId, AccountId, u64), DailyLedger>,

    last_paid_ns: LookupMap<NodeId, u64>,
    requests: IterableMap<String, PaymentRequest>,

    #[cfg(feature = "test-clock")]
    day_len_ns_override: u64,
}

#[near]
impl Vault {
    /// Must be called by the vault account itself, ideally in the same
    /// transaction as the deploy, so nobody else can initialize a freshly
    /// deployed vault with their own owner.
    #[init]
    pub fn new(owner: AccountId, network: String, strict_allocation: bool) -> Self {
        let vault_id = env::current_account_id();
        if env::predecessor_account_id() != vault_id {
            fail(ReasonCode::InitNotSelf, "initialize from the vault account");
        }
        if owner == vault_id {
            fail(ReasonCode::InvalidConfig, "owner must not be the vault");
        }
        if network.is_empty()
            || network.len() > 32
            || !network
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            fail(ReasonCode::InvalidConfig, "network must be 1-32 chars of [a-z0-9-]");
        }

        Self {
            owner,
            network,
            paused: false,
            strict_allocation,
            base_config: None,
            nodes: LookupMap::new(StorageKey::Nodes),
            node_order: Vec::new(),
            account_to_node: LookupMap::new(StorageKey::AccountToNode),
            next_node_id: ROOT_NODE,
            ledgers: LookupMap::new(StorageKey::Ledgers),
            last_paid_ns: LookupMap::new(StorageKey::LastPaid),
            requests: IterableMap::new(StorageKey::Requests),
            #[cfg(feature = "test-clock")]
            day_len_ns_override: PRODUCTION_DAY_NS,
        }
    }

    // ------------------------------------------------------- owner methods
    //
    // All owner methods require exactly 1 yoctoNEAR. A NEAR function-call
    // access key cannot attach a deposit, so these are reachable only with a
    // full-access key (a wallet confirmation) and never with an agent's
    // restricted key.

    #[payable]
    pub fn add_node(
        &mut self,
        parent: Option<NodeId>,
        label: String,
        limits: Vec<TokenLimit>,
        cooldown_sec: u32,
        recipients: Option<Vec<AccountId>>,
    ) -> NodeId {
        self.assert_owner();
        if self.node_order.len() as u32 >= MAX_NODES {
            fail(ReasonCode::MaxNodes, "node limit reached");
        }
        if label.is_empty() || label.len() > MAX_LABEL_LEN {
            fail(ReasonCode::InvalidConfig, "label must be 1..=48 chars");
        }
        if cooldown_sec > MAX_COOLDOWN_SEC {
            fail(ReasonCode::InvalidConfig, "cooldown too long");
        }
        validate_limits(&limits);
        validate_recipients(&recipients);

        // Ancestor chain is computed ONCE here and never mutated, which is
        // what lets the hot path walk a fixed-length array.
        let path: Vec<NodeId> = match parent {
            None => {
                if !self.node_order.is_empty() {
                    fail(ReasonCode::InvalidConfig, "root already exists");
                }
                Vec::new()
            }
            Some(pid) => {
                let p = self
                    .nodes
                    .get(&pid)
                    .cloned()
                    .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such parent"));
                if p.path.len() + 1 >= MAX_DEPTH {
                    fail(ReasonCode::MaxDepth, "tree is at maximum depth");
                }
                if p.child_count >= MAX_CHILDREN {
                    fail(ReasonCode::MaxChildren, "parent has too many children");
                }
                if self.strict_allocation {
                    for l in &limits {
                        let new_sum = p.child_sum_for(&l.token).saturating_add(l.daily_cap.0);
                        let parent_cap =
                            p.limit_for(&l.token).map(|x| x.daily_cap.0).unwrap_or(0);
                        if new_sum > parent_cap {
                            fail(
                                ReasonCode::InvalidAllocation,
                                "sum of child caps would exceed the parent cap",
                            );
                        }
                    }
                }
                let mut path = p.path.clone();
                path.push(pid);
                path
            }
        };

        let id = self.next_node_id;
        self.next_node_id += 1;

        let child_cap_sum: Vec<(AccountId, U128)> =
            limits.iter().map(|l| (l.token.clone(), U128(0))).collect();

        self.nodes.insert(
            id,
            Node {
                id,
                parent,
                path,
                label,
                account: None,
                limits: limits.clone(),
                child_cap_sum,
                child_count: 0,
                cooldown_sec,
                frozen: false,
                recipients,
            },
        );
        self.node_order.push(id);

        if let Some(pid) = parent {
            for l in &limits {
                self.bump_child_sum(pid, &l.token, 0, l.daily_cap.0);
            }
            if let Some(p) = self.nodes.get_mut(&pid) {
                p.child_count += 1;
            }
        }
        id
    }

    /// Strict mode re-checks containment in BOTH directions: a node may not
    /// rise above what its parent can cover, and may not fall below what it
    /// has already allocated to its own children.
    #[payable]
    pub fn set_node_caps(&mut self, node_id: NodeId, limits: Vec<TokenLimit>) {
        self.assert_owner();
        validate_limits(&limits);
        let node = self
            .nodes
            .get(&node_id)
            .cloned()
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such node"));

        if self.strict_allocation {
            // Downward: must still cover existing child allocations.
            for l in &limits {
                if l.daily_cap.0 < node.child_sum_for(&l.token) {
                    fail(
                        ReasonCode::InvalidAllocation,
                        "cap is below the sum already allocated to children",
                    );
                }
            }
            // Upward: must still fit inside the parent.
            if let Some(pid) = node.parent {
                let p = self
                    .nodes
                    .get(&pid)
                    .cloned()
                    .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such parent"));
                for l in &limits {
                    let old = node.limit_for(&l.token).map(|x| x.daily_cap.0).unwrap_or(0);
                    let new_sum = p
                        .child_sum_for(&l.token)
                        .saturating_sub(old)
                        .saturating_add(l.daily_cap.0);
                    let parent_cap = p.limit_for(&l.token).map(|x| x.daily_cap.0).unwrap_or(0);
                    if new_sum > parent_cap {
                        fail(
                            ReasonCode::InvalidAllocation,
                            "sum of child caps would exceed the parent cap",
                        );
                    }
                }
            }
        }

        if let Some(pid) = node.parent {
            for l in &limits {
                let old = node.limit_for(&l.token).map(|x| x.daily_cap.0).unwrap_or(0);
                self.bump_child_sum(pid, &l.token, old, l.daily_cap.0);
            }
        }
        if let Some(n) = self.nodes.get_mut(&node_id) {
            n.limits = limits;
        }
    }

    #[payable]
    pub fn bind_agent(&mut self, node_id: NodeId, account_id: AccountId) {
        self.assert_owner();
        self.do_bind(node_id, account_id);
    }

    /// Creates `<sub_label>.<vault>` and gives it ONE function-call access key
    /// pinned to this vault and to `request_payment` alone, then binds it to
    /// `node_id` once the account actually exists.
    ///
    /// The authority this grants is the whole security story, so it is worth
    /// stating exactly what the resulting key can and cannot do:
    ///
    /// - `receiver_id` is this vault, so the key cannot call ANY other
    ///   contract — including the token itself. That matters: a key that could
    ///   call `ft_transfer` directly would hold the vault's own transfer
    ///   authority and every budget check would be moot.
    /// - `method_names` is exactly `["request_payment"]`, so it cannot reach
    ///   owner methods.
    /// - a NEAR function-call key cannot attach a deposit at all, so it cannot
    ///   move NEAR directly. Every movement of value is contract logic.
    ///
    /// Owner-gated by requiring a deposit rather than by `assert_one_yocto`:
    /// the deposit funds the new account, and requiring one is just as
    /// effective at excluding a function-call key, which cannot attach any.
    #[payable]
    pub fn create_agent_account(
        &mut self,
        node_id: NodeId,
        sub_label: String,
        public_key: PublicKey,
        key_allowance: NearToken,
    ) -> Promise {
        if env::predecessor_account_id() != self.owner {
            fail(ReasonCode::NotOwner, "owner only");
        }
        if key_allowance < MIN_AGENT_KEY_ALLOWANCE {
            fail(
                ReasonCode::InvalidConfig,
                "key_allowance below the usable floor (see MIN_AGENT_KEY_ALLOWANCE)",
            );
        }
        let required = key_allowance.saturating_add(AGENT_ACCOUNT_STORAGE);
        let deposit = env::attached_deposit();
        if deposit < required {
            fail(
                ReasonCode::InvalidConfig,
                "deposit must cover key_allowance plus account storage",
            );
        }
        if sub_label.is_empty()
            || sub_label.len() > MAX_SUB_LABEL_LEN
            || !sub_label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
        {
            fail(ReasonCode::InvalidConfig, "sub_label must be 1..=32 chars of [a-z0-9-_]");
        }

        let vault_id = env::current_account_id();
        let sub_id = format!("{sub_label}.{vault_id}");
        if sub_id.len() > MAX_ACCOUNT_ID_LEN {
            fail(ReasonCode::InvalidConfig, "resulting account id is too long");
        }
        let sub: AccountId = sub_id
            .parse()
            .unwrap_or_else(|_| fail(ReasonCode::InvalidConfig, "invalid account id"));

        // Validate the binding BEFORE creating anything, so a rejected bind
        // cannot leave an orphaned funded account behind.
        self.assert_bindable(node_id, &sub);

        Promise::new(sub.clone())
            .create_account()
            .transfer(deposit)
            .add_access_key_allowance(
                public_key,
                Allowance::limited(key_allowance)
                    .unwrap_or_else(|| fail(ReasonCode::InvalidConfig, "zero key allowance")),
                vault_id,
                AGENT_ALLOWED_METHOD.to_string(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CREATE_CALLBACK)
                    .on_agent_created(node_id, sub),
            )
    }

    /// Binds only if the account was really created. Binding optimistically
    /// would leave a node pointing at an account that does not exist.
    #[private]
    pub fn on_agent_created(&mut self, node_id: NodeId, account_id: AccountId) -> bool {
        let created = env::promise_results_count() == 1
            && env::promise_result_checked(0, MAX_PROMISE_RESULT_LEN).is_ok();
        if created {
            self.do_bind(node_id, account_id);
        }
        created
    }

    #[payable]
    pub fn set_recipients(&mut self, node_id: NodeId, recipients: Option<Vec<AccountId>>) {
        self.assert_owner();
        validate_recipients(&recipients);
        let n = self
            .nodes
            .get_mut(&node_id)
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such node"));
        n.recipients = recipients;
    }

    #[payable]
    pub fn set_cooldown(&mut self, node_id: NodeId, cooldown_sec: u32) {
        self.assert_owner();
        if cooldown_sec > MAX_COOLDOWN_SEC {
            fail(ReasonCode::InvalidConfig, "cooldown too long");
        }
        let n = self
            .nodes
            .get_mut(&node_id)
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such node"));
        n.cooldown_sec = cooldown_sec;
    }

    /// Freezes the whole subtree. Nothing is propagated to children; the hot
    /// path checks `frozen` on every ancestor, which is O(MAX_DEPTH).
    #[payable]
    pub fn freeze_node(&mut self, node_id: NodeId, frozen: bool) {
        self.assert_owner();
        let n = self
            .nodes
            .get_mut(&node_id)
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such node"));
        n.frozen = frozen;
    }

    /// Deletes SETTLED and TRANSFER_FAILED requests reserved strictly before
    /// `before_day`, at most `limit` per call. Returns how many were removed.
    ///
    /// Requests are stored permanently otherwise, and the VAULT pays their
    /// storage staking (an agent's function-call key cannot attach a deposit,
    /// so it cannot pay for its own). Without pruning that only ever grows.
    ///
    /// It must NEVER remove a TRANSFER_PENDING request. Such a request still
    /// holds `pending` at every level of its chain, and the callback keyed by
    /// its id is the only thing that can release it — delete the request and
    /// that budget is consumed for the rest of the day with nothing left to
    /// give it back.
    ///
    /// TRADE-OFF, measured and deliberate: pruning FREES the request id.
    /// Duplicate detection is `requests.contains_key(id)`, so once a record is
    /// gone its id is accepted again and pays a second time. The replay is
    /// charged to the CURRENT day and bounded by every cap in the chain, so it
    /// is not a drain — but a request id is a unique idempotency key only among
    /// RETAINED requests. Pinned by
    /// `purge_settled_removes_history_without_refunding_the_budget`.
    #[payable]
    pub fn purge_settled(&mut self, before_day: u64, limit: u32) -> u32 {
        self.assert_owner();
        if limit > MAX_PURGE_LIMIT {
            fail(ReasonCode::InvalidConfig, "limit above MAX_PURGE_LIMIT");
        }
        if limit == 0 {
            return 0;
        }

        // Collected first: the map cannot be mutated while it is iterated.
        let mut doomed: Vec<String> = Vec::new();
        for (id, r) in self.requests.iter() {
            if doomed.len() as u32 >= limit {
                break;
            }
            let terminal = matches!(r.status, Status::Settled | Status::TransferFailed);
            if terminal && r.reserved_day < before_day {
                doomed.push(id.clone());
            }
        }

        let removed = doomed.len() as u32;
        for id in doomed {
            self.requests.remove(&id);
        }
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"vault","version":"1.0.0","event":"purged","data":[{{"removed":{removed},"before_day":{before_day}}}]}}"#
        ));
        removed
    }

    /// Releases reservations whose callback never arrived. Owner only.
    ///
    /// WHY THIS IS NEEDED. If a callback panics or runs out of gas, NEAR rolls
    /// back only that callback's receipt — the `pending` charge taken in the
    /// dispatching receipt survives. `purge_settled` cannot help: it only
    /// takes terminal requests, so a stuck `TransferPending` would hold its
    /// budget for the rest of the day AND its storage forever.
    ///
    /// WHAT THE OWNER IS ASSERTING. That the callback is never coming. There
    /// is a real tradeoff here and it should not be glossed: on the NEP-141
    /// rail, if `ft_transfer` SUCCEEDED and only the callback died, the tokens
    /// have already left the vault, and sweeping releases a reservation for a
    /// spend that genuinely happened — the budget under-counts it. The age
    /// floor makes that window negligible rather than impossible, so an owner
    /// should check the token balance before sweeping a NEAR-rail request.
    /// The alternative — no sweep at all — locks the budget until the day
    /// rolls over and the storage permanently, which is worse.
    ///
    /// The outcome is deliberately tagged `SWEPT_STUCK` rather than reusing
    /// `TRANSFER_FAILED`, so an audit can tell an owner's intervention apart
    /// from a rail that actually reported failure.
    ///
    /// Resolution goes through `resolve_reservation`, the same single place
    /// both rails use, so a swept reservation is released exactly once and a
    /// late callback finds a non-pending status and becomes a no-op.
    #[payable]
    pub fn sweep_stuck_pending(&mut self, limit: u32) -> u32 {
        self.assert_owner();
        if limit > MAX_PURGE_LIMIT {
            fail(ReasonCode::InvalidConfig, "limit above MAX_PURGE_LIMIT");
        }
        if limit == 0 {
            return 0;
        }
        let now = env::block_timestamp();

        // Collected first: the map cannot be mutated while it is iterated.
        let mut stuck: Vec<String> = Vec::new();
        for (id, r) in self.requests.iter() {
            if stuck.len() as u32 >= limit {
                break;
            }
            let aged = now.saturating_sub(r.updated_at_ns.0) >= MIN_SWEEP_AGE_NS;
            if r.status == Status::TransferPending && aged {
                stuck.push(id.clone());
            }
        }

        let swept = stuck.len() as u32;
        for id in &stuck {
            // succeeded = false: release the reservation, do NOT book it.
            self.resolve_reservation(id, false, ReasonCode::Settled, ReasonCode::SweptStuck);
        }
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"vault","version":"1.0.0","event":"swept_stuck","data":[{{"swept":{swept}}}]}}"#
        ));
        swept
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    #[payable]
    pub fn set_strict_allocation(&mut self, strict: bool) {
        self.assert_owner();
        self.strict_allocation = strict;
    }

    /// Opens (or re-points) the Base rail. Owner only.
    ///
    /// `usdc_address` is validated here rather than at signing time: it is the
    /// `to` of every transaction this rail will ever sign, so a malformed value
    /// would be a vault that signs garbage. Rejecting it at configuration time
    /// means the hot path cannot fail on it.
    #[payable]
    pub fn set_base_config(&mut self, config: Option<BaseConfig>) {
        self.assert_owner();
        if let Some(c) = &config {
            if evm::parse_evm_address(&c.usdc_address).is_none() {
                fail(ReasonCode::InvalidEvmAddress, "usdc_address must be lowercase 0x + 40 hex");
            }
            if c.derivation_path.is_empty() || c.derivation_path.len() > 64 {
                fail(ReasonCode::InvalidEvmAddress, "derivation_path must be 1..=64 chars");
            }
            // A zero ceiling would silently close the rail while the config
            // still reads as open, so it is rejected rather than accepted as
            // an accidental kill switch. Use `set_base_config(None)` to close.
            if c.max_tx_fee_wei.0 == 0 {
                fail(
                    ReasonCode::FeeCeilingExceeded,
                    "max_tx_fee_wei must be > 0; pass config: null to close the rail",
                );
            }
        }
        self.base_config = config;
    }

    pub fn get_base_config(&self) -> Option<BaseConfig> {
        self.base_config.clone()
    }

    // ------------------------------------------------------- agent methods

    /// NOT `#[payable]`: a function-call key cannot attach a deposit, so this
    /// must stay deposit-free to be callable by a restricted agent key.
    ///
    /// `route` absent means the NEAR rail, so every existing caller — and every
    /// agent key already pinned to `["request_payment"]` — is untouched. A
    /// second method would have forced re-issuing every agent key; routing both
    /// rails through this one method also means they share a single
    /// hierarchical check, which is why the cross-chain path cannot step around
    /// the budget tree or the payee allowlist.
    pub fn request_payment(
        &mut self,
        request_id: String,
        token: AccountId,
        amount: U128,
        recipient: AccountId,
        memo: String,
        route: Option<Route>,
    ) -> PromiseOrValue<PaymentOutcome> {
        let route = route.unwrap_or_default();
        let caller = env::predecessor_account_id();
        let node_id = *self
            .account_to_node
            .get(&caller)
            .unwrap_or_else(|| fail(ReasonCode::NotAgent, "caller is not bound to a node"));

        let gas_floor = match route {
            Route::NearDirect => MIN_GAS_FOR_DISPATCH,
            Route::BaseUsdc { .. } => MIN_GAS_FOR_BASE_DISPATCH,
        };
        if env::prepaid_gas() < gas_floor {
            // Checked before anything is charged. An under-funded dispatch that
            // ran out of gas mid-flight would never reach the callback, and the
            // reservation would stay held at every level of the chain.
            fail(ReasonCode::InsufficientGas, "not enough prepaid gas for this rail");
        }

        let node = self.get_node(node_id);
        // Resolved ONCE. Fixed length <= MAX_DEPTH. No recursion.
        let mut chain: Vec<NodeId> = node.path.clone();
        chain.push(node_id);

        // ---- cheap rejects first
        if self.paused {
            return blocked(&request_id, node_id, ReasonCode::VaultPaused);
        }
        if !is_valid_request_id(&request_id) {
            return blocked("<invalid>", node_id, ReasonCode::InvalidRequestId);
        }
        if self.requests.contains_key(&request_id) {
            return blocked(&request_id, node_id, ReasonCode::DuplicateRequest);
        }
        if amount.0 == 0 {
            return blocked(&request_id, node_id, ReasonCode::InvalidAmount);
        }
        if memo.len() > MAX_MEMO_LEN || memo.chars().any(char::is_control) {
            return blocked(&request_id, node_id, ReasonCode::InvalidMemo);
        }
        for id in &chain {
            if self.get_node(*id).frozen {
                return blocked(&request_id, node_id, ReasonCode::NodeFrozen);
            }
        }
        // The payee allowlist runs FIRST and runs for both rails. A Base
        // destination is carried in this same `recipient` field as a lowercase
        // `0x…` string, which is a valid NEAR account id, so the cross-chain
        // rail inherits the allowlist with no new field and no second code
        // path that could drift from it.
        if !self.effective_recipients(&chain).iter().any(|r| r == &recipient) {
            return blocked(&request_id, node_id, ReasonCode::RecipientNotAllowed);
        }

        // Rail-specific shape checks, AFTER the allowlist so an address that
        // is merely not allowed never reports as malformed.
        let base_target = match &route {
            Route::NearDirect => None,
            Route::BaseUsdc { nonce: _, max_priority_fee_per_gas, max_fee_per_gas, gas_limit } => {
                let Some(cfg) = self.base_config.clone() else {
                    return blocked(&request_id, node_id, ReasonCode::BaseRailClosed);
                };

                // EIP-1559 validity: a transaction whose priority fee exceeds
                // its max fee is malformed and Base would reject it. Refusing
                // here means the vault never spends a signature on it.
                if max_priority_fee_per_gas.0 > max_fee_per_gas.0 {
                    return blocked(&request_id, node_id, ReasonCode::InvalidFeeFields);
                }

                // THE GAS CEILING. See BaseConfig::max_tx_fee_wei.
                //
                // `checked_mul` and not `*`: `gas_limit` is caller-supplied and
                // `max_fee_per_gas` is a u128, so the product can overflow. A
                // wrapping multiply would turn an enormous fee into a small
                // number and sail past the ceiling — the overflow IS the
                // attack, so it is treated as exceeding the ceiling rather
                // than as an arithmetic detail.
                let worst_case_fee = u128::from(gas_limit.0).checked_mul(max_fee_per_gas.0);
                match worst_case_fee {
                    Some(fee) if fee <= cfg.max_tx_fee_wei.0 => {}
                    _ => return blocked(&request_id, node_id, ReasonCode::FeeCeilingExceeded),
                }

                match evm::parse_evm_address(recipient.as_str()) {
                    Some(addr) => Some((cfg, addr)),
                    None => return blocked(&request_id, node_id, ReasonCode::InvalidEvmAddress),
                }
            }
        };

        let now = env::block_timestamp();
        let last = self.last_paid_ns.get(&node_id).copied().unwrap_or(0);
        if node.cooldown_sec > 0
            && now < last.saturating_add(u64::from(node.cooldown_sec) * NS_PER_SEC)
        {
            return blocked(&request_id, node_id, ReasonCode::Cooldown);
        }

        let day = self.today();

        // ---- PASS ONE: check every level. Mutate nothing.
        //
        // Two passes rather than one: a panic reverts the whole receipt on
        // NEAR, so a combined check-and-charge loop would be safe today. Two
        // passes cost one extra map read per level and remove the dependency
        // on that property, so a future non-panicking error path cannot
        // half-charge a chain.
        for id in &chain {
            let n = self.get_node(*id);
            let lim = match n.limit_for(&token) {
                Some(l) => l.clone(),
                None => return blocked(&request_id, node_id, ReasonCode::TokenNotAllowed),
            };
            if amount.0 > lim.per_tx_cap.0 {
                let code = if *id == node_id {
                    ReasonCode::PerTxLimit
                } else {
                    ReasonCode::ParentPerTxLimit
                };
                return blocked(&request_id, node_id, code);
            }
            let led = self
                .ledgers
                .get(&(*id, token.clone(), day))
                .cloned()
                .unwrap_or_default();
            if amount.0 > available(lim.daily_cap.0, &led) {
                let code = if *id == node_id {
                    ReasonCode::DailyBudget
                } else {
                    ReasonCode::ParentDailyBudget
                };
                return blocked(&request_id, node_id, code);
            }
        }

        // ---- PASS TWO: charge every level. Reached only if ALL levels passed.
        for id in &chain {
            let key = (*id, token.clone(), day);
            let mut led = self.ledgers.get(&key).cloned().unwrap_or_default();
            led.pending = led
                .pending
                .checked_add(amount.0)
                .unwrap_or_else(|| fail(ReasonCode::LedgerInvariant, "pending overflow"));
            self.ledgers.insert(key, led);
        }
        self.last_paid_ns.insert(node_id, now);

        self.requests.insert(
            request_id.clone(),
            PaymentRequest {
                request_id: request_id.clone(),
                node_id,
                token: token.clone(),
                amount,
                recipient: recipient.clone(),
                memo,
                route: route.clone(),
                reserved_chain: chain,
                reserved_day: day,
                status: Status::TransferPending,
                reason_code: ReasonCode::TransferPending,
                created_at_ns: U64(now),
                updated_at_ns: U64(now),
            },
        );

        // ---- Only now does anything leave the contract.
        //
        // Both arms resolve through `resolve_reservation`, so the reservation
        // taken above is released or consumed exactly once either way.
        match route {
            Route::NearDirect => PromiseOrValue::Promise(
                ext_ft::ext(token)
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FOR_FT_TRANSFER)
                    .ft_transfer(recipient, amount, Some(format!("vault:{request_id}")))
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_FOR_TRANSFER_CALLBACK)
                            .on_transfer_result(request_id),
                    ),
            ),

            Route::BaseUsdc { nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit } => {
                // `base_target` was resolved during validation, so both the
                // config and the parsed address are already known good.
                let (cfg, payee) = base_target.expect("validated above");

                // THE POINT OF THIS WHOLE BRANCH.
                //
                // The contract does not accept a payload to sign. It builds
                // the ERC-20 calldata and the EIP-1559 transaction from
                // `payee` and `amount` — the exact values it just checked
                // against every level of the budget tree and the allowlist —
                // and signs the hash of its OWN construction.
                //
                // Accepting an opaque hash would make all of that decorative:
                // a compromised agent would pass the hash of a transfer to its
                // own address, or of `approve(attacker, MAX)`, and the budget
                // check and the allowlist would both pass while the signature
                // authorized something else entirely. `to`, `value` and `data`
                // are therefore never caller-supplied.
                let fields = evm::Eip1559Fields {
                    chain_id: cfg.chain_id,
                    nonce: nonce.0,
                    max_priority_fee_per_gas: max_priority_fee_per_gas.0,
                    max_fee_per_gas: max_fee_per_gas.0,
                    gas_limit: gas_limit.0,
                    // `to` is the TOKEN contract from owner-set config, not the
                    // payee — for an ERC-20 transfer the payee lives in the
                    // calldata. A caller cannot redirect this.
                    to: evm::parse_evm_address(&cfg.usdc_address)
                        .expect("validated in set_base_config"),
                    data: evm::erc20_transfer_calldata(payee, amount.0),
                };

                PromiseOrValue::Promise(
                    ext_mpc::ext(cfg.mpc_contract)
                        // `sign` is PAYABLE: the signer asks for a deposit per
                        // request to stop the network being spammed. Measured
                        // on v1.signer-prod.testnet — 1 yocto is accepted. It
                        // comes from the VAULT's balance, not the caller's,
                        // because a function-call agent key cannot attach a
                        // deposit at all. Omitting it made every live Base
                        // payment fail, and the mock could not show that.
                        .with_attached_deposit(ONE_YOCTO)
                        .with_static_gas(GAS_FOR_MPC_SIGN)
                        .sign(SignRequest {
                            payload_v2: Payload::Ecdsa(evm::hex32(
                                &evm::eip1559_sighash(&fields),
                            )),
                            path: cfg.derivation_path,
                            domain_id: cfg.domain_id,
                        })
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(GAS_FOR_SIGNATURE_CALLBACK)
                                .on_signature_result(request_id),
                        ),
                )
            }
        }
    }

    /// Resolves a payment that was dispatched to a rail.
    ///
    /// THE invariant lives here, and it lives here ONCE. Both rails — the
    /// NEP-141 transfer and the Chain Signatures request — resolve through
    /// this function, which is what makes I6 rail-agnostic rather than
    /// duplicated: "every `pending` increment has exactly one matching
    /// decrement, on the same keys and the same day" holds for the cross-chain
    /// path for the same reason it holds for the NEAR path, because it is
    /// literally the same code. A second copy would be free to drift.
    ///
    /// `reserved_day`, never `today()`: a callback landing after midnight
    /// would otherwise decrement a zeroed ledger.
    fn resolve_reservation(
        &mut self,
        request_id: &str,
        succeeded: bool,
        ok_code: ReasonCode,
        fail_code: ReasonCode,
    ) -> PaymentOutcome {
        let now = env::block_timestamp();

        let (chain, token, amount, day) = {
            let r = self
                .requests
                .get(request_id)
                .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "unknown request"));
            // Idempotency gate: a reservation is released or consumed once.
            if r.status != Status::TransferPending {
                return outcome(r);
            }
            (
                r.reserved_chain.clone(),
                r.token.clone(),
                r.amount.0,
                r.reserved_day,
            )
        };

        for id in &chain {
            let key = (*id, token.clone(), day);
            let mut led = self.ledgers.get(&key).cloned().unwrap_or_default();
            led.pending = led
                .pending
                .checked_sub(amount)
                .unwrap_or_else(|| fail(ReasonCode::LedgerInvariant, "pending underflow"));
            if succeeded {
                led.executed = led
                    .executed
                    .checked_add(amount)
                    .unwrap_or_else(|| fail(ReasonCode::LedgerInvariant, "executed overflow"));
            }
            self.ledgers.insert(key, led);
        }

        let r = self
            .requests
            .get_mut(request_id)
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "unknown request"));
        r.status = if succeeded { Status::Settled } else { Status::TransferFailed };
        r.reason_code = if succeeded { ok_code } else { fail_code };
        r.updated_at_ns = U64(now);
        outcome(r)
    }

    /// NEP-141 rail. A successful promise means value MOVED.
    #[private]
    pub fn on_transfer_result(&mut self, request_id: String) -> PaymentOutcome {
        // `promise_result_checked` and not `promise_result`: a token whose
        // ft_transfer returned a large payload would otherwise be copied into
        // the callback and could exhaust its static gas. An out-of-gas
        // callback never releases the reservation, which permanently consumes
        // the budget at every level of the chain.
        let succeeded = env::promise_results_count() == 1
            && env::promise_result_checked(0, MAX_PROMISE_RESULT_LEN).is_ok();
        self.resolve_reservation(
            &request_id,
            succeeded,
            ReasonCode::Settled,
            ReasonCode::TransferFailed,
        )
    }

    /// Chain Signatures rail. A successful promise means the MPC network
    /// returned a SIGNATURE over the Base transaction.
    ///
    /// Read that precisely: this proves the vault obtained authority to move
    /// the funds on Base. It does NOT prove the transaction was relayed or
    /// included. Relaying is off-chain and the contract cannot observe it, so
    /// `Signed` is deliberately a distinct reason code from `Settled` — a
    /// reader of the ledger can tell which guarantee they have.
    #[private]
    pub fn on_signature_result(&mut self, request_id: String) -> PaymentOutcome {
        let succeeded = env::promise_results_count() == 1
            && env::promise_result_checked(0, MAX_MPC_RESULT_LEN).is_ok();
        self.resolve_reservation(
            &request_id,
            succeeded,
            ReasonCode::Signed,
            ReasonCode::SignatureFailed,
        )
    }

    // ---------------------------------------------------------------- views

    pub fn get_node(&self, node_id: NodeId) -> Node {
        self.nodes
            .get(&node_id)
            .cloned()
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such node"))
    }

    pub fn get_tree(&self) -> Vec<Node> {
        self.node_order
            .iter()
            .filter_map(|id| self.nodes.get(id).cloned())
            .collect()
    }

    pub fn get_request(&self, request_id: String) -> Option<PaymentRequest> {
        self.requests.get(&request_id).cloned()
    }

    /// Stored payment requests, NEWEST FIRST, for the activity feed.
    ///
    /// Note what is NOT here: a BLOCKED request is never stored. The hot path
    /// returns it as a value and emits an event, deliberately — storing
    /// rejected attempts would let an agent grow the vault's storage bill at
    /// will. So this view shows in-flight, settled and failed payments, and a
    /// block is only visible in the response to the call that was blocked, or
    /// in the event log. A dashboard must say so rather than render an empty
    /// "blocked" list and imply none ever happened.
    pub fn list_requests(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<PaymentRequest> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(20).min(MAX_LIST_LIMIT) as usize;
        self.requests
            .values()
            .rev()
            .skip(from)
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn get_node_budget(
        &self,
        node_id: NodeId,
        token: AccountId,
        day: Option<u64>,
    ) -> Option<BudgetView> {
        let day = day.unwrap_or_else(|| self.today());
        let node = self.nodes.get(&node_id)?;
        let lim = node.limit_for(&token)?;
        let led = self
            .ledgers
            .get(&(node_id, token.clone(), day))
            .cloned()
            .unwrap_or_default();
        Some(BudgetView {
            node_id,
            token,
            day,
            daily_cap: lim.daily_cap,
            executed: U128(led.executed),
            pending: U128(led.pending),
            available: U128(available(lim.daily_cap.0, &led)),
        })
    }

    pub fn current_day(&self) -> u64 {
        self.today()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            vault_id: env::current_account_id(),
            owner: self.owner.clone(),
            network: self.network.clone(),
            paused: self.paused,
            strict_allocation: self.strict_allocation,
            node_count: self.node_order.len() as u32,
            clock_mode: self.clock_mode(),
        }
    }
}

// ------------------------------------------------------------------- clock
//
// `day_len_ns` is not a constructor argument in the production build, so no
// code path can shorten it and there is no validation to get wrong.

#[cfg(not(feature = "test-clock"))]
#[near]
impl Vault {
    /// Deploy scripts gate on this exact string. Do not change it.
    pub fn clock_mode(&self) -> String {
        "production".to_string()
    }
}

#[cfg(not(feature = "test-clock"))]
impl Vault {
    #[inline]
    pub(crate) fn day_len_ns(&self) -> u64 {
        PRODUCTION_DAY_NS
    }
}

#[cfg(feature = "test-clock")]
#[near]
impl Vault {
    pub fn clock_mode(&self) -> String {
        "TEST-CLOCK-DO-NOT-DEPLOY".to_string()
    }

    #[payable]
    pub fn set_day_len_ns(&mut self, ns: u64) {
        self.assert_owner();
        if ns == 0 {
            fail(ReasonCode::InvalidConfig, "day length must be positive");
        }
        self.day_len_ns_override = ns;
    }
}

#[cfg(feature = "test-clock")]
impl Vault {
    #[inline]
    pub(crate) fn day_len_ns(&self) -> u64 {
        self.day_len_ns_override
    }
}

// --------------------------------------------------------------- internals

impl Vault {
    #[inline]
    pub(crate) fn today(&self) -> u64 {
        env::block_timestamp() / self.day_len_ns()
    }

    pub(crate) fn assert_owner(&self) {
        assert_one_yocto();
        if env::predecessor_account_id() != self.owner {
            fail(ReasonCode::NotOwner, "owner only");
        }
    }

    /// Nearest ancestor (self first, then up) with an explicit recipient list.
    /// A child list REPLACES the inherited one; it does not union with it.
    pub(crate) fn effective_recipients(&self, chain: &[NodeId]) -> Vec<AccountId> {
        for id in chain.iter().rev() {
            if let Some(rs) = self.get_node(*id).recipients {
                return rs;
            }
        }
        Vec::new()
    }

    /// Shared by `bind_agent` and `on_agent_created` so the two paths cannot
    /// drift apart in what they consider a legal binding.
    fn assert_bindable(&self, node_id: NodeId, account_id: &AccountId) {
        if account_id == &self.owner || account_id == &env::current_account_id() {
            fail(ReasonCode::InvalidConfig, "agent must not be the owner or the vault");
        }
        if self.account_to_node.contains_key(account_id) {
            fail(ReasonCode::InvalidConfig, "account already bound to a node");
        }
        let n = self
            .nodes
            .get(&node_id)
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such node"));
        if n.account.is_some() {
            fail(ReasonCode::InvalidConfig, "node already has an account");
        }
    }

    fn do_bind(&mut self, node_id: NodeId, account_id: AccountId) {
        self.assert_bindable(node_id, &account_id);
        if let Some(n) = self.nodes.get_mut(&node_id) {
            n.account = Some(account_id.clone());
        }
        self.account_to_node.insert(account_id, node_id);
    }

    fn bump_child_sum(&mut self, parent_id: NodeId, token: &AccountId, old: u128, new: u128) {
        let p = self
            .nodes
            .get_mut(&parent_id)
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such parent"));
        match p.child_cap_sum.iter_mut().find(|(t, _)| t == token) {
            Some(entry) => {
                entry.1 = U128(entry.1 .0.saturating_sub(old).saturating_add(new));
            }
            None => p.child_cap_sum.push((token.clone(), U128(new))),
        }
    }
}

fn validate_limits(limits: &[TokenLimit]) {
    if limits.is_empty() || limits.len() > MAX_TOKENS {
        fail(ReasonCode::InvalidConfig, "1..=4 token limits required");
    }
    for (i, l) in limits.iter().enumerate() {
        if limits[..i].iter().any(|o| o.token == l.token) {
            fail(ReasonCode::InvalidConfig, "duplicate token");
        }
        if l.daily_cap.0 == 0 || l.per_tx_cap.0 == 0 {
            fail(ReasonCode::InvalidConfig, "caps must be positive");
        }
        if l.per_tx_cap.0 > l.daily_cap.0 {
            fail(ReasonCode::InvalidConfig, "per_tx_cap must be <= daily_cap");
        }
    }
}

fn validate_recipients(recipients: &Option<Vec<AccountId>>) {
    if let Some(rs) = recipients {
        if rs.is_empty() || rs.len() > MAX_RECIPIENTS {
            fail(ReasonCode::InvalidConfig, "1..=32 recipients, or None to inherit");
        }
        for (i, r) in rs.iter().enumerate() {
            if rs[..i].contains(r) {
                fail(ReasonCode::InvalidConfig, "duplicate recipient");
            }
            if r == &env::current_account_id() {
                fail(ReasonCode::InvalidConfig, "recipient must not be the vault");
            }
        }
    }
}

fn outcome(r: &PaymentRequest) -> PaymentOutcome {
    PaymentOutcome {
        request_id: r.request_id.clone(),
        node_id: r.node_id,
        status: r.status,
        reason_code: r.reason_code,
    }
}

fn blocked(
    request_id: &str,
    node_id: NodeId,
    code: ReasonCode,
) -> PromiseOrValue<PaymentOutcome> {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"vault","version":"1.0.0","event":"request_blocked","data":[{{"request_id":"{}","node_id":{},"reason_code":"{}"}}]}}"#,
        request_id,
        node_id,
        code.as_str()
    ));
    PromiseOrValue::Value(PaymentOutcome {
        request_id: request_id.to_string(),
        node_id,
        status: Status::Blocked,
        reason_code: code,
    })
}

pub fn fail(code: ReasonCode, detail: &str) -> ! {
    env::panic_str(&format!("{}: {}", code.as_str(), detail))
}

/// A lowered cap can leave `used > cap`; that means nothing is available.
///
/// `saturating_sub` and not `-`: u128 subtraction wraps silently in a release
/// build, which would turn an exhausted budget into an enormous one. Pinned by
/// `available_saturates_when_a_lowered_cap_is_already_exceeded` (mutation M11,
/// executed: 1 red). Note that test runs in DEBUG, where `-` panics; the
/// workspace's `overflow-checks = true` is what makes release behave the same,
/// so that profile line is load-bearing and not cosmetic.
pub fn available(daily_cap: u128, led: &DailyLedger) -> u128 {
    let used = led.executed.saturating_add(led.pending);
    daily_cap.saturating_sub(used)
}

pub fn is_valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_REQUEST_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}
