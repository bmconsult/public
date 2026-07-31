# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - capture the live panel window to a PNG.
# Verification tool: reads the actual screen framebuffer at the window's rect.
#
# BitBlt from the SCREEN dc, not PrintWindow on the window dc. PrintWindow asks the app to redraw
# itself into a bitmap, which returns black for GPU-composited surfaces like WebView2. Copying the
# screen gets whatever is genuinely on it - the only honest check of what the user sees.
#
#   .\shot.ps1 -Out shots\topbar.png

#   .\shot.ps1 -Out shots\setup.png -Title 'VITALS Setup'
#
# -Title exists because panel.ps1 has had one for a while: a second window (the popped-out chat, the
# setup screen) is distinguished by its caption, and a harness that only ever matched the literal
# string 'VITALS' silently photographed whichever OTHER window happened to hold that title. It does
# not error - it returns a perfectly good capture of the wrong thing, which is the worst way for a
# verification tool to fail.

param([string]$Out = 'shot.png', [string]$Title = 'VITALS')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $here $Out }
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

Add-Type @"
using System;using System.Runtime.InteropServices;
public static class S {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L, T, R, B; }
}
"@

$p = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1
if (-not $p) {
  $seen = (Get-Process | Where-Object { $_.MainWindowTitle -like 'VITALS*' } |
           ForEach-Object { $_.MainWindowTitle }) -join ', '
  Write-Error ("no window titled '$Title'" + $(if ($seen) { " - VITALS windows open: $seen" } else { '' }))
  exit 1
}
[void][S]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 600      # let it repaint on top

$r = New-Object S+RC
[void][S]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.R - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { Write-Error "bad rect ${w}x${h}"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap ([int]$w), ([int]$h)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size ([int]$w), ([int]$h)))
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"captured {0}x{1} at {2},{3} -> {4}" -f $w, $h, $r.L, $r.T, $Out
