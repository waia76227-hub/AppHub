param(
    [Parameter(Mandatory = $true)][string]$Vbs
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop '应用集合.lnk'
$appDir = Split-Path -Parent $Vbs
$exePath = Join-Path $appDir 'AppHub.exe'
$iconPath = Join-Path $appDir 'assets\apphub.ico'

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($linkPath)
if (Test-Path -LiteralPath $exePath) {
    $shortcut.TargetPath = $exePath
    $shortcut.WorkingDirectory = $appDir
    $shortcut.IconLocation = $exePath
} else {
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + $Vbs + '"'
    $shortcut.WorkingDirectory = $appDir
    if (Test-Path -LiteralPath $iconPath) {
        $shortcut.IconLocation = $iconPath
    }
}
$shortcut.Description = '我的应用集合'
$shortcut.Save()

[Console]::Out.WriteLine($linkPath)
