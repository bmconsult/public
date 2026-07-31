# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - persistent metrics emitter.
# ONE long-lived process. Emits one compact JSON line per tick on stdout; bridge.js reads it.
#
# WHY NOT WMI/CIM (this file used to, and ran at 0.32 Hz because of it):
#   Every Get-CimInstance against a Win32_PerfFormattedData_* class costs 250-700 ms REGARDLESS of
#   how little data it returns - the cost is the WMI perf provider refreshing, not marshalling.
#   Measured on this machine: PerfOS_Memory 295 ms, OperatingSystem 264 ms, PerfProc_Process 717 ms,
#   nine queries totalling 3117 ms per tick. Reusing a CimSession does not help (287 ms each).
#
#   System.Diagnostics.PerformanceCounter reads the same kernel counters through the registry perf
#   blob instead: four counters in 4 ms, and PerformanceCounterCategory('Process').ReadCategory()
#   returns ALL 28 counters for ALL ~386 process instances in 26 ms. Same numbers, ~70x cheaper.
#
#   Counter objects are created ONCE at startup and reused; construction is the expensive part.
#   Rate counters (NextValue) need a prior sample to differentiate against, hence the priming pass.

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

# ---------------- static ----------------
$cpuInfo   = Get-CimInstance Win32_Processor | Select-Object -First 1
$logical   = [int]$env:NUMBER_OF_PROCESSORS
$totalRam  = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB, 0)
$gpuNames  = (Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ' + '
$hasNvidia = $null -ne (Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$bootTime  = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$osName    = (Get-CimInstance Win32_OperatingSystem).Caption

# PERFORMANCE COUNTER NAMES ARE LOCALIZED, and this has to be known BEFORE the static message is
# emitted, because that message is where the panel learns what this host can do.
# .NET resolves 'Processor' / '% Processor Time' against the machine's LOCALIZED counter set, so on a
# German or Japanese Windows every lookup returns $null - and with $ErrorActionPreference =
# 'SilentlyContinue' it does so in total silence. The collector would then emit nulls forever while
# caps.js still reported every Windows capability as `true`: the manifest lying, which is the one
# failure this whole design exists to prevent.
$counterLocaleOK = $false
try {
  $probe = New-Object System.Diagnostics.PerformanceCounter('Processor', '% Processor Time', '_Total', $true)
  $null = $probe.NextValue()
  $counterLocaleOK = $true
  $probe.Dispose()
} catch { $counterLocaleOK = $false }
if (-not $counterLocaleOK) {
  [Console]::Error.WriteLine("[metrics] the English performance-counter names did not resolve on this system.")
  [Console]::Error.WriteLine("[metrics] this is usually a non-English Windows: .NET looks counters up by LOCALIZED name.")
  [Console]::Error.WriteLine("[metrics] CPU, memory, disk and network will report as UNAVAILABLE rather than as zero.")
}

Emit @{
  t = 'static'; cpu = $cpuInfo.Name.Trim(); cores = $cpuInfo.NumberOfCores; threads = $logical
  countersOK = $counterLocaleOK
  ramMB = $totalRam; gpu = $gpuNames; nvidia = $hasNvidia; host = $env:COMPUTERNAME; os = $osName
}

# ---------------- build counters once ----------------
function PC($cat, $name, $inst) {
  try { New-Object System.Diagnostics.PerformanceCounter($cat, $name, $inst, $true) } catch { $null }
}

$cCpu   = PC 'Processor' '% Processor Time' '_Total'
$cCores = @(); foreach ($i in 0..($logical - 1)) { $cCores += ,(PC 'Processor' '% Processor Time' "$i") }
$cAvail = PC 'Memory' 'Available MBytes' ''
$cPages = PC 'Memory' 'Pages/sec' ''
$cCommit= PC 'Memory' 'Committed Bytes' ''
$cCache = PC 'Memory' 'Cache Bytes' ''
$cDskT  = PC 'PhysicalDisk' '% Disk Time' '_Total'
$cDskR  = PC 'PhysicalDisk' 'Disk Read Bytes/sec' '_Total'
$cDskW  = PC 'PhysicalDisk' 'Disk Write Bytes/sec' '_Total'
$cDskQ  = PC 'PhysicalDisk' 'Current Disk Queue Length' '_Total'

$netRx = @(); $netTx = @()
try {
  foreach ($n in ([System.Diagnostics.PerformanceCounterCategory]::new('Network Interface')).GetInstanceNames()) {
    if ($n -match 'Loopback|Pseudo|Teredo|isatap|Filter') { continue }
    $netRx += ,(PC 'Network Interface' 'Bytes Received/sec' $n)
    $netTx += ,(PC 'Network Interface' 'Bytes Sent/sec' $n)
  }
} catch {}

$procCat = New-Object System.Diagnostics.PerformanceCounterCategory('Process')

# ---------------- GPU Engine counters (2026-07-29, telemetry-gaps pass) ----------------
# WHY: this machine has TWO GPUs (NVIDIA GTX 1650 Max-Q + Intel Iris Xe). nvidia-smi sees only the
# NVIDIA — which idles at 0% while the Intel iGPU does ALL the desktop compositing, including
# rendering this very panel. A ring reading "GPU 0%" while a GPU is genuinely busy is a lie.
# 'GPU Engine' perf counters are per-pid, per-engine and vendor-agnostic — Task Manager's own
# source. Raw values are cumulative 100-ns busy time, differenced like the CPU counters above.
# Measured on this machine: FIRST ReadCategory = 2,098 ms (metadata load), warm reads 1-4 ms —
# so the first read happens here in the priming pass and per-tick cost is ~free.
$gpuCat = $null
$gpuLuidName = @{}     # '0x0001057a' (low dword, lowercase) -> adapter name
try {
  $gpuCat = New-Object System.Diagnostics.PerformanceCounterCategory('GPU Engine')
  # LUID -> adapter name lives in HKLM\SOFTWARE\Microsoft\DirectX (readable unelevated).
  # Instance names carry luid_0xHIGH_0xLOW; the registry AdapterLuid QWORD's low dword matches.
  foreach ($k in (Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\DirectX' -ErrorAction SilentlyContinue)) {
    $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    if ($null -ne $p.AdapterLuid -and $p.Description) {
      $lo = '0x{0:x8}' -f ([int64]$p.AdapterLuid -band 0xFFFFFFFF)
      $gpuLuidName[$lo] = ([string]$p.Description -replace '\(R\)|\(TM\)', '').Trim()
    }
  }
} catch { $gpuCat = $null }
$gpuParse   = @{}      # instance name -> @(pid, luidLo, engId, engType) — parsed once, cached
$gpuPrevRaw = @{}      # instance name -> cumulative 100ns busy
$gpuRx = [regex]'^pid_(\d+)_luid_0x[0-9a-f]+_(0x[0-9a-f]+)_phys_\d+_eng_(\d+)_engtype_(.*)$'

# ---------------- battery / power (2026-07-29) ----------------
# GetSystemPowerStatus is a ~0 ms Win32 call -> every tick. The richer root\wmi classes cost
# ~300 ms of WMI provider -> every 15 ticks. Design capacity + cycle count come from one
# powercfg /batteryreport at startup (~2 s, once per collector lifetime).
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public struct VSPS { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public int BatteryLifeTime; public int BatteryFullLifeTime; }
public class VPWR { [DllImport("kernel32.dll", EntryPoint="GetSystemPowerStatus")] public static extern bool GetSystemPowerStatus(out VSPS s); }
'@ -ErrorAction SilentlyContinue
$hasBattery = $null -ne (Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
$batDesign = 0; $batCycles = 0; $batChem = ''
if ($hasBattery) {
  try {
    $brXml = Join-Path $env:TEMP 'vitals-battreport.xml'
    & powercfg /batteryreport /xml /output $brXml 2>$null | Out-Null
    [xml]$br = Get-Content $brXml -ErrorAction SilentlyContinue
    $bb = $br.BatteryReport.Batteries.Battery | Select-Object -First 1
    if ($bb) { $batDesign = [int]$bb.DesignCapacity; $batCycles = [int]$bb.CycleCount; $batChem = [string]$bb.Chemistry }
  } catch {}
}
$batWmi = $null; $batFull = 0   # refreshed every 15 ticks

function Val($c) { if ($c) { try { $c.NextValue() } catch { 0 } } else { 0 } }

# Prime every rate counter - the first NextValue() on a rate counter always returns 0 because there
# is nothing to differentiate against yet.
Val $cCpu | Out-Null; foreach ($c in $cCores) { Val $c | Out-Null }
Val $cPages | Out-Null; Val $cDskT | Out-Null; Val $cDskR | Out-Null; Val $cDskW | Out-Null
foreach ($c in $netRx) { Val $c | Out-Null }; foreach ($c in $netTx) { Val $c | Out-Null }
$procCat.ReadCategory() | Out-Null
if ($gpuCat) {   # eat the 2s first-read here, and seed prev-raw so the first tick has real deltas
  try {
    $gp = $gpuCat.ReadCategory()['utilization percentage']
    foreach ($ik in $gp.Keys) { $gpuPrevRaw[$ik] = [double]$gp[$ik].RawValue }
  } catch { $gpuCat = $null }
}
Start-Sleep -Milliseconds 500

# ---------------- self-attribution (FOOTPRINT page) ----------------
# The tick already reads CPU + private WS for EVERY process on the machine; attributing VITALS'
# own cost is therefore free at sample time - no extra counter reads. The only added work is
# discovering WHICH pids are ours: a Win32_Process command-line scan every 30 ticks (~30 s).
#
# Discovery notes, each learned by a detector missing something:
#   - The bridge is `node bridge.js 8790` with cwd=vitals: NO vitals marker in its command line.
#     But the bridge is this process's PARENT, which is unfakeable and free.
#   - WebView2 children (renderer/gpu/utility/crashpad) do not carry --user-data-dir; only the
#     browser root does. Children are found by walking ParentProcessId down from the root.
$selfPid    = $PID
$bridgePid  = 0
try { $bridgePid = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$selfPid").ParentProcessId } catch {}
function SelfScan {
  $m = @{}
  $m[[int]$selfPid] = 'collector'
  if ($bridgePid -gt 0) { $m[[int]$bridgePid] = 'bridge' }
  try {
    $all = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' OR Name='powershell.exe'" |
           Select-Object ProcessId, ParentProcessId, Name, CommandLine
    foreach ($p in $all) {
      $cl = [string]$p.CommandLine
      if ($p.Name -eq 'powershell.exe') {
        if     ($cl -match 'vitals[\\/]+panel\.ps1')    { $m[[int]$p.ProcessId] = 'host' }
        elseif ($cl -match 'vitals[\\/]+winagent\.ps1') { $m[[int]$p.ProcessId] = 'agent' }
      }
    }
    $wv = @($all | Where-Object { $_.Name -eq 'msedgewebview2.exe' })
    $set = @{}
    foreach ($r in $wv) {
      if ($r.CommandLine -match 'vitals-webview' -and $r.CommandLine -notmatch '--type=') { $set[[int]$r.ProcessId] = 'wv-browser' }
    }
    $grew = $true
    while ($grew) {
      $grew = $false
      foreach ($p in $wv) {
        $id = [int]$p.ProcessId
        if ($set.ContainsKey($id)) { continue }
        if ($set.ContainsKey([int]$p.ParentProcessId)) {
          $role = 'wv-other'
          if     ($p.CommandLine -match '--type=renderer')         { $role = 'wv-renderer' }
          elseif ($p.CommandLine -match '--type=gpu-process')      { $role = 'wv-gpu' }
          elseif ($p.CommandLine -match '--type=utility')          { $role = 'wv-utility' }
          elseif ($p.CommandLine -match '--type=crashpad-handler') { $role = 'wv-crashpad' }
          $set[$id] = $role; $grew = $true
        }
      }
    }
    foreach ($k in $set.Keys) { $m[$k] = $set[$k] }
  } catch {}
  $m
}
$selfMap    = SelfScan
$selfScanAt = [DateTime]::UtcNow
$SELF_ORDER = @('wv-browser','wv-renderer','wv-gpu','wv-utility','wv-crashpad','wv-other','host','bridge','collector','agent')

# ---------------- rolling state ----------------
$prevCpuRaw = @{}      # instance -> cumulative 100ns CPU ticks
$prevIoRaw  = @{}      # instance -> cumulative IO bytes
$prevStamp  = [DateTime]::UtcNow
$volCache   = $null
$gpuCache   = $null
$tick       = 0

while ($true) {
  $tick++
  $now = [DateTime]::UtcNow
  $elapsed = ($now - $prevStamp).TotalSeconds
  if ($elapsed -le 0) { $elapsed = 1 }

  # ----- machine scalars: ~10 ms for all of it -----
  $cpuTotal = [int](Val $cCpu)
  $perCore  = @(); foreach ($c in $cCores) { $perCore += [int](Val $c) }
  $freeMB   = [int](Val $cAvail)
  $usedMB   = $totalRam - $freeMB
  $pagesSec = [int](Val $cPages)
  $commitMB = [math]::Round((Val $cCommit) / 1MB, 0)
  $cacheMB  = [math]::Round((Val $cCache) / 1MB, 0)
  $dskBusy  = [math]::Min(100, [int](Val $cDskT))
  $dskR     = [math]::Round((Val $cDskR) / 1MB, 2)
  $dskW     = [math]::Round((Val $cDskW) / 1MB, 2)
  $dskQ     = [math]::Round((Val $cDskQ), 1)
  $rx = 0.0; foreach ($c in $netRx) { $rx += (Val $c) }
  $tx = 0.0; foreach ($c in $netTx) { $tx += (Val $c) }

  # ----- volume capacity: changes slowly, and it is the one CIM call left (~32 ms) -----
  if ($null -eq $volCache -or $tick % 10 -eq 1) {
    $v = @()
    foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")) {
      $v += @{ id = $d.DeviceID; label = $d.VolumeName
               sizeGB = [math]::Round($d.Size / 1GB, 1); freeGB = [math]::Round($d.FreeSpace / 1GB, 1)
               pct = if ($d.Size) { [math]::Round((($d.Size - $d.FreeSpace) / $d.Size) * 100, 1) } else { 0 } }
    }
    $volCache = $v
  }

  # refresh the self pid map every 30 ticks (~30 s): catches panel restarts and agent spawn
  if ($tick % 30 -eq 0) { $selfMap = SelfScan; $selfScanAt = $now }

  # ----- per-process: ONE bulk read (~26 ms) for CPU, memory and I/O -----
  # RawValue here is cumulative, so differencing gives exact totals rather than sampled rates.
  $procs = @()
  $selfAgg = @{}
  $pidName = @{}     # pid -> process name, from the same bulk read; the GPU block joins on it
  try {
    $cat = $procCat.ReadCategory()
    $idc   = $cat['ID Process']
    $wsc   = $cat['Working Set - Private']
    $cpuc  = $cat['% Processor Time']
    $iorc  = $cat['IO Read Bytes/sec']
    $iowc  = $cat['IO Write Bytes/sec']
    $pfc   = $cat['Page Faults/sec']

    $agg = @{}
    $curCpu = @{}; $curIo = @{}
    foreach ($inst in $idc.Keys) {
      if ($inst -eq '_Total' -or $inst -eq 'Idle') { continue }
      $pid2 = [int]$idc[$inst].RawValue
      if ($pid2 -le 0) { continue }
      $name = $inst -replace '#\d+$', ''
      $pidName[$pid2] = $name

      $cpuRaw = [double]$cpuc[$inst].RawValue          # 100-ns ticks, cumulative
      $ioR    = [double]$iorc[$inst].RawValue          # read + write kept SEPARATE: the NET page's
      $ioW    = [double]$iowc[$inst].RawValue          # per-process table has R and W columns, and
      $ioRaw  = $ioR + $ioW                            # they read 0.00 for months because only the
      $curCpu[$inst] = $cpuRaw; $curIo[$inst] = @($ioR, $ioW)   # combined figure was emitted
      $dCpu = 0.0; if ($prevCpuRaw.ContainsKey($inst)) { $dCpu = $cpuRaw - $prevCpuRaw[$inst] }
      if ($dCpu -lt 0) { $dCpu = 0 }
      $dIoR = 0.0; $dIoW = 0.0
      if ($prevIoRaw.ContainsKey($inst)) {
        $pv = $prevIoRaw[$inst]
        if ($pv -is [array]) { $dIoR = $ioR - $pv[0]; $dIoW = $ioW - $pv[1] }
        else { $dIoR = $ioRaw - [double]$pv }          # first tick after an upgrade: old scalar shape
      }
      if ($dIoR -lt 0) { $dIoR = 0 }; if ($dIoW -lt 0) { $dIoW = 0 }
      $dIo = $dIoR + $dIoW

      if (-not $agg.ContainsKey($name)) {
        $agg[$name] = @{ n = $name; mb = 0.0; cpu100ns = 0.0; io = 0.0; ioR = 0.0; ioW = 0.0; pf = 0.0; count = 0; pids = @() }
      }
      $agg[$name].mb       += [double]$wsc[$inst].RawValue / 1MB
      $agg[$name].cpu100ns += $dCpu
      $agg[$name].io       += $dIo
      $agg[$name].ioR      += $dIoR
      $agg[$name].ioW      += $dIoW
      $agg[$name].pf       += [double]$pfc[$inst].RawValue
      $agg[$name].count    += 1
      if ($agg[$name].pids.Count -lt 40) { $agg[$name].pids += $pid2 }

      # self-attribution rides the SAME read - zero extra counter cost
      if ($selfMap.ContainsKey($pid2)) {
        $sk = $selfMap[$pid2]
        if (-not $selfAgg.ContainsKey($sk)) { $selfAgg[$sk] = @{ cpu = 0.0; mb = 0.0; n = 0 } }
        $selfAgg[$sk].cpu += $dCpu
        $selfAgg[$sk].mb  += [double]$wsc[$inst].RawValue / 1MB
        $selfAgg[$sk].n   += 1
      }
    }
    $prevCpuRaw = $curCpu; $prevIoRaw = $curIo

    # CPU% exactly as Task Manager derives it: CPU-time delta / wall delta / logical threads.
    # 100-ns ticks -> seconds is a factor of 1e7.
    $procs = $agg.Values | ForEach-Object {
      @{ n = $_.n; mb = [math]::Round($_.mb, 0)
         cpu = [math]::Round((($_.cpu100ns / 1e7) / $elapsed / $logical) * 100, 1)
         ioMBs = [math]::Round(($_.io / 1MB) / $elapsed, 2)
         rMBs = [math]::Round(($_.ioR / 1MB) / $elapsed, 2)
         wMBs = [math]::Round(($_.ioW / 1MB) / $elapsed, 2)
         pf = [int]$_.pf; count = $_.count; pids = $_.pids }
    } | Sort-Object { $_.mb } -Descending | Select-Object -First 16
  } catch { $procs = @() }

  # ----- GPU: nvidia-smi is a process spawn (~120 ms), so only every 3rd tick -----
  if ($hasNvidia -and ($tick % 3 -eq 1)) {
    $raw = & nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null
    if ($raw) {
      $f = ($raw -split ',') | ForEach-Object { $_.Trim() }
      if ($f.Count -ge 5) {
        $gpuCache = @{ util = [int]($f[0] -replace '[^\d]',''); memUsed = [int]($f[1] -replace '[^\d]','')
                       memTotal = [int]($f[2] -replace '[^\d]',''); temp = [int]($f[3] -replace '[^\d]','')
                       watts = [double]($f[4] -replace '[^\d\.]','') }
      }
    }
  }

  # ----- GPU Engine: per-adapter, per-engine, per-pid truth (both GPUs, not just NVIDIA) -----
  # Cumulative 100-ns busy time per (pid × engine) instance, differenced against the previous tick.
  # Adapter utilization = the busiest single engine (Task Manager's definition), so it can never
  # exceed 100 and matches what the owner sees in Task Manager's GPU column.
  $gpusOut = $null
  if ($gpuCat) {
    try {
      $gc = $gpuCat.ReadCategory()
      $uc = $gc['utilization percentage']
      $engBusy = @{}   # "luid|engId|engType" -> delta 100ns
      $pidEng  = @{}   # "pid|luid|engId"     -> delta 100ns
      $curRaw  = @{}
      foreach ($ik in $uc.Keys) {
        $raw = [double]$uc[$ik].RawValue
        $curRaw[$ik] = $raw
        if (-not $gpuPrevRaw.ContainsKey($ik)) { continue }
        $d = $raw - $gpuPrevRaw[$ik]
        if ($d -le 0) { continue }
        $pi = $gpuParse[$ik]
        if ($null -eq $pi) {
          $m = $gpuRx.Match($ik)
          if (-not $m.Success) { continue }
          $pi = @([int]$m.Groups[1].Value, $m.Groups[2].Value, [int]$m.Groups[3].Value, $m.Groups[4].Value.ToLower())
          $gpuParse[$ik] = $pi
        }
        $ek = "$($pi[1])|$($pi[2])|$($pi[3])"
        $engBusy[$ek] = [double]$engBusy[$ek] + $d
        $pk = "$($pi[0])|$($pi[1])|$($pi[2])"
        $pidEng[$pk] = [double]$pidEng[$pk] + $d
      }
      $gpuPrevRaw = $curRaw
      if ($gpuParse.Count -gt 4000) { $gpuParse = @{} }   # pid churn guard; rebuilt lazily

      $denom = $elapsed * 1e7
      $ads = @{}   # luid -> @{ n; util; eng=@{} }
      foreach ($ek in $engBusy.Keys) {
        $parts = $ek -split '\|'
        $luid = $parts[0]; $etype = $parts[2]; if (-not $etype) { $etype = 'other' }
        $pct = [math]::Round(($engBusy[$ek] / $denom) * 100, 1)
        if ($pct -gt 100) { $pct = 100 }
        if (-not $ads.ContainsKey($luid)) {
          $nm = $gpuLuidName[$luid]; if (-not $nm) { $nm = "adapter $luid" }
          $ads[$luid] = @{ n = $nm; util = 0.0; eng = @{} }
        }
        if ($pct -gt [double]$ads[$luid].util) { $ads[$luid].util = $pct }
        if ($pct -gt [double]$ads[$luid].eng[$etype]) { $ads[$luid].eng[$etype] = $pct }
      }
      # per-pid: busiest engine for that pid on any adapter (Task Manager's per-process figure)
      $pidTop = @{}
      foreach ($pk in $pidEng.Keys) {
        $pp = [int]($pk -split '\|')[0]
        $pct = [math]::Round(($pidEng[$pk] / $denom) * 100, 1)
        if ($pct -gt 100) { $pct = 100 }
        if ($pct -gt [double]$pidTop[$pp]) { $pidTop[$pp] = $pct }
      }
      $top = @()
      foreach ($pp in ($pidTop.Keys | Sort-Object { $pidTop[$_] } -Descending | Select-Object -First 5)) {
        if ([double]$pidTop[$pp] -lt 0.5) { break }
        $nm = $pidName[[int]$pp]; if (-not $nm) { $nm = "pid $pp" }
        $top += @{ pid = [int]$pp; n = $nm; util = [double]$pidTop[$pp] }
      }
      # emit hardware adapters always (0% idle is honest); software rasterizer only if it moves
      $adsOut = @(); $maxU = 0.0
      foreach ($luid in ($ads.Keys | Sort-Object { [double]$ads[$_].util } -Descending)) {
        $a = $ads[$luid]
        if ($a.n -match 'Basic Render|Basic Display' -and [double]$a.util -lt 1) { continue }
        $adsOut += $a
        if ([double]$a.util -gt $maxU) { $maxU = [double]$a.util }
      }
      # idle hardware adapters produce no counter deltas at all — list them at 0 by name
      foreach ($luid in $gpuLuidName.Keys) {
        $nm = $gpuLuidName[$luid]
        if ($nm -match 'Basic Render|Basic Display') { continue }
        if (-not ($adsOut | Where-Object { $_.n -eq $nm })) { $adsOut += @{ n = $nm; util = 0.0; eng = @{} } }
      }
      $gpusOut = @{ max = $maxU; ads = $adsOut; top = $top }
    } catch { $gpusOut = $null }
  }

  # ----- battery / power -----
  $pwrOut = $null
  if ($hasBattery) {
    $sps = New-Object VSPS
    $null = [VPWR]::GetSystemPowerStatus([ref]$sps)
    if ($tick % 15 -eq 1) {
      try { $batWmi = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { $batWmi = $null }
      if (-not $batFull) {
        try { $batFull = [int](Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullChargedCapacity) } catch { $batFull = 0 }
      }
    }
    # signed flow in W: + while charging, − while discharging, 0 when the firmware reports no flow
    $rateW = $null; $remWh = $null
    if ($batWmi) {
      $rateW = [math]::Round((([double]$batWmi.ChargeRate - [double]$batWmi.DischargeRate) / 1000), 1)
      $remWh = [math]::Round([double]$batWmi.RemainingCapacity / 1000, 1)
    }
    $pwrOut = @{
      bat = $true
      pct = [int]$sps.BatteryLifePercent           # 255 = unknown
      ac = ($sps.ACLineStatus -eq 1)
      charging = ($batWmi -and [bool]$batWmi.Charging)
      discharging = ($batWmi -and [bool]$batWmi.Discharging)
      rateW = $rateW
      remWh = $remWh
      fullWh = if ($batFull) { [math]::Round($batFull / 1000, 1) } else { $null }
      designWh = if ($batDesign) { [math]::Round($batDesign / 1000, 1) } else { $null }
      cycles = $batCycles
      chem = $batChem
      lifeMin = if ($sps.BatteryLifeTime -ge 0) { [int]($sps.BatteryLifeTime / 60) } else { $null }
    }
  } else {
    $pwrOut = @{ bat = $false }
  }

  # ----- self block: what VITALS itself costs, per component (FOOTPRINT page) -----
  $selfComps = @(); $selfCpu = 0.0; $selfMb = 0.0; $selfN = 0
  foreach ($k in $SELF_ORDER) {
    if ($selfAgg.ContainsKey($k)) {
      $sc = [math]::Round((($selfAgg[$k].cpu / 1e7) / $elapsed / $logical) * 100, 2)
      $sm = [math]::Round($selfAgg[$k].mb, 1)
      $selfComps += @{ k = $k; n = $selfAgg[$k].n; cpu = $sc; mb = $sm }
      $selfCpu += $sc; $selfMb += $sm; $selfN += $selfAgg[$k].n
    }
  }

  Emit @{
    t = 'tick'; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    cpu = @{ total = $cpuTotal; cores = $perCore }
    mem = @{ usedMB = $usedMB; freeMB = $freeMB; totalMB = $totalRam; committedMB = $commitMB
             pct = [math]::Round(($usedMB / $totalRam) * 100, 1); cacheMB = $cacheMB; pagesSec = $pagesSec }
    disk = @{ vols = $volCache; io = @{ readMBs = $dskR; writeMBs = $dskW; busyPct = $dskBusy; queue = $dskQ } }
    net = @{ rxMBs = [math]::Round($rx / 1MB, 3); txMBs = [math]::Round($tx / 1MB, 3) }
    proc = @($procs)
    gpu = $gpuCache
    gpus = $gpusOut
    pwr = $pwrOut
    self = @{ comps = $selfComps; cpu = [math]::Round($selfCpu, 2); mb = [math]::Round($selfMb, 0)
              n = $selfN; scanAge = [int](($now - $selfScanAt).TotalSeconds) }
    up = [math]::Round(((Get-Date) - $bootTime).TotalHours, 1)
  }

  $prevStamp = $now
  Start-Sleep -Milliseconds 900
}
