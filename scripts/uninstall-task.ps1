<#
.SYNOPSIS
  Remove the Corridor Vision scheduled task. Leaves config, data and logs in place.
#>
param([string]$TaskName = "CorridorVision")
$ErrorActionPreference = "Stop"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "No scheduled task named '$TaskName' was found."
}
Write-Host "Configuration, history and logs were left untouched."
Write-Host "To remove them as well, delete the config\, data\ and logs\ folders."
