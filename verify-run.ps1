# Launch the widget hidden and capture a screenshot of the primary screen.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File verify-run.ps1
$ErrorActionPreference = 'Stop'
$proj = 'C:\KomarovLocal\Kimi Code\KimiUsageWidget'
$shot = Join-Path $proj 'widget-screenshot.png'

# start hidden, detached
$proc = Start-Process -WindowStyle Hidden -PassThru -WorkingDirectory $proj `
  -FilePath (Join-Path $proj 'node_modules\.bin\electron.cmd') -ArgumentList '.'
Write-Host "widget started, pid=$($proc.Id)"
Start-Sleep -Seconds 6

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "screenshot saved: $shot"
