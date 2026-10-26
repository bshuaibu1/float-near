//! A stand-in for the Chain Signatures MPC contract (`v1.signer`).
//!
//! It does NOT do threshold ECDSA. It records what it was asked to sign and
//! returns a signature-shaped value, which is exactly what the vault's
//! callback consumes — the vault branches on promise success, not on
//! cryptographic validity.
//!
//! The reason a mock is the right instrument here: what needs testing is that
//! the vault signs a transaction it BUILT ITSELF from the amount and payee it
//! authorized. That is a property of the payload, so the test asserts on the
//! recorded payload. A real MPC network would return a real signature over the
//! same bytes and tell us nothing more about the vault.
//!
//! What this therefore CANNOT establish: that the signature is valid, that the
//! transaction is well-formed to a Base node, or that it would be accepted
//! on-chain. Those need a real signer and a real relay.

use near_sdk::store::Vector;
use near_sdk::{env, near, PanicOnDefault};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SignRequest {
    pub payload: [u8; 32],
    pub path: String,
    pub key_version: u32,
}

/// Shaped like a real MPC response so the vault's callback sees a realistic
/// payload size — the callback bounds how much it copies, and a response that
/// was unrealistically small would not exercise that bound.
#[near(serializers = [borsh, json])]
pub struct SignatureResponse {
    pub big_r: String,
    pub s: String,
    pub recovery_id: u8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {
    /// Every payload this signer was asked to sign, in order. The test reads
    /// this to prove the vault signed the transaction it authorized.
    seen: Vector<SignRequest>,
    /// Deliberately a LATCH, not a countdown — the same lesson the mock FT
    /// carries. A countdown's decrement would live in the same receipt as
    /// `env::panic_str`, and a panic reverts every state change in its
    /// receipt, so the counter would never actually move.
    fail_signing: bool,
}

#[near]
impl MockMpc {
    #[init]
    pub fn new() -> Self {
        Self { seen: Vector::new(b"s"), fail_signing: false }
    }

    pub fn set_fail_signing(&mut self, fail: bool) {
        self.fail_signing = fail;
    }

    pub fn sign(&mut self, request: SignRequest) -> SignatureResponse {
        if self.fail_signing {
            env::panic_str("MOCK_MPC_REFUSED");
        }
        self.seen.push(request);
        SignatureResponse {
            big_r: "03".to_string() + &"ab".repeat(32),
            s: "cd".repeat(32),
            recovery_id: 0,
        }
    }

    // ----------------------------------------------------------- views

    pub fn sign_count(&self) -> u32 {
        self.seen.len()
    }

    /// Hex of the payload at `index`, so a test can assert on the exact bytes
    /// the vault asked to have signed.
    pub fn payload_hex(&self, index: u32) -> Option<String> {
        self.seen.get(index).map(|r| {
            r.payload.iter().map(|b| format!("{b:02x}")).collect::<String>()
        })
    }

    pub fn path_at(&self, index: u32) -> Option<String> {
        self.seen.get(index).map(|r| r.path.clone())
    }
}
