#!/usr/bin/env bash
# Build the sandbox wasms and run the integration tier, under Linux/WSL.
#
# WHY THIS EXISTS: near-workspaces ships a sandbox `neard` only for
# linux-x86_64, linux-aarch64 and darwin-arm64. On Windows it panics at BUILD
# time with UnsupportedPlatformError, so the whole integration tier has to run
# here. The repo on /mnt/c stays the single source of truth; only the cargo
# target dir is moved onto the Linux filesystem, because build I/O across the
# 9p /mnt/c boundary is what makes this unbearably slow otherwise.
#
# Usage (from Windows):
#   wsl -d Ubuntu -- bash /mnt/c/Users/BASHIR/Documents/near-vault/scripts/wsl-sandbox.sh [build|test|all]
set -euo pipefail

REPO=/mnt/c/Users/BASHIR/Documents/near-vault
cd "$REPO"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/near-vault-target}"
mkdir -p "$CARGO_TARGET_DIR"
export PATH="$HOME/.cargo/bin:$PATH"

echo "repo              : $REPO"
echo "CARGO_TARGET_DIR  : $CARGO_TARGET_DIR"
echo "rustc             : $(rustc --version)"
echo "cargo-near        : $(cargo-near --version)"
echo

step="${1:-all}"

if [ "$step" = "build" ] || [ "$step" = "all" ]; then
  echo "=============== BUILD (cargo near build, ABI step included) ==============="
  # No --no-abi here: the ABI step compiles a native cdylib, which links fine
  # under ld. It is only Windows MSVC that refuses undefined symbols. If this
  # succeeds it confirms the Windows failure was the ABI step and nothing else.
  bash scripts/build-wasm.sh
  echo
  echo "=============== VERIFY the built wasms ==============="
  for w in res/*.wasm; do
    printf '%-34s %8s B  panic_utf8=%s ed25519_verify=%s set_day_len_ns=%s\n' \
      "$w" "$(wc -c < "$w")" \
      "$(grep -c panic_utf8 "$w" || true)" \
      "$(grep -c ed25519_verify "$w" || true)" \
      "$(grep -c set_day_len_ns "$w" || true)"
  done
  echo
fi

if [ "$step" = "check" ]; then
  echo "=============== COMPILE-CHECK the test tier (no sandbox run) ==============="
  cargo test -p integration-tests --no-run
fi

if [ -n "${2:-}" ] && [ "$step" = "one" ]; then
  echo "=============== SINGLE TEST FILE: $2 ==============="
  cargo test -p integration-tests --test "$2" -- --nocapture --test-threads=2
fi

# For the mutation protocol in docs/MUTATIONS.md: a contract edit is NOT in the
# binary under test until the wasm is rebuilt, so a mutation run that skips the
# build is meaningless and reads as "the mutation survived". Always paired.
if [ -n "${2:-}" ] && [ "$step" = "mut" ]; then
  echo "=============== REBUILD + RUN $2 (mutation protocol) ==============="
  bash scripts/build-wasm.sh >/tmp/build-wasm.log 2>&1 || { tail -20 /tmp/build-wasm.log; exit 1; }
  echo "wasm rebuilt: $(sha256sum res/vault_test_clock.wasm | cut -c1-16)"
  cargo test -p integration-tests --test "$2" -- --test-threads=2
fi

if [ "$step" = "test" ] || [ "$step" = "all" ]; then
  echo "=============== INTEGRATION TIER (near-workspaces sandbox) ==============="
  cargo test -p integration-tests -- --nocapture --test-threads=2
fi
