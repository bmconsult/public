# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - elevated space reclaim: hibernation and pagefile. UAC one-shot, same split as mftscan.ps1
# and clean-admin.ps1 (the always-on bridge stays unprivileged; only short explicit operations elevate).
#
# Both changes are reversible and both are recorded before/after so the result can be checked rather
# than assumed:
#   powercfg /h off     deletes hiberfil.sys, disables Hibernate AND Fast Startup. Undo: powercfg /h on
#   pagefile initial/max sets a fixed size. Undo: set InitialSize/MaximumSize back to 0/0 (= system managed)
#
# Sizes are chosen from MEASUREMENT, not convention: this machine's pagefile was 24.89 GB on disk while
# never using more than 6.06 GB since boot, and the crash-dump setting is 3 (small dump), so a large
# pagefile is not needed for dumps either. Initial 8 GB sits above the observed peak so it should never
# have to grow; max 16 GB leaves room if something unusual happens.

param(
  [int]$PageInitMB = 8192,
  [int]$PageMaxMB  = 16384,
  [switch]$SkipHibernate,
  [switch]$SkipPagefile,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Continue'
$r = [ordered]@{ ranAt = (Get-Date).ToString('s') }
$r.elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function FreeGB { [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace / 1GB, 2) }
function FileGB([string]$p) {
  $f = Get-ChildItem (Split-Path $p) -Force -File -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -eq (Split-Path $p -Leaf) }
  if ($f) { [math]::Round($f.Length / 1GB, 2) } else { 0 }
}

$r.freeBefore = FreeGB
$r.hiberBefore = FileGB 'C:\hiberfil.sys'
$r.pageBefore  = FileGB 'C:\pagefile.sys'

# ---- hibernation ----
if (-not $SkipHibernate) {
  $out = & powercfg /h off 2>&1
  Start-Sleep -Seconds 2
  $r.hibernate = @{
    ran = $true
    output = ($out | Out-String).Trim()
    hiberAfterGB = FileGB 'C:\hiberfil.sys'
    # The only honest test is whether the file is gone, not whether the command printed nothing.
    ok = ((FileGB 'C:\hiberfil.sys') -eq 0)
  }
} else { $r.hibernate = @{ ran = $false } }

# ---- pagefile ----
if (-not $SkipPagefile) {
  $p = @{ ran = $true }
  try {
    $cs = Get-CimInstance Win32_ComputerSystem
    if ($cs.AutomaticManagedPagefile) {
      Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false } -ErrorAction Stop
      $p.disabledAutomatic = $true
    }
    $set = Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -like '*pagefile.sys' } | Select-Object -First 1
    if (-not $set) {
      # No explicit setting exists yet: create one for the system drive.
      $set = New-CimInstance -ClassName Win32_PageFileSetting `
             -Property @{ Name = 'C:\pagefile.sys'; InitialSize = $PageInitMB; MaximumSize = $PageMaxMB } `
             -ErrorAction Stop
      $p.created = $true
    } else {
      Set-CimInstance -InputObject $set -Property @{ InitialSize = $PageInitMB; MaximumSize = $PageMaxMB } -ErrorAction Stop
    }
    $after = Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -like '*pagefile.sys' } | Select-Object -First 1
    $p.initialMB = $after.InitialSize
    $p.maximumMB = $after.MaximumSize
    # The file does not shrink until the reboot applies the setting, so "ok" means the SETTING took,
    # not that space is back yet. Saying otherwise would promise space that is not there.
    $p.ok = ($after.InitialSize -eq $PageInitMB -and $after.MaximumSize -eq $PageMaxMB)
    $p.note = 'setting applied; the file resizes on the next reboot'
  } catch {
    $p.ok = $false; $p.err = "$_"
  }
  $r.pagefile = $p
} else { $r.pagefile = @{ ran = $false } }

$r.freeAfter = FreeGB
$r.freedNowGB = [math]::Round(($r.freeAfter - $r.freeBefore), 2)
$r.pendingRebootGB = if ($r.pagefile.ok) { [math]::Round(($r.pageBefore - ($PageInitMB / 1024.0)), 2) } else { 0 }

$r | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $Out -Encoding utf8
