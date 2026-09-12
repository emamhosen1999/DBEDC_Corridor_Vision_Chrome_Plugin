<#
.SYNOPSIS
  First-run setup for Corridor Vision on a Windows monitoring PC.

.DESCRIPTION
  Checks the environment, creates a starting configuration, runs the self-test, and
  tells you exactly what to do next. Safe to re-run: it never overwrites an existing
  config.json, inventory or credential vault.

  Run from an ordinary PowerShell prompt in the repository folder:

      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\scripts\setup.ps1

  Elevation is only needed later, for install-task.ps1.

.PARAMETER DataHome
  Where config, data and logs live. Defaults to the repository folder. Put this on a
  data volume if the app sits under Program Files, which is read-only for a service.

.PARAMETER SiteName
  Site name used in reports and alert footers.

.PARAMETER TimeZone
  IANA timezone for every timestamp (NOT the Windows name). Default Asia/Dhaka.
#>
param(
  [string]$DataHome = "",
  [string]$SiteName = "Dhaka Bypass Expressway",
  [string]$TimeZone = "Asia/Dhaka",
  [int]$Port = 8477,
  [switch]$SkipSelfTest
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $DataHome) { $DataHome = $repo }

function Say($msg, $colour = "Gray") { Write-Host $msg -ForegroundColor $colour }
function Ok($msg)   { Write-Host "  [ok]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Bad($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red }

Say ""
Say "Corridor Vision - setup" Cyan
Say ("=" * 60) DarkGray
Say "  repository : $repo"
Say "  data home  : $DataHome"
Say ""

# ---------------------------------------------------------------- Node ------
Say "Checking Node.js" White
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Bad "node.exe is not on PATH."
  Say ""
  Say "  Install Node.js 20.11 LTS or newer, then re-run this script:" Yellow
  Say "    https://nodejs.org/en/download  (choose the Windows Installer, LTS)" Yellow
  Say "  Or, if you have winget:" Yellow
  Say "    winget install OpenJS.NodeJS.LTS" Yellow
  Say ""
  exit 1
}
$ver = (& node --version).TrimStart('v')
$verClean = ($ver -split '-')[0]
if ([version]$verClean -lt [version]"20.11.0") {
  Bad "Node $ver found, but 20.11 or newer is required."
  Say "  Upgrade from https://nodejs.org and re-run." Yellow
  exit 1
}
Ok "Node $ver at $($node.Source)"

# ------------------------------------------------------------ directories ---
Say ""
Say "Preparing directories" White
foreach ($d in @("config", "data", "logs")) {
  $full = Join-Path $DataHome $d
  if (-not (Test-Path $full)) { New-Item -ItemType Directory -Path $full -Force | Out-Null }
}
try {
  $probe = Join-Path $DataHome "data\.writetest"
  Set-Content -Path $probe -Value "x" -ErrorAction Stop
  Remove-Item $probe -Force
  Ok "$DataHome is writable"
} catch {
  Bad "$DataHome is NOT writable by this account."
  Say "  Re-run with -DataHome pointing somewhere writable, e.g.:" Yellow
  Say "    .\scripts\setup.ps1 -DataHome C:\CorridorVision" Yellow
  exit 1
}

# ---------------------------------------------------------------- config ----
Say ""
Say "Configuration" White
$cfgPath = Join-Path $DataHome "config\config.json"
if (Test-Path $cfgPath) {
  Ok "config.json already exists - left untouched"
} else {
  $example = Join-Path $repo "config\config.example.json"
  if (-not (Test-Path $example)) { Bad "config.example.json is missing from the repository."; exit 1 }
  $cfg = Get-Content $example -Raw | ConvertFrom-Json
  $cfg.site.name = $SiteName
  $cfg.site.timezone = $TimeZone
  $cfg.server.port = $Port
  # Start with a quiet, safe default: probing on, nothing leaving the PC until the
  # operator deliberately enables a channel and tests it.
  $cfg | ConvertTo-Json -Depth 12 | Set-Content -Path $cfgPath -Encoding UTF8
  Ok "Created config\config.json for '$SiteName' ($TimeZone), dashboard port $Port"
}

$env:CORRIDOR_HOME = $DataHome
[Environment]::SetEnvironmentVariable("CORRIDOR_HOME", $DataHome, "Machine")
Ok "CORRIDOR_HOME set machine-wide to $DataHome"

# ------------------------------------------------------------- self-test ----
if (-not $SkipSelfTest) {
  Say ""
  Say "Running self-test (simulated cameras - touches nothing real)" White
  Say ""
  & node (Join-Path $repo "src\cli.mjs") selftest
  if ($LASTEXITCODE -ne 0) {
    Say ""
    Bad "Self-test failed. Fix the items above before continuing."
    exit 1
  }
}

# ------------------------------------------------------------ next steps ----
Say ""
Say ("=" * 60) DarkGray
Say "Setup complete." Green
Say ""
Say "Next steps:" White
Say ""
Say "  1. Import your camera list (the old extension's CSV export works as-is):" Gray
Say "       node src\cli.mjs import --csv cameras.csv" Cyan
Say ""
Say "  2. Store the camera credentials (encrypted, never written to config.json):" Gray
Say "       node src\cli.mjs secret set cameras.username admin" Cyan
Say "       node src\cli.mjs secret set cameras.password ""your-password""" Cyan
Say ""
Say "  3. Point the monitor at your core switch and NVR so it can tell its OWN" Gray
Say "     outage from a camera outage - edit monitor.gatewayCheck.hosts in" Gray
Say "       $cfgPath" Cyan
Say ""
Say "  4. Check everything, then run it:" Gray
Say "       node src\cli.mjs doctor" Cyan
Say "       node src\cli.mjs run" Cyan
Say "       http://127.0.0.1:$Port" Cyan
Say ""
Say "  5. When it looks right, install it to start at boot (elevated PowerShell):" Gray
Say "       .\scripts\install-task.ps1" Cyan
Say ""
Say "  If something misbehaves, produce a diagnostics bundle to share:" Gray
Say "       node src\cli.mjs support" Cyan
Say ""
