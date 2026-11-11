# Register the vault with the USDC contract, so it can RECEIVE tokens.
#
# WHY THIS IS NEEDED. NEP-141 transfers to an UNREGISTERED account fail. The
# vault currently has no storage record on the USDC contract:
#
#   storage_balance_of(test015-near.usefloat.near)  ->  null
#   storage_balance_of(test015.near)                ->  {"total":"1250000..."}
#
# So sending USDC to the vault right now would bounce. This is the step before
# funding, not after it.
#
# WHO PAYS. Anyone may register any account, so this is signed as test015.near
# and costs it 0.00125 NEAR — the token's own `storage_balance_bounds` min and
# max, which are equal, so there is nothing to choose.
#
# WHY A FILE RATHER THAN A PASTED LINE. Three paste attempts failed for two
# different shell reasons: backslash line-continuations are bash (PowerShell
# uses a backtick), and PowerShell 5.1 STRIPS double quotes from native-exe
# arguments, so '{"account_id":"x"}' arrives as {account_id:x} and the contract
# reports `key must be a string` — an error that reads like a bad payload
# rather than a quoting bug. The `\"` escaping below is the form proven to
# survive, verified first on a READ-ONLY call so the quoting could not be
# discovered wrong on something that signs.

$ErrorActionPreference = "Stop"

$TOKEN = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
$VAULT = "test015-near.usefloat.near"
$SIGNER = "test015.near"

Write-Host "Registering $VAULT with USDC ($TOKEN)" -ForegroundColor Cyan
Write-Host "  signer:  $SIGNER"
Write-Host "  deposit: 0.00125 NEAR (the token's exact minimum)"
Write-Host ""

near contract call-function as-transaction $TOKEN storage_deposit `
  json-args "{\`"account_id\`":\`"$VAULT\`"}" `
  prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' `
  sign-as $SIGNER network-config mainnet sign-with-legacy-keychain send

Write-Host ""
Write-Host "Verifying the registration actually landed..." -ForegroundColor Cyan

# ASSERT, rather than trust the send's own output. A transaction can report
# success while the thing you wanted did not happen -- that failure mode has
# cost this project real time, so the check reads the token back.
near contract call-function as-read-only $TOKEN storage_balance_of `
  text-args "{\`"account_id\`":\`"$VAULT\`"}" `
  network-config mainnet now
