<#
.SYNOPSIS
  Restart the dashboard dev server on 127.0.0.1:3000 with a clean .next.

.DESCRIPTION
  Run it with:
    powershell -ExecutionPolicy Bypass -File scripts\restart-dashboard.ps1

  WHY THIS IS NEEDED
  Several Next dev servers were run from this same project directory during
  development. They all share apps\dashboard\.next, so they overwrite each
  other's build manifests, and the long-lived server ends up serving a mix of
  200 / 404 / 500 for routes whose source is perfectly fine. The symptom is
  the giveaway: the SAME route flips status between requests, and a 500 body
  is the bare 21-byte "Internal Server Error" rather than Next's dev error
  page with a stack.

  Deleting .next is the documented remedy and is not optional here - a plain
  restart reuses the corrupted cache.

  Safe to re-run. Verifies every route afterwards rather than assuming.
#>

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'apps\dashboard'
Set-Location $repo
Write-Host "repo: $repo"

# --- 1. Stop every node process serving this dashboard ---------------------
# Name='node.exe' is load-bearing: without it the pattern also matches the
# shells whose command lines merely MENTION the path, and stopping those
# kills the terminal instead of the server.
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
    $_.CommandLine -like '*next*dev*3000*' -or
    $_.CommandLine -like '*next\dist\server\lib\start-server.js*'
  })

if ($running.Count -eq 0) {
  Write-Host "no dashboard dev server was running"
} else {
  foreach ($p in $running) {
    Write-Host "stopping pid $($p.ProcessId)"
    try { Stop-Process -Id $p.ProcessId -Force } catch { }
  }
  Start-Sleep -Seconds 3
}

# --- 2. Clear the corrupted build cache ------------------------------------
$next = Join-Path $app '.next'
if (Test-Path $next) {
  Write-Host "removing $next"
  Remove-Item -Recurse -Force $next
} else {
  Write-Host ".next already absent"
}

# --- 3. Start it again -----------------------------------------------------
$env:FLOAT_ADAPTER_URL = 'http://127.0.0.1:8787'
$env:FLOAT_API_TOKEN = 'local-dev-token'

$logDir = Join-Path $repo '.demo'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# LAUNCH node, NOT npx.
#
# `Start-Process -FilePath 'npx'` fails with "%1 is not a valid Win32
# application": npx on Windows is npx.cmd, a batch shim. PowerShell resolves
# .cmd when you invoke a command directly, but Start-Process calls
# CreateProcess, which will not run a batch file as an image. node.exe is a
# real executable, and Next ships a plain JS entry point, so we run that --
# the same shape the dev server already had in its own command line.
$nextBin = Join-Path $app 'node_modules\next\dist\bin\next'
if (-not (Test-Path $nextBin)) {
  throw "next binary not found at $nextBin - run npm install in apps\dashboard"
}

Start-Process -FilePath 'node' `
  -ArgumentList $nextBin, 'dev', '-p', '3000' `
  -WorkingDirectory $app `
  -RedirectStandardOutput (Join-Path $logDir 'dashboard.log') `
  -RedirectStandardError  (Join-Path $logDir 'dashboard.err.log') `
  -WindowStyle Hidden | Out-Null

Write-Host "`nwaiting for 127.0.0.1:3000 ..."
$up = $false
foreach ($i in 1..40) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -TimeoutSec 5 -UseBasicParsing | Out-Null
    $up = $true
    Write-Host "  up after $i second(s)"
    break
  } catch { }
}
if (-not $up) {
  Write-Host "`ndid NOT come up. Last lines of .demo\dashboard.err.log:"
  if (Test-Path (Join-Path $logDir 'dashboard.err.log')) {
    Get-Content (Join-Path $logDir 'dashboard.err.log') -Tail 25
  }
  throw "dashboard failed to start"
}

# --- 4. Verify EVERY route, not just the one that happened to load ---------
# A dev server compiles routes on first request, so the first hit can be slow
# and must not be read as a failure. Two attempts each.
Write-Host "`nchecking routes..."
$routes = @('/', '/policies', '/agents', '/activity', '/fund', '/api-keys', '/settings')
$bad = @()
foreach ($r in $routes) {
  $code = 0
  foreach ($try in 1..2) {
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3000$r" -TimeoutSec 90 -UseBasicParsing
      $code = $resp.StatusCode
    } catch {
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { $code = 0 }
    }
    if ($code -eq 200) { break }
  }
  $mark = if ($code -eq 200) { 'OK  ' } else { 'FAIL' }
  Write-Host ("  {0}  {1,-12} HTTP {2}" -f $mark, $r, $code)
  if ($code -ne 200) { $bad += $r }
}

Write-Host ""
if ($bad.Count -eq 0) {
  Write-Host "all $($routes.Count) routes return 200 - dashboard is clean."
} else {
  Write-Host "$($bad.Count) route(s) still failing: $($bad -join ', ')"
  Write-Host "That is now a real error, not stale cache. See .demo\dashboard.err.log"
  throw "routes failing after a clean restart"
}
