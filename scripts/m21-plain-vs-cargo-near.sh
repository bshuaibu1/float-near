#!/usr/bin/env bash
# M21, executed: does a plain `cargo build --target wasm32-unknown-unknown`
# really destroy this contract's panic reason codes?
#
# The repo contains two contradictory claims:
#   - the workspace Cargo.toml and docs/MUTATIONS.md M21 say a plain build
#     links near-sdk's pure-Rust fallbacks, so every panic arrives as
#     `WebAssembly trap: unreachable` and the reason code is gone;
#   - commit c732cbe says both artifacts import the same 40 `env` host
#     functions, and removed that claim as unsupported.
#
# Source reading cannot settle it: near-sdk 5.29.1 calls `sys::panic_utf8`
# from exactly one place with no cfg alternative, and `setup_panic_hook` is
# not cfg-gated either -- yet the two artifacts demonstrably differ. So build
# both HERE, in one environment with one toolchain and one profile, with the
# build command as the only variable, and ask the runtime.
#
# Usage: wsl -d Ubuntu -- bash /mnt/c/.../scripts/m21-plain-vs-cargo-near.sh
set -euo pipefail

REPO=/mnt/c/Users/BASHIR/Documents/near-vault
cd "$REPO"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/near-vault-target}"
export PATH="$HOME/.cargo/bin:$PATH"

echo "rustc      : $(rustc --version)"
echo "cargo-near : $(cargo-near --version)"
echo "target dir : $CARGO_TARGET_DIR"
echo

# res/m21/, NOT res/, deliberately: build-wasm.sh opens with `rm -f res/*.wasm`,
# so artifacts left at the top level are deleted by the next ordinary build and
# panic_reason_codes.rs then SKIPS -- reporting "2 passed" while testing
# nothing. A subdirectory survives that glob, which turns this row from a manual
# ritual into coverage that runs on every sandbox run.
mkdir -p res/m21

# Both builds use --features test-clock so the sandbox harness can load either
# one interchangeably, and both are --release so the profile is identical.
echo "=============== A: cargo near build (the correct way) ==============="
( cd contracts/vault && cargo near build non-reproducible-wasm --features test-clock \
    --out-dir "$REPO/res/m21/_tmp" )
find res/m21/_tmp -name '*.wasm' -exec cp {} res/m21/vault_cargo_near.wasm \;
rm -rf res/m21/_tmp

echo
echo "=============== B: plain cargo build (the suspect way) ==============="
cargo build -p vault --target wasm32-unknown-unknown --release --features test-clock
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/vault.wasm" res/m21/vault_plain.wasm

echo
echo "=============== sizes ==============="
for w in res/m21/vault_cargo_near.wasm res/m21/vault_plain.wasm; do
  printf '  %-34s %9s B\n' "$w" "$(wc -c < "$w")"
done

echo
echo "=============== grep (the UNRELIABLE method, for contrast) ==============="
# Shown deliberately: this is the measurement that produced the disagreement.
# A grep hit only proves the bytes appear somewhere -- name section, debug
# info, or string data all match -- so it cannot answer "is it IMPORTED?".
for w in res/m21/vault_cargo_near.wasm res/m21/vault_plain.wasm; do
  printf '  %-34s panic_utf8 bytes present: %s\n' "$w" "$(grep -c panic_utf8 "$w" || true)"
done

echo
echo "Now run, from Windows:"
echo "  node scripts/wasm-imports.mjs res/m21/vault_plain.wasm res/m21/vault_cargo_near.wasm"
echo "  wsl -d Ubuntu -- bash $REPO/scripts/wsl-sandbox.sh one panic_reason_codes"
