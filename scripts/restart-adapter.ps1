<#
.SYNOPSIS
  Rebuild and restart the Float adapter on 127.0.0.1:8787.

.DESCRIPTION
  A SCRIPT, not a one-liner, because the one-liner kept being wrong: bash
  `VAR=value` prefixes, `\` line continuations and `/c/...` paths are all
  parse errors in PowerShell, and `\$_` inside a nested -Command string gets
  mangled into a literal `\.CommandLine`.

  Run it with:
    powershell -ExecutionPolicy Bypass -File scripts\restart-adapter.ps1

  Safe to re-run. Stops any adapter already listening, rebuilds, starts a
  fresh one, then PROVES the new build is live by asking for an owner plan
  that only the new code can produce.
#>

$ErrorActionPreference = 'Stop'

# Repo root is this script's parent, so the script works from any directory.
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Write-Host "repo: $repo"

# --- 1. Rebuild ------------------------------------------------------------
Write-Host "`nbuilding adapter..."
# QUOTED: bare `@floatonnear/...` makes PowerShell try to SPLAT a variable
# named $floatonnear, which expands to nothing and builds the wrong thing.
npm run build --workspace '@floatonnear/float-adapter'
if ($LASTEXITCODE -ne 0) { throw "build failed with exit code $LASTEXITCODE" }

$dist = Join-Path $repo 'packages\float-adapter\dist\server.js'
if (-not (Test-Path $dist)) { throw "build produced no $dist" }

# --- 2. Stop whatever is already running -----------------------------------
# -Filter "Name='node.exe'" IS LOAD-BEARING, not tidiness.
#
# Without it the pattern also matches every bash.exe / powershell.exe whose
# command line merely MENTIONS that path — a shell that once ran a command
# containing the string. Measured on this machine: the broad pattern matched
# 7 processes, of which 5 were shells and only 2 were adapters. Running it
# would have killed the terminals, not the server.
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*float-adapter*dist*server.js*' })

if ($running.Count -eq 0) {
  Write-Host "no adapter process was running"
} else {
  foreach ($p in $running) {
    Write-Host "stopping pid $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force
  }
  Start-Sleep -Seconds 2
}

# --- 3. Start the new one --------------------------------------------------
# $env: assignment, NOT a bash `VAR=value cmd` prefix — PowerShell has no
# inline env-var prefix, which is exactly what broke the pasted command.
$env:NEAR_VAULT_CONTRACT       = 'work12-testnet-fleet.fac.floatv4.testnet'
$env:NEAR_VAULT_RPC_URL        = 'https://test.rpc.fastnear.com'
$env:NEAR_VAULT_TOKEN          = 'usdc.fakes.testnet'
$env:NEAR_VAULT_TOKEN_DECIMALS = '6'
# Needed only by /v1/resolve, which answers "which vault is MINE?" for a
# visitor by asking the factory's own `vault_id_for`. Without it that route
# reports itself unconfigured rather than guessing a factory, because a guess
# would hand someone an address that is not theirs.
$env:NEAR_VAULT_FACTORY        = 'fac.floatv4.testnet'
$env:NEAR_VAULT_AGENT_KEYS     = '.float/agent-keys.json'
$env:FLOAT_API_TOKEN           = 'local-dev-token'
$env:BLOCKED_FOLLOW            = '0'
$env:PORT                      = '8787'
$env:HOST                      = '127.0.0.1'

$logDir = Join-Path $repo '.demo'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Two files: PowerShell refuses to redirect stdout and stderr to the SAME one.
Start-Process -FilePath 'node' `
  -ArgumentList 'packages/float-adapter/dist/server.js' `
  -WorkingDirectory $repo `
  -RedirectStandardOutput (Join-Path $logDir 'adapter.log') `
  -RedirectStandardError  (Join-Path $logDir 'adapter.err.log') `
  -WindowStyle Hidden | Out-Null

Write-Host "`nwaiting for 127.0.0.1:8787 ..."
$up = $false
foreach ($i in 1..20) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8787/v1/vault-info' -TimeoutSec 5 | Out-Null
    $up = $true
    Write-Host "  up after $i second(s)"
    break
  } catch { }
}
if (-not $up) {
  Write-Host "`nadapter did NOT come up. Last lines of .demo\adapter.err.log:"
  if (Test-Path (Join-Path $logDir 'adapter.err.log')) {
    Get-Content (Join-Path $logDir 'adapter.err.log') -Tail 20
  }
  throw "adapter failed to start"
}

# --- 4. Prove the NEW build is live, not just SOME build -------------------
# "It responds" only proves a server is there; the old build answered
# /v1/vault-info perfectly well. `pause` is the discriminator: the old code
# returns {"error":"unknown action: pause"}, the new code returns a payload.
Write-Host "`nchecking the new actions are served..."
$body = '{"action":"pause","paused":true}'
$res = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/v1/owner-plan' `
  -Method Post -Body $body -TimeoutSec 20 `
  -Headers @{ 'content-type' = 'application/json'; 'authorization' = 'Bearer local-dev-token' }

if ($res.payload.methodName -eq 'set_paused') {
  Write-Host "  OK  - owner-plan pause -> set_paused on $($res.payload.receiverId)"
  Write-Host "`nadapter restarted and the new build is live."
} else {
  Write-Host "  adapter is up but did NOT return set_paused:"
  Write-Host "  $($res | ConvertTo-Json -Compress)"
  throw "stale build still serving"
}
