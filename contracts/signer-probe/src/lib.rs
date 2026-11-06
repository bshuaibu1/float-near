//! What does a contract see when a FUNCTION-CALL KEY ON ITS OWN ACCOUNT signs
//! a call to it?
//!
//! WHY THIS EXISTS. A design proposed 2026-10-31 would delete the relayer from
//! Float's architecture. Instead of `request_payment_signed` plus a relayer that
//! fronts gas and must be reimbursed, the agent gets an access key ON THE VAULT,
//! restricted to `request_payment`, carrying a NEAR `allowance`. Then the agent
//! submits its own transactions and pays its own gas, metered by the protocol;
//! `allowance` becomes a hard second budget for free; and the per-agent cost
//! drops from 0.55 NEAR (a sub-account) to ~0.05 (an allowance).
//!
//! Three protocol facts this repo had never tested:
//!
//!   Q1  Does NEAR accept an AddKey whose FunctionCall `receiver_id` IS the
//!       account the key is being added to?
//!   Q2  Can that key sign a call, and does gas come from its ALLOWANCE?
//!   Q3  What does the contract see? `predecessor_account_id()` will be the
//!       vault itself, so the ONLY thing that can tell one agent from another
//!       is `signer_account_pk()`. If that is not the signing key, the design
//!       is dead. Float already maps pubkey -> node (`pubkey_to_node`, built
//!       for virtual agents), so if it IS, the lookup already exists.
//!
//! NO near-sdk, NO std. The questions are about host functions, so they are
//! declared as externs and called directly: nothing sits between the
//! measurement and the thing measured. near-sdk silently substituting
//! pure-Rust fallbacks for host functions is the exact class of surprise this
//! repo has already been bitten by (root Cargo.toml, the panic_utf8 note).
//!
//! Returns a pipe-delimited string rather than JSON — hand-writing a JSON
//! encoder would add code to the one thing being kept small, and the driver can
//! split on a pipe.

#![no_std]

use core::panic::PanicInfo;
use core::ptr::addr_of_mut;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// The NEAR host ABI. Each `*_account_*` call writes into a REGISTER rather than
// returning, so every read is two steps: ask the length, then copy it out.
#[link(wasm_import_module = "env")]
extern "C" {
    fn current_account_id(register_id: u64);
    fn signer_account_id(register_id: u64);
    fn signer_account_pk(register_id: u64);
    fn predecessor_account_id(register_id: u64);
    fn register_len(register_id: u64) -> u64;
    fn read_register(register_id: u64, ptr: u64);
    fn value_return(value_len: u64, value_ptr: u64);
}

const CAP: usize = 1024;
static mut OUT: [u8; CAP] = [0; CAP];
static mut SCRATCH: [u8; 256] = [0; 256];

/// Copy register 0 into SCRATCH and return the length actually read.
unsafe fn take_register() -> usize {
    let n = register_len(0) as usize;
    if n == 0 || n > 256 {
        return 0;
    }
    read_register(0, addr_of_mut!(SCRATCH) as *mut u8 as u64);
    n
}

unsafe fn push(out_len: &mut usize, bytes: *const u8, n: usize) {
    let out = addr_of_mut!(OUT) as *mut u8;
    for i in 0..n {
        if *out_len >= CAP {
            return;
        }
        *out.add(*out_len) = *bytes.add(i);
        *out_len += 1;
    }
}

unsafe fn push_byte(out_len: &mut usize, b: u8) {
    let out = addr_of_mut!(OUT) as *mut u8;
    if *out_len < CAP {
        *out.add(*out_len) = b;
        *out_len += 1;
    }
}

/// Lowercase hex, hand-rolled: `format!` would pull in std's formatting
/// machinery and is the single biggest thing that would grow this binary.
unsafe fn push_hex(out_len: &mut usize, bytes: *const u8, n: usize) {
    const H: &[u8; 16] = b"0123456789abcdef";
    for i in 0..n {
        let b = *bytes.add(i);
        push_byte(out_len, H[(b >> 4) as usize]);
        push_byte(out_len, H[(b & 0x0f) as usize]);
    }
}

/// `"current|predecessor|signer|<signer_pk as hex>"`
///
/// A CHANGE method as far as the RPC is concerned: a view call has no signer at
/// all, so none of these questions can be asked of one.
///
/// WRAPPED IN DOUBLE QUOTES so the payload is a valid JSON string. near-api-js
/// returns `getTransactionLastResult`, which JSON-parses the SuccessValue — a
/// bare `a|b|c` is not JSON, and the client would either throw or hand back
/// undefined. Two quote bytes is cheaper than arguing with the client, and
/// cheaper than hand-writing a JSON object encoder in a 993-byte binary.
#[no_mangle]
pub extern "C" fn whoami() {
    unsafe {
        let mut len = 0usize;
        let scratch = addr_of_mut!(SCRATCH) as *const u8;
        push_byte(&mut len, b'"');

        current_account_id(0);
        let n = take_register();
        push(&mut len, scratch, n);
        push_byte(&mut len, b'|');

        predecessor_account_id(0);
        let n = take_register();
        push(&mut len, scratch, n);
        push_byte(&mut len, b'|');

        signer_account_id(0);
        let n = take_register();
        push(&mut len, scratch, n);
        push_byte(&mut len, b'|');

        // The whole question. 33 bytes for ed25519: a curve-type prefix byte
        // (0) followed by the 32-byte key. Returned as hex so the driver can
        // compare it to a key it generated without guessing an encoding.
        signer_account_pk(0);
        let n = take_register();
        push_hex(&mut len, scratch, n);

        push_byte(&mut len, b'"');
        value_return(len as u64, addr_of_mut!(OUT) as *const u8 as u64);
    }
}

/// Burns gas so an allowance delta is measurable above the noise of one cheap
/// call. No host calls, no state: a pure loop the gas meter still charges for.
#[no_mangle]
pub extern "C" fn burn() {
    unsafe {
        let mut acc: u64 = 1;
        for i in 0..200_000u64 {
            acc = acc.wrapping_mul(6364136223846793005).wrapping_add(i);
        }
        let mut len = 0usize;
        push_byte(&mut len, b'"');
        push_hex(&mut len, &acc as *const u64 as *const u8, 8);
        push_byte(&mut len, b'"');
        value_return(len as u64, addr_of_mut!(OUT) as *const u8 as u64);
    }
}
