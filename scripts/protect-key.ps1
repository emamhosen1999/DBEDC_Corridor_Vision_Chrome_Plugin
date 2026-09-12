<#
.SYNOPSIS
  Lock the credential vault key down to SYSTEM and Administrators.

.DESCRIPTION
  config\vault.key decrypts config\secrets.enc. On a shared monitoring PC any local
  user can read it by default, which would defeat the point of encrypting the
  credentials at all. This replaces the file's ACL with SYSTEM + Administrators only,
  and disables inheritance so a permissive parent folder cannot widen it again.

  Run from an elevated PowerShell prompt.
#>
param([string]$AppRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = "Stop"

foreach ($name in @("vault.key", "secrets.enc")) {
  $path = Join-Path $AppRoot "config\$name"
  if (-not (Test-Path $path)) { Write-Host "skip $name (not created yet)"; continue }

  $acl = Get-Acl $path
  $acl.SetAccessRuleProtection($true, $false)   # break inheritance, drop inherited rules
  foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
  foreach ($account in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      $account, "FullControl", "None", "None", "Allow"))) | Out-Null
  }
  Set-Acl -Path $path -AclObject $acl
  Write-Host "Locked $name to SYSTEM + Administrators."
}
Write-Host ""
Write-Host "Verify with:  icacls '$AppRoot\config\vault.key'"
