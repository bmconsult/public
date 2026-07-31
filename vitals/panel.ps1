# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - native panel host.
#
# Replaces the Edge --app window, which could never be made frameless: Chromium paints its title bar
# INSIDE the client area as part of its own UI, so Win32 window styles cannot remove it. Stripping
# WS_CAPTION only knocked Edge off its custom dark frame onto the native one, which looked worse.
#
# This is a plain WinForms Form (FormBorderStyle = None - genuinely no frame, nothing to remove)
# hosting a WebView2 control, which is the same Chromium engine rendering the same page. Rounded
# corners come from DWM on Windows 11, so they are real antialiased corners with a proper shadow
# rather than a hard-clipped region.
#
#   .\panel.ps1 -Port 8790 -Width 1120 -Height 740 -Alpha 0.94

param(
  [int]$Port   = 8790,
  [int]$Width  = 1120,
  [int]$Height = 740,
  # -Path lets a second window open onto a different view of the SAME bridge - the popped-out Ask
  # chat is "/?view=ask". It is appended to http://127.0.0.1:$Port, so this host can never be aimed
  # anywhere but the local bridge no matter what asks it to open a window.
  [string]$Path = '/',
  # -Title distinguishes windows in the taskbar and, more importantly, lets the capture harness and
  # the watchdog tell the panel apart from its own children.
  [string]$Title = 'VITALS',
  [double]$Alpha = 0.94,
  [switch]$NoTop,
  # -Spy: append raw WM_ACTIVATE / WM_ACTIVATEAPP / WM_SIZE / WM_SYSCOMMAND traffic to
  # history\panel-spy.log. Diagnostic aid for shell-interaction bugs (taskbar clicks, activation);
  # costs one file append per logged message, off by default.
  [switch]$Spy
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$lib  = Join-Path $here 'lib'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class N {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool SetDllDirectoryW(string p);
  [DllImport("dwmapi.dll")]  public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  [DllImport("user32.dll")]  public static extern bool ReleaseCapture();
  [DllImport("user32.dll")]  public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string id);
  [DllImport("user32.dll")]  public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")]  public static extern short GetAsyncKeyState(int k);
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
}
"@

# Without this the taskbar groups the window under powershell.exe and shows POWERSHELL's icon no
# matter what Form.Icon says - the AppUserModelID, not the window icon, is what decides grouping.
# Must be set before the first window is created.
try { [void][N]::SetCurrentProcessExplicitAppUserModelID('Ben.Vitals.Panel') } catch {}

# WebView2Loader.dll is a NATIVE dll the managed wrapper P/Invokes by bare name, so it is resolved
# against the process search path, not the assembly folder. Without this the control throws
# "Couldn't find WebView2 Runtime" even though the runtime is installed.
[void][N]::SetDllDirectoryW($lib)

# THE LOGGER IS CREATED HERE, NOT LATER.
# It used to be defined ~50 lines below, after the assembly load - so the single most likely startup
# failure on a fresh machine wrote nothing anywhere. $ErrorActionPreference is 'Stop', the script
# died at the Add-Type, and the only evidence was a window that never appeared.
$logFile = Join-Path $here 'history\panel.log'
if (-not (Test-Path (Split-Path -Parent $logFile))) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $logFile) -Force | Out-Null
}
function Log($m) { try { Add-Content -LiteralPath $logFile -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) } catch {} }

# MARK OF THE WEB. A folder extracted from a downloaded .zip carries a Zone.Identifier stream on
# EVERY file, and .NET refuses to load a managed assembly so marked: "Operation is not supported"
# (0x80131515). Unzip-and-run is the normal way someone acquires this, so untreated it means the
# panel never appears on a fresh download - the most common first experience, failing silently.
# Unblock-File is idempotent, costs nothing when there is no mark, and needs no elevation.
foreach ($f in @(
  (Join-Path $lib 'Microsoft.Web.WebView2.Core.dll'),
  (Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll'),
  (Join-Path $lib 'WebView2Loader.dll'))) {
  if (Test-Path -LiteralPath $f) { try { Unblock-File -LiteralPath $f -ErrorAction SilentlyContinue } catch {} }
}

# The load is the failure point, so it reports rather than dying mute. Rethrown afterwards so
# launch.ps1's fallback still triggers - this makes the failure VISIBLE, it does not hide it.
try {
  Add-Type -Path (Join-Path $lib 'Microsoft.Web.WebView2.Core.dll')
  Add-Type -Path (Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll')
} catch {
  Log ("FATAL: could not load the WebView2 assemblies: " + $_.Exception.Message)
  Log ("       if this folder came from a .zip, Windows may have marked the files:")
  Log ("       Get-ChildItem -Recurse '" + $here + "' | Unblock-File")
  throw
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$form = New-Object System.Windows.Forms.Form
$form.Text            = $Title
$form.FormBorderStyle = 'None'          # no frame at all - nothing to strip
$form.StartPosition   = 'Manual'
$form.Size            = New-Object System.Drawing.Size($Width, $Height)
$form.BackColor       = [System.Drawing.Color]::FromArgb(7, 9, 14)
$form.TopMost         = (-not $NoTop)
$form.Opacity         = [Math]::Max(0.25, [Math]::Min(1.0, $Alpha))
$form.ShowInTaskbar   = $true
$form.MinimumSize     = New-Object System.Drawing.Size(560, 400)
# POSITION LAST, and from the EFFECTIVE size. MinimumSize is 560 wide, so a window asked for at 520
# silently becomes 560 - and placing it before that line, using the REQUESTED width, hung it 40px off
# the right edge of the screen. Reading $form.Width back only helps once every constraint that can
# change it has been applied, which is why this moved below MinimumSize rather than staying put with
# a smarter expression. Clamped on both axes so any requested size lands somewhere visible.
$form.Location        = New-Object System.Drawing.Point(
                          [Math]::Max(0, $screen.Width  - $form.Width  - 24),
                          [Math]::Max(0, [Math]::Min(60, $screen.Height - $form.Height - 24)))
# vitals.ico is generated by makeicon.ps1 from the dashboard's own ring motif. Fall back to the
# host's icon only if it is genuinely missing - never silently, so a broken icon is visible.
$icoPath = Join-Path $here 'vitals.ico'
if (Test-Path $icoPath) {
  try { $form.Icon = New-Object System.Drawing.Icon($icoPath) }
  catch { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Get-Process -Id $PID).Path) }
} else {
  try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Get-Process -Id $PID).Path) } catch {}
}

$wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$wv.Dock = 'Fill'
$wv.DefaultBackgroundColor = [System.Drawing.Color]::FromArgb(7, 9, 14)

# WebView2 creates its user-data folder next to the HOST EXECUTABLE by default. The host here is
# C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe, so it tries to write into System32 and
# fails - silently. The control initialises to nothing and you get an empty window with no error.
# Always set this explicitly when hosting WebView2 from PowerShell.
$udf = Join-Path $env:LOCALAPPDATA 'vitals-webview'
if (-not (Test-Path $udf)) { New-Item -ItemType Directory -Path $udf -Force | Out-Null }
$cp = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
$cp.UserDataFolder = $udf
$wv.CreationProperties = $cp

# (Log and $logFile are defined above, before the assembly load that most often fails.)

# Never let initialisation fail quietly again.
$wv.add_CoreWebView2InitializationCompleted({
  param($s, $e)
  if ($e.IsSuccess) {
    Log "webview init OK"
    $wv.CoreWebView2.Settings.AreDefaultContextMenusEnabled = $false
    $wv.CoreWebView2.Settings.IsStatusBarEnabled = $false
    $wv.CoreWebView2.Settings.AreDevToolsEnabled = $true
    $wv.CoreWebView2.Navigate("http://127.0.0.1:$Port$Path")
  } else {
    Log ("webview init FAILED: " + $e.InitializationException.Message)
    $form.Text = 'VITALS - webview init failed'
  }
})
$wv.add_NavigationCompleted({
  param($s, $e)
  Log ("navigation " + $(if ($e.IsSuccess) { 'OK' } else { 'FAILED status=' + $e.WebErrorStatus }))
})

$form.Controls.Add($wv)

# ---- messages from the page (drag / minimise / close / opacity / topmost / resize) ----
# ---- edge docking ----
# Drag to a screen edge and the panel becomes a thin sidebar or topbar; drag away and it restores.
$script:mode = 'panel'
# Seeded from the launch geometry, NOT $null. It was only ever set inside the drag handler, so
# docking by any other route (hotkey, API) left it empty and "restore" restored nothing - the
# window just kept its topbar size.
$script:floatRect = New-Object System.Drawing.Rectangle(
                      [Math]::Max(0, $screen.Width - $Width - 24), 60, $Width, $Height)
$SIDEBAR_W = 138
$TOPBAR_H  = 46
$EDGE      = 20                    # how close the CURSOR must get to an edge to dock

function Set-PanelMode([string]$m) {
  # Auto-hide exit must run BEFORE the same-mode short-circuit: parking CONVERTS to sidebar-right,
  # so a dock command for sidebar-right arriving while parked matches the current mode — the old
  # order returned early and left the window invisible while claiming to be docked. Same mode →
  # slide back to the visible dock rect; different mode → no restore, the new dock owns geometry.
  if ($script:autoHide) { Exit-AutoHide ($m -eq $script:mode) }
  if ($m -eq $script:mode) { return }
  $wa = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
  # MinimumSize silently CLAMPS any assignment to Bounds - a 132 px sidebar came out 560 px wide
  # and a 64 px topbar came out 400 px tall, which is exactly the minimum. Drop the floor while
  # docked and restore it for the floating panel, where it stops the window being resized to
  # uselessness.
  $form.MinimumSize = if ($m -eq 'panel') { New-Object System.Drawing.Size(560, 400) }
                      else                { New-Object System.Drawing.Size(0, 0) }
  switch ($m) {
    'sidebar-left'  { $form.Bounds = New-Object System.Drawing.Rectangle($wa.Left, $wa.Top, $SIDEBAR_W, $wa.Height) }
    'sidebar-right' { $form.Bounds = New-Object System.Drawing.Rectangle(($wa.Right - $SIDEBAR_W), $wa.Top, $SIDEBAR_W, $wa.Height) }
    'topbar'        { $form.Bounds = New-Object System.Drawing.Rectangle($wa.Left, $wa.Top, $wa.Width, $TOPBAR_H) }
    'panel'         { if ($script:floatRect) { $form.Bounds = $script:floatRect } }
  }
  # Square off the outer corners when flush to an edge - rounded corners against a screen edge read
  # as a mistake. DWMWCP_DONOTROUND = 1, DWMWCP_ROUND = 2.
  $corner = if ($m -eq 'panel') { 2 } else { 1 }
  [void][N]::DwmSetWindowAttribute($form.Handle, 33, [ref]$corner, 4)
  $script:mode = $m
  Apply-Chrome
  Log "mode -> $m"
  try { $wv.CoreWebView2.PostWebMessageAsString("mode:$m") } catch {}
}

# THE DARK CORNERS (2026-07-29). The owner: "the corners of the window have a darkened edge is that
# intentional or an artifact?" It was an artifact, and not the one I first blamed.
#
# Measured, not guessed. Sampling the diagonal inward from the window's visual bounds gave
# +2=220, +3=115,118,120, +4=212, +5=243(panel). Two facts killed my first theory that this was
# Windows' own rounded-window border: setting DWMWA_BORDER_COLOR to COLOR_NONE returned S_OK and did
# not change that pixel, and the pixel stayed 115 with the window at two different screen positions
# over different wallpaper - a pixel that ignores what is behind it is OPAQUE and drawn by US.
# On a STRAIGHT edge the same shell border measures 207 and is invisible; at a corner the 14 px radius
# swings the arc about 4 px inward, which is why only the corners ever showed it.
#
# The real cause: these two lines were hard-coded to the dark theme's #07090e back when the app was
# dark-only. The page paints #shell with a 14 px radius over a transparent body, so in the wedge
# between the window's own clip and that arc there is nothing but this backdrop. On dark themes it
# matches the shell and cannot be seen; on light/pro the corner pixel is an antialiased blend of the
# 243 surface against a 7 backdrop, which lands at ~115. Same shape as the GPU-reads-0 bug: a value
# that was right when written and was never revisited when the context changed.
#
# So the backdrop follows the theme. The DWM border colour is set alongside it (attr 34, a COLORREF in
# 0x00BBGGRR order - the bytes are REVERSED from RGB) because leaving it at the system default means
# inheriting whatever contrast Windows picks; DWMWA_COLOR_NONE = 0xFFFFFFFE = -2 signed.
$script:themeName = 'dark'
function Apply-Chrome {
  $bg = switch ($script:themeName) {
    'light' { @(243, 242, 238) }   # #f3f2ee, the light shell's own surface
    'pro'   { @(236, 238, 241) }   # #eceef1
    'beast' { @(2, 4, 9) }         # #020409
    default { @(7, 9, 14) }        # dark: #07090e
  }
  $c = [System.Drawing.Color]::FromArgb($bg[0], $bg[1], $bg[2])
  try { $form.BackColor = $c } catch {}
  try { $wv.DefaultBackgroundColor = $c } catch {}
  # Docked strips sit flush to a screen edge, where any rim reads as a seam (the owner already had me
  # remove a light strip in that mode). No border when docked; a themed rim only when floating.
  $b = if ($script:mode -ne 'panel') { -2 } else {
    switch ($script:themeName) {
      'light' { 0x00D1D7D9 }   # #d9d7d1 - warm paper, one shade under #f3f2ee
      'pro'   { 0x00DDD7D3 }   # #d3d7dd - cool grey against #eceef1
      'beast' { 0x0030211B }   # #1b2130 - faint rim on near-black
      default { 0x0042322B }   # dark: #2b3242
    }
  }
  try { [void][N]::DwmSetWindowAttribute($form.Handle, 34, [ref]$b, 4) } catch {}
}

function Get-Zone([int]$x, [int]$y) {
  $wa = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($x, $y))).WorkingArea
  if     ($x -le ($wa.Left + $EDGE))  { return 'sidebar-left' }
  elseif ($x -ge ($wa.Right - $EDGE)) { return 'sidebar-right' }
  elseif ($y -le ($wa.Top + $EDGE))   { return 'topbar' }
  return 'panel'
}

# ---- auto-hide at the right screen edge (2026-07-29, owner ask; reworked same day) ----
# The owner's refined spec: "when you click minimize i want it to just be in the vertical thin
# hiding to popout as the side widget not the window when sliding over. if you click the icon it
# should open the window or the side whichever is open or was minimized."
# So minimise CONVERTS: whatever mode you were in, the thing living at the edge is the thin
# SIDEBAR widget — sliding to the edge reveals the sidebar, never the 1240px panel. The taskbar
# icon gives back whatever you minimised (panel → panel, sidebar → sidebar).
$script:autoHide   = $false
$script:peeked     = $false
$script:preTop     = $true
$script:outT       = $null
# THREE distinct pieces of state, deliberately not overloaded (floatRect double-duty already
# caused one shape bug today — see parkRect note):
#   floatRect  = the floating panel's geometry (owned by drag/Set-PanelMode)
#   parkRect   = the VISIBLE position of the parked widget (always the right-docked sidebar rect)
#   preMinMode = what minimise converted FROM, i.e. what the taskbar icon must give back
$script:parkRect   = $null
$script:preMinMode = 'panel'
# Fully off-screen: the owner asked ("do we need the thin white strip? my bottom one has [none]").
# His taskbar actually leaves 2 px, but dark-on-dark it reads as nothing — ours read as a white
# line in the paper themes. The reveal trigger is the whole edge, so no visible affordance needed.
$PEEK = 0

function Move-Slide([System.Drawing.Rectangle]$to) {
  $from = $form.Bounds
  for ($i = 1; $i -le 8; $i++) {
    $t = $i / 8.0
    $form.Location = New-Object System.Drawing.Point(
      [int]($from.X + ($to.X - $from.X) * $t), [int]($from.Y + ($to.Y - $from.Y) * $t))
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 11
  }
  $form.Bounds = $to
}

function Enter-AutoHide {
  if ($script:autoHide) { return }
  if ($script:mode -ne 'panel' -and $script:mode -ne 'sidebar-right') { return }  # left/top keep real minimise
  $script:preMinMode = $script:mode
  $script:preTop = $form.TopMost
  # CONVERT first: the parked thing is always the thin sidebar widget. Set-PanelMode saves
  # nothing about the panel, so bank the float geometry before converting.
  if ($script:mode -eq 'panel') {
    $script:floatRect = $form.Bounds
    Set-PanelMode 'sidebar-right'
  }
  $script:parkRect = $form.Bounds          # the sidebar's visible rect — where a peek slides to
  # The parked window must stay above other windows or the edge-reveal cannot reach it - the
  # user's topmost preference is saved and restored on exit.
  $form.TopMost = $true
  $wa = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
  $c = 1; [void][N]::DwmSetWindowAttribute($form.Handle, 33, [ref]$c, 4)   # square against the edge
  Move-Slide (New-Object System.Drawing.Rectangle(($wa.Right - $PEEK), $form.Bounds.Y, $form.Bounds.Width, $form.Bounds.Height))
  $script:autoHide = $true; $script:peeked = $false
  try { $wv.CoreWebView2.PostWebMessageAsString('autohide:1') } catch {}
  Log ("autohide: parked as sidebar (from " + $script:preMinMode + ")")
}

# Leaves the auto-hide state only. $restorePosition slides back to the parked widget's visible
# rect; it does NOT convert modes — that is Restore-FromAutoHide's job.
function Exit-AutoHide([bool]$restorePosition = $true) {
  if (-not $script:autoHide) { return }
  $script:autoHide = $false; $script:peeked = $false; $script:outT = $null
  $form.TopMost = $script:preTop
  if ($restorePosition -and $script:parkRect) { Move-Slide $script:parkRect }
  try { $wv.CoreWebView2.PostWebMessageAsString('autohide:0') } catch {}
  Log 'autohide: exited'
}

# The full un-minimise: give back whatever minimise converted from ("whichever is open or was
# minimized"). panel → Set-PanelMode restores floatRect, round corners, min-size; sidebar →
# slide the widget back to its docked position.
function Restore-FromAutoHide {
  if (-not $script:autoHide) { return }
  $wasPre = $script:preMinMode
  Exit-AutoHide $false
  if ($wasPre -eq 'panel') { Set-PanelMode 'panel' }
  else {
    if ($script:parkRect) { Move-Slide $script:parkRect }
    $c = 1; [void][N]::DwmSetWindowAttribute($form.Handle, 33, [ref]$c, 4)  # still flush right
  }
  # RAISE IT. Restoring geometry and mode is not enough when TopMost is off: the window returns to
  # its position but keeps its old z-order, so it comes back BEHIND whatever the user is looking at.
  # From the user's side that is indistinguishable from "it didn't come back" — and it is exactly why
  # clicking another window first appeared to fix the taskbar button: that route raises the window as
  # a side effect. Evidence: panel.log shows six consecutive successful park/restore cycles during
  # the period he reported the button as dead, and a capture at the panel's own coordinates
  # photographed his browser.
  # The TopMost flick is the reliable part: Windows may refuse SetForegroundWindow from a process
  # that does not currently own the foreground, but toggling topmost always reorders z.
  try {
    $form.BringToFront()
    $form.Activate()
    $keep = $form.TopMost
    $form.TopMost = $true
    $form.TopMost = $keep
  } catch {}
  Log ("autohide: restored to " + $wasPre + " (raised)")
}

$ahTimer = New-Object System.Windows.Forms.Timer
$ahTimer.Interval = 140
$ahTimer.add_Tick({
  if (-not $script:autoHide -or $script:dragging) { return }
  if ($form.WindowState -eq 'Minimized') { return }   # real (taskbar) minimise outranks the park
  $pt = New-Object N+PT; [void][N]::GetCursorPos([ref]$pt)
  $wa = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
  $b = $form.Bounds
  if (-not $script:peeked) {
    # pop out when the cursor presses the screen edge beside the sliver
    # THE WHOLE EDGE, exactly like the taskbar — no vertical constraint at all. The taskbar spans
    # its entire screen edge, so "slide over there" means the edge, not the strip. Gating on the
    # parked window's own Y range was the bug: on a right-docked sidebar you had to find the strip
    # before it would reveal, which is precisely backwards.
    if ($pt.X -ge ($wa.Right - 2)) {
      Move-Slide (New-Object System.Drawing.Rectangle(($wa.Right - $b.Width), $b.Y, $b.Width, $b.Height))
      $script:peeked = $true; $script:outT = $null
      try { $form.Activate() } catch {}
    }
  } else {
    # slide back once the cursor has been clear of the window (40 px margin) for 260 ms.
    # 700 ms read as the widget lingering after you had visibly moved on; the taskbar's own
    # re-hide is quick and unhesitant. Short enough to feel responsive, long enough that a brief
    # overshoot past the edge of the strip does not slam it shut mid-reach.
    $inside = ($pt.X -ge ($b.X - 40) -and $pt.Y -ge ($b.Y - 40) -and $pt.Y -le ($b.Y + $b.Height + 40))
    if ($inside) { $script:outT = $null }
    elseif ($null -eq $script:outT) { $script:outT = [DateTime]::UtcNow }
    elseif (([DateTime]::UtcNow - $script:outT).TotalMilliseconds -gt 260) {
      Move-Slide (New-Object System.Drawing.Rectangle(($wa.Right - $PEEK), $b.Y, $b.Width, $b.Height))
      $script:peeked = $false; $script:outT = $null
    }
  }
})
$ahTimer.Start()

# Our own drag loop, NOT the OS one.
#
# WM_NCLBUTTONDOWN/HTCAPTION runs a modal move loop inside SendMessage that does not return until
# the mouse comes up - so the earliest anything can react to the cursor reaching an edge is AFTER
# you let go. That is what made docking feel dead. Tracking the cursor ourselves means the dock
# happens the instant you touch the edge, and undocks the instant you leave it.
#
# The cost is losing the OS move loop's aero-snap. Worth it: edge docking IS the snap here.
$script:dragging = $false

function Start-Drag {
  # Application::DoEvents() below re-enters the message pump, so a second 'drag' arriving mid-drag
  # would start a NESTED loop - two loops fighting over the same window position. Guard it.
  if ($script:dragging) { return }
  # Dragging the grip while parked/peeked means "I'm taking it back" - leave autohide where it
  # stands (no slide-home animation fighting the drag) and let the drag own the position.
  if ($script:autoHide) { Exit-AutoHide $false }
  $script:dragging = $true
  try {
  $pt = New-Object N+PT
  [void][N]::GetCursorPos([ref]$pt)
  $b = $form.Bounds
  # Grab offset as a FRACTION of width, so the window stays under the pointer sensibly even after
  # its size changes between docked and floating.
  $fx = if ($b.Width -gt 0) { ($pt.X - $b.X) / $b.Width } else { 0.5 }
  $fy = 18
  if ($script:mode -eq 'panel') { $script:floatRect = $b }

  $zone = $script:mode
  $guard = 0
  while ((([N]::GetAsyncKeyState(0x01)) -band 0x8000) -ne 0 -and $guard -lt 6000) {
    [void][N]::GetCursorPos([ref]$pt)
    $z = Get-Zone $pt.X $pt.Y
    if ($z -ne $zone) { Set-PanelMode $z; $zone = $z }
    if ($z -eq 'panel') {
      $w = if ($script:floatRect) { $script:floatRect.Width } else { $form.Width }
      $h = if ($script:floatRect) { $script:floatRect.Height } else { $form.Height }
      $form.Bounds = New-Object System.Drawing.Rectangle(
        [int]($pt.X - $w * $fx), [int]($pt.Y - $fy), [int]$w, [int]$h)
    }
    [System.Windows.Forms.Application]::DoEvents()   # keep WebView2 painting mid-drag
    Start-Sleep -Milliseconds 6
    $guard++
  }
  if ($script:mode -eq 'panel') { $script:floatRect = $form.Bounds }
  } finally { $script:dragging = $false }
}

$wv.add_WebMessageReceived({
  param($sender, $e)
  $msg = $null
  try { $msg = $e.TryGetWebMessageAsString() } catch {}
  if (-not $msg) { return }
  switch -Regex ($msg) {
    '^drag$' { [void][N]::ReleaseCapture(); Start-Drag }
    '^mode:' { Set-PanelMode ($msg.Split(':')[1]) }
    '^min$'   { if ($script:autoHide) { Restore-FromAutoHide }
                elseif ($script:mode -eq 'panel' -or $script:mode -eq 'sidebar-right') { Enter-AutoHide }
                else { $form.WindowState = 'Minimized' } }
    '^close$' { $form.Close() }
    '^top:'   { $form.TopMost = ($msg.Split(':')[1] -eq '1') }
    '^theme:' { $script:themeName = $msg.Split(':')[1]; Apply-Chrome; Log ("theme -> " + $script:themeName + " (border re-tinted)") }
    '^alpha:' { $form.Opacity = [Math]::Max(0.25, [Math]::Min(1.0, [double]($msg.Split(':')[1]) / 255)) }
    '^snap:'  {
      $p = $msg.Split(':')[1]
      $w = [int]($screen.Width / 2)
      switch ($p) {
        'left'  { $form.Location = New-Object System.Drawing.Point(0, 0); $form.Size = New-Object System.Drawing.Size($w, $screen.Height) }
        'right' { $form.Location = New-Object System.Drawing.Point($w, 0); $form.Size = New-Object System.Drawing.Size($w, $screen.Height) }
        'reset' { $form.Size = New-Object System.Drawing.Size($Width, $Height)
                  $form.Location = New-Object System.Drawing.Point([Math]::Max(0, $screen.Width - $Width - 24), 60) }
      }
    }
  }
})

$form.add_Shown({
  # Windows 11 rounded corners via DWM: real antialiased corners WITH the system shadow.
  # DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2. A no-op on Windows 10, which is fine.
  $v = 2
  [void][N]::DwmSetWindowAttribute($form.Handle, 33, [ref]$v, 4)
  Apply-Chrome   # tint the rim immediately; the page re-sends its real theme once it loads

  # RAISE IT ON FIRST SHOW.
  # A window created by a background process does not get foreground rights: Windows refuses
  # SetForegroundWindow from a process that does not already own the foreground, precisely so that
  # background apps cannot steal focus. The bridge spawns this host, so a popped-out window opened
  # BEHIND the panel that asked for it - which reads as "the button did nothing" until you move the
  # main window and find it hiding underneath.
  # Briefly asserting TopMost is the standard way through: it raises the window without needing
  # foreground rights, and dropping it again immediately leaves it a normal window rather than
  # pinning it above everything forever. Skipped when TopMost is genuinely wanted (no -NoTop), since
  # there it is already on top and the flip would be a no-op with a flicker.
  if (-not $form.TopMost) {
    try {
      $form.TopMost = $true
      $form.BringToFront()
      $form.Activate()
      $form.TopMost = $false
    } catch {}
  }
  try { $form.Focus() | Out-Null } catch {}
  if ($Spy -and $script:wndSpy) { $script:wndSpy.AssignHandle($form.Handle); Log "SPY attached to hwnd" }
  Log "form shown - starting webview init"
  # EnsureCoreWebView2Async, not Source: setting Source implies initialisation but gives no handle on
  # its failure. This returns a Task we can observe, and the completion event above reports the
  # outcome either way. Navigation happens in that handler once the core is genuinely ready.
  try { [void]$wv.EnsureCoreWebView2Async($null) }
  catch { Log ("EnsureCoreWebView2Async threw: " + $_.Exception.Message) }
})

# Esc from the host side too, so a wedged page can still be closed.
$form.KeyPreview = $true
$form.add_KeyDown({ if ($_.KeyCode -eq 'Escape' -and $_.Shift) { $form.Close() } })

# THE UI CLOSES AS ONE THING, the application does not.
#
# Only the MAIN view does this ($Path is '/'). Pop-outs are children; closing a child must not take
# the panel with it, and closing one pop-out must not close its siblings.
#
# What deliberately does NOT happen here: stopping the bridge. The collector, history, journal and
# diagnosis keep running with no windows open - "close the window, keep the record" is a stated lever
# on the FOOTPRINT page, not an oversight. Closing the panel puts the instrument away; it does not
# stop the machine being measured.
#
# MINIMISE is untouched on purpose, and is the reason to keep them separate windows: minimising the
# panel leaves the chat up on its own, which turns out to be the most useful arrangement of the two.
if ($Path -eq '/') {
  $form.add_FormClosing({
    try {
      $req = [System.Net.WebRequest]::Create("http://127.0.0.1:$Port/api/window/close-children")
      $req.Method = 'POST'; $req.ContentLength = 0; $req.Timeout = 1500
      $req.GetResponse().Close()
    } catch {}   # the bridge may already be gone; closing must never be blocked by that
  })
}

# Trim Chromium's memory while minimised (2026-07-29 self-cost pass). The panel can sit minimised
# for hours; MemoryUsageTargetLevel=Low tells the browser process tree to shed rebuildable caches.
# rAF already pauses on hidden, so this is a memory-only lever with no telemetry trade.
# TrySuspendAsync was considered and deliberately NOT used: it pauses the page itself, which would
# silence the SYS journal detector and the footprint ledger - a capability cost the trim avoids.
# Verified present in lib\ assemblies (1.0.3240.44) by reflection; guarded anyway.
$script:restoring = $false

# The Resize hook below only fires when the taskbar click MINIMISES the window, and Windows only
# does that when the window is already foreground. Click the taskbar button while anything else has
# focus and Windows simply ACTIVATES it — no WM_SIZE, no Resize event, so the parked window stayed
# invisible. That is the common case: the user has been working in another app.
# Activation while parked-and-hidden can only mean "bring it back". Activation while PEEKED must be
# ignored, because the reveal path calls $form.Activate() itself and would otherwise cancel the peek.
$form.add_Activated({
  if ($Spy) { Log ("SPY Activated: autoHide=$($script:autoHide) peeked=$($script:peeked) restoring=$($script:restoring) state=$($form.WindowState)") }
  if ($script:autoHide -and -not $script:peeked -and -not $script:restoring) {
    $script:restoring = $true
    try { if ($form.WindowState -eq 'Minimized') { $form.WindowState = 'Normal' }; Restore-FromAutoHide } catch {}
    $script:restoring = $false
  }
})
$form.add_Deactivate({ if ($Spy) { Log ("SPY Deactivate: autoHide=$($script:autoHide) peeked=$($script:peeked)") } })

# ---- -Spy: raw window-message tap (see param block). WndProc cannot be overridden on an already-
# constructed Form from PowerShell, but a NativeWindow can ATTACH to its handle and see the same
# stream. AssignHandle after Shown; the delegate lives in $script so GC cannot collect it.
if ($Spy) {
  Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.Windows.Forms;
public class WndSpy : NativeWindow {
  public string LogFile;
  protected override void WndProc(ref Message m) {
    int msg = m.Msg;
    if (msg == 0x0006 || msg == 0x001C || msg == 0x0005 || msg == 0x0112 || msg == 0x0018) {
      // ACTIVATE, ACTIVATEAPP, SIZE, SYSCOMMAND, SHOWWINDOW
      string name = msg == 0x0006 ? "WM_ACTIVATE" : msg == 0x001C ? "WM_ACTIVATEAPP"
                  : msg == 0x0005 ? "WM_SIZE" : msg == 0x0018 ? "WM_SHOWWINDOW" : "WM_SYSCOMMAND";
      try { System.IO.File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + name +
            " w=0x" + m.WParam.ToInt64().ToString("X") + " l=0x" + m.LParam.ToInt64().ToString("X") + "\r\n"); } catch {}
    }
    base.WndProc(ref m);
  }
}
"@
  $script:wndSpy = New-Object WndSpy
  $script:wndSpy.LogFile = Join-Path $here 'history\panel-spy.log'
}

$form.add_Resize({
  # Taskbar-icon restore, one click. A parked window is invisible but NOT iconic, so the first
  # taskbar click MINIMISES it — which, when it is already hidden, can only mean "bring it back".
  # Catch that minimise and convert it into the real restore ("whichever is open or was
  # minimized"). Reentrancy guard: setting WindowState back to Normal fires Resize again.
  if ($form.WindowState -eq 'Minimized' -and $script:autoHide -and -not $script:restoring) {
    $script:restoring = $true
    try { $form.WindowState = 'Normal'; Restore-FromAutoHide } catch {}
    $script:restoring = $false
  }
  try {
    if ($null -ne $wv.CoreWebView2) {
      $lvl = if ($form.WindowState -eq 'Minimized') { [Microsoft.Web.WebView2.Core.CoreWebView2MemoryUsageTargetLevel]::Low }
             else { [Microsoft.Web.WebView2.Core.CoreWebView2MemoryUsageTargetLevel]::Normal }
      $wv.CoreWebView2.MemoryUsageTargetLevel = $lvl
      Log ("memory target -> " + $lvl)
    }
  } catch {}
})

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)

