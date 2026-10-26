use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

// ---------------------------------------------------------------- bounds
//
// Every bound exists so a single call's storage reads and gas use stay small
// and predictable. MAX_DEPTH in particular is what lets the hot path walk a
// fixed-length ancestor array instead of recursing.

pub const MAX_DEPTH: usize = 3; // root -> team -> agent
pub const MAX_NODES: u32 = 64;
pub const MAX_CHILDREN: u32 = 16;
pub const MAX_TOKENS: usize = 4;
pub const MAX_RECIPIENTS: usize = 32;
pub const MAX_LABEL_LEN: usize = 48;
pub const MAX_REQUEST_ID_LEN: usize = 64;
pub const MAX_MEMO_LEN: usize = 256;
pub const MAX_COOLDOWN_SEC: u32 = 7 * 24 * 60 * 60;

pub const NS_PER_SEC: u64 = 1_000_000_000;

pub type NodeId = u32;
pub const ROOT_NODE: NodeId = 0;

/// One token's limits at one node, in that token's smallest unit.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenLimit {
    pub token: AccountId,
    /// Executed plus in-flight per UTC day may not exceed this.
    pub daily_cap: U128,
    /// No single payment may exceed this.
    pub per_tx_cap: U128,
}

/// A node in the budget tree. `path` and `id` are immutable after creation.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    /// Ancestors, root-first, EXCLUDING self. len() <= MAX_DEPTH - 1.
    /// Written once at creation. This is what bounds the hot path.
    pub path: Vec<NodeId>,
    pub label: String,
    /// Set when an agent account is bound. None for internal (team) nodes.
    pub account: Option<AccountId>,
    pub limits: Vec<TokenLimit>,
    /// Maintained sum of children's `daily_cap` per token, so the strict-mode
    /// containment check is O(MAX_TOKENS) rather than O(children).
    pub child_cap_sum: Vec<(AccountId, U128)>,
    pub child_count: u32,
    pub cooldown_sec: u32,
    pub frozen: bool,
    /// None = inherit from the nearest ancestor with Some.
    pub recipients: Option<Vec<AccountId>>,
}

impl Node {
    pub fn limit_for(&self, token: &AccountId) -> Option<&TokenLimit> {
        self.limits.iter().find(|l| &l.token == token)
    }

    pub fn child_sum_for(&self, token: &AccountId) -> u128 {
        self.child_cap_sum
            .iter()
            .find(|(t, _)| t == token)
            .map(|(_, v)| v.0)
            .unwrap_or(0)
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DailyLedger {
    pub executed: u128,
    pub pending: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetView {
    pub node_id: NodeId,
    pub token: AccountId,
    pub day: u64,
    pub daily_cap: U128,
    pub executed: U128,
    pub pending: U128,
    pub available: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    /// Only ever returned, never stored.
    Blocked,
    TransferPending,
    Settled,
    TransferFailed,
}

/// Stable machine-readable rejection causes. A dashboard or an agent branches
/// on these rather than parsing prose.
///
/// `ParentDailyBudget` is deliberately distinct from `DailyBudget`: it is the
/// only way to tell "your own budget is exhausted" from "the pool you share
/// is exhausted", and the hierarchy tests assert on exactly that difference.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReasonCode {
    VaultPaused,
    NodeFrozen,
    NotAgent,
    DuplicateRequest,
    InvalidRequestId,
    InvalidAmount,
    InvalidMemo,
    TokenNotAllowed,
    RecipientNotAllowed,
    Cooldown,
    PerTxLimit,
    ParentPerTxLimit,
    DailyBudget,
    ParentDailyBudget,
    TransferPending,
    Settled,
    TransferFailed,
    // configuration / authorization
    NotOwner,
    InitNotSelf,
    InvalidConfig,
    InvalidAllocation,
    MaxDepth,
    MaxNodes,
    MaxChildren,
    UnknownNode,
    InsufficientGas,
    LedgerInvariant,
}

impl ReasonCode {
    pub fn as_str(self) -> &'static str {
        use ReasonCode::*;
        match self {
            VaultPaused => "VAULT_PAUSED",
            NodeFrozen => "NODE_FROZEN",
            NotAgent => "NOT_AGENT",
            DuplicateRequest => "DUPLICATE_REQUEST",
            InvalidRequestId => "INVALID_REQUEST_ID",
            InvalidAmount => "INVALID_AMOUNT",
            InvalidMemo => "INVALID_MEMO",
            TokenNotAllowed => "TOKEN_NOT_ALLOWED",
            RecipientNotAllowed => "RECIPIENT_NOT_ALLOWED",
            Cooldown => "COOLDOWN",
            PerTxLimit => "PER_TX_LIMIT",
            ParentPerTxLimit => "PARENT_PER_TX_LIMIT",
            DailyBudget => "DAILY_BUDGET",
            ParentDailyBudget => "PARENT_DAILY_BUDGET",
            TransferPending => "TRANSFER_PENDING",
            Settled => "SETTLED",
            TransferFailed => "TRANSFER_FAILED",
            NotOwner => "NOT_OWNER",
            InitNotSelf => "INIT_NOT_SELF",
            InvalidConfig => "INVALID_CONFIG",
            InvalidAllocation => "INVALID_ALLOCATION",
            MaxDepth => "MAX_DEPTH",
            MaxNodes => "MAX_NODES",
            MaxChildren => "MAX_CHILDREN",
            UnknownNode => "UNKNOWN_NODE",
            InsufficientGas => "INSUFFICIENT_GAS",
            LedgerInvariant => "LEDGER_INVARIANT",
        }
    }
}

/// A persisted payment. Every field above `status` is immutable once stored.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRequest {
    pub request_id: String,
    pub node_id: NodeId,
    pub token: AccountId,
    pub amount: U128,
    pub recipient: AccountId,
    pub memo: String,
    /// The exact ledgers that were charged. The release must mirror this.
    pub reserved_chain: Vec<NodeId>,
    /// The UTC day the reservation was charged to. The callback uses THIS,
    /// never `today()`, or a callback landing after midnight decrements a
    /// zeroed ledger.
    pub reserved_day: u64,
    pub status: Status,
    pub reason_code: ReasonCode,
    pub created_at_ns: U64,
    pub updated_at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentOutcome {
    pub request_id: String,
    pub node_id: NodeId,
    pub status: Status,
    pub reason_code: ReasonCode,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub vault_id: AccountId,
    pub owner: AccountId,
    pub network: String,
    pub paused: bool,
    pub strict_allocation: bool,
    pub node_count: u32,
    pub clock_mode: String,
}
