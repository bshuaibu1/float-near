#!/usr/bin/env bash
# Builds the wasm the sandbox tests load, into res/.
#
# RUN THIS IN LINUX (or WSL). near-workspaces only ships a sandbox node for
# linux-x86_64, linux-aarch64 and darwin-arm64 — there is no Windows sandbox,
# so the whole integration tier must run there.
#
# Uses `cargo near build`, NOT `cargo build --target wasm32-unknown-unknown`.
# near-sdk picks its host-function implementation by cfg: cargo-near sets
# `--cfg near` for the real on-chain host functions, while a plain cargo build
# gets `cfg(target_family="wasm")` pure-Rust fallbacks that near-sdk itself
# labels "not for on-chain use". Built the plain way, env::panic_str never
# reaches the host, so every panic arrives as a bare `unreachable` trap and
# this contract's stable reason codes are silently destroyed.
#
# The vault is built WITH `test-clock` on purpose — the day-boundary test needs
# a short budget window. That is exactly why this wasm must never be deployed:
# scripts/deploy-testnet.sh builds separately with --no-default-features and
# refuses to proceed unless clock_mode() == "production".
set -euo pipefail
cd "$(dirname "$0")/.."

command -v cargo-near >/dev/null || {
  echo "cargo-near not found. Install with: cargo install cargo-near --locked" >&2
  exit 1
}

OUT=res
mkdir -p "$OUT"
rm -f "$OUT"/*.wasm

build() { # <crate-dir> <output-name> [extra cargo-near args...]
  local dir="$1" name="$2"; shift 2
  echo "==> building $dir ${*:-}"
  ( cd "$dir" && cargo near build non-reproducible-wasm --out-dir "$(pwd)/../../$OUT/_tmp_$name" "$@" )
  find "$OUT/_tmp_$name" -name '*.wasm' -exec cp {} "$OUT/$name.wasm" \;
  rm -rf "$OUT/_tmp_$name"
}

build contracts/vault   vault_test_clock --features test-clock
build contracts/mock-ft mock_ft

echo
ls -l "$OUT"
echo
echo "NOTE: $OUT/vault_test_clock.wasm has a settable day length. Sandbox only."
