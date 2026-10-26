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
/// Upper bound on one `list_requests` page. A view that returns everything
/// when asked for a huge page turns a dashboard refresh into an unbounded read.
pub const MAX_LIST_LIMIT: u32 = 50;

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

/// Which rail settles a payment.
///
/// - `NearDirect`: the NEP-141 transfer callback proves SETTLEMENT.
/// - `BaseUsdc`: the Chain Signatures callback proves the vault obtained a
///   SIGNATURE over a Base transaction it BUILT ITSELF. It does NOT prove that
///   transaction landed on Base — relaying is off-chain and unobserved.
///
/// Both rails run the SAME hierarchical check and the SAME reservation
/// lifecycle, so the cross-chain path cannot be used to step around the budget
/// tree or the payee allowlist.
///
/// The `BaseUsdc` fields are fee and ordering parameters ONLY. Everything that
/// determines WHERE value goes — the token contract, the payee, the amount —
/// is derived by the contract from what it already authorized, never taken
/// from the caller. A caller who lies about `max_fee_per_gas` wastes its own
/// gas; it cannot move the payment.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    NearDirect,
    BaseUsdc {
        nonce: U64,
        max_priority_fee_per_gas: U128,
        max_fee_per_gas: U128,
        gas_limit: U64,
    },
}

impl Default for Route {
    fn default() -> Self {
        Self::NearDirect
    }
}

impl Route {
    /// The `rail` label the dashboard shows. A cross-chain payment must not
    /// render as a NEAR one.
    pub fn rail(&self) -> &'static str {
        match self {
            Route::NearDirect => "near",
            Route::BaseUsdc { .. } => "base",
        }
    }
}

/// Owner-set parameters for the Base rail.
///
/// `None` on the vault means the rail is CLOSED, which is the default: a
/// freshly deployed vault cannot sign a cross-chain anything until the owner
/// explicitly opens it and names the token contract.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseConfig {
    /// The MPC signer, e.g. `v1.signer-prod.testnet`.
    pub mpc_contract: AccountId,
    /// The ERC-20 USDC contract on Base, lowercase `0x` + 40 hex.
    pub usdc_address: String,
    /// 8453 mainnet, 84532 Sepolia. Signed over, so a signature for one chain
    /// is not valid on the other.
    pub chain_id: u64,
    /// MPC derivation path. Fixes which Base address the vault controls.
    pub derivation_path: String,
    /// Which MPC root key signs. Measured on v1.signer-prod.testnet
    /// 2026-10-26: domain 0 is CaitSith/secp256k1 — the ECDSA curve an EVM
    /// chain needs. Domain 1 is Frost/Ed25519 and would produce a signature
    /// Base cannot verify, which is why this is owner-set and not guessed.
    pub domain_id: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    /// Only ever returned, never stored.
    Blocked,
    /// Reservation held, awaiting the rail's resolution. Rail-agnostic: a
    /// pending NEP-141 transfer and a pending MPC signature are the same state
    /// as far as the ledger is concerned.
    TransferPending,
    /// The reservation was consumed: pending -> executed.
    Settled,
    /// The reservation was released back. The reason code says which rail
    /// failed and how.
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
    // chain-signature rail
    BaseRailClosed,
    SignatureRequested,
    Signed,
    SignatureFailed,
    InvalidEvmAddress,
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
            BaseRailClosed => "BASE_RAIL_CLOSED",
            SignatureRequested => "SIGNATURE_REQUESTED",
            Signed => "SIGNED",
            SignatureFailed => "SIGNATURE_FAILED",
            InvalidEvmAddress => "INVALID_EVM_ADDRESS",
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
    /// Which rail is settling this. See `Route` for the guarantee difference.
    pub route: Route,
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
