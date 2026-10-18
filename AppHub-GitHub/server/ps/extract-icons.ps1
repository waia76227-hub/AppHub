param(
    [Parameter(Mandatory = $true)][string]$Manifest,
    [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing | Out-Null

if (-not ('AppHubIconExtractor' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class AppHubIconExtractor
{
    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
    private interface IShellItemImageFactory
    {
        [PreserveSig]
        int GetImage(SIZE size, int flags, out IntPtr phbm);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE
    {
        public int cx;
        public int cy;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAP
    {
        public int bmType;
        public int bmWidth;
        public int bmHeight;
        public int bmWidthBytes;
        public ushort bmPlanes;
        public ushort bmBitsPixel;
        public IntPtr bmBits;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

    [DllImport("gdi32.dll")]
    private static extern int GetObject(IntPtr hgdiobj, int cbBuffer, out BITMAP lpvObject);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    public static bool Save(string path, string dest, int size)
    {
        Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
        IShellItemImageFactory factory;
        SHCreateItemFromParsingName(path, IntPtr.Zero, iid, out factory);
        IntPtr hbmp;
        int hr = factory.GetImage(new SIZE { cx = size, cy = size }, 0x4 | 0x1, out hbmp);
        if (hr != 0) throw new COMException("GetImage failed: " + hr, hr);
        try
        {
            BITMAP bm;
            if (GetObject(hbmp, Marshal.SizeOf(typeof(BITMAP)), out bm) == 0 || bm.bmBits == IntPtr.Zero || bm.bmBitsPixel != 32)
            {
                using (Bitmap fallback = Bitmap.FromHbitmap(hbmp))
                {
                    fallback.Save(dest, ImageFormat.Png);
                }
                return true;
            }

            int width = bm.bmWidth;
            int height = Math.Abs(bm.bmHeight);
            using (Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                BitmapData data = bmp.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                try
                {
                    byte[] row = new byte[width * 4];
                    for (int y = 0; y < height; y++)
                    {
                        int sourceY = bm.bmHeight > 0 ? (height - 1 - y) : y;
                        IntPtr source = IntPtr.Add(bm.bmBits, sourceY * bm.bmWidthBytes);
                        Marshal.Copy(source, row, 0, width * 4);
                        Marshal.Copy(row, 0, IntPtr.Add(data.Scan0, y * data.Stride), width * 4);
                    }
                }
                finally
                {
                    bmp.UnlockBits(data);
                }
                bmp.Save(dest, ImageFormat.Png);
            }
        }
        finally
        {
            DeleteObject(hbmp);
        }
        return true;
    }
}
'@ -ReferencedAssemblies System.Drawing | Out-Null
}

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$apps = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $apps) { $apps = @() }

foreach ($app in @($apps)) {
    $dest = Join-Path $OutDir ($app.id + '.png')
    $ok = $false

    foreach ($source in @($app.source, $app.fallback)) {
        if ([string]::IsNullOrWhiteSpace($source)) { continue }
        try {
            if (Test-Path -LiteralPath $source) {
                [void][AppHubIconExtractor]::Save($source, $dest, 128)
                $ok = $true
                break
            } elseif ($source.StartsWith('shell:')) {
                [void][AppHubIconExtractor]::Save($source, $dest, 128)
                $ok = $true
                break
            }
        } catch { }
    }

    if ($ok) {
        [Console]::Out.WriteLine('I:' + $app.id)
    } else {
        [Console]::Out.WriteLine('F:' + $app.id)
    }
}
