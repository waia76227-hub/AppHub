param(
    [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$items = New-Object System.Collections.ArrayList
$seenKeys = New-Object 'System.Collections.Generic.HashSet[string]'
$seenNames = New-Object 'System.Collections.Generic.HashSet[string]'
$seenTargets = New-Object 'System.Collections.Generic.HashSet[string]'
$wsh = New-Object -ComObject WScript.Shell

$skipRegex = '(?i)(\u5378\u8F7D|uninstall|readme|read\s?me|\u5E2E\u52A9|help|website|\u5B98\u7F51|\u624B\u518C|manual|documentation|\u6587\u6863|license|\u8BB8\u53EF|repair|\u4FEE\u590D|feedback|\u53CD\u9988|^install\s)'

function New-AppEntry {
    param(
        [string]$Name,
        [string]$Target,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$LnkPath,
        [string]$AppId,
        [string]$Kind,
        [string]$Source,
        [string]$IconSource
    )

    if ([string]::IsNullOrWhiteSpace($Name)) { return }
    $Name = $Name.Trim()
    if ($Name -match $skipRegex) { return }

    $key = if ($AppId) {
        'uwp:' + $AppId.ToLower()
    } elseif ($LnkPath) {
        'lnk:' + $LnkPath.ToLower()
    } else {
        'exe:' + $Target.ToLower()
    }
    if (-not $seenKeys.Add($key)) { return }

    if ($Target) {
        $targetKey = ($Target + '|' + $Arguments).ToLower()
        if (-not $seenTargets.Add($targetKey)) { return }
    }

    $nameKey = $Name.ToLower()
    if (-not $seenNames.Add($nameKey)) { return }

    [void]$items.Add([PSCustomObject]@{
        name     = $Name
        kind     = $Kind
        target   = $Target
        args     = $Arguments
        cwd      = $WorkingDirectory
        lnk      = $LnkPath
        appid    = $AppId
        source   = $Source
        iconFrom = $IconSource
    })
}

function Add-LnkFile {
    param([string]$Path, [string]$Source)

    $shortcut = $wsh.CreateShortcut($Path)
    if ($null -eq $shortcut) { return }

    $name = [System.IO.Path]::GetFileNameWithoutExtension($Path)
    $target = $shortcut.TargetPath
    $workingDirectory = $shortcut.WorkingDirectory
    $arguments = $shortcut.Arguments

    $kind = 'lnk'
    if ($target -and $target.ToLower().EndsWith('.exe')) { $kind = 'lnk' }

    # Do not list AppHub itself.
    if ($arguments -match 'AppHub' -or $target -match 'AppHub') { return }

    New-AppEntry -Name $name -Target $target -Arguments $arguments `
        -WorkingDirectory $workingDirectory -LnkPath $Path -AppId '' `
        -Kind $kind -Source $Source -IconSource $Path
}

$lnkDirs = @(
    @{ Path = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'); Source = 'startmenu' },
    @{ Path = (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'); Source = 'startmenu' },
    @{ Path = (Join-Path $env:USERPROFILE 'Desktop'); Source = 'desktop' },
    @{ Path = 'C:\Users\Public\Desktop'; Source = 'desktop' }
)

foreach ($dir in $lnkDirs) {
    if (-not (Test-Path -LiteralPath $dir.Path)) { continue }
    Get-ChildItem -LiteralPath $dir.Path -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            Add-LnkFile -Path $_.FullName -Source $dir.Source
        } catch { }
    }
}

# Windows Store / UWP apps and any Win32 app registered in the Apps folder.
$uwpSeen = 0
try {
    $shell = New-Object -ComObject Shell.Application
    $appsFolder = $shell.Namespace('shell:AppsFolder')
    if ($null -ne $appsFolder) {
        foreach ($item in $appsFolder.Items()) {
            try {
                $appId = [string]$item.Path
                $name = [string]$item.Name
                if ([string]::IsNullOrWhiteSpace($appId)) { continue }

                if ($appId.Contains('!')) {
                    New-AppEntry -Name $name -Target '' -Arguments '' -WorkingDirectory '' `
                        -LnkPath '' -AppId $appId -Kind 'uwp' -Source 'apps' `
                        -IconSource ('shell:AppsFolder\' + $appId)
                    $uwpSeen += 1
                } elseif ($appId.ToLower().EndsWith('.exe') -and $appId -match '^[A-Za-z]:\\') {
                    New-AppEntry -Name $name -Target $appId -Arguments '' -WorkingDirectory (Split-Path -Parent $appId) `
                        -LnkPath '' -AppId '' -Kind 'exe' -Source 'apps' -IconSource $appId
                }
            } catch { }
        }
    }
} catch { }

# If the shell Apps folder cannot be read, add a few essential Windows tools.
if ($uwpSeen -eq 0) {
    $builtins = @(
        @{ Name = '设置'; Path = (Join-Path $env:WINDIR 'ImmersiveControlPanel\SystemSettings.exe') },
        @{ Name = '计算器'; Path = (Join-Path $env:WINDIR 'System32\calc.exe') },
        @{ Name = '记事本'; Path = (Join-Path $env:WINDIR 'System32\notepad.exe') }
    )
    foreach ($builtin in $builtins) {
        if (Test-Path -LiteralPath $builtin.Path) {
            New-AppEntry -Name $builtin.Name -Target $builtin.Path -Arguments '' `
                -WorkingDirectory (Split-Path -Parent $builtin.Path) -LnkPath '' -AppId '' `
                -Kind 'exe' -Source 'builtin' -IconSource $builtin.Path
        }
    }
}

$json = ConvertTo-Json -InputObject @($items) -Depth 4 -Compress
if ([string]::IsNullOrWhiteSpace($json)) { $json = '[]' }
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
