# Create a desktop shortcut that launches the console.
#
#   powershell -ExecutionPolicy Bypass -File tools/make-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File tools/make-shortcut.ps1 -Name "取关管家"
#
# The shortcut points at this checkout, so moving the folder afterwards breaks
# it -- re-run this script if you move things.
#
# Saved as UTF-8 with a BOM on purpose: Windows PowerShell 5.1 reads a BOM-less
# script as ANSI and the Chinese default name would mangle the parser.
param(
  [string]$Name = 'B站清理助手'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'start.cmd'

if (-not (Test-Path $target)) {
  throw "not found: $target -- is this script still inside the checkout?"
}

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { throw 'could not locate the desktop folder' }

$linkPath = Join-Path $desktop ($Name + '.lnk')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'B站批量取关 / 收藏夹清理控制台'
$shortcut.Save()

Write-Host "created  : $linkPath"
Write-Host "target   : $target"