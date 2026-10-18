$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms | Out-Null

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择图标图片'
$dialog.Filter = '图片 (*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.ico)|*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.ico|所有文件 (*.*)|*.*'
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized

$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine($dialog.FileName)
} else {
    [Console]::Out.WriteLine('')
}

$owner.Dispose()
