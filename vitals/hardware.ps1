# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - DEEPER HARDWARE TELEMETRY: drive health, interrupt load, NPU.  (B13 · B14 · B15)
#
#   powershell -File hardware.ps1            # everything reachable without elevation
#   powershell -File hardware.ps1 -Elevated  # run from an admin one-shot for the SMART counters
#
# ---------------------------------------------------------------------------------------------
# WHAT EACH SECTION CAN AND CANNOT SAY, MEASURED ON THIS MACHINE 2026-08-01 RATHER THAN ASSUMED.
#
# B13 - DRIVE HEALTH. `Get-PhysicalDisk` answers unelevated and gives the manufacturer's own
#   HealthStatus, the media type and the bus. That is genuinely useful and it is free.
#   `MSStorageDriver_FailurePredictStatus` and `Get-StorageReliabilityCounter` - which carry the
#   numbers people actually want, wear percentage, temperature, power-on hours, reallocated
#   sectors - BOTH return access-denied unelevated. Measured, not guessed. So the wear numbers are
#   gated behind the elevated one-shot, and their absence is reported as "needs elevation" rather
#   than as a healthy zero.
#
# B14 - INTERRUPT AND DPC LOAD. `% DPC Time` and `% Interrupt Time` are ordinary performance
#   counters and need no privilege. THEY ARE NOT LATENCY. LatencyMon-style worst-case DPC latency
#   in microseconds requires an ETW kernel session or a driver, and there is no honest way to
#   produce that number from here - so this reports the time SHARE, says so in as many words, and
#   does not print a microsecond figure it cannot measure. A tool that prints the wrong unit
#   confidently is worse than one that prints nothing.
#
# B15 - NPU. Parity with Task Manager since June 2026, via the `NPU Engine` counter set. That set
#   does not exist on every machine and it does not exist on the machine this was written on (an
#   i7-1165G7 has no NPU), so this code has NEVER BEEN SEEN TO RETURN A READING. It is written from
#   the documented counter shape, it is declared unverified in caps.js, and the first machine with
#   an NPU is what turns that from code into a capability.
# ---------------------------------------------------------------------------------------------

param([switch]$Elevated)

$ErrorActionPreference = 'SilentlyContinue'
$out = @{}

# ---------------------------------------------------------------- B13: drives
$disks = @()
foreach ($d in (Get-PhysicalDisk)) {
  $row = @{
    name    = $d.FriendlyName
    media   = "$($d.MediaType)"
    bus     = "$($d.BusType)"
    sizeGB  = [math]::Round($d.Size / 1GB, 1)
    health  = "$($d.HealthStatus)"          # Healthy / Warning / Unhealthy — the vendor's own verdict
    opState = "$($d.OperationalStatus)"
    # Populated only when the elevated one-shot runs. NULL, never zero: a wear figure of 0% and
    # "we were not allowed to read the wear figure" are opposite statements about a drive.
    wearPct = $null; tempC = $null; powerOnHours = $null; readErrors = $null; writeErrors = $null
    smart   = 'not read'
  }
  if ($Elevated) {
    $c = $d | Get-StorageReliabilityCounter
    if ($c) {
      $row.smart = 'read'
      if ($null -ne $c.Wear)            { $row.wearPct      = [int]$c.Wear }
      if ($null -ne $c.Temperature)     { $row.tempC        = [int]$c.Temperature }
      if ($null -ne $c.PowerOnHours)    { $row.powerOnHours = [int]$c.PowerOnHours }
      if ($null -ne $c.ReadErrorsTotal) { $row.readErrors   = [int]$c.ReadErrorsTotal }
      if ($null -ne $c.WriteErrorsTotal){ $row.writeErrors  = [int]$c.WriteErrorsTotal }
    } else {
      $row.smart = 'elevated, but the driver refused'
    }
  } else {
    $row.smart = 'needs elevation'
  }
  $disks += $row
}
$out.disks = $disks

# Failure prediction is a separate class and a separate permission. Reported only when it answers.
$pred = @()
foreach ($p in (Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus)) {
  $pred += @{ instance = $p.InstanceName; predictFailure = [bool]$p.PredictFailure; reason = [int]$p.Reason }
}
$out.failurePredict = $pred
$out.failurePredictRead = ($pred.Count -gt 0)

# ---------------------------------------------------------------- B14: interrupt / DPC share
$irq = $null
$s = Get-Counter '\Processor(_Total)\% DPC Time', '\Processor(_Total)\% Interrupt Time'
if ($s) {
  $dpc = ($s.CounterSamples | Where-Object { $_.Path -like '*dpc*' }     | Select-Object -First 1).CookedValue
  $int = ($s.CounterSamples | Where-Object { $_.Path -like '*interrupt*' } | Select-Object -First 1).CookedValue
  $irq = @{
    dpcPct = [math]::Round([double]$dpc, 3)
    intPct = [math]::Round([double]$int, 3)
    # Stated in the payload, not only in this comment, so the number cannot be relabelled later by
    # someone reading the JSON without reading the source.
    note   = 'time share, not latency; worst-case DPC latency in microseconds needs an ETW kernel session or a driver and is not measured here'
  }
}
$out.irq = $irq

# ---------------------------------------------------------------- B15: NPU
# UNVERIFIED. Written from the documented counter shape; no machine here has an NPU, so this branch
# has never returned a reading. `present:false` means the counter set is absent, which on a machine
# without an NPU is the correct and expected answer.
$npu = @{ present = $false; utilPct = $null; engines = @(); note = 'no NPU Engine counter set on this host' }
$set = Get-Counter -ListSet 'NPU Engine'
if ($set) {
  $samples = (Get-Counter '\NPU Engine(*)\Utilization Percentage').CounterSamples
  if ($samples) {
    $eng = @()
    foreach ($x in $samples) { $eng += @{ path = $x.InstanceName; util = [math]::Round([double]$x.CookedValue, 2) } }
    $max = ($samples | Measure-Object -Property CookedValue -Maximum).Maximum
    $npu = @{ present = $true; utilPct = [math]::Round([double]$max, 2); engines = $eng
              note = 'read from the NPU Engine counter set; never verified on hardware by the author' }
  } else {
    $npu.note = 'NPU Engine counter set exists but returned no samples'
  }
}
$out.npu = $npu

$out.elevated = [bool]$Elevated
$out.takenAt  = (Get-Date).ToString('o')
$out | ConvertTo-Json -Depth 6 -Compress
