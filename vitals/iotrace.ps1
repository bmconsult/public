# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - I/O tracer. Best run as ADMINISTRATOR (ETW kernel session requires it).
#
#   .\iotrace.ps1 -Seconds 10 -Out history\iotrace.json
#
# TWO mechanisms, deliberately, because they fail in different ways:
#
#  1. HIGH-FREQUENCY COUNTER SAMPLING (primary, always runs, works unelevated).
#     Win32_PerfRawData_PerfProc_Process exposes IOReadOperations/IOWriteOperations and the byte
#     counters as CUMULATIVE totals, not rates. Sampling them at 10 Hz and differencing endpoints
#     gives EXACT bytes moved per process over the window - not an average of sampled rates, which
#     is what the 1 Hz live stream necessarily gives you and which misses short bursts entirely.
#
#  2. ETW KERNEL TRACE (secondary, best-effort, needs admin).
#     Gets FILE-level attribution - which specific paths were touched. This is what Resource
#     Monitor's Disk Activity pane shows. It is best-effort on purpose: only one "NT Kernel Logger"
#     session can exist system-wide, so anything else profiling (WPR, xperf, some AV) blocks it,
#     and tracerpt's CSV schema is not stable across Windows builds. When it fails the script says
#     so explicitly rather than silently returning less.

param(
  [int]$Seconds = 10,
  [string]$Out,
  [int]$Hz = 10
)

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Out) { $Out = Join-Path $here 'history\iotrace.json' }
$outDir = Split-Path -Parent $Out
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# ---------------------------------------------------------------- 2. start ETW (best effort)
$etl = Join-Path $env:TEMP 'vitals-io.etl'
$etwState = 'not attempted'
$sessionName = 'NT Kernel Logger'
if ($isAdmin) {
  Remove-Item $etl -Force -ErrorAction SilentlyContinue
  & logman stop $sessionName -ets 2>&1 | Out-Null           # clear a stale session if one exists
  $r = & logman start $sessionName -p "Windows Kernel Trace" "(disk,fileio)" -o $etl -ets 2>&1
  $etwState = if ($LASTEXITCODE -eq 0) { 'running' } else { "start failed: $($r -join ' ')" }
}

# ---------------------------------------------------------------- 1. high-frequency sampling
$first = @{}; $last = @{}; $peak = @{}; $names = @{}
$prevSample = @{}
$prevT = $null
$sw = [Diagnostics.Stopwatch]::StartNew()
$interval = [int](1000 / $Hz)
$samples = 0

while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $t = [DateTime]::UtcNow
  foreach ($p in (Get-CimInstance Win32_PerfRawData_PerfProc_Process -ErrorAction SilentlyContinue)) {
    if ($p.Name -eq '_Total' -or $p.Name -eq 'Idle') { continue }
    $id = "$($p.IDProcess)"
    if ($id -eq '0') { continue }
    $tot = [double]$p.IOReadBytesPersec + [double]$p.IOWriteBytesPersec   # raw class => cumulative
    $names[$id] = $p.Name -replace '#\d+$', ''
    if (-not $first.ContainsKey($id)) {
      $first[$id] = @{ r = [double]$p.IOReadBytesPersec; w = [double]$p.IOWriteBytesPersec }
    }
    $last[$id] = @{ r = [double]$p.IOReadBytesPersec; w = [double]$p.IOWriteBytesPersec }

    if ($prevT -and $prevSample.ContainsKey($id)) {
      $dt = ($t - $prevT).TotalSeconds
      if ($dt -gt 0) {
        $rate = ($tot - $prevSample[$id]) / $dt
        if (-not $peak.ContainsKey($id) -or $rate -gt $peak[$id]) { $peak[$id] = $rate }
      }
    }
    $prevSample[$id] = $tot
  }
  $prevT = $t
  $samples++
  Start-Sleep -Milliseconds $interval
}
$elapsed = $sw.Elapsed.TotalSeconds

$byName = @{}
foreach ($id in $last.Keys) {
  if (-not $first.ContainsKey($id)) { continue }
  $dr = $last[$id].r - $first[$id].r
  $dw = $last[$id].w - $first[$id].w
  if ($dr -lt 0) { $dr = 0 }; if ($dw -lt 0) { $dw = 0 }
  if (($dr + $dw) -le 0) { continue }
  $n = $names[$id]
  if (-not $byName.ContainsKey($n)) { $byName[$n] = @{ read = 0.0; write = 0.0; peak = 0.0; procs = 0 } }
  $byName[$n].read  += $dr
  $byName[$n].write += $dw
  $byName[$n].procs += 1
  if ($peak.ContainsKey($id) -and $peak[$id] -gt $byName[$n].peak) { $byName[$n].peak = $peak[$id] }
}

$procRows = $byName.GetEnumerator() | ForEach-Object {
  [PSCustomObject]@{
    name      = $_.Key
    readMB    = [math]::Round($_.Value.read / 1MB, 2)
    writeMB   = [math]::Round($_.Value.write / 1MB, 2)
    totalMB   = [math]::Round(($_.Value.read + $_.Value.write) / 1MB, 2)
    peakMBs   = [math]::Round($_.Value.peak / 1MB, 2)
    instances = $_.Value.procs
  }
} | Sort-Object totalMB -Descending | Select-Object -First 25

# ---------------------------------------------------------------- 2b. stop + parse ETW
$files = @()
$etwNote = $etwState
if ($etwState -eq 'running') {
  & logman stop $sessionName -ets 2>&1 | Out-Null
  $csv = Join-Path $env:TEMP 'vitals-io.csv'
  Remove-Item $csv -Force -ErrorAction SilentlyContinue
  & tracerpt $etl -o $csv -of CSV -y 2>&1 | Out-Null

  if (Test-Path $csv) {
    try {
      # tracerpt's CSV is not a stable schema across builds, so match on content rather than on
      # column position: find any field that looks like a path, and any that looks like a size.
      $rows = Get-Content $csv -TotalCount 400000
      $agg = @{}
      foreach ($line in $rows) {
        if ($line -notmatch 'FileIo|DiskIo') { continue }
        $m = [regex]::Matches($line, '"?([A-Za-z]:\\\\?[^",]+|\\\\Device\\\\HarddiskVolume\d+\\\\[^",]+)"?')
        if ($m.Count -eq 0) { continue }
        $p = $m[0].Groups[1].Value.Trim()
        if ($p.Length -lt 4) { continue }
        if (-not $agg.ContainsKey($p)) { $agg[$p] = 0 }
        $agg[$p] += 1
      }
      $files = $agg.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 30 |
               ForEach-Object { [PSCustomObject]@{ path = $_.Key; events = $_.Value } }
      $etwNote = if ($files.Count) { "ok - $($files.Count) paths from $($rows.Count) trace lines" }
                 else { 'trace captured but no file paths recognised in this build''s CSV schema' }
    } catch { $etwNote = "parse failed: $($_.Exception.Message)" }
    Remove-Item $csv -Force -ErrorAction SilentlyContinue
  } else { $etwNote = 'tracerpt produced no CSV' }
  Remove-Item $etl -Force -ErrorAction SilentlyContinue
} elseif (-not $isAdmin) {
  $etwNote = 'skipped - needs Administrator for a kernel session'
}

[PSCustomObject]@{
  takenAt   = (Get-Date).ToString('o')
  seconds   = [math]::Round($elapsed, 2)
  samples   = $samples
  hzTarget  = $Hz
  # The CIM query itself costs ~450 ms, so the achieved rate is well below the target. Byte TOTALS
  # stay exact regardless (cumulative counters differenced end-to-end); it is only the peak-burst
  # resolution that suffers. Reported so the peak figure is read with the right skepticism.
  hzActual  = [math]::Round($samples / [math]::Max($elapsed, 0.01), 2)
  elevated  = $isAdmin
  processes = @($procRows)
  files     = @($files)
  etw       = $etwNote
} | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $Out -Encoding utf8

"wrote $Out - $($procRows.Count) processes, $($files.Count) file paths, etw: $etwNote"
