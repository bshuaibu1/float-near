#!/usr/bin/env bash
# Measure what UseGlobalContractAction actually charges a user.
#
# docs/GLOBAL-CONTRACTS-NEP-591.md §4 marked this UNVERIFIED and warned that
# "zero onboarding cost" is too strong, because a vault still stakes for its own
# state even if it stops staking for code. This settles the code half with
# numbers instead of leaving it as a claim.
#
# ---- RESULT, measured on testnet 2026-10-31. The claim is now VERIFIED.
#
#   acct                       storage_usage   staked NEAR   code readable
#   A  deploy   49B (normal)             231       0.00231      49 bytes
#   B  use      49B (global)             214       0.00214      49 bytes
#   C  deploy 5122B (normal)            5304       0.05304    5122 bytes
#   D  use    5122B (global)             214       0.00214    5122 bytes
#
#   C - A = 5073 bytes  <- exactly the padding: a normal deploy charges for
#                          every byte of code
#   D - B = 0 bytes     <- a global REFERENCE is SIZE-INDEPENDENT
#
# So the real vault's 299,016 bytes of code stake (2.99016 NEAR) becomes a
# 214-byte pointer (0.00214), saving 2.98802 per vault, against a one-time
# 29.90160 NEAR BURNED to publish it globally at the 10x rate. Break-even is
# ~10 vaults — and that is structural, not a coincidence: the global rate IS
# 10x the normal rate, so it is always about ten.
#
# `view_code` returning the full 49 / 5122 bytes on B and D is the guard that
# matters: an account with NO contract would also show small storage, so
# "small storage" alone would have been a false positive.
#
# ---- THE INSTRUMENT IS DELIBERATELY TINY.
#
# The question is what an ACTION costs, not what a contract costs, and the
# action's price does not depend on what the code does. Measuring with the real
# vault would mean a global deploy of 299,016 bytes at NEP-591's 10x rate --
# about 30 NEAR, burned. A 49-byte module costs ~0.005 and answers the same
# question.
#
# THE DESIGN IS DIFFERENTIAL, AND THAT IS THE POINT. One account deploying
# normally and one referencing a global contract tells you the difference for
# ONE size. Two sizes, ~100x apart, tell you whether the user's cost depends on
# code size at all -- which is the actual V2 claim.
#
# ---- TWO THINGS THE FIRST REAL RUN FIXED.
#
# 1. The CLI form was wrong and would have stopped this at step one.
#    `deploy-as-global use-file <wasm> as-global-hash` takes the signer account
#    as its OWN argument; the original used `sign-as "$PARENT"` and near-cli-rs
#    0.30.1 answers `error: unexpected argument 'floatv4.testnet' found`.
# 2. It asked the operator to copy two code hashes by hand and re-run the B and
#    D deploys themselves, so it never produced a result on its own. The hashes
#    are sha256-base58 of the wasm, computable locally -- verified by computing
#    tiny's hash and matching the CLI's own report byte for byte -- so the whole
#    thing now runs unattended.
#
# FUND_EACH defaults to 0.1, not the original 0.5. The measured quantity is
# storage_usage, which does not depend on an account's balance at all, and this
# testnet pool holds ~2.7 NEAR of free balance in total.
#
# Usage:
#   PARENT=floatv4.testnet bash scripts/measure-global-contract.sh
#
# Costs ~0.6 NEAR of the parent: ~0.52 is the two global deploys (BURNED), 0.4
# goes into four throwaway sub-accounts (refundable, left in place so the
# numbers can be re-read), the rest is gas.
set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/shell-env.sh

# Which shell? FIRST, before anything else — under WSL on a Windows path,
# `sign-with-legacy-keychain` reads a different $HOME and finds no credentials,
# and $env:PARENT is not inherited either.
SHELL_KIND="$(shell_kind "$(uname -s)" "$(cat /proc/sys/kernel/osrelease 2>/dev/null || true)")"
if [ "$(wsl_verdict "$SHELL_KIND" "$(pwd)" "${ALLOW_WSL:-0}")" = "trap" ]; then
  echo "FATAL: this is WSL's bash on a Windows path ($(pwd))." >&2
  echo "  sign-with-legacy-keychain reads \$HOME, which differs here, so it will" >&2
  echo "  find no credentials. Use git-bash and set the variables inside it:" >&2
  echo '    & '"'"'C:\Program Files\Git\bin\bash.exe'"'"' -c "PARENT=<acct> bash scripts/measure-global-contract.sh"' >&2
  echo "  Or re-run with ALLOW_WSL=1 if you really mean it." >&2
  exit 1
fi
echo "==> shell: $SHELL_KIND"

: "${PARENT:?set PARENT to a funded testnet account you hold a key for}"
case "$PARENT" in
  *.near) echo "FATAL: $PARENT looks like mainnet. This burns NEAR; testnet only." >&2; exit 1 ;;
esac
command -v near >/dev/null || { echo "FATAL: near-cli-rs not found" >&2; exit 1; }

NET="network-config testnet sign-with-legacy-keychain send"
STAMP="${STAMP:-$(date +%H%M%S)}"
FUND_EACH="${FUND_EACH:-0.1 NEAR}"
say() { printf "\n=== %s\n" "$*"; }

mkdir -p .demo
node scripts/tiny-wasm.mjs .demo/tiny.wasm
node scripts/pad-wasm.mjs .demo/tiny.wasm .demo/padded.wasm 5120

# sha256-base58 of each artifact. Verified against the CLI's own "Wasm code
# hash" line for tiny; they matched exactly, which is why the padded one can be
# trusted without parsing CLI output.
TINY_HASH="$(node scripts/wasm-hash.mjs .demo/tiny.wasm)"
PADDED_HASH="$(node scripts/wasm-hash.mjs .demo/padded.wasm)"
echo "    tiny   $(wc -c < .demo/tiny.wasm) bytes  $TINY_HASH"
echo "    padded $(wc -c < .demo/padded.wasm) bytes  $PADDED_HASH"

# ---- 1. publish both sizes as global contracts, and price the burn
for w in tiny padded; do
  say "deploy-as-global ($w, $(wc -c < ".demo/$w.wasm") bytes)"
  near contract deploy-as-global use-file ".demo/$w.wasm" as-global-hash "$PARENT" \
    $NET 2>&1 | grep -iE "code hash|successfully|Transaction fee|^ERROR" | head -5
done

# ---- 2. four equally funded accounts
mk() {
  near account create-account fund-myself "$1.$PARENT" "$FUND_EACH" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$PARENT" $NET >/dev/null 2>&1 || { echo "FATAL: could not create $1.$PARENT" >&2; exit 1; }
  echo "$1.$PARENT"
}
say "four accounts at $FUND_EACH each"
A=$(mk "ga$STAMP"); echo "    A (deploy tiny)    $A"
B=$(mk "gb$STAMP"); echo "    B (use    tiny)    $B"
C=$(mk "gc$STAMP"); echo "    C (deploy padded)  $C"
D=$(mk "gd$STAMP"); echo "    D (use    padded)  $D"

# ---- 3. the four deploys: two normal controls, two global references
say "A: NORMAL deploy of tiny"
near contract deploy "$A" use-file .demo/tiny.wasm without-init-call $NET 2>&1 | grep -iE "successfully|^ERROR" | head -2
say "B: reference the tiny GLOBAL contract"
near contract deploy "$B" use-global-hash "$TINY_HASH" without-init-call $NET 2>&1 | grep -iE "successfully|^ERROR" | head -2
say "C: NORMAL deploy of padded"
near contract deploy "$C" use-file .demo/padded.wasm without-init-call $NET 2>&1 | grep -iE "successfully|^ERROR" | head -2
say "D: reference the padded GLOBAL contract"
near contract deploy "$D" use-global-hash "$PADDED_HASH" without-init-call $NET 2>&1 | grep -iE "successfully|^ERROR" | head -2

# ---- 4. the result
echo "$A $B $C $D" > .demo/g-accounts.txt
say "comparing"
node scripts/compare-global-storage.mjs "$A" "$B" "$C" "$D"
