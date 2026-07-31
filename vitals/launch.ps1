# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS launcher — starts the bridge, opens the panel, makes it float.
#
# Why this and not Electron: Electron would add ~150 MB of resident memory to a machine already at
# 78% RAM, to render a page Edge can render with a process it mostly already has warm. Edge's
# --app mode gives a frameless window; the Win32 calls below give it always-on-top and translucency.
# Net cost is roughly a third of an Electron shell.
#
#   .\launch.ps1                    # default: 94% opacity, top-right
#   .\launch.ps1 -Alpha 215         # more see-through (0-255)
#   .\launch.ps1 -Width 1180 -Height 760
#   .\launch.ps1 -NoTop             # behave like a normal window

param(
  [int]$Alpha  = 240,
  [int]$Width  = 1080,
  [int]$Height = 720,
  [int]$Port   = 8790,
  [switch]$NoTop,
  [switch]$Framed        # keep the OS title bar (escape hatch if frameless misbehaves)
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------- 1. bridge ----------
$alive = $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($alive) {
  Write-Host "bridge already listening on $Port" -ForegroundColor DarkGray
} else {
  # A BUNDLED RUNTIME WINS OVER PATH, and this order is the whole point of the portable build.
  # vitals.cmd and vitals.sh already preferred runtime\node.exe; this script did not, so the one
  # entry point a normal person uses - double-clicking VITALS.exe - was the only one that still
  # demanded a system Node. It failed with "node not found on PATH" while the runtime it needed sat
  # in the same folder. A fallback that the primary path does not share is not a fallback.
  $bundled = Join-Path $here 'runtime\node.exe'
  if (Test-Path -LiteralPath $bundled) {
    $node = $bundled
  } else {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  }
  if (-not $node) { throw "node not found: no runtime\node.exe in the install folder and none on PATH" }
  Start-Process -FilePath $node -ArgumentList "`"$here\bridge.js`"" -WorkingDirectory $here -WindowStyle Hidden
  Write-Host "bridge starting on $Port…" -ForegroundColor DarkGray
  $ok = $false
  foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 250
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { $ok = $true; break }
  }
  if (-not $ok) { throw "bridge did not come up on $Port — run 'node bridge.js' directly to see the error" }
}

# ---------- 2. panel ----------
# Native WinForms + WebView2 host. Preferred over Edge --app because Chromium paints its title bar
# inside the client area, so an --app window can never be made frameless from the outside.
$panel = Join-Path $here 'panel.ps1'

# SINGLE INSTANCE. The bridge was already guarded ("bridge already listening") but the panel was not,
# so launching twice - a double-click, or clicking a pinned tile while it was running - produced a
# second window quietly competing with the first for the same port and the same dock geometry. Now a
# second launch RAISES the existing window instead, which is what clicking an app's icon should do.
Add-Type -Namespace VW -Name Find -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@ -ErrorAction SilentlyContinue
$existing = [IntPtr]::Zero
try {
  $cb = [VW.Find+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [void][VW.Find]::GetWindowTextW($h, $sb, 256)
    if ($sb.ToString() -eq 'VITALS' -and [VW.Find]::IsWindowVisible($h)) { $script:existing = $h; return $false }
    return $true
  }
  [void][VW.Find]::EnumWindows($cb, [IntPtr]::Zero)
} catch {}
if ($existing -ne [IntPtr]::Zero) {
  Write-Host "VITALS is already running - raising the existing window" -ForegroundColor DarkGray
  if ([VW.Find]::IsIconic($existing)) { [void][VW.Find]::ShowWindow($existing, 9) }   # SW_RESTORE
  [void][VW.Find]::SetForegroundWindow($existing)
  return
}

# ARM64: WebView2Loader.dll shipped here is an x64 NATIVE binary, and ARM64 Windows PowerShell cannot
# load an x64 native DLL into its process. Untreated that is the same silent nothing as a blocked
# download - the host starts, the load fails, no window. Detected up front so the fallback is used
# deliberately and the reason is stated, rather than discovered as an absence.
$archNative = $env:PROCESSOR_ARCHITECTURE
if ($archNative -eq 'ARM64') {
  Write-Host "ARM64 detected - the bundled WebView2 loader is x64-only, so the frameless host cannot run here." -ForegroundColor Yellow
  Write-Host "  falling back to a browser window (it will have a title bar). Everything else is unaffected." -ForegroundColor DarkGray
}
if ($archNative -ne 'ARM64' -and (Test-Path (Join-Path $here 'lib\Microsoft.Web.WebView2.WinForms.dll')) -and (Test-Path $panel)) {
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',$panel,
         '-Port',"$Port",'-Width',"$Width",'-Height',"$Height",
         '-Alpha',([Math]::Round($Alpha / 255.0, 3)).ToString([Globalization.CultureInfo]::InvariantCulture))
  if ($NoTop) { $a += '-NoTop' }

  # UNBLOCK FIRST. A folder extracted from a downloaded .zip carries Mark of the Web on every file,
  # and .NET refuses to load a managed assembly so marked. panel.ps1 unblocks its own DLLs too, but
  # doing it here as well means the sweep happens even if panel.ps1 itself is the blocked file.
  # Idempotent, unelevated, and a no-op on a folder that was never downloaded.
  try { Get-ChildItem -LiteralPath $here -Recurse -File -ErrorAction SilentlyContinue |
          Unblock-File -ErrorAction SilentlyContinue } catch {}

  Start-Process powershell -ArgumentList $a -WindowStyle Hidden

  # VERIFY THE WINDOW EXISTS BEFORE CLAIMING IT DOES.
  # This block used to print "native panel launched" the instant Start-Process returned, which says
  # only that PowerShell was started - not that it survived, and certainly not that a window appeared.
  # Every host-side failure (blocked DLLs, ARM64, missing WebView2 runtime, a WinForms exception) then
  # produced a cheerful green success line, no error, no log, and nothing on screen. Worse, the
  # working Edge fallback below was never reached, because this branch had already returned.
  # So: wait for a window with our title, and if none arrives, fall through to the fallback.
  $seen = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 700
    if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'VITALS' }) { $seen = $true; break }
  }
  if ($seen) {
    Write-Host "native panel launched (frameless WebView2 host)" -ForegroundColor Green
    Write-Host ""
    Write-Host "  VITALS  ->  http://127.0.0.1:$Port" -ForegroundColor Cyan
    Write-Host "  drag the top strip - double-click it to dock left/right" -ForegroundColor DarkGray
    Write-Host "  keys: 1-9,0 switch views - Esc = overview - Shift+Esc closes the panel" -ForegroundColor DarkGray
    return
  }
  Write-Host "the native host did not produce a window within 21s" -ForegroundColor Yellow
  $panelLog = Join-Path $here 'history\panel.log'
  if (Test-Path $panelLog) {
    Write-Host "  last lines of history\panel.log:" -ForegroundColor DarkGray
    Get-Content $panelLog -Tail 4 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  }
  Write-Host "  falling back to a browser window" -ForegroundColor Yellow
}
Write-Host "WebView2 host unavailable - falling back to an Edge --app window (it will have a title bar)" -ForegroundColor Yellow

$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found" }

# Load the assembly BEFORE referencing the type, and fall back if the screen query fails at all
# (headless / RDP / odd DPI setups) rather than aborting the launch over window placement.
Add-Type -AssemblyName System.Windows.Forms
$x = 60
try { $x = [int]([System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Width - $Width - 24) } catch {}
if ($x -lt 0) { $x = 0 }

# NOT $profile - that is a PowerShell automatic variable holding the path to your profile script.
$userData = Join-Path $env:LOCALAPPDATA 'vitals-panel'
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  "--app=http://127.0.0.1:$Port/",
  "--window-size=$Width,$Height",
  "--window-position=$x,60",
  "--user-data-dir=`"$userData`"",    # own profile: keeps the panel out of your browsing session
  "--no-first-run",
  "--disable-features=Translate,OptimizationGuideModelDownloading"
)

# ---------- 3. Win32: float it ----------
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint k, byte a, uint f);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr r, bool redraw);
  [DllImport("gdi32.dll")]  public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$GWL_STYLE = -16; $GWL_EXSTYLE = -20; $WS_EX_LAYERED = 0x80000
$LWA_ALPHA = 0x2; $HWND_TOPMOST = [IntPtr](-1)
$SWP = 0x0001 -bor 0x0002 -bor 0x0010     # NOSIZE | NOMOVE | NOACTIVATE
$SWP_FRAMECHANGED = 0x0020
# WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
$FRAME_BITS = 0x00C00000 -bor 0x00040000 -bor 0x00800000 -bor 0x00400000 -bor 0x00080000 -bor 0x00020000 -bor 0x00010000

$hwnd = [IntPtr]::Zero
foreach ($i in 1..60) {
  Start-Sleep -Milliseconds 250
  $proc.Refresh()
  if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $proc.MainWindowHandle; break }
  # Edge often re-parents to an existing browser_broker process, so fall back to a title match
  $c = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'VITALS' } | Select-Object -First 1
  if ($c) { $hwnd = $c.MainWindowHandle; break }
}

if ($hwnd -eq [IntPtr]::Zero) {
  Write-Warning "panel opened but its window handle never appeared — it is running, just not floated."
} else {
  # 1. strip the frame. Edge --app still draws a Chromium title bar; there is no command-line flag
  #    that removes it, so the window style has to be rewritten. SWP_FRAMECHANGED is required or
  #    Windows keeps painting the old non-client area.
  if (-not $Framed) {
    $st = [W]::GetWindowLong($hwnd, $GWL_STYLE)
    [void][W]::SetWindowLong($hwnd, $GWL_STYLE, ($st -band (-bnot $FRAME_BITS)))
    [void][W]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, ($SWP -bor $SWP_FRAMECHANGED))

    # 2. round the ACTUAL window. CSS border-radius rounds the page inside a square window, which
    #    is why the corners looked like they were floating in a rectangle. This clips the OS window.
    $rc = New-Object W+RECT
    [void][W]::GetWindowRect($hwnd, [ref]$rc)
    $rgn = [W]::CreateRoundRectRgn(0, 0, ($rc.R - $rc.L + 1), ($rc.B - $rc.T + 1), 28, 28)
    [void][W]::SetWindowRgn($hwnd, $rgn, $true)
  }

  if ($Alpha -lt 255) {
    [void][W]::SetWindowLong($hwnd, $GWL_EXSTYLE, ([W]::GetWindowLong($hwnd, $GWL_EXSTYLE) -bor $WS_EX_LAYERED))
    [void][W]::SetLayeredWindowAttributes($hwnd, 0, [byte]$Alpha, $LWA_ALPHA)
  }
  if (-not $NoTop) { [void][W]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, $SWP) }
  Write-Host "panel floated - frameless $(-not $Framed), rounded, alpha $Alpha, topmost $(-not $NoTop)" -ForegroundColor Green
}

Write-Host ""
Write-Host "  VITALS  →  http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "  keys: 1-9,0 switch views · Esc = overview · 7 = Diagnose" -ForegroundColor DarkGray
Write-Host "  stop: Get-Process node | Where-Object { `$_.Id -eq (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess } | Stop-Process" -ForegroundColor DarkGray
