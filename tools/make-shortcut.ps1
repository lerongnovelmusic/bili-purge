# Put a shortcut to the console on the desktop.
#
#   powershell -ExecutionPolicy Bypass -File tools/make-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File tools/make-shortcut.ps1 -Name "取关管家"
#
# start.cmd runs this by itself on first launch, so nobody has to come looking
# for it. It is idempotent: an existing shortcut that already points here is
# left alone, so a name you changed by hand survives.
#
# The shortcut points at this checkout, so moving the folder breaks it -- run
# this again afterwards and it will be repointed.
#
# Saved as UTF-8 with a BOM on purpose: Windows PowerShell 5.1 reads a BOM-less
# script as ANSI and the Chinese default name would mangle the parser.
param(
  [string]$Name = 'B站清理助手',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Say([string]$message) {
  if (-not $Quiet) { Write-Host $message }
}

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'start.cmd'

if (-not (Test-Path $target)) {
  throw "not found: $target -- is this script still inside the checkout?"
}

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { throw 'could not locate the desktop folder' }

$linkPath = Join-Path $desktop ($Name + '.lnk')
$shell = New-Object -ComObject WScript.Shell

if (Test-Path $linkPath) {
  $current = $shell.CreateShortcut($linkPath)
  if ($current.TargetPath -eq $target) {
    Say "已经在桌面上：$linkPath"
    exit 0
  }
  Say "更新快捷方式（原来指向 $($current.TargetPath)）"
}

$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'B站批量取关 / 收藏夹清理控制台'
$shortcut.Save()

Say "已创建：$linkPath"
Say "指向  ：$target"