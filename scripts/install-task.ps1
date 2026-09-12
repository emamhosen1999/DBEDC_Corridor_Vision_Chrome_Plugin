<#
.SYNOPSIS
  Install Corridor Vision as a Windows scheduled task that starts at boot.

.DESCRIPTION
  Uses the built-in Task Scheduler — nothing to download, nothing to install.

  Registered with:
    - Trigger:  At system startup (runs BEFORE anyone logs in)
    - Account:  SYSTEM (survives logout; no stored password)
    - Restart:  Every 1 minute, up to 999 times, if the process exits
    - No idle/battery/network conditions, so it never quietly stops on a laptop

  Run this from an elevated PowerShell prompt:
      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\scripts\install-task.ps1

.PARAMETER Home
  Where Corridor Vision keeps config, data and logs. Defaults to the repo root.
  Put this on a data volume if the app lives under Program Files.

.PARAMETER UserSession
  Install for the logged-in user instead of SYSTEM. Choose this if you want native
  Windows toast notifications, which a SYSTEM service cannot display (session 0
  isolation). Monitoring then only runs once that user has logged in.
#>
param(
  [string]$TaskName   = "CorridorVision",
  [string]$AppRoot    = (Split-Path -Parent $PSScriptRoot),
  [string]$DataHome   = "",
  [string]$NodeExe    = "",
  [switch]$UserSession
)

$ErrorActionPreference = "Stop"

if (-not $NodeExe) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { throw "node.exe was not found on PATH. Install Node.js 20.11 or newer, then re-run this script." }
  $NodeExe = $node.Source
}
$nodeVersion = & $NodeExe --version
Write-Host "Using Node $nodeVersion at $NodeExe"
if ([version]($nodeVersion.TrimStart('v').Split('-')[0]) -lt [version]"20.11.0") {
  throw "Corridor Vision needs Node 20.11 or newer. Found $nodeVersion."
}

$entry = Join-Path $AppRoot "src\cli.mjs"
if (-not (Test-Path $entry)) { throw "Could not find $entry. Pass -AppRoot pointing at the Corridor Vision folder." }
if (-not $DataHome) { $DataHome = $AppRoot }

Write-Host "App root : $AppRoot"
Write-Host "Data home: $DataHome"

# Verify the configuration before we register anything that runs unattended.
Write-Host "`nChecking configuration..."
$env:CORRIDOR_HOME = $DataHome
& $NodeExe $entry doctor
if ($LASTEXITCODE -ne 0) {
  Write-Warning "The configuration check reported problems (see above)."
  $answer = Read-Host "Install the task anyway? (y/N)"
  if ($answer -ne 'y') { throw "Aborted. Fix the problems above, then re-run." }
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "`nRemoving the existing '$TaskName' task..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$entry`" run" -WorkingDirectory $AppRoot

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -StartWhenAvailable `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -RestartCount 999 `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

if ($UserSession) {
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
  Write-Host "`nInstalling for user '$env:USERNAME' (starts at logon; desktop toasts available)."
} else {
  $trigger   = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Write-Host "`nInstalling as SYSTEM (starts at boot, before login; no desktop toasts)."
}

# CORRIDOR_HOME has to reach the task, and a scheduled task does not inherit the
# shell environment — set it machine-wide so every start sees the same data folder.
[Environment]::SetEnvironmentVariable("CORRIDOR_HOME", $DataHome, "Machine")

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "Corridor Vision — 24/7 CCTV health monitoring and alerting" | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6

$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "`nTask '$TaskName' registered. State: $state"

$port = 8477
$cfgPath = Join-Path $DataHome "config\config.json"
if (Test-Path $cfgPath) {
  try { $port = (Get-Content $cfgPath -Raw | ConvertFrom-Json).server.port } catch { }
}
Write-Host "Dashboard: http://127.0.0.1:$port"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "  Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Get-Content '$DataHome\logs\corridor-*.log' -Tail 40 -Wait"
