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


#[cfg(test)]
mod tests;

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, AccountId, Allowance, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};

pub use crate::types::*;

pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
pub const GAS_FOR_TRANSFER_CALLBACK: Gas = Gas::from_tgas(10);
/// Registering the quote's one-time deposit address, on the cross-chain rail.
pub const GAS_FOR_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
/// What NEP-145 registration costs on the tokens this vault is used with:
/// 0.00125 NEAR, both the min AND the max of `storage_balance_bounds` on
/// mainnet USDC (measured 2026-10-28).
///
/// Fixed rather than read from the token, which would cost another
/// cross-contract round trip on every payment. It degrades safely both ways:
/// `registration_only: true` refunds the excess on a cheaper token, and on a
/// more expensive one the registration simply fails, the transfer then fails as
/// it does today, and the reservation is released by the usual path.
pub const DEPOSIT_ADDRESS_STORAGE: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// How much of the vault's OWN NEAR agents may cause it to spend per day.
///
/// The budget tree bounds token VALUE. The deposit-address registration above
/// costs NEAR per TRANSACTION, so a cap of 2.04 USDC permitted far more
/// payments than the vault's NEAR could fund: ~120 payments of 0.01 USDC —
/// 1.2 USDC, well inside the cap — exhausted it and killed the cross-chain
/// rail. Measured, with an executable PoC in
/// `intents_registration.rs::near_cost_is_per_transaction_not_per_value`.
///
/// 0.05 NEAR is ~45 registrations a day at the measured ~0.0011 each, which is
/// an order of magnitude above what the default tree can pay for (2.04 USDC at
/// a 0.51 per-tx cap is at most 4 payments). An owner running higher volume
/// raises it with `set_max_daily_near`.
pub const DEFAULT_MAX_DAILY_NEAR: NearToken = NearToken::from_millinear(50);
/// Checked up front so a call cannot reserve budget and then run out of gas
/// part-way through dispatch. The ONLY gas floor — both `Route` variants use
/// it, so this is the number a relay has to clear.
///
/// MEASURED on testnet 2026-10-28, not guessed: the signed-payment path burns
/// 7.85 Tgas at tree depth 1 and 9.28 Tgas at MAX_DEPTH. 50 Tgas prepaid
/// settles; 49 panics with INSUFFICIENT_GAS. So the floor carries ~5x headroom
/// over the deepest real burn, and float-relay.mjs's 100 Tgas carries ~10x.
/// Do not raise this to cover a hypothetical — a floor above what a relay
/// attaches fails EVERY payment, which is how the removed Base rail's 130 Tgas
/// came to look like the relay was 30 Tgas under-funded when that constant was
/// in fact unreachable.
pub const MIN_GAS_FOR_DISPATCH: Gas = Gas::from_tgas(50);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// `ft_transfer` returns nothing; anything longer is an unexpected token.
const MAX_PROMISE_RESULT_LEN: usize = 256;

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

/// The `ft_transfer` entry point of a NEP-141 token contract.
#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleTokenCore {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    /// NEP-145. `registration_only: true` refunds anything above the minimum,
    /// so a fixed attached amount cannot overpay a token with cheaper storage.
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Nodes,
    Ledgers,
    LastPaid,
    AccountToNode,
    Requests,
    /// Virtual agents: an authorized signing key -> the node it spends from.
    /// MANY-TO-ONE on purpose, unlike `AccountToNode` — a swarm shares a pool.
    PubkeyToNode,
    /// Virtual agents: signing key -> highest nonce already consumed.
    ///
    /// This is the replay guard and it must NEVER be pruned. `request_id`
    /// dedup cannot serve that role: `sweep_stuck_pending` removes terminal
    /// requests, which frees the id for reuse. That is harmless for
    /// `request_payment`, where NEAR's per-transaction nonce makes replay
    /// impossible at the protocol level, but for a detached signature it would
    /// be a drain — resubmit an old payload after the purge window and the
    /// budget is spent again.
    PubkeyToNonce,
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

    // NOTE: a 5th field `base_config: Option<BaseConfig>` sat here until
    // 2026-10-28. It was REMOVED, which changes this struct's borsh layout —
    // see `migrate` at the bottom of this impl. Any state written before that
    // date must pass through `migrate` or it will misparse from this point on.
    nodes: LookupMap<NodeId, Node>,
    /// Bounded by MAX_NODES so `get_tree` stays a single view call.
    node_order: Vec<NodeId>,
    account_to_node: LookupMap<AccountId, NodeId>,
    /// Virtual agents. Many keys may map to one node; a 100-signer swarm draws
    /// on a shared pool rather than consuming 100 of the MAX_NODES budget.
    pubkey_to_node: LookupMap<PublicKey, NodeId>,
    /// Highest nonce consumed per virtual agent key. Monotonic, never pruned.
    pubkey_to_nonce: LookupMap<PublicKey, u64>,
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
            nodes: LookupMap::new(StorageKey::Nodes),
            node_order: Vec::new(),
            account_to_node: LookupMap::new(StorageKey::AccountToNode),
            pubkey_to_node: LookupMap::new(StorageKey::PubkeyToNode),
            pubkey_to_nonce: LookupMap::new(StorageKey::PubkeyToNonce),
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

    // ---- The quote signer.
    //
    // An Intents payment sends funds to a one-time deposit address that can
    // never be on the payee allowlist. Something has to vouch that paying
    // that address pays the allowlisted payee, and the contract cannot check
    // it — the correspondence only exists inside the solver's quote.
    //
    // So this is an EXPLICIT TRUSTED PRODUCER, named rather than implied.
    // Whoever holds this key can bind any deposit address to any payee, which
    // means they can redirect any Intents payment the budget allows. It
    // should be the operator's key, kept off the machines agents run on. With
    // no signer registered the Intents rail is simply closed.
    //
    // Stored under its own key, like the other additions, so the borsh layout
    // of `Vault` is untouched.

    /// The vault's own-NEAR budget. Kept OUTSIDE `Vault` for the same reason
    /// `QUOTE_SIGNER` and `PENDING_OWNER` are: adding a struct field is a borsh
    /// layout change and every deployed vault would need `migrate()` in the
    /// same transaction as the deploy. A dedicated storage key needs neither.
    const MAX_DAILY_NEAR_KEY: &'static [u8] = b"MAX_DAILY_NEAR";
    /// `(day, spent)` for the CURRENT day. A stored day that is not today reads
    /// as zero spent, so the counter resets without anyone sweeping it.
    const NEAR_SPENT_KEY: &'static [u8] = b"NEAR_SPENT";

    fn max_daily_near() -> u128 {
        env::storage_read(Self::MAX_DAILY_NEAR_KEY)
            .and_then(|b| <[u8; 16]>::try_from(b).ok())
            .map(u128::from_le_bytes)
            .unwrap_or(DEFAULT_MAX_DAILY_NEAR.as_yoctonear())
    }

    fn near_spent_today(day: u64) -> u128 {
        let Some(raw) = env::storage_read(Self::NEAR_SPENT_KEY) else { return 0 };
        let Ok(buf) = <[u8; 24]>::try_from(raw) else { return 0 };
        let stored_day = u64::from_le_bytes(buf[0..8].try_into().unwrap());
        if stored_day != day {
            return 0;
        }
        u128::from_le_bytes(buf[8..24].try_into().unwrap())
    }

    fn charge_near(day: u64, amount: u128) {
        let next = Self::near_spent_today(day).saturating_add(amount);
        let mut buf = [0u8; 24];
        buf[0..8].copy_from_slice(&day.to_le_bytes());
        buf[8..24].copy_from_slice(&next.to_le_bytes());
        env::storage_write(Self::NEAR_SPENT_KEY, &buf);
    }

    /// Raise or lower the daily ceiling on the vault's own NEAR spend.
    /// `None` restores the default.
    #[payable]
    pub fn set_max_daily_near(&mut self, amount: Option<U128>) {
        self.assert_owner();
        match amount {
            None => env::storage_remove(Self::MAX_DAILY_NEAR_KEY),
            Some(a) => {
                env::storage_write(Self::MAX_DAILY_NEAR_KEY, &a.0.to_le_bytes());
                true
            }
        };
    }

    /// Today's NEAR budget, so an operator can see the drain coming.
    pub fn get_near_budget(&self) -> NearBudgetView {
        let day = self.today();
        let cap = Self::max_daily_near();
        let spent = Self::near_spent_today(day);
        NearBudgetView {
            day,
            max_daily: U128(cap),
            spent: U128(spent),
            available: U128(cap.saturating_sub(spent)),
        }
    }

    const QUOTE_SIGNER_KEY: &'static [u8] = b"QUOTE_SIGNER";

    fn read_quote_signer() -> Option<[u8; 32]> {
        env::storage_read(Self::QUOTE_SIGNER_KEY).and_then(|b| b.try_into().ok())
    }

    /// Register (or with `None`, revoke) the ed25519 key that signs quotes.
    ///
    /// Revoking closes the Intents rail outright. That is the correct
    /// response to a suspected key compromise, and it needs no other
    /// coordination: with no signer, every Intents payment is refused.
    #[payable]
    pub fn set_quote_signer(&mut self, public_key: Option<Base64VecU8>) {
        self.assert_owner();
        match public_key {
            None => {
                env::storage_remove(Self::QUOTE_SIGNER_KEY);
                env::log_str(
                    r#"EVENT_JSON:{"standard":"vault","version":"1.0.0","event":"quote_signer_cleared","data":[{}]}"#,
                );
            }
            Some(pk) => {
                if pk.0.len() != 32 {
                    fail(ReasonCode::InvalidConfig, "quote signer must be a 32-byte ed25519 key");
                }
                env::storage_write(Self::QUOTE_SIGNER_KEY, &pk.0);
                env::log_str(
                    r#"EVENT_JSON:{"standard":"vault","version":"1.0.0","event":"quote_signer_set","data":[{}]}"#,
                );
            }
        }
    }

    /// The registered quote signer, if the Intents rail is open.
    pub fn get_quote_signer(&self) -> Option<Base64VecU8> {
        Self::read_quote_signer().map(|k| Base64VecU8(k.to_vec()))
    }

    /// Reclaim a node, returning its slot to the MAX_NODES budget.
    ///
    /// Why this had to exist before anything could spawn children. `add_node`
    /// did `node_order.push` with no counterpart anywhere in the contract, so
    /// MAX_NODES was a ONE-WAY budget: every node ever created consumed one of
    /// sixty-four slots permanently. That is survivable while only the owner
    /// can create nodes. It is not survivable the moment an agent can, because
    /// a buggy or compromised agent exhausts the tree and nothing — not
    /// freezing it, not revoking its key — ever gives those slots back.
    ///
    /// The preconditions are deliberately strict, because the failure mode of
    /// getting this wrong is a wedged reservation rather than an error:
    ///
    /// - FROZEN. Freezing is what stops new reservations from forming, and
    ///   the hot path checks `frozen` on every node in the chain. Without it,
    ///   a payment could be reserved against this node between the emptiness
    ///   check and the removal.
    /// - CHILDLESS. A descendant keeps this node in its `path`, so removing a
    ///   parent would leave children charging a level that no longer exists.
    /// - NO PENDING, across today AND yesterday. A reservation outlives the
    ///   call that made it; `RESERVATION_TTL` is an hour, so one taken before
    ///   midnight can still be open after it. Checking only today would miss
    ///   exactly that case.
    /// - NOT THE ROOT. Removing it would leave a vault no payment can route
    ///   through, unrecoverably.
    ///
    /// Note what is NOT done: the node's ledgers are left in place. They are
    /// keyed by `(node, token, day)` and `next_node_id` only ever increments,
    /// so the id can never be reused and the rows are inert. Deleting them
    /// would be worse than useless — if any reservation did still reference
    /// this node, its release does `pending.checked_sub(amount)` against a
    /// ledger that `unwrap_or_default()` would resurrect as zero, underflow,
    /// and panic in a CALLBACK. That reservation would then be stuck forever
    /// at every level of its chain. Keeping the rows makes the dangerous case
    /// merely wasteful instead.
    #[payable]
    pub fn remove_node(&mut self, node_id: NodeId) {
        self.assert_owner();

        let node = self.get_node(node_id);

        let parent = match node.parent {
            Some(p) => p,
            None => fail(ReasonCode::InvalidConfig, "cannot remove the root"),
        };
        if node.child_count > 0 {
            fail(ReasonCode::MaxChildren, "node still has children");
        }
        if !node.frozen {
            fail(
                ReasonCode::InvalidConfig,
                "freeze the node first: freezing is what stops new reservations",
            );
        }

        // Today and yesterday, because a reservation can outlive a day
        // boundary. `today()` is a fixed window, so yesterday is today - 1.
        let today = self.today();
        for l in &node.limits {
            for day in [today, today.saturating_sub(1)] {
                let led = self
                    .ledgers
                    .get(&(node_id, l.token.clone(), day))
                    .cloned()
                    .unwrap_or_default();
                if led.pending > 0 {
                    fail(
                        ReasonCode::LedgerInvariant,
                        "node has an open reservation; sweep_stuck_pending first",
                    );
                }
            }
        }

        // Give the parent back the allocation this node was holding, so a
        // strict-mode tree can re-use the headroom.
        for l in &node.limits {
            self.bump_child_sum(parent, &l.token, l.daily_cap.0, 0);
        }
        if let Some(p) = self.nodes.get_mut(&parent) {
            p.child_count = p.child_count.saturating_sub(1);
        }

        // Free the agent account binding, or the account could never be bound
        // to another node and the key would be orphaned.
        if let Some(acct) = node.account.clone() {
            self.account_to_node.remove(&acct);
        }

        self.nodes.remove(&node_id);
        self.node_order.retain(|id| *id != node_id);

        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"vault","version":"1.0.0","event":"node_removed","data":[{{"node_id":{},"parent":{},"freed_slots":{}}}]}}"#,
            node_id,
            parent,
            MAX_NODES as usize - self.node_order.len()
        ));
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

    // ---- Ownership handover, and the owner's way out.
    //
    // Both were missing, and the two absences compounded into the worst
    // failure this contract had. `owner` was written once in `new` and never
    // again, and the only route tokens could take out of the vault was
    // `request_payment` to an ALLOWLISTED recipient under a daily cap. So a
    // lost owner key froze the configuration permanently with the funds still
    // inside, and even an attentive owner could do no better than drip their
    // own deposit back to themselves — and only if they had thought to
    // allowlist themselves in advance.
    //
    // A note on where `pending_owner` lives. It sits under its own storage key
    // rather than as a field on `Vault`, deliberately. Adding a struct field
    // changes the borsh layout, so the already-deployed vault's state would
    // fail to deserialize under the new code and would need a migration to
    // survive. A separately-keyed value leaves the layout untouched, which
    // means this can be deployed over the live vault with its tree, ledgers
    // and payment history intact, and with no migration step to get wrong.

    /// Raw storage key for the pending owner. Not a `StorageKey` variant,
    /// because those derive collection prefixes and this is a single value.
    const PENDING_OWNER_KEY: &'static [u8] = b"PENDING_OWNER";

    fn read_pending_owner() -> Option<AccountId> {
        env::storage_read(Self::PENDING_OWNER_KEY)
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|s| s.parse().ok())
    }

    /// Nominate the next owner, or pass `None` to cancel a nomination.
    ///
    /// Two steps rather than one. A single `set_owner` taking effect
    /// immediately would hand the vault to whatever string was typed, and a
    /// typo would recreate exactly the unrecoverable state this exists to
    /// remove — instantly, and with no way back. Requiring the nominee to call
    /// `accept_ownership` proves the account exists and holds its keys before
    /// any authority moves.
    #[payable]
    pub fn propose_owner(&mut self, new_owner: Option<AccountId>) {
        self.assert_owner();
        match new_owner {
            None => {
                env::storage_remove(Self::PENDING_OWNER_KEY);
                env::log_str(
                    r#"EVENT_JSON:{"standard":"vault","version":"1.0.0","event":"owner_proposal_cancelled","data":[{}]}"#,
                );
            }
            Some(next) => {
                // The same two rules `new` enforces. A vault that owned itself
                // would make `assert_owner` unsatisfiable by any external
                // caller, which is the brick this is here to prevent.
                if next == env::current_account_id() {
                    fail(ReasonCode::InvalidConfig, "owner must not be the vault");
                }
                if next == self.owner {
                    fail(ReasonCode::InvalidConfig, "already the owner");
                }
                env::storage_write(Self::PENDING_OWNER_KEY, next.as_str().as_bytes());
                env::log_str(&format!(
                    r#"EVENT_JSON:{{"standard":"vault","version":"1.0.0","event":"owner_proposed","data":[{{"pending_owner":"{next}"}}]}}"#
                ));
            }
        }
    }

    /// Complete a handover. Callable only by the nominated account.
    #[payable]
    pub fn accept_ownership(&mut self) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        match Self::read_pending_owner() {
            Some(pending) if pending == caller => {
                let previous = self.owner.clone();
                self.owner = caller;
                env::storage_remove(Self::PENDING_OWNER_KEY);
                env::log_str(&format!(
                    r#"EVENT_JSON:{{"standard":"vault","version":"1.0.0","event":"owner_changed","data":[{{"previous_owner":"{}","new_owner":"{}"}}]}}"#,
                    previous, self.owner
                ));
            }
            _ => fail(ReasonCode::NotOwner, "not the pending owner"),
        }
    }

    pub fn get_pending_owner(&self) -> Option<AccountId> {
        Self::read_pending_owner()
    }

    /// Move tokens out of the vault on the owner's authority alone.
    ///
    /// This deliberately bypasses the budget hierarchy. Caps exist to bound
    /// what AGENTS may spend; applying them to the owner's own exit is what
    /// turned a deposit into a hundred-day drip. An owner who can already
    /// rewrite every cap in the tree gains no new capability by withdrawing
    /// directly, so there is no escalation here — only a path that should
    /// have existed from the start.
    ///
    /// Not gated on `paused`. Pausing stops agents; an escape hatch a pause
    /// can close is not an escape hatch.
    ///
    /// Interaction with in-flight payments: withdrawing can leave less on hand
    /// than outstanding reservations expect, in which case those transfers
    /// fail at the token contract and their reservations are released by the
    /// existing `resolve_reservation` / `sweep_stuck_pending` machinery. No
    /// accounting is corrupted; a payment simply does not go through.
    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128, receiver_id: AccountId) -> Promise {
        self.assert_owner();
        if amount.0 == 0 {
            fail(ReasonCode::InvalidConfig, "amount must be positive");
        }
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"vault","version":"1.0.0","event":"owner_withdrawal","data":[{{"token":"{}","amount":"{}","receiver_id":"{}"}}]}}"#,
            token, amount.0, receiver_id
        ));
        ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(receiver_id, amount, Some("vault:owner-withdrawal".to_string()))
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
        let caller = env::predecessor_account_id();
        let node_id = *self
            .account_to_node
            .get(&caller)
            .unwrap_or_else(|| fail(ReasonCode::NotAgent, "caller is not bound to a node"));
        self.dispatch_payment(
            node_id,
            request_id,
            token,
            amount,
            recipient,
            memo,
            route.unwrap_or_default(),
        )
    }

    /// Authorize a virtual agent: a signing key that may spend from `node_id`
    /// without owning a NEAR account.
    ///
    /// MANY-TO-ONE, unlike `create_agent_account`. Several keys may share one
    /// node, so a swarm draws on a shared pool instead of consuming one of the
    /// 64 MAX_NODES per member. The node's `account` field stays `None`: that
    /// field means "a real sub-account is bound here" and a virtual agent is
    /// precisely the absence of one.
    ///
    /// Costs ~0.001 NEAR of state rather than the 0.55 NEAR a real sub-account
    /// locks. Unbinding reclaims the `pubkey_to_node` mapping (82 bytes); the
    /// `pubkey_to_nonce` entry (86 bytes, roughly half the total) is retained
    /// on purpose and is never reclaimed — see `unbind_virtual_agent` for why
    /// dropping it would reopen the replay guard.
    #[payable]
    pub fn bind_virtual_agent(&mut self, node_id: NodeId, public_key: PublicKey) {
        self.assert_owner();
        // The node must exist. Unlike assert_bindable we do NOT reject a node
        // that already has signers; that is the point.
        let _ = self.get_node(node_id);
        if self.pubkey_to_node.contains_key(&public_key) {
            fail(ReasonCode::InvalidConfig, "key already bound to a node");
        }
        self.pubkey_to_node.insert(public_key.clone(), node_id);
        // The nonce counter is NOT initialised here, and must not be: a fresh
        // key starts with no entry, read as 0, so its first usable nonce is 1.
        // Re-binding a previously used key keeps its old counter, which is
        // what stops unbind/rebind from resetting the replay guard.
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"vault","version":"1.0.0","event":"virtual_agent_bound","data":[{{"node_id":{node_id}}}]}}"#
        ));
    }

    /// Revoke a virtual agent's key.
    ///
    /// Deliberately keeps the nonce entry. Dropping it would let an owner
    /// unbind and rebind a key to reset the replay guard, making every
    /// signature that key ever produced valid again.
    #[payable]
    pub fn unbind_virtual_agent(&mut self, public_key: PublicKey) {
        self.assert_owner();
        if self.pubkey_to_node.remove(&public_key).is_none() {
            fail(ReasonCode::NotVirtualAgent, "key is not bound");
        }
        env::log_str(
            r#"EVENT_JSON:{"standard":"vault","version":"1.0.0","event":"virtual_agent_unbound","data":[{}]}"#,
        );
    }

    /// The next nonce a virtual agent must use. Relayers and SDKs read this.
    pub fn get_virtual_agent_nonce(&self, public_key: PublicKey) -> u64 {
        self.pubkey_to_nonce.get(&public_key).copied().unwrap_or(0) + 1
    }

    /// Which node a virtual agent key spends from, if any.
    pub fn get_virtual_agent_node(&self, public_key: PublicKey) -> Option<NodeId> {
        self.pubkey_to_node.get(&public_key).copied()
    }

    /// Spend on behalf of a virtual agent, authorized by its signature.
    ///
    /// Anyone may call this — the caller is only a relayer paying the gas and
    /// is not trusted for anything. Authority comes entirely from the
    /// signature over `VirtualAgentBinding`, which covers every field the
    /// relayer could otherwise tamper with.
    ///
    /// The relayer DOES choose whether to submit at all, so it can censor but
    /// not forge or redirect. An agent that wants no relayer dependency can
    /// still own a real sub-account and call `request_payment`; both paths
    /// remain open and land in the same budget logic.
    pub fn request_payment_signed(
        &mut self,
        request_id: String,
        token: AccountId,
        amount: U128,
        recipient: AccountId,
        memo: String,
        route: Option<Route>,
        public_key: PublicKey,
        nonce: u64,
        deadline_ns: U64,
        signature: Base64VecU8,
    ) -> PromiseOrValue<PaymentOutcome> {
        let route = route.unwrap_or_default();

        // ---- authenticate, in the order that leaks least work to an attacker
        let node_id = match self.pubkey_to_node.get(&public_key) {
            Some(n) => *n,
            // No node to attribute a `blocked` outcome to, so this is a hard
            // failure rather than a recorded rejection.
            None => fail(ReasonCode::NotVirtualAgent, "signing key is not bound to a node"),
        };

        if env::block_timestamp() > deadline_ns.0 {
            return blocked(&request_id, node_id, ReasonCode::AgentSignatureExpired);
        }

        // Strictly greater. Equal would permit one replay.
        let last = self.pubkey_to_nonce.get(&public_key).copied().unwrap_or(0);
        if nonce <= last {
            return blocked(&request_id, node_id, ReasonCode::NonceNotFresh);
        }

        let binding = VirtualAgentBinding {
            vault: env::current_account_id(),
            nonce,
            deadline_ns: deadline_ns.0,
            request_id: request_id.clone(),
            token: token.clone(),
            amount,
            recipient: recipient.clone(),
            memo: memo.clone(),
            route: route.clone(),
        };
        let msg = near_sdk::borsh::to_vec(&binding).expect("borsh");
        let Ok(sig) = <[u8; 64]>::try_from(signature.0.as_slice()) else {
            return blocked(&request_id, node_id, ReasonCode::BadAgentSignature);
        };
        // `PublicKey` carries a curve-type prefix byte; ed25519_verify wants
        // the raw 32. Slicing past the prefix is only correct for ed25519, so
        // a non-ed25519 key is refused rather than mis-sliced.
        let raw = public_key.as_bytes();
        if raw.len() != 33 || raw[0] != 0 {
            return blocked(&request_id, node_id, ReasonCode::BadAgentSignature);
        }
        let Ok(pk32) = <[u8; 32]>::try_from(&raw[1..]) else {
            return blocked(&request_id, node_id, ReasonCode::BadAgentSignature);
        };
        if !env::ed25519_verify(&sig, &msg, &pk32) {
            return blocked(&request_id, node_id, ReasonCode::BadAgentSignature);
        }

        // ---- the nonce is burned BEFORE dispatch.
        //
        // Not after, and not in the callback. `dispatch_payment` may return a
        // `blocked` outcome or yield a Promise, and a nonce consumed only on
        // the success path would leave a rejected-but-validly-signed payload
        // replayable. Burning here means one signature is worth at most one
        // attempt *that reaches dispatch*, which is the guarantee a
        // relayer-submitted payload needs.
        //
        // Scoped deliberately: a path that PANICS rather than returning —
        // notably `dispatch_payment`'s `InsufficientGas` floor — reverts this
        // insert along with the rest of the receipt, so the nonce survives and
        // the payload stays replayable. That is the behaviour we want. If an
        // under-gassed submission burned the nonce, a malicious relayer could
        // destroy an agent's signed payloads by deliberately under-gassing
        // them. A panic means nothing happened, so a retry is correct.
        self.pubkey_to_nonce.insert(public_key, nonce);

        self.dispatch_payment(node_id, request_id, token, amount, recipient, memo, route)
    }

    /// The one budget-and-dispatch implementation.
    ///
    /// Both entry points — account-authenticated `request_payment` and
    /// signature-authenticated `request_payment_signed` — resolve a `node_id`
    /// their own way and then land here. Deliberately ONE body: two copies of
    /// hierarchical reservation, allowlist, cooldown and freeze logic would
    /// drift, and the copy that drifts is the one with the money in it.
    ///
    /// Everything below this line is caller-agnostic. Authentication is the
    /// caller's job and is finished by the time we are called.
    fn dispatch_payment(
        &mut self,
        node_id: NodeId,
        request_id: String,
        token: AccountId,
        amount: U128,
        recipient: AccountId,
        memo: String,
        route: Route,
    ) -> PromiseOrValue<PaymentOutcome> {
        let gas_floor = match route {
            Route::NearDirect => MIN_GAS_FOR_DISPATCH,
            // A NEP-141 transfer; the cross-chain half is off-contract.
            Route::Intents { .. } => MIN_GAS_FOR_DISPATCH,
        };
        if env::prepaid_gas() < gas_floor {
            // Checked before anything is charged. An under-funded dispatch that
            // ran out of gas mid-flight would never reach the callback, and the
            // reservation would stay held at every level of the chain.
            //
            // `<`, NOT `<=`: a submission at EXACTLY MIN_GAS_FOR_DISPATCH is
            // adequately funded and must dispatch, or the real floor would be
            // one gas unit above the constant that documents it. Measured on
            // testnet 2026-10-28 against the deployed vault: 50 Tgas prepaid
            // settles, 49 panics. Pinned from both sides by
            // `a_signed_payload_at_exactly_the_gas_floor_dispatches` and
            // `an_under_gassed_signed_payload_panics_rather_than_consuming_its_nonce`.
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
        // Not a value any more: with the MPC rail gone there is nothing to
        // resolve here, only a gate to pass.
        match &route {
            Route::NearDirect => {}
            Route::Intents { deposit_address, quote_deadline_ns, signature } => {
                // THE GATE THAT KEEPS THE ALLOWLIST MEANINGFUL.
                //
                // The allowlist was checked above against `recipient` — the
                // final payee on the far chain. But the money is about to go
                // to `deposit_address`, a one-time address from a quote that
                // can never appear on that list, and which the contract has
                // no way to connect back to the payee.
                //
                // If an agent could choose it, the allowlist would be
                // decorative: quote a swap paying yourself, and the vault
                // funds it with every other check passing. So a key the OWNER
                // registered must have signed the binding between the two.
                let Some(signer) = Self::read_quote_signer() else {
                    return blocked(&request_id, node_id, ReasonCode::QuoteSignerUnset);
                };
                if env::block_timestamp() > quote_deadline_ns.0 {
                    return blocked(&request_id, node_id, ReasonCode::QuoteExpired);
                }
                let binding = QuoteBinding {
                    vault: env::current_account_id(),
                    request_id: request_id.clone(),
                    token: token.clone(),
                    amount,
                    payee: recipient.to_string(),
                    deposit_address: deposit_address.clone(),
                    deadline_ns: quote_deadline_ns.0,
                };
                let msg = near_sdk::borsh::to_vec(&binding).expect("borsh");
                let Ok(sig) = <[u8; 64]>::try_from(signature.0.as_slice()) else {
                    return blocked(&request_id, node_id, ReasonCode::QuoteBadSignature);
                };
                if !env::ed25519_verify(&sig, &msg, &signer) {
                    return blocked(&request_id, node_id, ReasonCode::QuoteBadSignature);
                }

                // THE VAULT'S OWN NEAR IS A BUDGETED RESOURCE TOO.
                //
                // Registering the deposit address below costs NEAR per
                // TRANSACTION while the tree bounds token VALUE, so without
                // this an agent drains the vault's NEAR with payments that
                // never approach any cap. Checked HERE — after the signature,
                // before anything is charged or sent — so a refusal costs
                // nothing and a bad signature is still rejected first.
                let spend_day = self.today();
                let cost = DEPOSIT_ADDRESS_STORAGE.as_yoctonear();
                if Self::near_spent_today(spend_day).saturating_add(cost) > Self::max_daily_near() {
                    return blocked(&request_id, node_id, ReasonCode::NearBudget);
                }
            }
        }

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

            // A cross-chain payment is an ordinary NEP-141 transfer to the
            // quote's one-time deposit address. A solver delivers the far-chain
            // asset to `recipient` and prices that chain's gas into the quote.
            //
            // No MPC signature, no derived address, no ETH to keep topped up,
            // no nonce to allocate. It resolves through the same callback as
            // the NEAR rail, so a failed transfer releases the reservation by
            // exactly the same path.
            Route::Intents { deposit_address, .. } => PromiseOrValue::Promise({
                // Charged at dispatch, not in the callback: the deposit is
                // attached whether or not the transfer later succeeds, so
                // booking it on success would under-count every failure.
                Self::charge_near(day, DEPOSIT_ADDRESS_STORAGE.as_yoctonear());
                // REGISTER THE DEPOSIT ADDRESS FIRST.
                //
                // 1Click mints a fresh IMPLICIT account per quote, which has no
                // storage balance on the token, and NEP-141 refuses an
                // unregistered receiver. That killed the first real mainnet
                // cross-chain payment (KNOWN-TRADEOFFS 13).
                //
                // The vault pays because nothing else can. An operator daemon
                // cannot get ahead of it: the transfer is built HERE, in the
                // same transaction as the request, so the address is not
                // observable until it is already in flight. And a restricted
                // function-call key cannot attach a deposit at all, so an
                // operator-side registrar would need a full-access key living in
                // a long-running service.
                //
                // It cannot be used to drain the vault's NEAR: this arm is
                // reached only AFTER the quote-signature gate above, so every
                // registration costs the owner's own signature.
                //
                // If registration fails the chain still proceeds, the transfer
                // fails exactly as it does today, and the callback releases the
                // reservation by the usual path.
                ext_ft::ext(token.clone())
                    .with_attached_deposit(DEPOSIT_ADDRESS_STORAGE)
                    .with_static_gas(GAS_FOR_STORAGE_DEPOSIT)
                    .storage_deposit(Some(deposit_address.clone()), Some(true))
                    .then(
                        ext_ft::ext(token)
                            .with_attached_deposit(ONE_YOCTO)
                            .with_static_gas(GAS_FOR_FT_TRANSFER)
                            .ft_transfer(deposit_address, amount, Some(format!("vault:{request_id}"))),
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_FOR_TRANSFER_CALLBACK)
                            .on_transfer_result(request_id),
                    )
            }),
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

    // ---------------------------------------------------------------- views
    //
    // Nothing between this banner and the first view. There used to be an
    // orphaned `#[private]` here — the leftover of `on_sign_result`, the Chain
    // Signatures callback deleted when the MPC/Base rail was removed. Its body
    // went; its doc comment and attribute stayed. Rust binds an attribute to
    // the next ITEM and a comment is not an item, so `#[private]` landed on
    // `get_node` and expanded to an assert on `predecessor_account_id()`, which
    // the runtime forbids in a view context. `get_node` shipped to mainnet
    // answering every view call with
    // `HostError(ProhibitedInView { method_name: "predecessor_account_id" })`.
    //
    // It stayed invisible because `#[private]` is injected into the generated
    // `extern "C"` wrapper, not the inner method: the six internal
    // `self.get_node(..)` calls below were unaffected, and the 15 unit-test
    // call sites invoke the Rust method directly, so neither could observe it.
    // Only a real node can. tests/views.rs now calls every view AS a view.

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

// --------------------------------------------------------------- migration
//
// `base_config: Option<BaseConfig>` was the 5th field of `Vault` until
// 2026-10-28, when the MPC/Base rail was removed. Deleting a field from a
// borsh struct shifts every byte after it, so a vault deployed before that
// date cannot read its own state under this code: the `Option`'s tag byte
// would be consumed as the start of `nodes`' storage prefix, and every field
// after it would misparse.
//
// MEASURED on testnet 2026-10-28, which is why this is a migration and not a
// plain delete:
//   v4.floatv4.testnet           `get_base_config` -> null    (1 byte, 0x00)
//   v3.floatvault-12329.testnet  `get_base_config` -> {..}    (~130 bytes)
// A populated config is not hypothetical. v3 was configured while the setter
// still existed, so the shifted region is a whole struct there, not one byte.
//
// `migrate` MUST be called in the same transaction as the deploy. A deploy
// without it leaves a vault whose every method panics on state read.

/// The pre-removal `BaseConfig`, retained ONLY so `migrate` can consume the
/// bytes it has to read past. Field ORDER is the layout — do not reorder, and
/// do not "tidy" these types.
// `dead_code` is correct here and the point: these fields are DESERIALISED
// and never read. Borsh needs them declared to know how many bytes to consume
// before `nodes`; discarding the value is the migration. Deleting them to
// silence the warning would resize the struct and corrupt every field after
// it.
#[allow(dead_code)]
#[derive(near_sdk::borsh::BorshDeserialize)]
#[cfg_attr(test, derive(near_sdk::borsh::BorshSerialize))]
#[borsh(crate = "near_sdk::borsh")]
pub(crate) struct LegacyBaseConfig {
    mpc_contract: AccountId,
    usdc_address: String,
    chain_id: u64,
    derivation_path: String,
    max_tx_fee_wei: U128,
    domain_id: u64,
}

/// The pre-removal `Vault` layout, field for field — including the
/// `test-clock` cfg, so each build migrates the layout that same build would
/// have written. The deploy script refuses to ship a test-clock wasm, so live
/// state is the `not(test-clock)` shape.
// Same reason as above: `base_config` is read to be thrown away.
#[allow(dead_code)]
#[derive(near_sdk::borsh::BorshDeserialize)]
#[cfg_attr(test, derive(near_sdk::borsh::BorshSerialize))]
#[borsh(crate = "near_sdk::borsh")]
pub(crate) struct LegacyVault {
    pub(crate) owner: AccountId,
    pub(crate) network: String,
    pub(crate) paused: bool,
    pub(crate) strict_allocation: bool,
    pub(crate) base_config: Option<LegacyBaseConfig>,
    pub(crate) nodes: LookupMap<NodeId, Node>,
    pub(crate) node_order: Vec<NodeId>,
    pub(crate) account_to_node: LookupMap<AccountId, NodeId>,
    pub(crate) pubkey_to_node: LookupMap<PublicKey, NodeId>,
    pub(crate) pubkey_to_nonce: LookupMap<PublicKey, u64>,
    pub(crate) next_node_id: NodeId,
    pub(crate) ledgers: LookupMap<(NodeId, AccountId, u64), DailyLedger>,
    pub(crate) last_paid_ns: LookupMap<NodeId, u64>,
    pub(crate) requests: IterableMap<String, PaymentRequest>,
    #[cfg(feature = "test-clock")]
    pub(crate) day_len_ns_override: u64,
}

#[near]
impl Vault {
    /// Reads the pre-2026-10-28 layout and rewrites state without
    /// `base_config`. Owner-agnostic but `#[private]`: only the vault account
    /// itself can call it, which is the account doing the deploy.
    ///
    /// The collections move across by handle. Their entries live under their
    /// own storage prefixes, not inside this struct — only the prefix is a
    /// struct field — so no key/value pair is rewritten, copied, or charged
    /// for again. That is what keeps this O(1) rather than O(nodes).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        // Panics with "Cannot deserialize the contract state." if the bytes
        // are not the OLD layout, which is the correct outcome: running this
        // against already-migrated state must fail loudly rather than
        // overwrite it with a half-read struct.
        let old: LegacyVault = match env::state_read() {
            Some(v) => v,
            None => fail(ReasonCode::InvalidConfig, "no existing state to migrate"),
        };

        Self {
            owner: old.owner,
            network: old.network,
            paused: old.paused,
            strict_allocation: old.strict_allocation,
            // old.base_config is read and DROPPED here. That is the migration.
            nodes: old.nodes,
            node_order: old.node_order,
            account_to_node: old.account_to_node,
            pubkey_to_node: old.pubkey_to_node,
            pubkey_to_nonce: old.pubkey_to_nonce,
            next_node_id: old.next_node_id,
            ledgers: old.ledgers,
            last_paid_ns: old.last_paid_ns,
            requests: old.requests,
            #[cfg(feature = "test-clock")]
            day_len_ns_override: old.day_len_ns_override,
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
