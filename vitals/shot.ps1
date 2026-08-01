# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - capture the live panel window to a PNG.
# Verification tool: reads the actual screen framebuffer at the window's rect.
#
# TWO WAYS TO CAPTURE, AND THE DEFAULT IS THE HONEST ONE.
#
# Screen copy (default): BitBlt from the SCREEN dc, so it gets whatever is genuinely on the glass -
# including translucency, blur and anything composited over the window. That is what the user sees,
# so it is what a verification tool should photograph.
#
# Its failure mode is the reason for the check below: it copies a RECTANGLE OF THE SCREEN, so if the
# window is not actually on top, the capture is a perfectly sharp photograph of some other program.
# SetForegroundWindow is not guaranteed - Windows refuses it from a background process - and this
# script used to discard its return value and shoot anyway. Now it confirms the window really did
# come forward and falls back rather than lying.
#
# PrintWindow (-Direct, and the automatic fallback): renders the window's own content, so occlusion
# and focus stop mattering. The plain flag does return black for GPU-composited surfaces like
# WebView2 - which is what the old comment here recorded - but PW_RENDERFULLCONTENT (flag 2, since
# Windows 8.1) does not. Measured 2026-07-31: four clean captures of the live WebView2 panel while
# it was fully occluded and never focused. It cannot show translucency over what is behind it, so
# it is the fallback and not the default.
#
#   .\shot.ps1 -Out shots\topbar.png

#   .\shot.ps1 -Out shots\setup.png -Title 'VITALS Setup'
#
# -Title exists because panel.ps1 has had one for a while: a second window (the popped-out chat, the
# setup screen) is distinguished by its caption, and a harness that only ever matched the literal
# string 'VITALS' silently photographed whichever OTHER window happened to hold that title. It does
# not error - it returns a perfectly good capture of the wrong thing, which is the worst way for a
# verification tool to fail.

param([string]$Out = 'shot.png', [string]$Title = 'VITALS', [switch]$Direct)

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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
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
$hwnd = $p.MainWindowHandle
$onTop = $false
if (-not $Direct) {
  [void][S]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 600    # let it repaint on top
  # ASK, DO NOT ASSUME. SetForegroundWindow's return value lies often enough that the only reliable
  # test is whether the window IS the foreground one afterwards.
  $onTop = ([S]::GetForegroundWindow() -eq $hwnd)
}

$r = New-Object S+RC
[void][S]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.R - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { Write-Error "bad rect ${w}x${h}"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap ([int]$w), ([int]$h)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
if ($onTop) {
  $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size ([int]$w), ([int]$h)))
  $how = 'screen'
} else {
  # Either -Direct was asked for, or the window would not come forward. Render its own content
  # rather than photographing whatever is sitting on top of it.
  $hdc = $g.GetHdc()
  [void][S]::PrintWindow($hwnd, $hdc, 2)      # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc)
  $how = if ($Direct) { 'direct' } else { 'direct (window would not come forward)' }
}
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"captured {0}x{1} at {2},{3} via {4} -> {5}" -f $w, $h, $r.L, $r.T, $how, $Out
