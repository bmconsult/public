# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - GRADUATED QUARANTINE: the reversible ladder that replaces a kill.  (B10)
#
#   powershell -File quarantine.ps1 -Action state   -TargetPid 1234
#   powershell -File quarantine.ps1 -Action priority -TargetPid 1234
#   powershell -File quarantine.ps1 -Action affinity -TargetPid 1234 -Cores 2
#   powershell -File quarantine.ps1 -Action suspend  -TargetPid 1234
#   powershell -File quarantine.ps1 -Action release  -TargetPid 1234
#
# ---------------------------------------------------------------------------------------------
# WHY A LADDER RATHER THAN A KILL.
#
# "End process" is the only lever most monitors offer, and it is the WORST one available: it is
# irreversible, it loses unsaved work, and it is wildly disproportionate to the usual complaint,
# which is not "this program is broken" but "this program is taking more than its share right now".
#
# Three rungs, each strictly reversible, in increasing severity:
#
#   1. PRIORITY   -> BelowNormal. The process keeps running and keeps every CPU; it simply yields
#                    when anything else wants the core. For a background indexer or a compiler this
#                    is usually the whole fix, and the user never notices it happened.
#   2. AFFINITY   -> restricted to N cores. Now it cannot occupy the whole machine however hard it
#                    tries. Still running, still making progress, just fenced.
#   3. SUSPEND    -> frozen. Uses the documented Debug API rather than an undefined native call, so
#                    it is a supported operation with a supported inverse.
#
# EVERY RUNG IS REVERSIBLE AND THE ORIGINAL IS RECORDED FIRST. `release` restores exactly what was
# there before, which is why `state` captures the original priority and affinity mask before
# anything is changed. A ladder you cannot climb back down is just a slower kill.
#
# WHAT THIS REFUSES.
#   - PID 0 and 4 (System / Idle), and anything whose main module cannot be read, which in practice
#     means protected system processes. Fencing the kernel is not a user affordance.
#   - Its own bridge and panel, by name, because a monitor that can suspend itself will eventually
#     be asked to.
#   - Suspending a process with a visible main window. A frozen window does not repaint and Windows
#     draws a white rectangle over it - the user's conclusion is "the app crashed", not "I fenced
#     it", and an action whose result is indistinguishable from a crash is not a kindness.
# ---------------------------------------------------------------------------------------------

param(
  [Parameter(Mandatory = $true)][ValidateSet('state', 'priority', 'affinity', 'suspend', 'release')]
  [string]$Action,
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [int]$Cores = 2
)

$ErrorActionPreference = 'Stop'

# SUSPEND IS PER-THREAD, and getting here cost a real defect worth recording.
#
# The first version used the debug API: DebugActiveProcess freezes every thread, and
# DebugActiveProcessStop is its documented inverse. It tested as a KILL. A debugger owns its
# debuggee, and this is a ONE-SHOT - the moment the script exits, the attachment ends and the target
# is terminated (or, with KillOnExit cleared, simply resumed, so the suspend would not persist
# either). Both outcomes are wrong, and one of them is the exact thing this whole file exists to
# avoid: an irreversible action wearing a reversible name. It was caught only because the test
# asked for the process back afterwards rather than stopping at "the call returned true".
#
# OpenThread + SuspendThread is documented, survives the caller exiting, and its inverse is
# ResumeThread. The one honest caveat is that it freezes the threads that exist AT THAT MOMENT: a
# process that spawns another thread afterwards will have one running thread. That is stated in the
# result rather than hidden, because a partial freeze described as a freeze is a lie the user would
# discover by watching the CPU.
Add-Type -Namespace VitalsQ -Name Native -MemberDefinition @'
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenThread(int access, bool inherit, int tid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern int SuspendThread(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern int ResumeThread(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
'@

# THREAD_SUSPEND_RESUME
$THREAD_SUSPEND_RESUME = 0x0002

function Invoke-Threads([System.Diagnostics.Process]$proc, [string]$mode) {
  $done = 0; $failed = 0
  foreach ($t in $proc.Threads) {
    $h = [VitalsQ.Native]::OpenThread($THREAD_SUSPEND_RESUME, $false, $t.Id)
    if ($h -eq [IntPtr]::Zero) { $failed++; continue }
    try {
      $r = if ($mode -eq 'suspend') { [VitalsQ.Native]::SuspendThread($h) } else { [VitalsQ.Native]::ResumeThread($h) }
      if ($r -lt 0) { $failed++ } else { $done++ }
    } finally { [void][VitalsQ.Native]::CloseHandle($h) }
  }
  return @{ done = $done; failed = $failed }
}

function Fail($why) { @{ ok = $false; error = $why } | ConvertTo-Json -Compress; exit 1 }

if ($TargetPid -le 4) { Fail 'refusing: pid 0 and 4 are the Idle and System processes' }

try { $p = Get-Process -Id $TargetPid -ErrorAction Stop } catch { Fail "no process with pid $TargetPid" }

# Never fence the instrument. A monitor that can suspend its own bridge will be asked to, once, by
# someone who then cannot un-ask.
$self = @('node', 'powershell', 'pwsh', 'conhost')
if ($self -contains $p.ProcessName.ToLower()) {
  $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction SilentlyContinue).CommandLine
  if ($cl -and ($cl -match 'bridge\.js|panel\.ps1|vitals')) { Fail 'refusing: that is VITALS itself' }
}

# NOT $cores. PowerShell variable names are CASE-INSENSITIVE, so `$cores` and the `-Cores`
# parameter are the same variable - assigning the machine's core count here silently overwrote the
# caller's argument, and `-Cores 2` arrived as 8. The symptom was the affinity rung refusing itself
# with "restricting to 8 of 8 cores would not fence anything", which is a true sentence about a
# value the caller never passed.
$cpuCount = [Environment]::ProcessorCount
$out = @{ ok = $true; pid = $TargetPid; name = $p.ProcessName; action = $Action; cores = $cpuCount }

switch ($Action) {

  'state' {
    # Read the ORIGINAL before anything is changed. `release` restores from this, so capturing it is
    # what makes the ladder reversible rather than merely re-settable to a guess at the default.
    $out.priority = "$($p.PriorityClass)"
    try { $out.affinityMask = [int64]$p.ProcessorAffinity } catch { $out.affinityMask = $null }
    $out.threads = $p.Threads.Count
    $out.hasWindow = ($p.MainWindowHandle -ne 0)
    $out.responding = $p.Responding
    # A rough read of whether it is already fenced, so the panel can show the rung it is on.
    $full = [int64]([math]::Pow(2, $cpuCount) - 1)
    $out.rung = if ("$($p.PriorityClass)" -eq 'BelowNormal' -or "$($p.PriorityClass)" -eq 'Idle') {
                  if ($out.affinityMask -and $out.affinityMask -ne $full) { 'affinity' } else { 'priority' }
                } elseif ($out.affinityMask -and $out.affinityMask -ne $full) { 'affinity' } else { 'none' }
  }

  'priority' {
    $out.was = "$($p.PriorityClass)"
    $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
    $out.now = 'BelowNormal'
    $out.note = 'still running on every core; it now yields whenever anything else wants one'
  }

  'affinity' {
    if ($Cores -lt 1) { Fail 'need at least one core' }
    if ($Cores -ge $cpuCount) { Fail "restricting to $Cores of $cpuCount cores would not fence anything" }
    $out.wasMask = [int64]$p.ProcessorAffinity
    # The LOW cores, deliberately. On hybrid parts (P/E cores) the low indices are the performance
    # cores on some CPUs and the efficiency cores on others, so this does not claim to pick "slow"
    # cores - only to pick FEWER of them, which is the property being relied on.
    $mask = [int64]([math]::Pow(2, $Cores) - 1)
    $p.ProcessorAffinity = [IntPtr]$mask
    $out.nowMask = $mask
    $out.note = "fenced to $Cores of $cpuCount cores; still running, still progressing, just bounded"
  }

  'suspend' {
    # A frozen window does not repaint, and Windows paints a white rectangle where it was. The user
    # reads that as a crash. An action indistinguishable from a crash is not a kindness, so a
    # process with a visible main window is refused at this rung.
    if ($p.MainWindowHandle -ne 0) {
      Fail 'refusing: that process has a visible window, and a frozen window looks exactly like a crashed one. Use priority or affinity instead.'
    }
    $r = Invoke-Threads $p 'suspend'
    if ($r.done -eq 0) { Fail "could not suspend any of $($p.Threads.Count) threads — the process is probably protected" }
    $out.suspended = $r.done
    $out.refused = $r.failed
    $out.note = "froze $($r.done) of $($p.Threads.Count) threads. Threads created after this moment " +
                "keep running, so this is a freeze of what was there, not a guarantee about what comes next."
    if ($r.failed -gt 0) { $out.note += " $($r.failed) thread(s) could not be opened." }
  }

  'release' {
    # Undo everything, in the reverse order it could have been applied. Each step is attempted
    # independently: a process that was only ever de-prioritised must still be restorable even
    # though there is no debugger to detach.
    $undone = @()
    # Resume is idempotent per thread: a thread that was never suspended has a suspend count of 0
    # and ResumeThread simply reports it. So `release` is safe on a process that was only ever
    # de-prioritised, which is the common case.
    $r = Invoke-Threads $p 'resume'
    if ($r.done -gt 0) { $undone += "resumed $($r.done) threads" }
    try {
      $p.ProcessorAffinity = [IntPtr]([int64]([math]::Pow(2, $cpuCount) - 1))
      $undone += 'affinity restored to all cores'
    } catch {}
    try {
      $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Normal
      $undone += 'priority restored to Normal'
    } catch {}
    $out.undone = $undone
    $out.note = 'every rung reversed'
  }
}

$out | ConvertTo-Json -Depth 5 -Compress
