# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - self-cost measurement harness.
#
# Measures what VITALS itself costs, per component, the SAME way every time - so before/after
# claims are paired measurements, not impressions. This is also the reference implementation of
# the PID discovery that metrics.ps1 uses for the in-app FOOTPRINT page.
#
#   .\measure.ps1 -Seconds 15 -Label "before-panel-ov"
#
# Method: two reads of the Process perf-counter category (cumulative raw counters), N seconds
# apart. CPU% = delta of '% Processor Time' raw (100ns ticks) / wall / logical threads - exactly
# Task Manager's formula and exactly what metrics.ps1 streams, so numbers here and numbers in the
# app can never disagree by construction. Memory = 'Working Set - Private' (same counter the app
# uses everywhere; WorkingSet64 inflates shared pages).
#
# Discovery: command lines via Win32_Process. The WebView2 BROWSER process carries
# --user-data-dir=...vitals-webview; its children (renderer/gpu/utility/crashpad) do NOT, so they
# are found by walking ParentProcessId from the browser down. node is matched on bridge.js,
# powershell on metrics/panel/winagent .ps1 paths. This is why a name-only detector undercounts:
# 'node' alone is ambiguous (6 node.exe live on this machine right now) and the webview children
# carry no vitals marker at all.

param(
  [int]$Seconds = 15,
  [int]$Port = 8790,
  [string]$Label = '',
  [switch]$Quiet
)
$ErrorActionPreference = 'SilentlyContinue'
$logical = [int]$env:NUMBER_OF_PROCESSORS

# ---------- discover VITALS pids ----------
function Get-VitalsMap {
  $map = @{}   # pid -> @{comp; role; desc}
  # The bridge is launched as `node bridge.js 8790` with cwd=vitals - its command line contains
  # NO vitals marker at all (this is the exact reason two independent detectors missed it).
  # The one unfakeable marker: it OWNS the listening port. Match that first, cmdline as fallback.
  $bridgePid = 0
  $lst = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($lst) { $bridgePid = [int]$lst.OwningProcess }
  $all = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' OR Name='node.exe' OR Name='powershell.exe'" |
         Select-Object ProcessId, ParentProcessId, Name, CommandLine
  foreach ($p in $all) {
    $cl = [string]$p.CommandLine
    if ($p.Name -eq 'node.exe' -and ([int]$p.ProcessId -eq $bridgePid -or $cl -match 'vitals[\\/]+bridge\.js')) {
      $map[[int]$p.ProcessId] = @{ comp = 'bridge';    desc = 'node bridge.js' }
    } elseif ($p.Name -eq 'powershell.exe') {
      if     ($cl -match 'vitals[\\/]+metrics\.ps1')  { $map[[int]$p.ProcessId] = @{ comp = 'collector'; desc = 'metrics.ps1' } }
      elseif ($cl -match 'vitals[\\/]+panel\.ps1')    { $map[[int]$p.ProcessId] = @{ comp = 'host';      desc = 'panel.ps1 (WinForms host)' } }
      elseif ($cl -match 'vitals[\\/]+winagent\.ps1') { $map[[int]$p.ProcessId] = @{ comp = 'agent';     desc = 'winagent.ps1' } }
    }
  }
  # WebView2: browser process is marked by our user-data folder; children are found by parent walk.
  $wv = $all | Where-Object { $_.Name -eq 'msedgewebview2.exe' }
  $roots = $wv | Where-Object { $_.CommandLine -match 'vitals-webview' -and $_.CommandLine -notmatch '--type=' }
  $wvSet = @{}
  foreach ($r in $roots) { $wvSet[[int]$r.ProcessId] = 'browser' }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $wv) {
      $id = [int]$p.ProcessId
      if ($wvSet.ContainsKey($id)) { continue }
      if ($wvSet.ContainsKey([int]$p.ParentProcessId)) {
        $role = 'other'
        if     ($p.CommandLine -match '--type=renderer')         { $role = 'renderer' }
        elseif ($p.CommandLine -match '--type=gpu-process')      { $role = 'gpu' }
        elseif ($p.CommandLine -match '--type=utility')          { $role = 'utility' }
        elseif ($p.CommandLine -match '--type=crashpad-handler') { $role = 'crashpad' }
        $wvSet[$id] = $role
        $grew = $true
      }
    }
  }
  foreach ($id in $wvSet.Keys) { $map[$id] = @{ comp = ('wv-' + $wvSet[$id]); desc = ('WebView2 ' + $wvSet[$id]) } }
  return $map
}

$map = Get-VitalsMap
if (-not $map.Count) { Write-Host 'No VITALS processes found.'; exit 1 }

# ---------- two-point counter read ----------
$cat = New-Object System.Diagnostics.PerformanceCounterCategory('Process')
function Snap($cat, $map) {
  $r = $cat.ReadCategory()
  $idc = $r['ID Process']; $cpuc = $r['% Processor Time']; $wsc = $r['Working Set - Private']
  $out = @{}
  foreach ($inst in $idc.Keys) {
    if ($inst -eq '_Total' -or $inst -eq 'Idle') { continue }
    $id = [int]$idc[$inst].RawValue
    if ($map.ContainsKey($id)) {
      $out[$id] = @{ cpu = [double]$cpuc[$inst].RawValue; mb = [double]$wsc[$inst].RawValue / 1MB }
    }
  }
  $out
}

$t0 = [DateTime]::UtcNow; $s0 = Snap $cat $map
Start-Sleep -Seconds $Seconds
$t1 = [DateTime]::UtcNow; $s1 = Snap $cat $map
$dt = ($t1 - $t0).TotalSeconds

# ---------- aggregate ----------
$rows = @{}
foreach ($id in $s1.Keys) {
  $comp = $map[$id].comp
  $d = 0.0
  if ($s0.ContainsKey($id)) { $d = $s1[$id].cpu - $s0[$id].cpu; if ($d -lt 0) { $d = 0 } }
  if (-not $rows.ContainsKey($comp)) { $rows[$comp] = @{ comp = $comp; n = 0; cpu = 0.0; mb = 0.0 } }
  $rows[$comp].n   += 1
  $rows[$comp].cpu += (($d / 1e7) / $dt / $logical) * 100
  $rows[$comp].mb  += $s1[$id].mb
}
$order = @('wv-browser','wv-renderer','wv-gpu','wv-utility','wv-crashpad','wv-other','host','bridge','collector','agent')
$list = @(); foreach ($k in $order) { if ($rows.ContainsKey($k)) { $list += $rows[$k] } }
foreach ($k in $rows.Keys) { if ($order -notcontains $k) { $list += $rows[$k] } }

$tc = 0.0; $tm = 0.0; $tn = 0
foreach ($r in $list) { $tc += $r.cpu; $tm += $r.mb; $tn += $r.n }

if (-not $Quiet) {
  Write-Host ("VITALS self-cost  ({0:0.0}s window, CPU as % of {1} logical threads)  {2}" -f $dt, $logical, $Label)
  Write-Host ("{0,-14} {1,5} {2,8} {3,9}" -f 'component', 'procs', 'cpu%', 'MB')
  foreach ($r in $list) { Write-Host ("{0,-14} {1,5} {2,8:0.00} {3,9:0.0}" -f $r.comp, $r.n, $r.cpu, $r.mb) }
  Write-Host ("{0,-14} {1,5} {2,8:0.00} {3,9:0.0}" -f 'TOTAL', $tn, $tc, $tm)
}

# ---------- record ----------
$rec = @{
  at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); label = $Label; secs = [math]::Round($dt,1)
  logical = $logical
  comps = @($list | ForEach-Object { @{ comp = $_.comp; n = $_.n; cpu = [math]::Round($_.cpu,2); mb = [math]::Round($_.mb,1) } })
  total = @{ n = $tn; cpu = [math]::Round($tc,2); mb = [math]::Round($tm,1) }
}
$log = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'history\selfcost.jsonl'
Add-Content -LiteralPath $log -Value ($rec | ConvertTo-Json -Compress -Depth 5)
