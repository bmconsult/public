# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - elevated reclaim, run as a UAC one-shot.
#
# Why this exists as a separate elevated script: the bridge is deliberately NOT elevated. It can end
# processes and delete caches, so a long-lived server running as admin is a liability. The same pattern
# as mftscan.ps1 - the always-on part stays unprivileged, and the few operations that genuinely need
# admin are short, explicit, and prompt for consent.
#
# The bug this fixes: the unelevated bridge tried to delete C:\Windows\SoftwareDistribution\Download,
# was denied on every file, and reported success anyway because the delete used -EA SilentlyContinue
# and the result was hard-coded ok=$true. The ledger recorded "freedGB: -0.02".
#
# This script counts what it could NOT delete and reports it, so a partial or failed run is visible.
#
#   powershell -File clean-admin.ps1 -Targets winupdate,wintemp -Out result.json

param(
  [Parameter(Mandatory = $true)][string]$Targets,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Continue'

# Paths are resolved HERE, not passed in, so an elevated process can never be handed an arbitrary
# path to delete. The caller chooses a key from this table or nothing happens.
$MAP = @{
  winupdate = @{ path = "$env:WINDIR\SoftwareDistribution\Download"; svc = @('wuauserv', 'bits'); what = 'Windows Update downloaded packages' }
  wintemp   = @{ path = "$env:WINDIR\Temp";                          svc = @();                    what = 'Windows temp' }
  winre     = @{ path = "$env:SystemDrive\`$WinREAgent";              svc = @();                    what = 'update/recovery staging' }
  thumbs    = @{ path = "$env:LOCALAPPDATA\Microsoft\Windows\Explorer"; svc = @();                  what = 'Explorer thumbnail cache' }
}

function Measure-Tree([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return @{ bytes = 0; files = 0 } }
  $b = 0L; $n = 0
  $stack = New-Object System.Collections.Stack
  $stack.Push((New-Object IO.DirectoryInfo $p))
  while ($stack.Count) {
    $d = $stack.Pop()
    try { foreach ($f in $d.EnumerateFiles()) { $b += $f.Length; $n++ } } catch {}
    try {
      foreach ($sd in $d.EnumerateDirectories()) {
        if (-not ($sd.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $stack.Push($sd) }
      }
    } catch {}
  }
  @{ bytes = $b; files = $n }
}

$results = @()
foreach ($key in ($Targets -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
  if (-not $MAP.ContainsKey($key)) { $results += @{ key = $key; ok = $false; err = 'unknown target' }; continue }
  $t = $MAP[$key]
  $p = $t.path
  if (-not (Test-Path -LiteralPath $p)) { $results += @{ key = $key; ok = $true; freedGB = 0; note = 'path absent' }; continue }

  $before = Measure-Tree $p
  # Stop the services that hold the files open. Without this, the update cache deletes only partially
  # and the leftovers look like a permissions problem when they are a lock.
  $stopped = @()
  foreach ($s in $t.svc) {
    try {
      $svc = Get-Service -Name $s -ErrorAction Stop
      if ($svc.Status -eq 'Running') { Stop-Service -Name $s -Force -ErrorAction Stop; $stopped += $s }
    } catch {}
  }
  Start-Sleep -Milliseconds 600

  # Delete children, not the folder itself: Windows expects these directories to exist.
  $denied = 0; $deleted = 0
  foreach ($item in (Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)) {
    try { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop; $deleted++ }
    catch { $denied++ }
  }

  foreach ($s in $stopped) { try { Start-Service -Name $s -ErrorAction Stop } catch {} }

  $after = Measure-Tree $p
  $freed = [math]::Round((($before.bytes - $after.bytes) / 1GB), 2)
  $results += @{
    key = $key; what = $t.what; path = $p
    ok = ($denied -eq 0 -or $freed -gt 0)      # honest: partial success is still reported with the denial count
    freedGB = $freed
    leftGB = [math]::Round($after.bytes / 1GB, 2)
    filesBefore = $before.files; filesAfter = $after.files
    entriesDeleted = $deleted; entriesDenied = $denied
    servicesStopped = $stopped
  }
}

$vol = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'"
@{
  ranAt = (Get-Date).ToString('s')
  elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  results = $results
  freeGBAfter = [math]::Round($vol.FreeSpace / 1GB, 2)
  # Summed by hand, NOT with Measure-Object -Property: $results holds HASHTABLES, and freedGB is a KEY
  # on a hashtable rather than a property, so Measure-Object finds nothing and quietly returns null ->
  # a run that freed 11 GB reported totalFreedGB 0. The per-target numbers were right the whole time,
  # which is exactly why a wrong total is worth guarding: it contradicts the detail beside it.
  totalFreedGB = [math]::Round(($results | ForEach-Object { [double]$_.freedGB } | Measure-Object -Sum).Sum, 2)
  totalDenied  = ($results | ForEach-Object { [int]$_.entriesDenied } | Measure-Object -Sum).Sum
} | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $Out -Encoding utf8
