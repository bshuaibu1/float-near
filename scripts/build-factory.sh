#!/usr/bin/env bash
# Build a contract wasm, and FAIL if the build did nothing.
#
# Usage: scripts/build-factory.sh [crate]   (default: factory; `vault` also valid)
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

CRATE="${1:-factory}"
FINAL="target/near/$CRATE/$CRATE.wasm"
INTERMEDIATE="target/wasm32-unknown-unknown/release/$CRATE.wasm"

command -v cargo-near >/dev/null || {
  # "not found" is usually a LIE here, and the honest cause is the shell.
  #
  # On Windows, PowerShell's `bash` resolves to C:\WINDOWS\system32\bash.exe —
  # which is WSL, a different machine with a different filesystem and a PATH
  # that does not contain ~/.cargo/bin. cargo-near is installed and working;
  # this shell simply cannot see it. Telling the user to install it sends them
  # off to reinstall something they already have.
  # Detect WSL from /proc/version, not from whether ~/.cargo/bin is missing.
  # The first version of this check tested `[ ! -d "$HOME/.cargo/bin" ]` and
  # NEVER FIRED — WSL here has its own Linux cargo install, so the directory
  # exists and the condition was false. It fell through to the same misleading
  # "cargo-near not found" it was written to replace.
  if grep -qi microsoft /proc/version 2>/dev/null; then
    echo "FATAL: this is running under WSL, which has its own PATH and cannot see" >&2
    echo "       your Windows cargo install. Use git-bash instead:" >&2
    echo >&2
    echo "         & \"C:\\Program Files\\Git\\bin\\bash.exe\" scripts/build-factory.sh${1:+ $1}" >&2
    echo >&2
    echo "       (check with: Get-Command bash | Select -ExpandProperty Source —" >&2
    echo "        if it says system32\\bash.exe, that is WSL.)" >&2
    exit 1
  fi
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
