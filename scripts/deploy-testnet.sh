#!/usr/bin/env bash
# Deploys the vault to testnet, and REFUSES if the binary it just deployed
# carries the test clock.
#
# Why this exists: the sandbox tier builds the vault with `--features
# test-clock`, which exposes `set_day_len_ns` and lets the owner shrink the
# budget window to 100 ms. That is correct for a deterministic day-boundary
# test and catastrophic in production — a one-second "day" means a daily cap
# refills a thousand times an hour.
#
# The feature is non-default, so a plain build cannot pick it up by accident.
# This is the second line of defence: build it ourselves, then interrogate what
# we actually deployed rather than what we meant to deploy.
#
# Usage: VAULT=my-vault.testnet OWNER=me.testnet bash scripts/deploy-testnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VAULT:?set VAULT to the account the vault will live on}"
: "${OWNER:?set OWNER to the account that will own the vault}"

command -v near >/dev/null || { echo "near CLI not found" >&2; exit 1; }
command -v cargo-near >/dev/null || {
  echo "cargo-near not found. Install: cargo install cargo-near --locked" >&2
  exit 1
}

# Build HERE rather than reusing whatever is in target/ or res/: res/ holds the
# test-clock build that the sandbox tier needs.
echo "==> building vault with --no-default-features (production clock)"
( cd contracts/vault && cargo near build non-reproducible-wasm --no-default-features )

WASM=$(find target/near -name 'vault.wasm' -newermt '-10 minutes' | head -1)
[ -n "$WASM" ] || { echo "could not locate the freshly built vault.wasm" >&2; exit 1; }
echo "    wasm: $WASM ($(wc -c < "$WASM") bytes)"

echo "==> deploying to $VAULT"
near contract deploy "$VAULT" use-file "$WASM" \
  with-init-call new json-args "{\"owner\":\"$OWNER\",\"network\":\"testnet\",\"strict_allocation\":false}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

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
