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

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, PromiseOrValue,
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

pub const PRODUCTION_DAY_NS: u64 = 86_400 * NS_PER_SEC;

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
        if account_id == self.owner || account_id == env::current_account_id() {
            fail(ReasonCode::InvalidConfig, "agent must not be the owner or the vault");
        }
        if self.account_to_node.contains_key(&account_id) {
            fail(ReasonCode::InvalidConfig, "account already bound to a node");
        }
        let n = self
            .nodes
            .get_mut(&node_id)
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "no such node"));
        if n.account.is_some() {
            fail(ReasonCode::InvalidConfig, "node already has an account");
        }
        n.account = Some(account_id.clone());
        self.account_to_node.insert(account_id, node_id);
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
    pub fn request_payment(
        &mut self,
        request_id: String,
        token: AccountId,
        amount: U128,
        recipient: AccountId,
        memo: String,
    ) -> PromiseOrValue<PaymentOutcome> {
        let caller = env::predecessor_account_id();
        let node_id = *self
            .account_to_node
            .get(&caller)
            .unwrap_or_else(|| fail(ReasonCode::NotAgent, "caller is not bound to a node"));

        if env::prepaid_gas() < MIN_GAS_FOR_DISPATCH {
            fail(ReasonCode::InsufficientGas, "attach at least 50 Tgas");
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
        if !self.effective_recipients(&chain).iter().any(|r| r == &recipient) {
            return blocked(&request_id, node_id, ReasonCode::RecipientNotAllowed);
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
                reserved_chain: chain,
                reserved_day: day,
                status: Status::TransferPending,
                reason_code: ReasonCode::TransferPending,
                created_at_ns: U64(now),
                updated_at_ns: U64(now),
            },
        );

        // ---- Only now does anything leave the contract.
        PromiseOrValue::Promise(
            ext_ft::ext(token)
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FOR_FT_TRANSFER)
                .ft_transfer(recipient, amount, Some(format!("vault:{request_id}")))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_FOR_TRANSFER_CALLBACK)
                        .on_transfer_result(request_id),
                ),
        )
    }

    /// Releases the reservation on exactly the keys that were charged, and on
    /// the day it was charged to — `req.reserved_day`, never `today()`. A
    /// callback landing after midnight would otherwise decrement a zeroed
    /// ledger.
    #[private]
    pub fn on_transfer_result(&mut self, request_id: String) -> PaymentOutcome {
        // `promise_result_checked` and not `promise_result`: a token whose
        // ft_transfer returned a large payload would otherwise be copied into
        // the callback and could exhaust its static gas. An out-of-gas
        // callback never releases the reservation, which permanently consumes
        // the budget at every level of the chain — the same blast radius as
        // deleting the release itself. `ft_transfer` returns nothing, so
        // anything longer than this bound is an unexpected token contract.
        let succeeded = env::promise_results_count() == 1
            && env::promise_result_checked(0, MAX_PROMISE_RESULT_LEN).is_ok();
        let now = env::block_timestamp();

        let (chain, token, amount, day) = {
            let r = self
                .requests
                .get(&request_id)
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
            .get_mut(&request_id)
            .unwrap_or_else(|| fail(ReasonCode::UnknownNode, "unknown request"));
        if succeeded {
            r.status = Status::Settled;
            r.reason_code = ReasonCode::Settled;
        } else {
            r.status = Status::TransferFailed;
            r.reason_code = ReasonCode::TransferFailed;
        }
        r.updated_at_ns = U64(now);
        outcome(r)
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
/// `saturating_sub` and not `-`: u128 subtraction wraps silently in release
/// builds, which would turn an exhausted budget into an enormous one.
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
