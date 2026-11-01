#!/usr/bin/env bash
# Confirm the global-contract burn rate on MAINNET, for ~0.026 NEAR.
#
# WHY A SEPARATE SCRIPT. measure-global-burn.sh refuses `.near` accounts, and
# that guard is correct: it publishes TWO modules and burns ~0.154 NEAR, which
# is fine on testnet and wasteful on mainnet. Rather than weaken a guard that
# protects an irreversible spend, this is a narrower instrument for a narrower
# question.
#
# WHAT IS ALREADY KNOWN, so this run's job is small. The testnet differential at
# protocol 88 measured the rate at 10.001x and showed storage_usage unchanged
# across both publishes, so "burn, not stake, and it is 10x" is established
# there. Mainnet runs protocol 86. The rate is a protocol parameter and is
# unlikely to differ, but ~30 NEAR per release rests on it, so it is worth
# 0.026 to stop assuming.
#
# A SINGLE DEPLOY IS ENOUGH HERE, which it was NOT on testnet. There, rate and
# fixed action cost were both unknown and a differential was the only way to
# separate them. Here the rate hypothesis is already specific, and the two
# candidates are 10x apart:
#
#   258 bytes  ->  0.00258 NEAR if 1x,  0.0258 NEAR if 10x
#
# Gas is ~0.00003, three orders of magnitude below that gap, so one point
# discriminates cleanly.
#
# THE PREDICTION IS PRINTED BEFORE THE DEPLOY. A burn is irreversible, so there
# is no second run to fall back on, and a number interpreted after the fact is
# one that can be talked into agreeing with whatever appeared.
#
# PRECONDITIONS, all verified read-only on 2026-11-01:
#   - test015.near holds 0.176825 NEAR free; this leaves ~0.151
#   - hash 99JSL6HEiVCoR1w8Z4xYsSgmgNq6uUQum6bTEENqzAyf is NOT yet a mainnet
#     global. Confirmed with a POSITIVE CONTROL: the same query against testnet,
#     where it IS published, returns the 258 bytes — so the mainnet
#     NO_GLOBAL_CONTRACT_CODE is a real absence and not a malformed request.
#     This matters because republishing an existing hash would measure nothing.
#
# Usage:
#   CONFIRM_MAINNET=1 PARENT=test015.near bash scripts/confirm-global-rate-mainnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/shell-env.sh
SHELL_KIND="$(shell_kind "$(uname -s)" "$(cat /proc/sys/kernel/osrelease 2>/dev/null || true)")"
if [ "$(wsl_verdict "$SHELL_KIND" "$(pwd)" "${ALLOW_WSL:-0}")" = "trap" ]; then
  echo "FATAL: this is WSL's bash on a Windows path. Use git-bash." >&2
  exit 1
fi

PARENT="${PARENT:?set PARENT to the mainnet account that will pay the burn}"
case "$PARENT" in
  *.near) ;;
  *) echo "FATAL: $PARENT is not a mainnet account. Use measure-global-burn.sh for testnet." >&2; exit 1 ;;
esac
[ "${CONFIRM_MAINNET:-0}" = "1" ] || {
  echo "FATAL: this BURNS ~0.026 real NEAR, irreversibly." >&2
  echo "  Re-run with CONFIRM_MAINNET=1 if that is what you mean." >&2
  exit 1
}

WASM=".demo/g256.wasm"
[ -f "$WASM" ] || { echo "FATAL: $WASM missing — run: node scripts/pad-wasm.mjs .demo/tiny.wasm $WASM 256" >&2; exit 1; }
BYTES="$(wc -c < "$WASM" | tr -d '[:space:]')"
HASH="$(node scripts/wasm-hash.mjs "$WASM" | tr -cd '[:alnum:]')"

echo "==> module"
echo "    $WASM  $BYTES bytes  hash $HASH"

echo "==> refusing to measure a hash that is already published"
# Republishing an existing hash would cost ~nothing and read as "1x", i.e. as a
# refutation of the 10x. The check is worth more than it looks.
PUB_STATUS=0
node scripts/global-is-published.mjs "$HASH" mainnet || PUB_STATUS=$?
case "$PUB_STATUS" in
  0)
    echo "FATAL: $HASH is ALREADY a mainnet global contract. Publishing it again measures nothing." >&2
    exit 1 ;;
  1)
    echo "    not published on mainnet — the measurement is valid" ;;
  *)
    # An RPC failure is NOT evidence of absence. Treating it as such would
    # publish on top of an unknown state and then report whatever came out.
    echo "FATAL: could not determine whether $HASH is published (exit $PUB_STATUS)." >&2
    echo "  Refusing to burn real NEAR on an unverified precondition." >&2
    exit 1 ;;
esac

echo "==> the prediction, BEFORE spending anything"
NETWORK=mainnet node scripts/global-burn-probe.mjs "$PARENT" predict "$BYTES"

echo "==> deployer state before (settled)"
NETWORK=mainnet node scripts/global-burn-probe.mjs "$PARENT" mark before

echo "==> publishing $BYTES bytes as a mainnet global contract (CodeHash)"
# The account is POSITIONAL to as-global-hash; `sign-as` is the wrong form and
# near-cli-rs 0.30.1 rejects it.
near contract deploy-as-global use-file "$WASM" as-global-hash "$PARENT" \
  network-config mainnet sign-with-legacy-keychain send 2>&1 |
  grep -iE "code hash|successfully|Transaction fee|^ERROR|error" | head -5

echo "==> deployer state after (settled)"
NETWORK=mainnet node scripts/global-burn-probe.mjs "$PARENT" mark after

echo "==> the answer"
NETWORK=mainnet node scripts/global-burn-probe.mjs "$PARENT" confirm "$BYTES"
