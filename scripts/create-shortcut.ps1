<#
.SYNOPSIS
  Puts a "Estuary" shortcut on the Desktop.

.DESCRIPTION
  Points at the installed build (%LOCALAPPDATA%\Programs\Estuary\Estuary.exe) when it
  exists, otherwise at the unpacked build produced by `npm run dist:dir`
  (release\win-unpacked\Estuary.exe).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
#>
[CmdletBinding()]
param(
  # Where to put the .lnk. Defaults to the current user's Desktop.
  [string]$ShortcutDir = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot

$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Estuary\Estuary.exe'),
  (Join-Path $projectRoot 'release\win-unpacked\Estuary.exe')
)

$target = $null
foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath $candidate) { $target = $candidate; break }
}

if (-not $target) {
  Write-Error @"
No Estuary executable found. Looked in:
  $($candidates -join "`n  ")
Run 'npm run dist' (installer) or 'npm run dist:dir' (unpacked) first.
"@
  exit 1
}

$linkPath = Join-Path $ShortcutDir 'Estuary.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = Split-Path -Parent $target
$shortcut.IconLocation = "$target,0"
$shortcut.Description = 'Estuary - all your email in one inbox'
$shortcut.Save()

Write-Host "Created $linkPath"
Write-Host "  -> $target"
