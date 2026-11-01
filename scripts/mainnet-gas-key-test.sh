#!/usr/bin/env bash
# Does NEP-611 gas keys work on MAINNET? One command, six steps, self-cleaning.
#
# WHY THIS SCRIPT EXISTS RATHER THAN SIX PASTED COMMANDS. The staged version in
# docs/STAGED-mainnet-gas-key-test.md was six commands plus "open this JSON file
# and paste the private key into step 4", which is a lot of places to go wrong
# on a live account. This is one command, it never asks anyone to handle a
# secret, and it cleans up after itself even when a step fails.
#
# WHAT IT PROVES. Gas keys are documented as live from protocol 86 and mainnet
# is on 86, but nothing read-only can confirm the protocol accepts an AddGasKey
# ACTION there — mainnet and testnet answer view_gas_key_nonces identically and
# their runtime configs are the same shape. Only sending it settles it, and it
# is the single unverified assumption behind preferring gas keys over 0.55-NEAR
# agent sub-accounts.
#
# WHAT IT CANNOT TOUCH. The target is test015.near, the OWNER. The live vault
# float.test015.near and its real USDC are never a signer here. The key created
# is function-call restricted to ONE read-only view method on the vault, so it
# cannot move tokens, transfer NEAR, add keys or deploy — and a function-call
# key cannot carry a deposit at all.
#
# EXPOSURE. 0.05 NEAR parked in the gas key, plus ~0.001 of gas. The cleanup
# trap withdraws and deletes on ANY exit path, so a failure halfway does not
# strand it. Withdraw was verified on testnet: free 0.017299 -> 0.082762.
#
# Usage, from git-bash:
#   CONFIRM_MAINNET=1 bash scripts/mainnet-gas-key-test.sh
set -uo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/shell-env.sh

ACCOUNT="${ACCOUNT:-test015.near}"
VAULT="${VAULT:-float.test015.near}"
METHOD=get_config
FUND="${FUND:-0.05}"
TGAS="${TGAS:-30}"
SECRETS=.demo/gaskey-mainnet-probe.json
NET="network-config mainnet sign-with-legacy-keychain send"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '    \033[31mFAIL\033[0m %s\n' "$*"; }
info() { printf '    \033[2m%s\033[0m\n' "$*"; }

# ---- guards, cheapest first
SHELL_KIND="$(shell_kind "$(uname -s)" "$(cat /proc/sys/kernel/osrelease 2>/dev/null || true)")"
if [ "$(wsl_verdict "$SHELL_KIND" "$(pwd)" "${ALLOW_WSL:-0}")" = "trap" ]; then
  echo "FATAL: this is WSL's bash. sign-with-legacy-keychain reads \$HOME, which" >&2
  echo "  differs here, so it will find no mainnet credentials. Use git-bash:" >&2
  echo '    & '"'"'C:\Program Files\Git\bin\bash.exe'"'"' -c "CONFIRM_MAINNET=1 bash scripts/mainnet-gas-key-test.sh"' >&2
  exit 1
fi

[ "${CONFIRM_MAINNET:-0}" = "1" ] || {
  echo "FATAL: this sends REAL MAINNET transactions. Re-run with CONFIRM_MAINNET=1." >&2
  exit 1
}
command -v near >/dev/null || { echo "FATAL: near-cli-rs not found" >&2; exit 1; }
[ -f "$SECRETS" ] || { echo "FATAL: $SECRETS missing — the throwaway keypair is gone." >&2; exit 1; }
[ -f "$HOME/.near-credentials/mainnet/$ACCOUNT.json" ] || {
  echo "FATAL: no mainnet credentials for $ACCOUNT" >&2; exit 1; }

GK="$(node -e "console.log(require('./$SECRETS').public_key)")"
SK="$(node -e "console.log(require('./$SECRETS').private_key)")"
state() { node scripts/gas-key-state.mjs "$ACCOUNT" "$GK" mainnet; }
field() { state | grep "^$1=" | cut -d= -f2; }
near6() { node -e "process.stdout.write((Number(process.argv[1])/1e24).toFixed(6))" "$1"; }

# Poll until a field STOPS equalling a known-old value, rather than sleeping a
# guessed number of seconds. These reads are at `final` finality, which lags the
# chain head — and a fixed sleep that is a shade too short reports "the key is
# not a gas key" or "the balance did not move", both of which read as a failed
# protocol rather than an impatient script. Three spikes this week were
# misread for exactly this reason.
wait_change() { # <field> <old-value> [tries]
  local f="$1" old="$2" tries="${3:-20}" i v
  for ((i = 0; i < tries; i++)); do
    v="$(field "$f")"
    if [ -n "$v" ] && [ "$v" != "$old" ]; then printf '%s' "$v"; return 0; fi
    sleep 1
  done
  printf '%s' "$(field "$f")"
  return 1
}

# ---- cleanup on ANY exit, so the 0.05 cannot be stranded
cleanup() {
  local code=$?
  bold "CLEANUP (runs on every exit path)"
  local g
  g="$(field gas)"
  if [ "$g" != "none" ] && [ "$g" != "0" ] && [ -n "$g" ]; then
    info "withdrawing $(near6 "$g") NEAR from the gas key"
    near account withdraw-from-gas-key "$ACCOUNT" "$GK" "$g yoctonear" $NET >/dev/null 2>&1 \
      && ok "withdrawn" || bad "withdraw failed — $(near6 "$g") NEAR is still in the gas key"
  else
    info "gas key balance is ${g:-unknown}, nothing to withdraw"
  fi
  if [ "$(field gas)" != "none" ]; then
    near account delete-keys "$ACCOUNT" public-keys "$GK" $NET >/dev/null 2>&1 \
      && ok "gas key deleted" || bad "could not delete the gas key — remove it by hand"
  fi
  info "$ACCOUNT free is now $(near6 "$(field free)") NEAR, $(field keys) key(s)"
  exit $code
}

bold "MAINNET gas-key test   account $ACCOUNT   gas key ${GK:0:24}…"
info "before: free $(near6 "$(field free)") NEAR, $(field keys) key(s), gas key $(field gas)"

# ---- 1. THE DECISIVE STEP
bold "[1] add a function-call GAS KEY  <- if this works, gas keys are live on mainnet"
if ! near account add-key "$ACCOUNT" grant-gas-key-function-call-access \
      --num-nonces 1 --contract-account-id "$VAULT" --function-names "$METHOD" \
      use-manually-provided-public-key "$GK" \
      $NET 2>&1 | tail -4; then
  bad "AddGasKey was REJECTED"
  info "=> gas keys are NOT usable on mainnet at this protocol version."
  info "=> keep agent sub-accounts, and DO the 6-line recovery fix: it is"
  info "   forward-only, so every agent made before it strands 0.55 NEAR."
  exit 1
fi
trap cleanup EXIT   # armed only now: before this there is nothing to clean up
G0="$(wait_change gas none)" || true
if [ "$G0" = "none" ]; then bad "the key never became readable as a gas key"; exit 1; fi
ok "gas key created, own balance $(near6 "$G0") NEAR"
info "(created empty is correct — NEP-611 gas keys start at zero)"

# ---- 2. fund its own pot
bold "[2] fund the gas key's OWN balance with $FUND NEAR"
FREE_BEFORE_FUND="$(field free)"
near account fund-gas-key "$ACCOUNT" "$GK" "$FUND NEAR" $NET >/dev/null 2>&1 \
  && ok "funded" || { bad "fund-gas-key failed"; exit 1; }
GAS_FUNDED="$(wait_change gas "$G0")" || info "(the balance did not change within 20s)"
info "gas key   $(near6 "$G0") -> $(near6 "$GAS_FUNDED")"
info "acct free $(near6 "$FREE_BEFORE_FUND") -> $(near6 "$(field free)")"

# ---- 3. THE SECOND DECISIVE STEP
bold "[3] call $METHOD on the vault, SIGNED BY THE GAS KEY ($TGAS TGas)"
GAS_BEFORE="$(field gas)"
FREE_BEFORE="$(field free)"
near contract call-function as-transaction "$VAULT" "$METHOD" \
  json-args '{}' prepaid-gas "$TGAS.0 Tgas" attached-deposit '0 NEAR' \
  sign-as "$ACCOUNT" network-config mainnet \
  sign-with-plaintext-private-key "$SK" send 2>&1 | tail -6 \
  && ok "the call executed" || bad "the call failed — read the output above"
GAS_AFTER="$(wait_change gas "$GAS_BEFORE")" || info "(gas balance unchanged after 20s of polling)"
FREE_AFTER="$(field free)"
info "gas key   $(near6 "$GAS_BEFORE") -> $(near6 "$GAS_AFTER")"
info "acct free $(near6 "$FREE_BEFORE") -> $(near6 "$FREE_AFTER")"

bold "VERDICT"
if [ "$GAS_AFTER" != "$GAS_BEFORE" ]; then
  ok "the GAS KEY's own balance paid for the call"
  ok "=> gas keys work on mainnet. Adopt them; skip the sub-account recovery fix."
  info "   An agent then costs ~0.05 recoverable instead of 0.55 stranded,"
  info "   and agents do not contend for the vault's free NEAR."
else
  bad "the gas key's balance did not move — read the two lines above"
  info "=> do NOT adopt gas keys on this evidence. Re-measure before deciding."
fi
# cleanup runs here, via the trap
