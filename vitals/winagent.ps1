# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - window agent.
# ONE long-lived process. Reads JSON commands on stdin, writes JSON replies on stdout.
#
# Why a persistent agent instead of spawning PowerShell per call: window dragging needs sub-frame
# latency. A fresh powershell.exe costs ~250 ms to boot, which would make the panel feel nailed to
# the desk. Same architecture as metrics.ps1 - one process, forever.
#
# Commands: {"cmd":"attach"} {"cmd":"frameless"} {"cmd":"round","r":14} {"cmd":"alpha","a":240}
#           {"cmd":"top","on":true} {"cmd":"drag"} {"cmd":"min"} {"cmd":"close"}
#           {"cmd":"size","w":1120,"h":740} {"cmd":"rect"}

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  /* Deliberately NOT FindWindow. Its first parameter is a class name that must be NULL to mean
     "any class", and PowerShell marshals $null into a string parameter as EMPTY STRING, not NULL —
     so the call silently matches nothing and returns 0. Enumerating is also more robust: it can
     match on class AND title and survives Chromium changing either. */
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc c, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

  public static IntPtr FindByTitle(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(300); GetWindowTextW(h, t, 300);
      if (t.ToString() != title) return true;
      var c = new StringBuilder(200); GetClassNameW(h, c, 200);
      if (c.ToString().IndexOf("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = h; return false;                       // stop enumerating
    }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint k, byte a, uint f);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr r, bool redraw);
  [DllImport("gdi32.dll")]  public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
'@

$GWL_STYLE = -16; $GWL_EXSTYLE = -20
$WS_CAPTION = 0x00C00000; $WS_THICKFRAME = 0x00040000; $WS_BORDER = 0x00800000
$WS_DLGFRAME = 0x00400000; $WS_SYSMENU = 0x00080000; $WS_MINIMIZEBOX = 0x00020000
$WS_MAXIMIZEBOX = 0x00010000
$WS_EX_LAYERED = 0x80000; $LWA_ALPHA = 0x2
$HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOSIZE = 0x1; $SWP_NOMOVE = 0x2; $SWP_NOACTIVATE = 0x10; $SWP_FRAMECHANGED = 0x20
$VK_LBUTTON = 0x01

$hwnd = [IntPtr]::Zero

function Reply($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 3)); [Console]::Out.Flush() }

function Attach {
  # Chromium app windows use class Chrome_WidgetWin_1; matching on the title alone is enough and
  # survives Chromium renaming its window class between versions.
  $script:hwnd = [W]::FindWindowW($null, 'VITALS')
  return $script:hwnd -ne [IntPtr]::Zero
}

function ApplyRound($r) {
  if ($script:hwnd -eq [IntPtr]::Zero) { return $false }
  $rc = New-Object W+RECT
  [void][W]::GetWindowRect($script:hwnd, [ref]$rc)
  $w = $rc.R - $rc.L; $h = $rc.B - $rc.T
  if ($w -le 0 -or $h -le 0) { return $false }
  # The region is in CLIENT coordinates relative to the window, hence 0,0..w,h. +1 because
  # CreateRoundRectRgn's right/bottom edges are exclusive.
  $rgn = [W]::CreateRoundRectRgn(0, 0, $w + 1, $h + 1, $r * 2, $r * 2)
  return ([W]::SetWindowRgn($script:hwnd, $rgn, $true) -ne 0)
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $c = $null
  try { $c = $line | ConvertFrom-Json } catch { Reply @{ ok = $false; err = 'bad json' }; continue }

  if ($hwnd -eq [IntPtr]::Zero -and $c.cmd -ne 'attach') { [void](Attach) }

  switch ($c.cmd) {
    'attach' { Reply @{ ok = (Attach); hwnd = $hwnd.ToInt64() } }

    'frameless' {
      if ($hwnd -eq [IntPtr]::Zero) { Reply @{ ok = $false; err = 'no window' }; break }
      $s = [W]::GetWindowLong($hwnd, $GWL_STYLE)
      $s = $s -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME -bor $WS_BORDER -bor $WS_DLGFRAME -bor
                            $WS_SYSMENU -bor $WS_MINIMIZEBOX -bor $WS_MAXIMIZEBOX))
      [void][W]::SetWindowLong($hwnd, $GWL_STYLE, $s)
      # SWP_FRAMECHANGED is REQUIRED - without it Windows keeps painting the old non-client area
      # and the title bar stays visible until something else forces a recalc.
      [void][W]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0,
                              ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED))
      Reply @{ ok = $true }
    }

    'round' { $r = if ($c.r) { [int]$c.r } else { 14 }; Reply @{ ok = (ApplyRound $r) } }

    'alpha' {
      if ($hwnd -eq [IntPtr]::Zero) { Reply @{ ok = $false }; break }
      $a = [int]$c.a
      $ex = [W]::GetWindowLong($hwnd, $GWL_EXSTYLE)
      [void][W]::SetWindowLong($hwnd, $GWL_EXSTYLE, ($ex -bor $WS_EX_LAYERED))
      Reply @{ ok = [W]::SetLayeredWindowAttributes($hwnd, 0, [byte]$a, $LWA_ALPHA) }
    }

    'top' {
      $t = if ($c.on) { $HWND_TOPMOST } else { $HWND_NOTOPMOST }
      Reply @{ ok = [W]::SetWindowPos($hwnd, $t, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE)) }
    }

    'size' {
      $rc = New-Object W+RECT; [void][W]::GetWindowRect($hwnd, [ref]$rc)
      [void][W]::MoveWindow($hwnd, $rc.L, $rc.T, [int]$c.w, [int]$c.h, $true)
      [void](ApplyRound $(if ($c.r) { [int]$c.r } else { 14 }))
      Reply @{ ok = $true }
    }

    'rect' {
      $rc = New-Object W+RECT; [void][W]::GetWindowRect($hwnd, [ref]$rc)
      Reply @{ ok = $true; x = $rc.L; y = $rc.T; w = ($rc.R - $rc.L); h = ($rc.B - $rc.T) }
    }

    # The whole drag runs HERE, natively, until the mouse button comes up. The alternative -
    # streaming mousemove deltas from the page - would put an HTTP round trip in the middle of
    # every frame of a drag, which reads as lag no matter how fast the server is.
    'drag' {
      if ($hwnd -eq [IntPtr]::Zero) { Reply @{ ok = $false }; break }
      $p = New-Object W+POINT; [void][W]::GetCursorPos([ref]$p)
      $rc = New-Object W+RECT; [void][W]::GetWindowRect($hwnd, [ref]$rc)
      $offX = $p.X - $rc.L; $offY = $p.Y - $rc.T
      $w = $rc.R - $rc.L; $h = $rc.B - $rc.T
      $guard = 0
      while (([W]::GetAsyncKeyState($VK_LBUTTON) -band 0x8000) -ne 0 -and $guard -lt 4000) {
        [void][W]::GetCursorPos([ref]$p)
        [void][W]::MoveWindow($hwnd, ($p.X - $offX), ($p.Y - $offY), $w, $h, $false)
        Start-Sleep -Milliseconds 8
        $guard++
      }
      [void][W]::GetWindowRect($hwnd, [ref]$rc)
      Reply @{ ok = $true; x = $rc.L; y = $rc.T }
    }

    'min'   { [void][W]::ShowWindow($hwnd, 6); Reply @{ ok = $true } }        # SW_MINIMIZE
    'close' { [void][W]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); Reply @{ ok = $true } }  # WM_CLOSE
    default { Reply @{ ok = $false; err = "unknown cmd '$($c.cmd)'" } }
  }
}
