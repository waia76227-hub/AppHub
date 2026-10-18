param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [Parameter(Mandatory = $true)][string]$Enable,
    [string]$StartupDir = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($StartupDir)) {
    $StartupDir = [Environment]::GetFolderPath('Startup')
}

$enabled = $Enable -eq 'true'
$linkPath = Join-Path $StartupDir '应用集合.lnk'

if (-not $enabled) {
    if (Test-Path -LiteralPath $linkPath) {
        Remove-Item -LiteralPath $linkPath -Force
    }
    [Console]::Out.WriteLine('OK')
    return
}

if (-not (Test-Path -LiteralPath $StartupDir)) {
    New-Item -ItemType Directory -Path $StartupDir -Force | Out-Null
}

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($linkPath)

$exePath = Join-Path $AppDir 'AppHub.exe'
if (Test-Path -LiteralPath $exePath) {
    $shortcut.TargetPath = $exePath
    $shortcut.Arguments = ''
    $shortcut.IconLocation = $exePath
} else {
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $AppDir '启动应用集合.vbs') + '"'
    $shortcut.IconLocation = Join-Path $AppDir 'assets\apphub.ico'
}

$shortcut.WorkingDirectory = $AppDir
$shortcut.Description = '我的应用集合'
$shortcut.Save()
[Console]::Out.WriteLine('OK')
