<#
    应用集合 AppHub 卸载脚本

    用法：
      powershell -ExecutionPolicy Bypass -File uninstall.ps1
      powershell -ExecutionPolicy Bypass -File uninstall.ps1 -KeepData

    只删除 AppHub 自己的文件和快捷方式，不影响电脑上已安装的其他应用。
#>
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'AppHub'),
    [switch]$KeepData
)

$ErrorActionPreference = 'Stop'

Write-Host "正在卸载 应用集合 AppHub..." -ForegroundColor Cyan

Get-Process -Name 'AppHub' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
foreach ($link in @((Join-Path $desktop '应用集合 AppHub.lnk'), (Join-Path $startMenu '应用集合 AppHub.lnk'))) {
    if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
}

if ($KeepData -and (Test-Path -LiteralPath (Join-Path $InstallDir 'data'))) {
    $backup = Join-Path $env:USERPROFILE ("AppHub-data-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath (Join-Path $InstallDir 'data') -Destination $backup -Recurse -Force
    Write-Host "  设置已备份到 $backup" -ForegroundColor DarkGray
}

if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

Write-Host "卸载完成。" -ForegroundColor Green
