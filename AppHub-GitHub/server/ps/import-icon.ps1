param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Dest
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing | Out-Null

$image = $null
$icon = $null

try {
    if ([System.IO.Path]::GetExtension($Source).ToLower() -eq '.ico') {
        try {
            $icon = New-Object System.Drawing.Icon($Source, 256, 256)
            $image = $icon.ToBitmap()
        } catch {
            $icon = New-Object System.Drawing.Icon($Source)
            $image = $icon.ToBitmap()
        }
    } else {
        $image = [System.Drawing.Image]::FromFile($Source)
    }

    $size = 256
    $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $scale = [Math]::Min(($size - 12) / $image.Width, ($size - 12) / $image.Height)
    $width = [int][Math]::Max(1, [Math]::Round($image.Width * $scale))
    $height = [int][Math]::Max(1, [Math]::Round($image.Height * $scale))
    $x = [int](($size - $width) / 2)
    $y = [int](($size - $height) / 2)
    $graphics.DrawImage($image, $x, $y, $width, $height)

    $graphics.Dispose()

    $destDir = Split-Path -Parent $Dest
    if (-not (Test-Path -LiteralPath $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    $bitmap.Save($Dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    [Console]::Out.WriteLine('OK')
} finally {
    if ($image) { $image.Dispose() }
    if ($icon) { $icon.Dispose() }
}
