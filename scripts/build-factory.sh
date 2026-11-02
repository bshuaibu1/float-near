#!/usr/bin/env bash
# Build the factory wasm, and FAIL if the build did nothing.
#
# WHY THIS IS NOT JUST `cargo near build`.
#
# cargo-near decides whether to run its wasm-opt post-step by comparing
# mtimes, and when the FINAL artifact is newer than the intermediate it skips
# the whole thing — while still printing a success banner and a checksum:
#
#   • Skipped running wasm-opt as final target exists and is newer than wasm
#     produced by cargo
#   ✓ Contract successfully built!
#        - SHA-256 checksum hex : 89325171…
#       Finished cargo near build in 0s
#
# That checksum is the STALE FILE'S. "Built fresh" and "did nothing" produce
# the same output, in 0s, even after `cargo clean -p factory` — so reading the
# hash off the build log cannot tell you whether your edit is in it. A bare
# `touch`, a `cp`, a checkout or a restore is enough to trigger it.
#
# This repo has already come one command away from redeploying a contract with
# a known squatting vulnerability while reporting the fix as shipped, with the
# two builds 24 bytes apart.
#
# So: delete BOTH artifacts first, then require the final one to exist
# afterwards. A no-op build then has nothing to leave behind and fails loudly.
#
# --no-abi is required on Windows: the ABI step links a NATIVE dll and produces
# ~52 LNK2019 unresolved near-sdk host-function externs. It still passes
# `--cfg near`, so the contract's stable panic reason codes survive.
set -euo pipefail
cd "$(dirname "$0")/.."

CRATE=factory
FINAL="target/near/$CRATE/$CRATE.wasm"
INTERMEDIATE="target/wasm32-unknown-unknown/release/$CRATE.wasm"

command -v cargo-near >/dev/null || {
  echo "cargo-near not found. Install with: cargo install cargo-near --locked" >&2
  exit 1
}

echo "==> removing both artifacts so a no-op build cannot masquerade as a real one"
for f in "$FINAL" "$INTERMEDIATE"; do
  if [ -f "$f" ]; then
    echo "    rm $f"
    rm -f "$f"
  fi
done

echo "==> cargo near build"
( cd "contracts/$CRATE" && cargo near build non-reproducible-wasm --no-abi )

# THE ASSERTION THAT MAKES THIS WORTH HAVING. After deleting the artifact, a
# build that did nothing leaves nothing behind.
if [ ! -f "$FINAL" ]; then
  echo "FATAL: $FINAL does not exist after the build. The build did nothing." >&2
  exit 1
fi

BYTES=$(wc -c <"$FINAL" | tr -d ' ')
echo
echo "    $FINAL"
echo "    $BYTES bytes"
if command -v sha256sum >/dev/null; then
  echo "    sha256 $(sha256sum "$FINAL" | cut -d' ' -f1)"
fi
echo
echo "    (builds here are byte-deterministic — the same source reproduces the"
echo "     same hash, even cold in a different worktree — so comparing this"
echo "     hash against the chain IS valid, now that real work was forced.)"
