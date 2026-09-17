# Creates a FORGE desktop shortcut (Start-FORGE.vbs + icon) on the current
# user's Desktop. Run from an Explorer right-click "Run with PowerShell" or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\Install-Shortcut.ps1
$ErrorActionPreference = 'Stop'

$desktopDir = [Environment]::GetFolderPath('Desktop')
$forgeRoot = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot 'Start-FORGE.vbs'
$ico = Join-Path $PSScriptRoot 'forge.ico'
$lnkPath = Join-Path $desktopDir 'FORGE.lnk'

if (-not (Test-Path $vbs)) { throw "launcher not found: $vbs" }
if (-not (Test-Path $ico)) { throw "icon not found: $ico (run desktop\make-icon.js)" }

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = 'wscript.exe'
$shortcut.Arguments = '"' + $vbs + '"'
$shortcut.WorkingDirectory = $forgeRoot
$shortcut.IconLocation = "$ico,0"
$shortcut.Description = 'FORGE — Autonomous Software Engineering Workspace'
$shortcut.Save()

Write-Host "shortcut created: $lnkPath"
