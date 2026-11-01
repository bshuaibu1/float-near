#!/usr/bin/env bash
# What does publishing a GLOBAL contract actually cost the deployer, per byte?
#
# WHY THIS EXISTS. docs/GLOBAL-CONTRACTS-NEP-591.md prices publishing this
# vault globally at ~30 NEAR, derived from NEP-591's statement that
# `global_contract_storage_amount_per_byte` is 10x the normal storage rate. That
# figure decides whether we spend ~30 NEAR per release, and it is NOT MEASURED:
# mainnet's own protocol config exposes `global_contract_host_fns: true` and
# `storage_amount_per_byte: 1e19`, but no global-contract rate at all. So the
# 30 NEAR rests on a document.
#
# This buys the answer for about 0.16 NEAR of testnet funds.
#
# THE METHOD IS DIFFERENTIAL, which is the only part that needs defending. A
# deploy's cost is `fixed_action_cost + bytes * rate`, and the fixed part is
# unknown. Publishing TWO sizes and subtracting cancels it:
#
#   rate = (burn_big - burn_small) / (bytes_big - bytes_small)
#
# A single deploy could not separate the rate from the overhead. The two
# candidate rates are 1e19 (no multiplier) and 1e20 (the claimed 10x), which are
# 10x apart, so the sizes do not need to be large to tell them apart:
#
#   1,024-byte difference  ->  0.01024 NEAR if 1x,  0.1024 NEAR if 10x
#
# SIZES MUST BE FRESH. A CodeHash global is keyed by the wasm hash, so
# republishing an already-published module would measure nothing. 49 and 5,122
# bytes were published on 2026-10-31 by measure-global-contract.sh; this uses
# 256 and 1,280.
#
# AND IT CHECKS BURN-VS-STAKE SEPARATELY. The claim is that the deployer's
# tokens are DESTROYED rather than locked. A balance drop alone cannot tell
# those apart — a stake drops the balance too. The distinguishing evidence is
# `storage_usage`: a stake raises it, a burn does not. Both are recorded.
#
# TESTNET ONLY. It burns real tokens, and on mainnet that is unrecoverable.
# Note that testnet runs protocol 88 and mainnet 86, so this establishes the
# rate at 88; see the staged mainnet confirmation at the end of the output.
#
# Usage:
#   PARENT=floatv4.testnet bash scripts/measure-global-burn.sh
set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/shell-env.sh

SHELL_KIND="$(shell_kind "$(uname -s)" "$(cat /proc/sys/kernel/osrelease 2>/dev/null || true)")"
if [ "$(wsl_verdict "$SHELL_KIND" "$(pwd)" "${ALLOW_WSL:-0}")" = "trap" ]; then
  echo "FATAL: this is WSL's bash on a Windows path. Use git-bash." >&2
  exit 1
fi

PARENT="${PARENT:?set PARENT to the testnet account that will pay the burn}"
case "$PARENT" in
  *.near) echo "FATAL: $PARENT looks like mainnet. This BURNS tokens; testnet only." >&2; exit 1 ;;
  *.testnet) ;;
  *) echo "FATAL: $PARENT is not a .testnet account." >&2; exit 1 ;;
esac

SMALL=256
BIG=1280
NET="network-config testnet sign-with-legacy-keychain send"

command -v near >/dev/null || { echo "FATAL: near-cli-rs not found" >&2; exit 1; }

echo "==> building two fresh sizes that have never been published"
node scripts/pad-wasm.mjs .demo/tiny.wasm ".demo/g$SMALL.wasm" "$SMALL"
node scripts/pad-wasm.mjs .demo/tiny.wasm ".demo/g$BIG.wasm" "$BIG"

# MEASURE the sizes, never assume the requested ones. pad-wasm's custom-section
# length prefix is LEB128, so it costs one byte under 128 and two above: asking
# for 256 and 1,280 actually produces 258 and 1,282. Here the DIFFERENCE happens
# to come out at 1,024 either way, and that coincidence is exactly why this must
# not be left to chance -- the per-byte rate is the differential divided by this
# number, so a 2-byte error in it is a 0.2% error in the headline figure and a
# future size pair might not be so forgiving.
SMALL_B="$(wc -c < ".demo/g$SMALL.wasm" | tr -d '[:space:]')"
BIG_B="$(wc -c < ".demo/g$BIG.wasm" | tr -d '[:space:]')"
for s in "$SMALL" "$BIG"; do
  echo "    .demo/g$s.wasm  $(wc -c < ".demo/g$s.wasm") bytes  hash $(node scripts/wasm-hash.mjs ".demo/g$s.wasm")"
done
echo "    requested $SMALL/$BIG, actual $SMALL_B/$BIG_B, differential $((BIG_B - SMALL_B)) bytes"
[ "$BIG_B" -gt "$SMALL_B" ] || { echo "FATAL: sizes are not ordered; the differential would be meaningless" >&2; exit 1; }

echo "==> deployer state before anything"
node scripts/global-burn-probe.mjs "$PARENT" mark before

for s in "$SMALL" "$BIG"; do
  echo "==> publishing g$s.wasm as a global contract (CodeHash)"
  # The account is a POSITIONAL argument to as-global-hash. `sign-as "$PARENT"`
  # is the wrong form and near-cli-rs 0.30.1 rejects it with
  # "unexpected argument found" -- recorded in measure-global-contract.sh.
  near contract deploy-as-global use-file ".demo/g$s.wasm" as-global-hash "$PARENT" \
    $NET 2>&1 | grep -iE "code hash|successfully|Transaction fee|^ERROR|error" | head -5
  node scripts/global-burn-probe.mjs "$PARENT" mark "after$s"
done

echo "==> the answer"
node scripts/global-burn-probe.mjs "$PARENT" report "$SMALL_B" "$BIG_B" "$SMALL" "$BIG"
