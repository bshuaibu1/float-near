#!/usr/bin/env bash
# Upgrades an EXISTING vault in place, preserving its state.
#
# Why this is separate from deploy-testnet.sh. That script ends its deploy
# with `with-init-call new`, which is correct for a fresh vault and wrong
# here: `new` is `#[init]` and refuses to run against initialised state, so
# pointing it at a live vault aborts the whole transaction. (Atomically, so
# nothing is damaged — but nothing is upgraded either.) This one deploys
# `without-init-call` and leaves the existing state exactly where it is.
#
# The upgrade is only safe because the new code does not change the borsh
# layout of `Vault`: `pending_owner` lives under its own storage key rather
# than as a struct field. If a future change adds a FIELD, this script is no
# longer sufficient and a migration is required.
#
# Usage:
#   VAULT=v3.floatvault-12329.testnet bash scripts/upgrade-testnet.sh
#
# Requires: near-cli-rs, cargo-near, and a key for VAULT in the legacy keychain.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VAULT:?set VAULT to the existing vault account}"

command -v near >/dev/null || { echo "near CLI not found" >&2; exit 1; }
command -v cargo-near >/dev/null || {
  echo "cargo-near not found. Install: cargo install cargo-near --locked" >&2; exit 1; }

# ---- 1. Record what is there now.
#
# Run BEFORE the deploy, deliberately. "The state survived" is unfalsifiable
# without a before-picture, and reconstructing one afterwards from memory is
# how a silent loss gets signed off as a success.
echo "==> snapshotting live state"
node scripts/verify-upgrade.mjs snapshot

# ---- 2. Build with the PRODUCTION clock.
#
# cargo-near, never plain `cargo build --target wasm32-unknown-unknown`: the
# latter silently links near-sdk's pure-Rust fallbacks, after which every
# contract panic arrives as "unreachable opcode" and the reason codes this
# vault's whole UX depends on are gone. Tests still pass, so nothing warns you.
echo "==> building (production clock)"
( cd contracts/vault && cargo near build non-reproducible-wasm --no-default-features )

WASM=""
for base in "${CARGO_TARGET_DIR:-}" "target"; do
  [ -n "$base" ] || continue
  cand="$base/near/vault/vault.wasm"
  [ -f "$cand" ] && WASM="$cand" && break
done
[ -n "$WASM" ] || { echo "FATAL: built vault.wasm not found" >&2; exit 1; }
echo "    wasm: $WASM ($(wc -c < "$WASM") bytes)"

# ---- 3. Deploy over the top. No init call.
echo "==> deploying to $VAULT (no init call — state is preserved)"
near contract deploy "$VAULT" use-file "$WASM" \
  without-init-call \
  network-config testnet sign-with-legacy-keychain send

# ---- 4. Prove it.
#
# Checks the tree, the ledgers' request history, the config, that the new
# methods actually resolve, and that the deployed build carries the production
# clock. Non-zero exit if any of those is wrong.
echo "==> verifying"
node scripts/verify-upgrade.mjs verify
