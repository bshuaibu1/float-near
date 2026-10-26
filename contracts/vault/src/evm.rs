//! Building the exact Base transaction the vault is willing to sign.
//!
//! The whole point: the contract does NOT accept a payload to sign. It
//! constructs the ERC-20 calldata and the EIP-1559 transaction itself, from
//! the amount and recipient it already authorized against the budget tree, and
//! signs the hash of its own construction.
//!
//! Accepting an opaque hash would make the leash decorative — a compromised
//! agent would pass the hash of a transfer to its own address, or of
//! `approve(attacker, MAX)`, and the budget check and payee allowlist would
//! both be satisfied while the signature authorized something else entirely.
//! Everything that determines WHERE value goes (`to`, `value`, `data`) is
//! built here. Only fee and nonce fields come from the caller, and those
//! cannot redirect funds.

use near_sdk::env;

/// `transfer(address,uint256)`
const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
pub const EIP1559_TX_TYPE: u8 = 0x02;

/// Parse a lowercase `0x`-prefixed 20-byte hex address.
///
/// Lowercase only, deliberately: the same string is matched against the node's
/// payee allowlist, and accepting mixed case would let `0xAbC…` and `0xabc…`
/// be two different allowlist entries for one address.
pub fn parse_evm_address(s: &str) -> Option<[u8; 20]> {
    let hex = s.strip_prefix("0x")?;
    if hex.len() != 40 || !hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let hi = (chunk[0] as char).to_digit(16)? as u8;
        let lo = (chunk[1] as char).to_digit(16)? as u8;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

/// ERC-20 `transfer(to, amount)` calldata: 4-byte selector + two 32-byte words.
pub fn erc20_transfer_calldata(to: [u8; 20], amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(68);
    data.extend_from_slice(&ERC20_TRANSFER_SELECTOR);
    // address is left-padded to 32 bytes
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&to);
    // uint256, big-endian, left-padded to 32 bytes
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&amount.to_be_bytes());
    data
}

/// Big-endian minimal byte representation. RLP encodes zero as the EMPTY
/// string, not as a zero byte — getting this wrong changes the hash.
fn be_minimal(n: u128) -> Vec<u8> {
    if n == 0 {
        return Vec::new();
    }
    let full = n.to_be_bytes();
    let first = full.iter().position(|b| *b != 0).unwrap_or(15);
    full[first..].to_vec()
}

/// RLP-encode a byte string.
pub fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len() + 9);
    if b.len() == 1 && b[0] <= 0x7f {
        out.push(b[0]);
    } else if b.len() <= 55 {
        out.push(0x80 + b.len() as u8);
        out.extend_from_slice(b);
    } else {
        let len = be_minimal(b.len() as u128);
        out.push(0xb7 + len.len() as u8);
        out.extend_from_slice(&len);
        out.extend_from_slice(b);
    }
    out
}

/// RLP-encode an unsigned integer (as its minimal big-endian string).
pub fn rlp_uint(n: u128) -> Vec<u8> {
    rlp_bytes(&be_minimal(n))
}

/// RLP-encode a list whose items are ALREADY encoded.
pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.concat();
    let mut out = Vec::with_capacity(payload.len() + 9);
    if payload.len() <= 55 {
        out.push(0xc0 + payload.len() as u8);
    } else {
        let len = be_minimal(payload.len() as u128);
        out.push(0xf7 + len.len() as u8);
        out.extend_from_slice(&len);
    }
    out.extend_from_slice(&payload);
    out
}

pub struct Eip1559Fields {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    /// The ERC-20 contract. NOT the payee — for a token transfer the payee is
    /// inside `data`, and `to` is the token itself.
    pub to: [u8; 20],
    pub data: Vec<u8>,
}

/// The unsigned EIP-1559 payload: `0x02 || rlp([...])`.
pub fn eip1559_unsigned(f: &Eip1559Fields) -> Vec<u8> {
    let items = vec![
        rlp_uint(f.chain_id as u128),
        rlp_uint(f.nonce as u128),
        rlp_uint(f.max_priority_fee_per_gas),
        rlp_uint(f.max_fee_per_gas),
        rlp_uint(f.gas_limit as u128),
        rlp_bytes(&f.to),
        rlp_uint(0), // value: an ERC-20 transfer moves no native ETH
        rlp_bytes(&f.data),
        rlp_list(&[]), // empty access list
    ];
    let mut out = Vec::with_capacity(1 + items.iter().map(|i| i.len()).sum::<usize>() + 9);
    out.push(EIP1559_TX_TYPE);
    out.extend_from_slice(&rlp_list(&items));
    out
}

/// Lowercase hex, no `0x`.
///
/// The MPC contract's current interface takes the payload as a hex STRING
/// (`payload_v2: {"Ecdsa": "<64 hex>"}`), not as a byte array. Measured against
/// v1.signer-prod.testnet on 2026-10-26.
pub fn hex32(b: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for byte in b {
        s.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap());
    }
    s
}

/// The 32-byte hash the MPC network signs.
pub fn eip1559_sighash(f: &Eip1559Fields) -> [u8; 32] {
    let digest = env::keccak256(&eip1559_unsigned(f));
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // RLP vectors from the canonical specification. These are the reference,
    // not this implementation — a self-consistent encoder that is wrong in the
    // same way everywhere would otherwise look correct.
    #[test]
    fn rlp_matches_the_canonical_spec_vectors() {
        assert_eq!(rlp_bytes(b"dog"), vec![0x83, b'd', b'o', b'g']);
        assert_eq!(rlp_bytes(b""), vec![0x80]);
        assert_eq!(rlp_bytes(&[0x00]), vec![0x00]); // single byte < 0x80 is itself
        assert_eq!(rlp_bytes(&[0x0f]), vec![0x0f]);
        assert_eq!(rlp_bytes(&[0x04, 0x00]), vec![0x82, 0x04, 0x00]);
        assert_eq!(rlp_list(&[]), vec![0xc0]);
        assert_eq!(
            rlp_list(&[rlp_bytes(b"cat"), rlp_bytes(b"dog")]),
            vec![0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']
        );
    }

    /// The 55/56-byte boundary is where the short form becomes the long form.
    #[test]
    fn rlp_switches_to_the_long_form_at_exactly_56_bytes() {
        let fifty_five = vec![b'a'; 55];
        let fifty_six = vec![b'a'; 56];
        assert_eq!(rlp_bytes(&fifty_five)[0], 0x80 + 55);
        assert_eq!(&rlp_bytes(&fifty_six)[..2], &[0xb8, 56]);
    }

    /// RLP encodes integer zero as the EMPTY string, not as a zero byte.
    /// Encoding it as 0x00 produces a different, silently wrong hash.
    #[test]
    fn rlp_uint_encodes_zero_as_the_empty_string() {
        assert_eq!(rlp_uint(0), vec![0x80]);
        assert_eq!(rlp_uint(1), vec![0x01]);
        assert_eq!(rlp_uint(127), vec![0x7f]);
        assert_eq!(rlp_uint(128), vec![0x81, 0x80]);
        assert_eq!(rlp_uint(1024), vec![0x82, 0x04, 0x00]);
    }

    #[test]
    fn be_minimal_strips_leading_zeroes() {
        assert_eq!(be_minimal(0), Vec::<u8>::new());
        assert_eq!(be_minimal(1), vec![0x01]);
        assert_eq!(be_minimal(256), vec![0x01, 0x00]);
        assert_eq!(be_minimal(u128::MAX), vec![0xff; 16]);
    }

    #[test]
    fn hex32_is_64_lowercase_chars_with_no_prefix() {
        let mut b = [0u8; 32];
        b[0] = 0x0a;
        b[31] = 0xff;
        let h = hex32(&b);
        assert_eq!(h.len(), 64);
        assert!(h.starts_with("0a"), "{h}");
        assert!(h.ends_with("ff"), "{h}");
        assert!(!h.contains("0x"));
        assert_eq!(h, h.to_lowercase());
        // Leading nibble must NOT be trimmed: this is a fixed-width field, and
        // a 63-char string is rejected by the signer's Min32/Max32 bound.
        assert_eq!(hex32(&[0u8; 32]), "0".repeat(64));
    }

    #[test]
    fn parses_a_lowercase_evm_address() {
        let a = parse_evm_address("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913").unwrap();
        assert_eq!(a[0], 0x83);
        assert_eq!(a[19], 0x13);
    }

    /// Mixed case is REJECTED on purpose: the same string is matched against
    /// the payee allowlist, so accepting both cases would make one address two
    /// distinct allowlist entries.
    #[test]
    fn rejects_anything_that_is_not_a_lowercase_20_byte_address() {
        for bad in [
            "833589fcd6edb6e08f4c7c32d4f71b54bda02913",   // no 0x
            "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913", // uppercase
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda029",   // too short
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda0291333", // too long
            "0xzz3589fcd6edb6e08f4c7c32d4f71b54bda02913", // non-hex
            "0x",
            "",
        ] {
            assert!(parse_evm_address(bad).is_none(), "accepted {bad}");
        }
    }

    #[test]
    fn erc20_calldata_has_the_transfer_selector_and_two_padded_words() {
        let to = parse_evm_address("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913").unwrap();
        let d = erc20_transfer_calldata(to, 60_000_000);

        assert_eq!(d.len(), 4 + 32 + 32);
        assert_eq!(&d[..4], &[0xa9, 0x05, 0x9c, 0xbb]); // transfer(address,uint256)
        assert_eq!(&d[4..16], &[0u8; 12]); // address left-padded
        assert_eq!(&d[16..36], &to);
        assert_eq!(u128::from_be_bytes(d[52..68].try_into().unwrap()), 60_000_000);
    }

    /// The security property, stated as a test: change WHO is paid or HOW
    /// MUCH, and the bytes being signed change. If this ever held constant,
    /// the signature would not be bound to the authorized payment.
    #[test]
    fn calldata_changes_with_recipient_and_amount() {
        let a = parse_evm_address("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913").unwrap();
        let b = parse_evm_address("0x4200000000000000000000000000000000000006").unwrap();
        assert_ne!(erc20_transfer_calldata(a, 100), erc20_transfer_calldata(b, 100));
        assert_ne!(erc20_transfer_calldata(a, 100), erc20_transfer_calldata(a, 101));
    }

    fn fields() -> Eip1559Fields {
        Eip1559Fields {
            chain_id: 84532,
            nonce: 0,
            max_priority_fee_per_gas: 1_000_000,
            max_fee_per_gas: 20_000_000,
            gas_limit: 100_000,
            to: parse_evm_address("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913").unwrap(),
            data: erc20_transfer_calldata(
                parse_evm_address("0x4200000000000000000000000000000000000006").unwrap(),
                60_000_000,
            ),
        }
    }

    #[test]
    fn unsigned_payload_is_type_2_then_a_nine_item_rlp_list() {
        let p = eip1559_unsigned(&fields());
        assert_eq!(p[0], 0x02, "EIP-1559 type byte");
        // 68-byte calldata pushes the list past 55 bytes, so the long form.
        assert!(p[1] >= 0xf7, "expected a long-form RLP list, got {:#x}", p[1]);
        assert_eq!(*p.last().unwrap(), 0xc0, "trailing empty access list");
    }

    #[test]
    fn the_payload_changes_when_any_authorized_field_changes() {
        let base = eip1559_unsigned(&fields());
        let mut other = fields();
        other.chain_id = 8453;
        assert_ne!(base, eip1559_unsigned(&other), "chain id not bound");

        let mut amt = fields();
        amt.data = erc20_transfer_calldata(
            parse_evm_address("0x4200000000000000000000000000000000000006").unwrap(),
            60_000_001,
        );
        assert_ne!(base, eip1559_unsigned(&amt), "amount not bound");
    }
}
