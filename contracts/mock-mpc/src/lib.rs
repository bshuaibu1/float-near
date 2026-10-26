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

/// Mirrors v1.signer-prod.testnet's CURRENT args, read off its embedded ABI
/// and confirmed by a live call on 2026-10-26.
///
/// The first version of this mock used `{payload: [u8;32], key_version}` — a
/// shape the real signer only accepts through a deprecated alias — and it was
/// also missing the fact that `sign` is PAYABLE. Both were invisible because a
/// mock agrees with whatever the caller sends. Matching the real names here is
/// what makes the sandbox tier able to fail for the right reason.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SignRequest {
    pub payload_v2: Payload,
    pub path: String,
    pub domain_id: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub enum Payload {
    Ecdsa(String),
}

/// The real response is NESTED, not flat. Captured verbatim from a live call:
///
/// ```json
/// {"big_r":{"affine_point":"03b69c…"},"recovery_id":0,
///  "s":{"scalar":"199423…"},"scheme":"Secp256k1"}
/// ```
///
/// Shape and size both matter: the vault's callback bounds how much of the
/// promise result it copies (MAX_MPC_RESULT_LEN), so a response that was
/// unrealistically small would not exercise that bound.
#[near(serializers = [borsh, json])]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [borsh, json])]
pub struct Scalar {
    pub scalar: String,
}

#[near(serializers = [borsh, json])]
pub struct SignatureResponse {
    pub big_r: AffinePoint,
    pub recovery_id: u8,
    pub s: Scalar,
    pub scheme: String,
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

    /// `#[payable]` because the real one is: it asks for a deposit per request
    /// so the signer network cannot be spammed. A non-payable mock would make
    /// a vault that attaches no deposit look correct, which is exactly what
    /// happened before this was measured.
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> SignatureResponse {
        if self.fail_signing {
            env::panic_str("MOCK_MPC_REFUSED");
        }
        // The real signer rejects a deposit-free request. Asserting it here
        // means the sandbox tier catches an omission the live network would.
        assert!(
            env::attached_deposit() >= near_sdk::NearToken::from_yoctonear(1),
            "MOCK_MPC_NO_DEPOSIT: sign requires a deposit, as the real signer does",
        );
        self.seen.push(request);
        SignatureResponse {
            big_r: AffinePoint { affine_point: "03".to_string() + &"ab".repeat(32) },
            recovery_id: 0,
            s: Scalar { scalar: "cd".repeat(32) },
            scheme: "Secp256k1".to_string(),
        }
    }

    // ----------------------------------------------------------- views

    pub fn sign_count(&self) -> u32 {
        self.seen.len()
    }

    /// The exact payload the vault asked to have signed. Already hex on the
    /// current interface.
    pub fn payload_hex(&self, index: u32) -> Option<String> {
        self.seen.get(index).map(|r| match &r.payload_v2 {
            Payload::Ecdsa(hex) => hex.clone(),
        })
    }

    pub fn domain_at(&self, index: u32) -> Option<u64> {
        self.seen.get(index).map(|r| r.domain_id)
    }

    pub fn path_at(&self, index: u32) -> Option<String> {
        self.seen.get(index).map(|r| r.path.clone())
    }
}
