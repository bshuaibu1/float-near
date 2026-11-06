<#
.SYNOPSIS
  Remove /payments and /setup - redirects to places that no longer apply.

.DESCRIPTION
  Run it with:
    powershell -ExecutionPolicy Bypass -File scripts\remove-redirect-pages.ps1

  WHY, HAVING EARLIER ARGUED TO KEEP THEM

  I kept these on the grounds that a redirect preserving a bookmarked URL is
  deliberate design, not residue. That was reading each page's own comment as
  a statement of current fact. It was not:

    - Both have exactly ONE commit: "Port the existing Float dashboard to the
      NEAR vault, data layer only". The comments were written for SOLANA
      Float, hosted at app.usefloat.xyz.
    - This NEAR dashboard has no deploy config and is not hosted anywhere, so
      no bookmark points at it. The bookmarks those comments protect belong to
      a different deployment of a different product.
    - /setup redirects to https://usefloat.xyz/docs/quickstart, which does not
      resolve at all (HTTP 000). It forwards to nothing.

  A redirect is only worth its route when something actually arrives there.

  PUBLIC_PATHS goes with them. /setup was its last entry, and the array exists
  to let a route render WITHOUT the nav and the wallet gate. With no such
  route left, an empty array would be a switch nothing can flip - the exact
  shape of dead control this dashboard has been shedding all day.
#>

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host "=== removing the redirect routes ==="
foreach ($f in @("apps\dashboard\app\payments\page.tsx", "apps\dashboard\app\setup\page.tsx")) {
  $p = Join-Path $repo $f
  if (Test-Path $p) { Remove-Item -LiteralPath $p -Force; Write-Host "  removed  $f" }
  else { Write-Host "  absent   $f" }
}

foreach ($d in @("apps\dashboard\app\payments", "apps\dashboard\app\setup")) {
  $p = Join-Path $repo $d
  if (-not (Test-Path $p)) { Write-Host "  absent   $d"; continue }
  $left = @(Get-ChildItem -LiteralPath $p -Recurse -File)
  if ($left.Count -eq 0) { Remove-Item -LiteralPath $p -Force; Write-Host "  removed  $d" }
  else { Write-Host "  KEPT     $d  ($($left.Count) file(s) still inside)" }
}

Write-Host "`n=== typecheck ==="
Push-Location (Join-Path $repo 'apps\dashboard')
npx tsc --noEmit -p tsconfig.json
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "typecheck failed - something still references a deleted page" }
Write-Host "  clean"

Write-Host "`nNext:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\restart-dashboard.ps1"
