#!/usr/bin/env bash
# Upgrades an EXISTING vault in place, preserving its state.
#
# Why this is separate from deploy-testnet.sh. That script ends its deploy
# with `with-init-call new`, which is correct for a fresh vault and wrong
# here: `new` is `#[init]` and refuses to run against initialised state, so
# pointing it at a live vault aborts the whole transaction. (Atomically, so
# nothing is damaged — but nothing is upgraded either.)
#
# ---- THE MIGRATION, and why it is the DEFAULT rather than a flag.
#
# This script used to deploy `without-init-call`, with a note saying that was
# only safe "because the new code does not change the borsh layout of Vault"
# and that "if a future change adds a FIELD, this script is no longer
# sufficient". That condition fired: removing `base_config` (the 5th field of
# `#[near(contract_state)] struct Vault`) shifts every byte after it, so new
# code reading old bytes misparses from `nodes` onward and every method dies
# on PanicOnDefault. The note was correct and the script was not updated with
# it, which left a script whose only purpose is upgrading live vaults silently
# able to brick one.
#
# So the deploy now runs `migrate` as its init call, in the SAME transaction.
# Not a separate step: a deploy that lands without its migration leaves a vault
# that cannot answer a single view call, and there is no second chance to fix
# it from outside.
#
# Migrating is the DEFAULT because of which way it fails:
#   old layout + no migrate -> BRICKED. Every method panics. Unrecoverable
#                              except by another deploy.
#   new layout + migrate    -> `migrate` cannot deserialise the old struct,
#                              panics, and NEAR reverts the whole transaction
#                              atomically. Nothing changes. Safe.
# One direction destroys a vault, the other wastes some gas. The default must
# be the second. If the transaction aborts with a deserialize panic, that is
# this script telling you the vault is ALREADY migrated — re-run with
# NO_MIGRATE=1 for a layout-compatible upgrade.
#
# ---- NETWORK is a parameter, and this file is no longer called
# ---- upgrade-testnet.sh.
#
# It hardcoded the testnet network-config in BOTH deploy branches while taking
# the vault account as a variable. Pointing it at a mainnet vault therefore
# looked like it would work and silently addressed a testnet account of the
# same name — which for float.test015.near does not exist, so it would have
# failed, but for any name that exists on both networks it would have deployed
# to the wrong chain. The name said testnet and one of the two things it needed
# to know was a variable; that is the inconsistency.
#
# verify-upgrade.mjs defaults to a TESTNET rpc independently, so the network
# has to be threaded into the verifier too. Missing that gives the worst
# outcome available here: a real mainnet deploy followed by a green verdict
# obtained by reading a different chain.
#
# Usage:
#   VAULT=v4.floatv4.testnet bash scripts/upgrade-vault.sh
#   NO_MIGRATE=1 VAULT=... bash scripts/upgrade-vault.sh      # no field change
#   NETWORK=mainnet CONFIRM_MAINNET=1 NO_MIGRATE=1 VAULT=float.test015.near #     bash scripts/upgrade-vault.sh
#
# Requires: near-cli-rs, cargo-near, and a key for VAULT in the legacy keychain.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VAULT:?set VAULT to the existing vault account}"

NETWORK="${NETWORK:-testnet}"
case "$NETWORK" in
  testnet) DEFAULT_RPC="https://test.rpc.fastnear.com" ;;
  mainnet)
    DEFAULT_RPC="https://free.rpc.fastnear.com"
    # An explicit second key for real money. Every other guard here protects
    # against the wrong STATE; this one protects against the wrong CHAIN, which
    # no amount of state verification detects.
    [ "${CONFIRM_MAINNET:-0}" = "1" ] || {
      echo "FATAL: NETWORK=mainnet needs CONFIRM_MAINNET=1." >&2
      echo "       This deploys over a live vault holding real funds." >&2
      exit 1
    }
    ;;
  *) echo "FATAL: NETWORK must be testnet or mainnet, got '$NETWORK'" >&2; exit 1 ;;
esac

# The account suffix and the network must agree. A `.near` account on testnet or
# a `.testnet` account on mainnet is a typo in one of the two variables, and
# both reach the deploy as a perfectly well-formed request.
case "$NETWORK:$VAULT" in
  testnet:*.near)    echo "FATAL: $VAULT looks like a mainnet account but NETWORK=testnet" >&2; exit 1 ;;
  mainnet:*.testnet) echo "FATAL: $VAULT looks like a testnet account but NETWORK=mainnet" >&2; exit 1 ;;
esac

export NEAR_VAULT_RPC_URL="${NEAR_VAULT_RPC_URL:-$DEFAULT_RPC}"
echo "==> network: $NETWORK   vault: $VAULT   rpc: $NEAR_VAULT_RPC_URL"

# ---- Tooling, with the Windows trap named.
#
# On Windows, plain `bash` in PowerShell resolves to C:\WINDOWS\system32ash.exe
# — WSL — and NOT git-bash. A non-login WSL shell has no ~/.cargo/bin on PATH,
# so cargo-near reports "not found" while being perfectly well installed on the
# Windows side. The toolchain this script needs lives in git-bash:
#   near       -> /c/Users/<you>/AppData/Roaming/npm/near
#   cargo-near -> /c/Users/<you>/.cargo/bin/cargo-near
#
# So the check reports WHICH SHELL it is running in. "not found" in WSL is a
# wrong-shell problem; "not found" in MINGW64 is a missing-install problem, and
# the two have completely different fixes.
missing() {
  echo "FATAL: $1 not found.   shell: $(uname -s)" >&2
  case "$(uname -s)" in
    Linux*)
      echo "       This is WSL. On Windows, plain 'bash' is WSL's bash and its PATH" >&2
      echo "       omits ~/.cargo/bin. Use git-bash explicitly:" >&2
      echo "         & 'C:\Program Files\Gitinash.exe' -c \"...\"" >&2
      ;;
    *) echo "       Install it: $2" >&2 ;;
  esac
  exit 1
}
command -v near       >/dev/null || missing near       "npm i -g near-cli-rs"
command -v cargo-near >/dev/null || missing cargo-near "cargo install cargo-near --locked"

# ---- 1. Record what is there now.
#
# Run BEFORE the deploy, deliberately. "The state survived" is unfalsifiable
# without a before-picture, and reconstructing one afterwards from memory is
# how a silent loss gets signed off as a success.
#
# NEAR_VAULT_CONTRACT is exported, and that is not cosmetic. verify-upgrade.mjs
# defaults it to `v3.floatvault-12329.testnet`, so without this the script
# snapshotted and verified v3 while deploying to $VAULT — reporting a pass
# about a vault it never touched, and reading the protected demo to do it.
# A verifier pointed at the wrong account is worse than no verifier, because
# it produces a green result.
export NEAR_VAULT_CONTRACT="$VAULT"
echo "==> snapshotting live state of $NEAR_VAULT_CONTRACT"
node scripts/verify-upgrade.mjs snapshot

# ---- 2. Build with the PRODUCTION clock.
#
# cargo-near, never plain `cargo build --target wasm32-unknown-unknown`: the
# latter silently links near-sdk's pure-Rust fallbacks, after which every
# contract panic arrives as "unreachable opcode" and the reason codes this
# vault's whole UX depends on are gone. Tests still pass, so nothing warns you.
#
# NO_ABI=1 is required on Windows, for the same reason as in
# deploy-testnet.sh: cargo-near's ABI step compiles the crate natively as a
# cdylib and link.exe refuses to emit a DLL with near-sdk's host-function
# externs undefined. It skips only ABI metadata; the wasm build still runs
# through cargo-near, so --cfg near is preserved. That matters precisely
# because of the comment above.
ABI_FLAGS=()
if [ "${NO_ABI:-0}" = "1" ]; then
  echo "    NO_ABI=1: skipping ABI generation (required on Windows)"
  ABI_FLAGS+=(--no-abi)
fi
echo "==> building (production clock)"
( cd contracts/vault && cargo near build non-reproducible-wasm --no-default-features "${ABI_FLAGS[@]}" )

WASM=""
for base in "${CARGO_TARGET_DIR:-}" "target"; do
  [ -n "$base" ] || continue
  cand="$base/near/vault/vault.wasm"
  [ -f "$cand" ] && WASM="$cand" && break
done
[ -n "$WASM" ] || { echo "FATAL: built vault.wasm not found" >&2; exit 1; }
echo "    wasm: $WASM ($(wc -c < "$WASM") bytes)"

# ---- 3. Deploy over the top, migrating in the SAME transaction.
#
# Atomicity is the whole point. If `migrate` panics, NEAR reverts the deploy
# with it and the vault keeps running the old code against its old state —
# degraded to "not upgraded", never to "bricked". Splitting these into two
# transactions would open a window in which the new code is live and the state
# is still the old shape, and in that window every method panics.
if [ "${NO_MIGRATE:-0}" = "1" ]; then
  echo "==> deploying to $VAULT (NO_MIGRATE=1: no init call, state untouched)"
  echo "    Only correct when this build does NOT change the borsh layout of Vault."
  near contract deploy "$VAULT" use-file "$WASM" \
    without-init-call \
    network-config "$NETWORK" sign-with-legacy-keychain send
else
  echo "==> deploying to $VAULT with migrate() in the same transaction"
  near contract deploy "$VAULT" use-file "$WASM" \
    with-init-call migrate json-args '{}' \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi

# ---- 4. Prove it.
#
# Checks the tree, the ledgers' request history, the config, that the new
# methods actually resolve, and that the deployed build carries the production
# clock. Non-zero exit if any of those is wrong.
echo "==> verifying $NEAR_VAULT_CONTRACT"
node scripts/verify-upgrade.mjs verify

# A migration's real failure mode is not "the transaction failed" — that
# reverts safely — but "it succeeded and the state is subtly wrong". The
# verifier above compares the before/after snapshot, which is what catches
# that. Reaching here means the tree, ledgers, request history and config all
# matched what was recorded before the deploy.
echo
echo "==> OK: $NEAR_VAULT_CONTRACT upgraded and state verified against the pre-deploy snapshot"
