<#
    应用集合 AppHub 安装脚本

    用法：
      powershell -ExecutionPolicy Bypass -File install.ps1
      powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir "D:\Apps\AppHub" -Launch

    默认安装到 %LOCALAPPDATA%\AppHub，不需要管理员权限。
#>
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'AppHub'),
    [switch]$NoDesktopShortcut,
    [switch]$NoStartMenuShortcut,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$payload = Join-Path $here 'app'
if (-not (Test-Path -LiteralPath $payload)) { $payload = $here }

$exeSource = Join-Path $payload 'AppHub.exe'
if (-not (Test-Path -LiteralPath $exeSource)) {
    throw "安装包不完整：找不到 AppHub.exe（$payload）"
}

Write-Host "正在安装 应用集合 AppHub..." -ForegroundColor Cyan

# 结束正在运行的实例，避免文件被占用
Get-Process -Name 'AppHub' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $payload '*') -Destination $InstallDir -Recurse -Force

$exePath = Join-Path $InstallDir 'AppHub.exe'
$iconPath = Join-Path $InstallDir 'assets\apphub.ico'
$shell = New-Object -ComObject WScript.Shell

function New-AppHubShortcut {
    param([string]$LinkPath)

    $parent = Split-Path -Parent $LinkPath
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

    $shortcut = $shell.CreateShortcut($LinkPath)
    $shortcut.TargetPath = $exePath
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.Description = '应用集合 AppHub'
    if (Test-Path -LiteralPath $iconPath) { $shortcut.IconLocation = "$iconPath,0" }
    $shortcut.Save()
}

if (-not $NoDesktopShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    New-AppHubShortcut -LinkPath (Join-Path $desktop '应用集合 AppHub.lnk')
    Write-Host "  已创建桌面快捷方式" -ForegroundColor DarkGray
}

if (-not $NoStartMenuShortcut) {
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    New-AppHubShortcut -LinkPath (Join-Path $startMenu '应用集合 AppHub.lnk')
    Write-Host "  已创建开始菜单快捷方式" -ForegroundColor DarkGray
}

Write-Host "安装完成：$InstallDir" -ForegroundColor Green
Write-Host "  卸载：右键开始菜单图标所在文件夹里的 uninstall.ps1，或删除该目录。"

if ($Launch) {
    Start-Process -FilePath $exePath -WorkingDirectory $InstallDir
}
