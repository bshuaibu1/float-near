<#
.SYNOPSIS
  Remove /registry and /agents/deploy - unported Solana carry-over.

.DESCRIPTION
  Run it with:
    powershell -ExecutionPolicy Bypass -File scripts\remove-unported-pages.ps1

  WHY THESE TWO

  Both have exactly ONE commit: "Port the existing Float dashboard to the NEAR
  vault, data layer only". Neither has been touched since. They came across in
  the bulk port and were never adapted, unlike /policies which has three
  commits and has been actively reworked.

  /agents/deploy is not merely broken, it is impossible here. It POSTs to
  /v1/agents/deploy - one of the six Solana-era endpoints the NEAR adapter
  never served - and expects back a `walletAddress` and an `apiKey`. On NEAR
  an agent is a budget node plus a GAS KEY ON THE VAULT; it owns no wallet,
  and there is no apiKey to issue.

  More fundamentally: creating an agent means generating a keypair whose
  SECRET has to reach the machine that will run the agent. The MCP writes it
  to .float/agent-keys.json and deliberately never returns it - "The secret
  itself is deliberately absent". A browser page can only display that secret,
  which is this repo's existing scar, or have a server hold it, which is the
  custodial model NEAR Float exists to avoid.

  /registry is a 347-line UI for /v1/registry, which 404s. The nav comment
  says it is "planned as standalone registry.usefloat.xyz once APIs are
  natively x402" - a DIFFERENT domain. The intent is recorded there; the
  unreachable code does not need to carry it.

  WHAT IS DELIBERATELY KEPT

  /payments and /setup look orphaned but are not: both are redirects for
  bookmarked URLs (/payments -> /activity, /setup -> the docs site). Not being
  linked is correct for a redirect.
#>

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$files = @(
  "apps\dashboard\app\registry\page.tsx",
  "apps\dashboard\app\agents\deploy\page.tsx"
)

Write-Host "=== removing ==="
foreach ($f in $files) {
  $p = Join-Path $repo $f
  if (Test-Path $p) {
    Remove-Item -LiteralPath $p -Force
    Write-Host "  removed  $f"
  } else {
    Write-Host "  absent   $f"
  }
}

Write-Host "`n=== removing the directories, only if empty ==="
foreach ($d in @("apps\dashboard\app\registry", "apps\dashboard\app\agents\deploy")) {
  $p = Join-Path $repo $d
  if (-not (Test-Path $p)) { Write-Host "  absent   $d"; continue }
  $left = @(Get-ChildItem -LiteralPath $p -Recurse -File)
  if ($left.Count -eq 0) {
    Remove-Item -LiteralPath $p -Force
    Write-Host "  removed  $d"
  } else {
    Write-Host "  KEPT     $d  ($($left.Count) other file(s) still inside)"
  }
}

Write-Host "`n=== typecheck ==="
Push-Location (Join-Path $repo 'apps\dashboard')
npx tsc --noEmit -p tsconfig.json
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "typecheck failed - something still references a deleted page" }
Write-Host "  clean"

Write-Host "`nNow restart the dashboard so the routes disappear:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\restart-dashboard.ps1"
