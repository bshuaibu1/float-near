#!/usr/bin/env bash
# Deploys the vault to testnet, and REFUSES if the binary it just deployed
# carries the test clock.
#
# Why this exists: the sandbox tier builds the vault with `--features
# test-clock`, which exposes `set_day_len_ns` and lets the owner shrink the
# budget window to 100 ms. Correct for a deterministic day-boundary test,
# catastrophic in production — a one-second "day" refills a daily cap a
# thousand times an hour.
#
# The feature is non-default, so a plain build cannot pick it up by accident.
# This is the second line of defence: build it here, then interrogate what was
# actually deployed rather than what we meant to deploy.
#
# Usage:
#   VAULT=vault.me.testnet OWNER=me.testnet bash scripts/deploy-testnet.sh
#
# Requires: near-cli-rs, cargo-near, and a key for VAULT in the legacy keychain.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VAULT:?set VAULT to the account the vault contract will live on}"
: "${OWNER:?set OWNER to the account that will own the vault}"

if [ "$VAULT" = "$OWNER" ]; then
  echo "FATAL: the contract rejects owner == vault. Use a sub-account, e.g. vault.$OWNER" >&2
  exit 1
fi

command -v near >/dev/null || { echo "near CLI not found" >&2; exit 1; }
command -v cargo-near >/dev/null || {
  echo "cargo-near not found. Install: cargo install cargo-near --locked" >&2
  exit 1
}

echo "==> building vault with --no-default-features (production clock)"
( cd contracts/vault && cargo near build non-reproducible-wasm --no-default-features )

# cargo-near writes to $CARGO_TARGET_DIR/near/<crate>/ when that is set, and to
# ./target/near/<crate>/ when it is not. Checking only one of those is how an
# earlier version of this script failed to find its own output.
WASM=""
for base in "${CARGO_TARGET_DIR:-}" "target"; do
  [ -n "$base" ] || continue
  cand="$base/near/vault/vault.wasm"
  [ -f "$cand" ] && WASM="$cand" && break
done
[ -n "$WASM" ] || { echo "FATAL: built vault.wasm not found under CARGO_TARGET_DIR or ./target" >&2; exit 1; }
echo "    wasm: $WASM ($(wc -c < "$WASM") bytes)"

# Args via a file, not an inline shell string: the JSON contains quotes, and
# escaping them through two shell layers is how a malformed init call gets sent.
ARGS=$(mktemp)
trap 'rm -f "$ARGS"' EXIT
printf '{"owner":"%s","network":"testnet","strict_allocation":false}\n' "$OWNER" > "$ARGS"
echo "    init args: $(cat "$ARGS")"

# `new` requires predecessor == current_account_id, so nobody can initialise a
# freshly deployed vault with their own owner. Deploying as VAULT satisfies it.
echo "==> deploying to $VAULT"
near contract deploy "$VAULT" use-file "$WASM" \
  with-init-call new file-args "$ARGS" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send

# ---- the guard.
#
# Print expected AND actual before comparing. A `near view` that fails and
# returns an empty string is indistinguishable from a genuine "production"
# unless both sides are on screen.
echo "==> verifying the deployed clock"
MODE=$(near contract call-function as-read-only "$VAULT" clock_mode \
         json-args '{}' network-config testnet now 2>/dev/null \
       | tr -d '"[:space:]' || true)
EXPECTED="production"
echo "    clock_mode: expected='$EXPECTED' actual='$MODE'"

if [ -z "$MODE" ]; then
  echo "FATAL: clock_mode returned nothing. Cannot confirm the deployed build." >&2
  echo "       Treating an unreadable guard as a failure, not as a pass." >&2
  exit 1
fi
if [ "$MODE" != "$EXPECTED" ]; then
  echo "FATAL: the deployed wasm carries the TEST CLOCK. Do not use this vault." >&2
  exit 1
fi

echo "==> OK: $VAULT is running the production clock"
