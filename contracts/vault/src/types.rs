use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::{near, AccountId};

// ---------------------------------------------------------------- bounds
//
// Every bound exists so a single call's storage reads and gas use stay small
// and predictable. MAX_DEPTH in particular is what lets the hot path walk a
// fixed-length ancestor array instead of recursing.

pub const MAX_DEPTH: usize = 4; // root -> team -> agent -> sub-agent
// Raised from 3 so an agent can have sub-agents beneath it. The cost is
// real and lands on the hot path: `chain` is path+self, and every payment
// loops it three times (frozen check, cap check, charge). A fourth level
// is therefore ~3 extra map reads and 1 extra write per payment. It stays
// a fixed-length walk, which is the property that actually matters.
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
/// - `NearDirect`: the NEP-141 transfer callback proves SETTLEMENT on NEAR.
/// - `Intents`: a NEP-141 transfer to a solver's one-time deposit address.
///   The callback proves the vault PAID THE SOLVER; it does not prove the
///   solver delivered on the far chain, which is off-chain and unobserved.
///
/// Both rails run the SAME hierarchical check and the SAME reservation
/// lifecycle, so the cross-chain path cannot be used to step around the budget
/// tree or the payee allowlist.
///
/// Nothing in either variant determines WHERE value goes. The payee is checked
/// against the allowlist, and for `Intents` the deposit address is bound to
/// that payee by a signature from a key the owner registered — so a caller who
/// substitutes an address of its own is refused rather than funded.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    NearDirect,
    /// Cross-chain via NEAR Intents. The vault performs an ordinary NEP-141
    /// transfer on NEAR to a one-time deposit address, and a solver delivers
    /// the destination asset to `recipient` on the far chain, pricing that
    /// chain's gas into the quote.
    ///
    /// No MPC signature, no derived address, no gas to fund, no nonce. A
    /// cross-chain payment is a NEAR transfer that the budget tree already
    /// knows how to check.
    ///
    /// Borsh tags enum variants by position. `NearDirect` must therefore stay
    /// first, and any future variant must be appended rather than inserted:
    /// renumbering would silently reinterpret every request already stored.
    Intents {
        /// The one-time NEAR address from the quote.
        deposit_address: AccountId,
        /// Nanosecond deadline after which the quote is refused.
        quote_deadline_ns: U64,
        /// Ed25519 over borsh(QuoteBinding), from the registered signer.
        signature: Base64VecU8,
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
            // The dashboard already filters on this label; an Intents payment
            // lands on the far chain, so it must not render as a NEAR one.
            Route::Intents { .. } => "intents",
        }
    }
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
    /// An Intents payment was attempted with no quote signer registered.
    /// Refusing is the safe direction: without one, nothing binds the
    /// deposit address to the allowlisted payee.
    QuoteSignerUnset,
    /// The quote's deadline has passed. Prices move and deposit addresses
    /// expire, so a stale quote must not be honoured.
    QuoteExpired,
    /// The signature did not verify against the registered signer, or was
    /// not 64 bytes.
    QuoteBadSignature,
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
    SweptStuck,
    FeeCeilingExceeded,
    InvalidFeeFields,
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
    // virtual agents
    //
    // APPENDED, not inserted. Borsh tags enum variants by position and a
    // ReasonCode is stored inside every PaymentRequest, so renumbering would
    // silently reinterpret the reason on every request already on chain.
    /// The signing key is not bound to any node.
    NotVirtualAgent,
    /// The signature did not verify against the bound key, or was not 64 bytes.
    BadAgentSignature,
    /// The nonce is not strictly greater than the highest already consumed by
    /// this key. This is the replay guard; see StorageKey::PubkeyToNonce.
    NonceNotFresh,
    /// The signed payload's deadline has passed.
    AgentSignatureExpired,
}

impl ReasonCode {
    pub fn as_str(self) -> &'static str {
        use ReasonCode::*;
        match self {
            VaultPaused => "VAULT_PAUSED",
            NodeFrozen => "NODE_FROZEN",
            NotAgent => "NOT_AGENT",
            QuoteSignerUnset => "QUOTE_SIGNER_UNSET",
            QuoteExpired => "QUOTE_EXPIRED",
            QuoteBadSignature => "QUOTE_BAD_SIGNATURE",
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
            SweptStuck => "SWEPT_STUCK",
            FeeCeilingExceeded => "FEE_CEILING_EXCEEDED",
            InvalidFeeFields => "INVALID_FEE_FIELDS",
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
            NotVirtualAgent => "NOT_VIRTUAL_AGENT",
            BadAgentSignature => "BAD_AGENT_SIGNATURE",
            NonceNotFresh => "NONCE_NOT_FRESH",
            AgentSignatureExpired => "AGENT_SIGNATURE_EXPIRED",
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

/// What a quote signer attests to.
///
/// A 1Click quote hands back a ONE-TIME deposit address. Money sent there is
/// swapped and delivered to the payee named in the quote — but that address is
/// unpredictable, so it can never appear on the vault's payee allowlist. The
/// vault therefore checks the allowlist against the Base payee and then sends
/// the funds somewhere else entirely, to an address it has no way to connect
/// back to that payee.
///
/// If the agent supplied that address, the allowlist would be decorative: a
/// compromised agent quotes a swap paying itself and the vault funds it, in
/// budget, with every check passing. This struct is what closes that hole. A
/// key the OWNER registered signs the binding between payee and deposit
/// address, and the contract refuses any Intents payment without it.
///
/// Serialised with borsh for the signed message rather than concatenated as
/// text. Borsh is length-prefixed, so no two different field sets can produce
/// the same bytes; a plain concatenation would let `("alic", "ebob")` and
/// `("alice", "bob")` sign the same message.
/// What a VIRTUAL AGENT signs to authorize one payment.
///
/// A virtual agent has no NEAR account. It holds only a keypair, signs this
/// struct off-chain, and hands the signature to a relayer that submits it. The
/// relayer pays the gas and is NOT trusted: every field it could tamper with
/// is covered here.
///
/// Borsh, not text concatenation, for the same reason as QuoteBinding: borsh
/// is length-prefixed, so no two different field sets produce the same bytes.
///
/// WHY EACH FIELD IS PRESENT — every one of these closes an attack:
///
/// * `vault` — without it a signature is replayable against any other vault
///   that has bound the same key.
/// * `nonce` — THE replay guard. Must be strictly greater than the highest
///   this key has consumed. `request_id` cannot serve this role: terminal
///   requests are purged by `sweep_stuck_pending`, which frees the id for
///   reuse. Under `request_payment` that is harmless because NEAR's
///   per-transaction nonce prevents replay in the protocol; for a detached
///   signature it is a repeatable drain.
/// * `deadline_ns` — bounds how long a leaked or withheld signature is worth
///   anything. A relayer that sits on a payload cannot fire it next month.
/// * `route` — a relayer could otherwise take a signature authorizing a cheap
///   on-NEAR transfer and resubmit it as a cross-chain Intents payment.
/// * `token`, `amount`, `recipient`, `memo` — the payment itself.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct VirtualAgentBinding {
    pub vault: AccountId,
    pub nonce: u64,
    pub deadline_ns: u64,
    pub request_id: String,
    pub token: AccountId,
    pub amount: U128,
    pub recipient: AccountId,
    pub memo: String,
    pub route: Route,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct QuoteBinding {
    /// This vault. Without it, a signature is replayable against any other
    /// vault that trusts the same signer.
    pub vault: AccountId,
    /// Ties the signature to one payment. `request_id` is already rejected as
    /// a duplicate, so this makes each quote single-use for free.
    pub request_id: String,
    pub token: AccountId,
    /// What leaves the vault on NEAR.
    pub amount: U128,
    /// The FINAL destination on the far chain, as checked against the
    /// allowlist. The whole point of the signature is to bind this to the
    /// deposit address below.
    pub payee: String,
    /// Where the vault actually sends the tokens — the one-time address the
    /// quote returned.
    pub deposit_address: AccountId,
    /// Quotes go stale: prices move and deposit addresses expire. Past this,
    /// the signature is refused.
    pub deadline_ns: u64,
}
