# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - icon generator. Produces vitals.ico from the dashboard's own ring motif.
# Run once; re-run only if the mark changes.  .\makeicon.ps1
#
# Writes a genuine multi-resolution .ico rather than a single bitmap, because Windows picks a
# different entry for the taskbar, alt-tab, the title bar and high-DPI scaling. A one-size icon gets
# stretched for the rest and looks mushy exactly where it is most visible.

param([string]$Out)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Out) { $Out = Join-Path $here 'vitals.ico' }

# Same palette and geometry as the dashboard core: three arcs sweeping 270 degrees with the gap on
# the left, so the icon reads as a miniature of the thing it opens.
$RINGS = @(
  @{ c = [System.Drawing.Color]::FromArgb(255,  58, 212, 200); r = 0.415 },   # cpu   teal
  @{ c = [System.Drawing.Color]::FromArgb(255, 157, 125, 251); r = 0.295 },   # mem   violet
  @{ c = [System.Drawing.Color]::FromArgb(255, 240, 166,  60); r = 0.175 }    # disk  amber
)

function New-Mark([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  # No backdrop - fully transparent, just the arcs. Ben's call, and it reads better: the mark sits
  # on whatever the taskbar or title bar already is instead of stamping a disc onto it.
  #
  # All three rings at every size. Below ~24 px they do crowd, so the stroke thins slightly to keep
  # the gaps between them open rather than letting them merge into one blob.
  $use  = $RINGS
  $wMul = if ($size -le 24) { 0.070 } else { 0.088 }

  foreach ($ring in $use) {
    $rad = $size * $ring.r
    $pen = New-Object System.Drawing.Pen($ring.c, [float]($size * $wMul))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($pen, [float]($size / 2 - $rad), [float]($size / 2 - $rad),
                     [float]($rad * 2), [float]($rad * 2), -135, 270)
    $pen.Dispose()
  }
  $g.Dispose()
  return $bmp
}

# Encode an image as a classic ICO DIB entry: BITMAPINFOHEADER with DOUBLED height (the format
# reserves the second half for an AND mask), then bottom-up BGRA rows, then the mask itself.
function ConvertTo-Dib([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width; $h = $bmp.Height
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt32]40); $bw.Write([Int32]$w); $bw.Write([Int32]($h * 2))
  $bw.Write([UInt16]1);  $bw.Write([UInt16]32); $bw.Write([UInt32]0)
  $bw.Write([UInt32]0);  $bw.Write([Int32]0);   $bw.Write([Int32]0)
  $bw.Write([UInt32]0);  $bw.Write([UInt32]0)
  for ($y = $h - 1; $y -ge 0; $y--) {            # bottom-up
    for ($x = 0; $x -lt $w; $x++) {
      $c = $bmp.GetPixel($x, $y)
      $bw.Write([Byte]$c.B); $bw.Write([Byte]$c.G); $bw.Write([Byte]$c.R); $bw.Write([Byte]$c.A)
    }
  }
  # AND mask: 1 bpp, rows padded to 4 bytes. All zero = "use the alpha channel", which is what
  # every 32-bit icon does; a non-zero mask here would punch holes in the artwork.
  $rowBytes = [int](([math]::Floor(($w + 31) / 32)) * 4)
  for ($y = 0; $y -lt $h; $y++) { $bw.Write((New-Object Byte[] $rowBytes)) }
  $bw.Flush()
  $out = $ms.ToArray(); $bw.Close(); $ms.Dispose()
  # The leading comma is load-bearing: `return $out` on a byte[] UNROLLS it into the pipeline, so
  # the caller gets an object[] of boxed bytes and BinaryWriter.Write() silently binds the wrong
  # overload. Wrapping in an outer array preserves the byte[] intact.
  return ,$out
}

# Sizes Windows actually asks for: 16/20/24 taskbar+tray, 32/40/48 alt-tab and 125-200% DPI,
# 64/128/256 large icons and the properties dialog.
#
# DIB for <=64, PNG only for the big two. PNG entries are legal in ICO since Vista and the shell
# reads them fine, but System.Drawing does NOT - a PNG-only icon throws "Requested range extends
# past the end of the array" from ToBitmap(), which would break the very code loading it here.
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$pngs  = @()
foreach ($s in $sizes) {
  $bmp = New-Mark $s
  if ($s -le 64) {
    $pngs += ,@($s, (ConvertTo-Dib $bmp), $false)
  } else {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += ,@($s, $ms.ToArray(), $true)
    $ms.Dispose()
  }
  $bmp.Dispose()
}

$fs = [System.IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter($fs)
# ICONDIR
$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type 1 = icon
$bw.Write([UInt16]$pngs.Count)
# ICONDIRENTRY x N - 16 bytes each, so image data starts after the whole directory
$offset = 6 + (16 * $pngs.Count)
foreach ($p in $pngs) {
  $s = $p[0]; $bytes = $p[1]
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))   # 0 means 256 in this field
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write([Byte]0)                 # palette count (0 = truecolour)
  $bw.Write([Byte]0)                 # reserved
  $bw.Write([UInt16]1)               # colour planes
  $bw.Write([UInt16]32)              # bits per pixel
  $bw.Write([UInt32]$bytes.Length)
  $bw.Write([UInt32]$offset)
  $offset += $bytes.Length
}
foreach ($p in $pngs) { $bw.Write([byte[]]$p[1]) }   # explicit cast: never let overload resolution guess
$bw.Flush(); $bw.Close(); $fs.Close()

$i = Get-Item $Out
"wrote {0}  ({1:N0} bytes, {2} sizes: {3})" -f $i.FullName, $i.Length, $pngs.Count, ($sizes -join ',')

# Prove it round-trips as a real icon rather than just a file with the right extension.
try {
  $ico = New-Object System.Drawing.Icon($Out)
  "loads OK - default size {0}x{1}" -f $ico.Width, $ico.Height
  foreach ($t in 16, 32, 256) {
    $v = New-Object System.Drawing.Icon($Out, $t, $t)
    "  requested {0,3} -> got {1}x{2}" -f $t, $v.Width, $v.Height
    $v.Dispose()
  }
  $ico.Dispose()
} catch { "VERIFY FAILED: $($_.Exception.Message)" }
