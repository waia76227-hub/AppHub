param(
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = $root }
$lib = Join-Path $PSScriptRoot 'lib'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path -LiteralPath $csc)) {
    throw '未找到 .NET Framework 编译器（csc.exe）。Windows 10/11 默认应自带。'
}

$cscArgs = @(
    '/nologo',
    '/target:winexe',
    "/out:$OutDir\AppHub.exe",
    "/win32icon:$root\assets\apphub.ico",
    "/r:$lib\Microsoft.Web.WebView2.Core.dll",
    "/r:$lib\Microsoft.Web.WebView2.WinForms.dll",
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    "$PSScriptRoot\AppHub.cs"
)

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) {
    throw "编译失败，退出码 $LASTEXITCODE"
}

Copy-Item -Path (Join-Path $lib '*.dll') -Destination $OutDir -Force
Write-Host "已生成 $OutDir\AppHub.exe"
