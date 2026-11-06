<#
.SYNOPSIS
  Bring up the whole local Float stack and verify it.

.DESCRIPTION
  Run it with:
    powershell -ExecutionPolicy Bypass -File scripts\start-stack.ps1

  Three servers have to be running for the dashboard to do anything useful,
  and they die together whenever the machine restarts:

    8787  adapter       reads the vault, builds owner-method payloads
    3000  dashboard     the UI; proxies to 8787 server-side
    8080  signing page  where an owner approves a prepared transaction

  Starting them by hand is three different invocations with three different
  sets of environment variables, and getting one wrong fails in a way that
  looks like a code bug: a dead 8787 makes every page render "Unable to reach
  the vault adapter", and a dead 8080 makes every signing link 404 at the
  moment the owner clicks it.

  Safe to re-run: each step skips what is already healthy, except the
  dashboard, which is restarted with a clean .next because a stale build
  cache is its own class of phantom failure (see restart-dashboard.ps1).
#>

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Test-Port([int]$port, [string]$path = '/') {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$port$path" -TimeoutSec 6 -UseBasicParsing | Out-Null
    return $true
  } catch {
    # A 404 still proves something is listening and speaking HTTP.
    if ($_.Exception.Response) { return $true }
    return $false
  }
}

Write-Host "=== adapter (8787) ==="
if (Test-Port 8787 '/v1/vault-info') {
  Write-Host "  already up"
} else {
  & (Join-Path $PSScriptRoot 'restart-adapter.ps1')
}

Write-Host "`n=== signing page (8080) ==="
if (Test-Port 8080) {
  Write-Host "  already up"
} else {
  $logDir = Join-Path $repo '.demo'
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

  # SET PORT EXPLICITLY.
  #
  # restart-adapter.ps1 runs first and sets $env:PORT = '8787' in THIS
  # session. web/serve.mjs reads `process.env.PORT ?? 8080`, so it inherited
  # 8787, tried to bind the port the adapter already holds, and died - while
  # the log cheerfully printed URLs on 8787. An inherited variable is the
  # worst kind of config bug: nothing is misspelled and nothing is missing.
  $env:PORT = '8080'
  Start-Process -FilePath 'node' -ArgumentList 'web/serve.mjs' -WorkingDirectory $repo `
    -RedirectStandardOutput (Join-Path $logDir 'serve.log') `
    -RedirectStandardError  (Join-Path $logDir 'serve.err.log') `
    -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 3
  if (Test-Port 8080) { Write-Host "  started" } else { throw "signing page failed to start - see .demo\serve.err.log" }
}

Write-Host "`n=== dashboard (3000) ==="
& (Join-Path $PSScriptRoot 'restart-dashboard.ps1')

Write-Host "`n=== all three ==="
$all = @(
  @{ n = 'adapter     '; p = 8787; path = '/v1/vault-info' },
  @{ n = 'signing page'; p = 8080; path = '/' },
  @{ n = 'dashboard   '; p = 3000; path = '/policies' }
)
$bad = 0
foreach ($s in $all) {
  $ok = Test-Port $s.p $s.path
  Write-Host ("  {0}  {1}  :{2}" -f $(if ($ok) { 'OK  ' } else { 'DOWN' }), $s.n, $s.p)
  if (-not $ok) { $bad++ }
}
if ($bad -gt 0) { throw "$bad service(s) down" }
Write-Host "`nstack is up: http://127.0.0.1:3000/policies"
