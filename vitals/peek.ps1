# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
#
# VITALS - SCREEN PEEK. A long-lived worker that reports the COLOUR of a screen rectangle,
#
# WHY A WORKER AND NOT A ONE-SHOT. Everything else Windows-side here goes through ps(), which
# execFiles a fresh powershell.exe per call - measured at 80-900 ms of process start before a single
# useful instruction runs. That is fine for a scan you ask for and impossible for something sampled
# a few times a second, so this one stays alive: read a request line, answer it, loop. Process start
# is paid once.
#
# WHAT IT RETURNS. One line of hex, SIX characters per cell: RGB, one cell per grid square. The
# caller needs SPECTRUM - a dark blue and a dark grey are the same luminance, so a light meter
# cannot tell water from window chrome. The header here said "the LUMINANCE only" for a build
# after this became RGB, which is the worst kind of stale comment: specific, reassuring, and false.
# The honest claim is the CEILING, and the caller enforces it - 64x24 is 4,608 bytes, a colour
# thumbnail far too coarse to read text or recognise anything, and it is all the route permits.
#
# DPI. BitBlt works in PHYSICAL pixels. Without SetProcessDPIAware this process is told about a
# virtualised desktop, so on any scaled display every rectangle it is handed lands somewhere else
# entirely - and it does not fail, it just samples the wrong part of the screen, which is the worst
# kind of wrong because the output still looks plausible.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VitalsPeek {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
try { [VitalsPeek]::SetProcessDPIAware() | Out-Null } catch {}

$hex = '0123456789abcdef'

# One reusable bitmap per geometry: allocating a fresh Bitmap per sample is most of the cost, and
# this is called on a timer.
$bmp = $null; $gfx = $null; $bw = 0; $bh = 0
$small = $null; $sgfx = $null; $sw = 0; $sh = 0

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }                      # stdin closed: the bridge is gone, so are we
  $line = $line.Trim()
  if ($line -eq '' ) { continue }
  if ($line -eq 'quit') { break }

  try {
    # x y w h gw gh   — screen rect in physical pixels, then the grid to reduce it to
    $p = $line -split '\s+'
    if ($p.Count -lt 6) { [Console]::Out.WriteLine('ERR bad-request'); continue }
    $x = [int]$p[0]; $y = [int]$p[1]; $w = [int]$p[2]; $h = [int]$p[3]
    $gw = [int]$p[4]; $gh = [int]$p[5]
    # 64x24 here too. The route clamps first and peek.sample() is the only writer to this stdin,
    # so the effective ceiling was already 64x24 — but a second bound 4x looser than the claim is
    # a second ceiling nobody is holding to the claim. Two numbers, one promise.
    if ($w -lt 4 -or $h -lt 4 -or $gw -lt 1 -or $gh -lt 1 -or $gw -gt 64 -or $gh -gt 24) {
      [Console]::Out.WriteLine('ERR bad-rect'); continue
    }

    if ($null -eq $bmp -or $bw -ne $w -or $bh -ne $h) {
      if ($gfx) { $gfx.Dispose() }; if ($bmp) { $bmp.Dispose() }
      $bmp = New-Object System.Drawing.Bitmap($w, $h)
      $gfx = [System.Drawing.Graphics]::FromImage($bmp)
      $bw = $w; $bh = $h
    }
    if ($null -eq $small -or $sw -ne $gw -or $sh -ne $gh) {
      if ($sgfx) { $sgfx.Dispose() }; if ($small) { $small.Dispose() }
      $small = New-Object System.Drawing.Bitmap($gw, $gh)
      $sgfx = [System.Drawing.Graphics]::FromImage($small)
      # HighQualityBilinear AVERAGES the source pixels it spans. NearestNeighbor would point-sample,
      # which on a screen full of text lands on a glyph or between two glyphs and reports black or
      # white from one pixel - the grid would then shimmer with the caret instead of describing the
      # region. The averaging is the measurement, not a smoothing nicety.
      $sgfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
      $sgfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $sw = $gw; $sh = $gh
    }
    $gfx.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))

    # DOWNSCALE IN GDI+, NOT IN POWERSHELL. The first version marshalled the whole capture into a
    # byte[] (a 1150x150 strip is 690 KB) and averaged each cell in a nested PowerShell loop:
    # measured 49 ms a sample, which at any useful rate is more CPU than the effect is worth.
    # DrawImage does the same averaging in native code and reduces the marshalled buffer to
    # gw*gh*4 bytes - about 6 KB. Same numbers, one interpreted loop deleted.
    $sgfx.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $gw, $gh)),
                    (New-Object System.Drawing.Rectangle(0, 0, $w, $h)),
                    [System.Drawing.GraphicsUnit]::Pixel)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $gw, $gh)
    $data = $small.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                            [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
    $stride = $data.Stride
    $bytes = New-Object byte[] ($stride * $gh)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $small.UnlockBits($data)

    $sb = New-Object System.Text.StringBuilder ($gw * $gh * 6)
    for ($cy = 0; $cy -lt $gh; $cy++) {
      $row = $cy * $stride
      for ($cx = 0; $cx -lt $gw; $cx++) {
        $i = $row + $cx * 4
        # `-shr 4`, NOT `[int]($v / 16)`. PowerShell's [int] cast ROUNDS - it does not truncate -
        # so [int](255/16) is 16, which indexes past this 16-character string, yields $null, and
        # Append($null) writes NOTHING. Every bright cell silently lost a character and the whole
        # line came back short: 2854 chars where 3072 were expected. It was caught only because the
        # Node side checks the length; decoding it anyway would have produced a grid that was
        # subtly wrong from the first bright pixel onward and shifted after it - a picture of the
        # screen with everything displaced, which looks like a plausible reading of somewhere else.
        #
        # RGB, THREE BYTES A CELL, replacing the single luminance byte this used to send. The caller
        # needs SPECTRUM, not brightness: a dark blue and a dark grey are the same number, so a
        # particle asked to seek "the blue region" or "the dark window edge" cannot be served by a
        # light meter. Stated in the panel rather than widened quietly — at 64x24 this is a very
        # coarse thumbnail, too coarse to read text or recognise anything, but it is more than the
        # luminance it replaced and the caption says so.
        foreach ($o in 2, 1, 0) {                       # bytes are BGR; emit RGB
          $c = $bytes[$i + $o]
          [void]$sb.Append($hex[$c -shr 4]); [void]$sb.Append($hex[$c -band 15])
        }
      }
    }
    [Console]::Out.WriteLine('OK ' + $sb.ToString())
  } catch {
    [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '\s+', ' '))
  }
}
if ($gfx) { $gfx.Dispose() }
if ($bmp) { $bmp.Dispose() }
if ($sgfx) { $sgfx.Dispose() }
if ($small) { $small.Dispose() }
