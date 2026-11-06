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
# ---- THE FOUR PREFLIGHTS, in the order they cost you money.
#
# Added after a single mainnet upgrade on 2026-10-31 failed four separate
# times. Each failure was predicted by a note somewhere in this repo and each
# one still cost a full cycle, because nothing checked before acting:
#
#   1. the wrong SHELL   plain `bash` on Windows is WSL, where cargo-near is
#                        absent and $env:VAULT is not inherited
#   2. the ABI step      cargo-near's native cdylib pass cannot link on Windows
#   3. the SIGNER key    the credential file held a key removed from the account
#   4. the STORAGE cost  a bigger contract raises the locked balance
#
# 1 and 2 are decided in scripts/lib/shell-env.sh, which takes `uname -s`, the
# cwd and the kernel release as arguments precisely so both branches can be
# tested from one shell (test/shell-env.test.mjs). 3 and 4 are read off chain
# BEFORE the build, because a build takes minutes and all three of the failed
# deploys paid for one before dying.
#
# Usage:
#   VAULT=v4.floatv4.testnet bash scripts/upgrade-vault.sh
#   NO_MIGRATE=1 VAULT=... bash scripts/upgrade-vault.sh      # no field change
#   NETWORK=mainnet CONFIRM_MAINNET=1 NO_MIGRATE=1 \
#     VAULT=float.test015.near bash scripts/upgrade-vault.sh
#
# On Windows, call git-bash explicitly and pass the variables INSIDE it:
#   & 'C:\Program Files\Git\bin\bash.exe' -c "VAULT=... bash scripts/upgrade-vault.sh"
#
# Requires: near-cli-rs, cargo-near, and a key for VAULT in the legacy keychain.
set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/shell-env.sh

# ---- 0. Which shell is this, and is it the right one?
#
# FIRST, before the VAULT check, and that ordering is the entire point. Run
# under WSL from PowerShell, the symptom is this script aborting with
# "set VAULT to the existing vault account" — because WSL does not inherit
# $env:VAULT — which reads as a usage mistake and sends you looking at the
# wrong thing. Naming the shell first turns a confusing error into a correct
# one.
SHELL_KIND="$(shell_kind "$(uname -s)" "$(cat /proc/sys/kernel/osrelease 2>/dev/null || true)")"

if [ "$(wsl_verdict "$SHELL_KIND" "$(pwd)" "${ALLOW_WSL:-0}")" = "trap" ]; then
  echo "FATAL: this is WSL's bash, working on a Windows path ($(pwd))." >&2
  echo "" >&2
  echo "  In PowerShell, plain 'bash' resolves to C:\\WINDOWS\\system32\\bash.exe," >&2
  echo "  which is WSL and NOT git-bash. Three things break at once here and only" >&2
  echo "  one of them says so:" >&2
  echo "    - \$env:VAULT is not inherited, so this script aborts with 'set VAULT'" >&2
  echo "    - cargo-near is absent: WSL's PATH carries no ~/.cargo/bin" >&2
  echo "    - 'near' IS present, resolved to the Windows .exe through /mnt/c, so a" >&2
  echo "      tool check passes and the Windows binary then gets /mnt/c/... paths" >&2
  echo "" >&2
  echo "  Use git-bash, and set the variables INSIDE it:" >&2
  echo '    & '"'"'C:\Program Files\Git\bin\bash.exe'"'"' -c "VAULT=<vault> NETWORK=<net> bash scripts/upgrade-vault.sh"' >&2
  echo "" >&2
  echo "  If you really do mean to build inside WSL, re-run with ALLOW_WSL=1." >&2
  exit 1
fi
echo "==> shell: $SHELL_KIND"

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

# ---- Tooling.
#
# The WSL case is already handled above, so a "not found" here is a genuine
# missing install. The shell is still reported, because the two have completely
# different fixes and the message should not have to be guessed at.
missing() {
  echo "FATAL: $1 not found.   shell: $SHELL_KIND ($(uname -s))" >&2
  echo "       Install it: $2" >&2
  exit 1
}
command -v near       >/dev/null || missing near       "npm i -g near-cli-rs"
command -v cargo-near >/dev/null || missing cargo-near "cargo install cargo-near --locked"

# ---- 1. Can the key on disk even sign this deploy?
#
# FIRST of the on-chain checks and well before the build, because this is the
# one that cost three cycles. A DeployContract action applies to the signer's
# own account, so a deploy's signer_id must equal its receiver_id: the only key
# that can upgrade the vault is a full-access key ON the vault. near-cli-rs's
# legacy keychain picks that key by FILENAME, so `sign-with-legacy-keychain`
# reads ~/.near-credentials/<network>/<VAULT>.json and signs with whatever is
# in it.
#
# Measured 2026-10-31: float.test015.near.json still held ed25519:Bb9qZA8...,
# the setup key a hand rotation had removed from the account and left on disk.
# Three deploys failed at the signing step, each after a full cargo-near build.
# The file had been described in this repo as "inert"; it is in fact how
# near-cli chooses the signer.
echo "==> checking the signing key for $VAULT"
if ! node scripts/check-signer-key.mjs "$VAULT" "$NETWORK" "$NEAR_VAULT_RPC_URL"; then
  echo "FATAL: refusing to build — the key on disk cannot sign this deploy." >&2
  exit 1
fi

# ---- 2. Record what is there now.
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

# ---- 3. Build with the PRODUCTION clock — OR deploy a PINNED artifact.
#
# USE_WASM=<path> skips the build and deploys that file. Added because this
# script could only ever deploy what it had just rebuilt, which is the wrong
# thing in the one case where the exact bytes are load-bearing: redeploying the
# artifact that was ALREADY validated on testnet and ALREADY published to npm.
# `cargo near build non-reproducible-wasm` is, by its own name, not guaranteed
# to reproduce those bytes, so a rebuild is only PROBABLY identical — and
# "probably" is not good enough for a mainnet deploy whose entire purpose is to
# prove a claim about the published artifact.
#
# EXPECT_CODE_HASH pins it. Without that, USE_WASM only moves the question from
# "did the rebuild match?" to "did I point at the right file?", so the hash is
# checked here and the deploy refuses on a mismatch.
#
# It is base58(sha256(wasm)) — NEAR's OWN code_hash encoding, not hex. That is
# deliberate: the same string can be read straight back off the chain from
# viewAccount().code_hash, so the pre-deploy pin and the post-deploy proof are
# the same value in the same format. A hex digest would need converting to
# compare, and the conversion is where a "verification" stops verifying.
if [ -n "${USE_WASM:-}" ]; then
  [ -f "$USE_WASM" ] || { echo "FATAL: USE_WASM=$USE_WASM does not exist" >&2; exit 1; }
  WASM="$USE_WASM"
  echo "==> SKIPPING the build: deploying the pinned artifact"
  echo "    wasm: $WASM ($(wc -c < "$WASM") bytes)"
  GOT="$(node scripts/wasm-hash.mjs "$WASM" | tr -cd '[:alnum:]')"
  echo "    code hash $GOT"
  case "$(artifact_verdict "$GOT" "${EXPECT_CODE_HASH:-}")" in
    match)
      echo "    matches EXPECT_CODE_HASH" ;;
    unverified)
      echo "    WARNING: no EXPECT_CODE_HASH given — this artifact is unverified" >&2 ;;
    mismatch)
      echo "FATAL: artifact hash mismatch — refusing to deploy." >&2
      echo "  expected ${EXPECT_CODE_HASH:-<empty>}" >&2
      echo "  got      ${GOT:-<empty>}" >&2
      exit 1 ;;
  esac
else

# cargo-near, never plain `cargo build --target wasm32-unknown-unknown`: the
# latter silently links near-sdk's pure-Rust fallbacks, after which every
# contract panic arrives as "unreachable opcode" and the reason codes this
# vault's whole UX depends on are gone. Tests still pass, so nothing warns you.
#
# The ABI step is skipped on git-bash AUTOMATICALLY. cargo-near compiles the
# crate a second time, natively, as a cdylib to extract ABI metadata, and
# link.exe refuses to emit a DLL with near-sdk's host-function externs
# undefined — about 52 LNK2019 errors. This used to require remembering
# NO_ABI=1, which is a thing you learn only after the build has failed; it cost
# a cycle on 2026-10-31 and the repo's own memory file had already recorded it.
#
# --no-abi drops only the metadata. The wasm still goes through cargo-near, so
# `--cfg near` is preserved and the reason codes survive, which is exactly why
# the paragraph above matters.
#
# NO_ABI overrides the automatic choice in both directions: 1 forces skip,
# 0 forces the ABI step even on Windows.
ABI_FLAGS=()
case "${NO_ABI:-auto}" in
  1) ABI_DECISION="skip"; ABI_WHY="NO_ABI=1" ;;
  0) ABI_DECISION="build"; ABI_WHY="NO_ABI=0" ;;
  *) ABI_DECISION="$(abi_policy "$SHELL_KIND")"; ABI_WHY="auto, shell=$SHELL_KIND" ;;
esac
if [ "$ABI_DECISION" = "skip" ]; then
  echo "    skipping ABI generation ($ABI_WHY) — link.exe cannot build the native cdylib"
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
echo "    sha256 $(node scripts/wasm-hash.mjs "$WASM" | tr -cd '[:alnum:]')"

fi

# ---- 4. Will it still FIT?
#
# NEAR locks storage_usage * 1e19 yocto. A deploy changes usage by the
# code-size delta, so a bigger contract raises the locked amount — and if that
# exceeds the balance the deploy fails with LackBalanceForState.
#
# Measured 2026-10-31: the approval gate grew the vault 284,572 -> 299,016
# bytes, taking float.test015.near from locked 2.90165 to 3.04609 against a
# 2.98807 balance. SHORT by 0.05802. There was no check here, so this script
# would have sent the deploy and failed in flight. Atomic, so nothing breaks,
# but on a live mainnet vault that reads as a broken upgrade instead of "top
# the account up first".
#
# The shortfall is NOT the code delta: the account may already carry headroom.
echo "==> checking the storage margin for $VAULT"
if ! node scripts/check-upgrade-margin.mjs "$VAULT" "$WASM" "$NEAR_VAULT_RPC_URL"; then
  echo "FATAL: refusing to deploy — see the top-up above." >&2
  exit 1
fi

# ---- 5. Deploy over the top, migrating in the SAME transaction.
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

# ---- 6. Prove it.
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
