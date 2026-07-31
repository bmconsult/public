# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - per-window mini module (badge).
#
# Attaches a small live badge to any window and answers, on the glass of the thing itself: what is
# THIS window's process costing, and does the diagnosis engine have anything to say about it?
# The badge is not just stats: it cross-references the machine's live state - if the process is the
# top memory consumer on the box, or is named in an active finding, the badge says so. That linkage
# is the point; a number without rank or verdict is a gauge, not an instrument.
#
#   .\badge.ps1 -TargetPid 12345          # attach by process id (its main window)
#   .\badge.ps1 -Title "notepad"          # or by window-title substring (first visible match)
#
# Engineering notes:
#  - Window tracking is a WinEventHook (EVENT_OBJECT_LOCATIONCHANGE etc.) with WINEVENT_OUTOFCONTEXT:
#    events are marshalled to THIS process over the message pump - nothing is injected into the
#    target, so any window of any privilege can be tracked and the target cannot be destabilised.
#    The delegate MUST be held in a live variable: PowerShell's GC does not know native code holds a
#    pointer to it, and a collected delegate is a use-after-free crash minutes later.
#  - Rendering is native GDI+ owner-draw (double-buffered panel, no WebView, no toolkit) - this is
#    the pilot for the native docked-strip renderer: prove the shape (native window + bridge REST
#    polling + owner draw) before Direct2D is spent on it.
#  - Data comes from the bridge's /api/latest (the same tick every page renders - one source of
#    truth) at 1 Hz, and /api/diagnose every 10 s. HONESTY: per-process CPU in the tick is grouped
#    by NAME (metrics.ps1 aggregates instances), so the badge labels it "xN" when the group has
#    more than one process; memory is the target pid's own where the tick carries it.

param(
  [int]$TargetPid = 0,
  [string]$Title = '',
  [int]$Port = 8790
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BW {
  public delegate void WinEventDelegate(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventDelegate cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

# ---------- find the target window ----------
$script:target = [IntPtr]::Zero
$script:tgtPid = 0
$found = New-Object System.Collections.ArrayList
$enum = [BW+EnumProc]{
  param($h, $l)
  if (-not [BW]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][BW]::GetWindowText($h, $sb, 512)
  $t = $sb.ToString()
  if (-not $t) { return $true }
  $q = 0; [void][BW]::GetWindowThreadProcessId($h, [ref]$q)
  [void]$found.Add(@{ hwnd = $h; pid = $q; title = $t })
  return $true
}
[void][BW]::EnumWindows($enum, [IntPtr]::Zero)
foreach ($w in $found) {
  if ($TargetPid -and $w.pid -eq $TargetPid) { $script:target = $w.hwnd; $script:tgtPid = $w.pid; break }
  if ($Title -and $w.title -like "*$Title*") { $script:target = $w.hwnd; $script:tgtPid = $w.pid; break }
}
if ($script:target -eq [IntPtr]::Zero) {
  Write-Host "no visible window matched (pid=$TargetPid title='$Title'); candidates:"
  $found | ForEach-Object { Write-Host ("  {0,7}  {1}" -f $_.pid, $_.title.Substring(0, [Math]::Min(70, $_.title.Length))) }
  exit 1
}
$script:procName = try { (Get-Process -Id $script:tgtPid).ProcessName } catch { "pid $($script:tgtPid)" }
Write-Host "attached to '$($script:procName)' (pid $($script:tgtPid), hwnd $($script:target))"

# ---------- badge window ----------
$W = 208; $H = 56
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Size = New-Object System.Drawing.Size($W, $H)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(7, 9, 14)
$form.Opacity = 0.93
# KNOWN PILOT LIMIT: Show() takes activation once at attach (WinForms offers no clean
# ShowWithoutActivation from PowerShell without subclassing). One focus blink at attach; the
# position syncs after that never re-activate. The Direct2D strip should do WS_EX_NOACTIVATE.

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic').SetValue($panel, $true, $null)
$form.Controls.Add($panel)

# ---------- live state ----------
$script:row = $null        # this process's row from the tick (name-grouped)
$script:myMB = $null       # this pid's own MB where the tick carries per-instance data
$script:rank = -1          # memory rank of the group among all groups (0 = top consumer)
$script:groupN = 1
$script:cpuHist = New-Object System.Collections.Generic.Queue[double]
$script:flag = ''          # diagnosis cross-reference line ('' = nothing to say)
$script:flagSev = ''
$script:stale = $true

function Poll-Tick {
  try {
    $t = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/latest" -TimeoutSec 2
    if (-not $t -or $t.none) { $script:stale = $true; return }
    $script:stale = $false
    $rows = @($t.proc)
    $script:row = $null; $script:myMB = $null; $script:rank = -1
    for ($i = 0; $i -lt $rows.Count; $i++) {
      $r = $rows[$i]
      if (@($r.pids) -contains $script:tgtPid) {
        $script:row = $r; $script:rank = $i; $script:groupN = [int]$r.count
        $inst = @($r.inst) | Where-Object { $_.pid -eq $script:tgtPid } | Select-Object -First 1
        if ($inst) { $script:myMB = [double]$inst.mb }
        break
      }
    }
    if ($script:row) {
      $script:cpuHist.Enqueue([double]$script:row.cpu)
      while ($script:cpuHist.Count -gt 40) { [void]$script:cpuHist.Dequeue() }
    }
  } catch { $script:stale = $true }
}

function Poll-Diag {
  try {
    $d = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/diagnose" -TimeoutSec 3
    $script:flag = ''; $script:flagSev = ''
    # named in an active finding? (title or evidence mentions the process name)
    foreach ($f in @($d.findings)) {
      $hay = ($f.title + ' ' + (@($f.evidence) -join ' '))
      if ($script:procName -and $hay -match [regex]::Escape($script:procName)) {
        $script:flag = "named in finding: $($f.id)"; $script:flagSev = $f.sevName; return
      }
    }
    if ($script:rank -eq 0) { $script:flag = 'top memory consumer on this machine'; $script:flagSev = 'warn' }
  } catch { }
}

# ---------- paint (native renderer pilot: pure GDI+, no toolkit) ----------
$fontN = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Bold)
$fontV = New-Object System.Drawing.Font('Segoe UI', 8.0)
$fontS = New-Object System.Drawing.Font('Segoe UI', 7.0)
$panel.add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $ink  = [System.Drawing.Color]::FromArgb(226, 230, 238)
  $dim  = [System.Drawing.Color]::FromArgb(122, 130, 146)
  $acc  = [System.Drawing.Color]::FromArgb(66, 226, 199)
  $warn = [System.Drawing.Color]::FromArgb(255, 179, 71)
  $crit = [System.Drawing.Color]::FromArgb(255, 92, 108)
  $g.Clear([System.Drawing.Color]::FromArgb(7, 9, 14))
  $g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 66, 226, 199))), 0, 0, $W - 1, $H - 1)
  $bInk = New-Object System.Drawing.SolidBrush($ink)
  $bDim = New-Object System.Drawing.SolidBrush($dim)
  if ($script:stale) {
    $g.DrawString('VITALS bridge unreachable', $fontV, $bDim, 8, 20); return
  }
  $name = $script:procName + $(if ($script:groupN -gt 1) { " x$($script:groupN)" } else { '' })
  $g.DrawString($name, $fontN, $bInk, 6, 4)
  if ($script:row) {
    $cpu = [double]$script:row.cpu
    # the 1 Hz tick groups by name and carries no per-instance split (that lives on the on-demand
    # /api/processes) - so when the group has multiple processes the MB figure MUST say "all"
    $mbTxt = if ($null -ne $script:myMB -and $script:groupN -gt 1) { "$([math]::Round($script:myMB)) MB (this) / $($script:row.mb) MB (all)" }
             elseif ($script:groupN -gt 1) { "$($script:row.mb) MB (all $($script:groupN))" }
             else { "$($script:row.mb) MB" }
    $cpuTxt = if ($script:groupN -gt 1) { "$cpu% cpu (all $($script:groupN))" } else { "$cpu% cpu" }
    $g.DrawString("$cpuTxt  ·  $mbTxt", $fontV, $bInk, 6, 20)
    # cpu sparkline, right-aligned in the header row - motion means data, still means idle
    $hist = @($script:cpuHist)
    if ($hist.Count -gt 1) {
      $sw = 56; $sh = 12; $sx = $W - $sw - 6; $sy = 4
      $mx = [Math]::Max(5.0, ($hist | Measure-Object -Maximum).Maximum)
      $pen = New-Object System.Drawing.Pen($acc, 1.2)
      for ($i = 1; $i -lt $hist.Count; $i++) {
        $x0 = $sx + ($i - 1) / [double]($hist.Count - 1) * $sw
        $x1 = $sx + $i / [double]($hist.Count - 1) * $sw
        $g.DrawLine($pen, [float]$x0, [float]($sy + $sh - $hist[$i-1] / $mx * $sh), [float]$x1, [float]($sy + $sh - $hist[$i] / $mx * $sh))
      }
      $pen.Dispose()
    }
  } else {
    $g.DrawString('below the tick''s top-40 - negligible right now', $fontV, $bDim, 6, 20)
  }
  if ($script:flag) {
    $fc = if ($script:flagSev -eq 'critical') { $crit } elseif ($script:flagSev -match 'warn') { $warn } else { $dim }
    $bF = New-Object System.Drawing.SolidBrush($fc)
    $g.DrawString([char]0x25B2 + ' ' + $script:flag, $fontS, $bF, 6, 38)
    $bF.Dispose()
  } else {
    $g.DrawString('no findings name this process', $fontS, $bDim, 6, 38)
  }
  $bInk.Dispose(); $bDim.Dispose()
})

# ---------- glue to the target ----------
function Sync-Position {
  if (-not [BW]::IsWindow($script:target)) { $form.Close(); return }
  if ([BW]::IsIconic($script:target) -or -not [BW]::IsWindowVisible($script:target)) {
    if ($form.Visible) { $form.Hide() }; return
  }
  $r = New-Object BW+RECT
  [void][BW]::GetWindowRect($script:target, [ref]$r)
  # top-right corner of the target, tucked inside its frame
  $x = $r.R - $W - 14; $y = $r.T + 8
  if (-not $form.Visible) { $form.Show() }
  if ($form.Left -ne $x -or $form.Top -ne $y) { $form.Location = New-Object System.Drawing.Point($x, $y) }
}

# WinEventHook scoped to the target's pid. OUTOFCONTEXT(0) - no dll enters the target process.
# EVENT_OBJECT_LOCATIONCHANGE(0x800B) covers move+resize; the range covers destroy(0x8001),
# show(0x8002), hide(0x8003) too. The 500 ms timer below is the belt to this suspenders - hooks
# can miss events during a modal move loop.
$script:cb = [BW+WinEventDelegate]{
  param($hook, $evt, $hwnd, $idObject, $idChild, $thread, $time)
  if ($hwnd -eq $script:target -and $idObject -eq 0) { Sync-Position }
}
$script:hook1 = [BW]::SetWinEventHook(0x8001, 0x8003, [IntPtr]::Zero, $script:cb, [uint32]$script:tgtPid, 0, 0)
$script:hook2 = [BW]::SetWinEventHook(0x800B, 0x800B, [IntPtr]::Zero, $script:cb, [uint32]$script:tgtPid, 0, 0)

$tick = New-Object System.Windows.Forms.Timer
$tick.Interval = 1000
$tick.add_Tick({ Poll-Tick; Sync-Position; $panel.Invalidate() })
$tick.Start()
$diagT = New-Object System.Windows.Forms.Timer
$diagT.Interval = 10000
$diagT.add_Tick({ Poll-Diag })
$diagT.Start()

$form.add_Shown({ Poll-Tick; Poll-Diag; Sync-Position; $panel.Invalidate() })
$form.add_FormClosed({
  if ($script:hook1 -ne [IntPtr]::Zero) { [void][BW]::UnhookWinEvent($script:hook1) }
  if ($script:hook2 -ne [IntPtr]::Zero) { [void][BW]::UnhookWinEvent($script:hook2) }
})

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)
