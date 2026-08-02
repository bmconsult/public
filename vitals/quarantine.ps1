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
# EVERY RUNG IS REVERSIBLE AND THE ORIGINAL IS RECORDED FIRST - and "recorded" has to mean written
# somewhere `release` can read, which is the part the first version got wrong.
#
# `state` returned the original priority and affinity to the CALLER and nothing kept them, so
# `release` restored a GUESS: hard-coded Normal, hard-coded all-cores. On a process legitimately
# running at Idle - a background indexer, a well-behaved updater - "undo" therefore PROMOTED it, and
# on one deliberately pinned by its own app it removed the pinning. An undo that does not restore
# what was there is a second change wearing the name of a reversal.
#
# The original is now written to a sidecar next to the history store the first time a rung is
# applied, and `release` restores from it. The file is the ladder's memory: without it this is a
# one-way trip that reports success.
#
# SUSPEND COUNTS, TOO. SuspendThread keeps a PER-THREAD counter, so two suspends need two resumes.
# The first version resumed once regardless, which left a doubly-suspended process frozen while the
# tool reported "every rung reversed". The sidecar records the depth and `release` unwinds all of it.
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
  # BOTH FUNCTIONS RETURN THE PREVIOUS SUSPEND COUNT, and that distinction was being thrown away.
  # ResumeThread on a thread that was never suspended returns 0 and succeeds - so counting "not
  # negative" as done reported "resumed 12 thread-handles" for a process nothing had ever frozen.
  # A count of work that did not happen is worse than no count, because it reads as evidence.
  # `done` now means SOMETHING ACTUALLY CHANGED: a suspend that took, or a resume that decremented
  # a real suspension. `touched` keeps the old meaning for the cases that want it.
  $done = 0; $failed = 0; $touched = 0
  foreach ($t in $proc.Threads) {
    $h = [VitalsQ.Native]::OpenThread($THREAD_SUSPEND_RESUME, $false, $t.Id)
    if ($h -eq [IntPtr]::Zero) { $failed++; continue }
    try {
      $r = if ($mode -eq 'suspend') { [VitalsQ.Native]::SuspendThread($h) } else { [VitalsQ.Native]::ResumeThread($h) }
      if ($r -lt 0) { $failed++ }
      else {
        $touched++
        if ($mode -eq 'suspend') { $done++ }
        elseif ($r -gt 0) { $done++ }     # it really was suspended, and is now one level less
      }
    } finally { [void][VitalsQ.Native]::CloseHandle($h) }
  }
  return @{ done = $done; failed = $failed; touched = $touched }
}

function Fail($why) { @{ ok = $false; error = $why } | ConvertTo-Json -Compress; exit 1 }

# The ladder's memory. Keyed by pid AND process start time, because pids are reused: restoring a
# priority captured from a process that has since exited onto whatever now holds that pid would be
# a change to an innocent bystander.
$StateDir = Join-Path $PSScriptRoot 'history'
$StateFile = Join-Path $StateDir 'quarantine-state.json'

# Entries whose process is gone are dropped on the way past. A process that exits without `release`
# would otherwise leave its record forever, and the file only ever grows. Pruning on read costs one
# Get-Process per entry on a file that holds a handful of rows at most.
function Prune-Ladder($h) {
  $live = @{}
  foreach ($k in @($h.Keys)) {
    $pidPart = ($k -split '\|')[0]
    $alive = $false
    try { $alive = $null -ne (Get-Process -Id ([int]$pidPart) -ErrorAction Stop) } catch { $alive = $false }
    if ($alive) { $live[$k] = $h[$k] }
  }
  return $live
}

function Read-Ladder {
  if (-not (Test-Path $StateFile)) { return @{} }
  # Prune-Ladder below returns the live subset; if anything was dropped it is written back here.
  # Pruning that is not persisted is not pruning - the file grows forever and every read pays for
  # the same dead rows again.
  try {
    $raw = Get-Content -LiteralPath $StateFile -Raw -ErrorAction Stop
    if (-not $raw.Trim()) { return @{} }
    $o = $raw | ConvertFrom-Json
    $h = @{}
    foreach ($k in $o.PSObject.Properties.Name) { $h[$k] = $o.$k }
    $live = Prune-Ladder $h
    if ($live.Count -ne $h.Count) { [void](Write-Ladder $live) }
    return $live
  } catch { return @{} }
}

# RETURNS WHETHER IT ACTUALLY WROTE. The first version swallowed every error in a bare `catch {}`,
# which meant a read-only history\ folder, a full disk or a locked file produced exactly the failure
# this whole sidecar exists to prevent: the rung was applied, the memory was not written, `ok:true`
# was returned, and the process stayed de-prioritised forever. Caught in review by chmod-ing the
# file - Idle went to BelowNormal and `release` then reported `restoredFrom: null` and changed
# nothing. An undo that depends on a write must not proceed when the write failed.
function Write-Ladder($h) {
  try {
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
    ($h | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $StateFile -Encoding utf8 -ErrorAction Stop
    return $true
  } catch { return $false }
}

# pid alone is not an identity. Start time makes the key survive pid reuse.
function Ladder-Key($proc) {
  $st = try { $proc.StartTime.ToUniversalTime().ToString('o') } catch { 'unknown' }
  return "$($proc.Id)|$st"
}

# Capture the ORIGINAL exactly once. A second rung must not overwrite the first rung's memory with
# the state the first rung produced - that is how "restore" comes to mean "restore to de-prioritised".
function Remember-Original($proc) {
  $lad = Read-Ladder
  $key = Ladder-Key $proc
  if (-not $lad.ContainsKey($key)) {
    $lad[$key] = @{
      name = $proc.ProcessName
      priority = "$($proc.PriorityClass)"
      affinity = [int64]$proc.ProcessorAffinity
      suspendDepth = 0
      at = (Get-Date).ToString('o')
    }
    # NO MEMORY, NO RUNG. Refusing to act is the only honest response to being unable to record how
    # to undo the action - the alternative is a one-way change that reports success.
    if (-not (Write-Ladder $lad)) {
      Fail "could not record this process's original state to $StateFile, so the change was NOT made - a rung that cannot be written down cannot be climbed back down. Check that the history folder is writable and has space."
    }
  }
  return $lad[$key]
}

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
# PRUNE ON EVERY RUN, not only when something happens to read the ladder. The first version pruned
# inside Read-Ladder, which meant `state` - the action the panel calls constantly and the only one
# that never touches the sidecar - never triggered it, and a process that died while fenced left its
# row forever. Verified: a dead pid's key survived every `state` call until this moved out here.
[void](Read-Ladder)

$out = @{ ok = $true; pid = $TargetPid; name = $p.ProcessName; action = $Action; cores = $cpuCount }

switch ($Action) {

  'state' {
    # Reports the CURRENT state for the panel. It is not what `release` restores from - that comes
    # from the sidecar, written by Remember-Original at the moment a rung is applied. The comment
    # that used to sit here said otherwise, and describing the returned values as the thing `release`
    # uses is exactly how the original bug survived: nothing kept them.
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
    [void](Remember-Original $p)
    $out.was = "$($p.PriorityClass)"
    $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
    $out.now = 'BelowNormal'
    $out.note = 'still running on every core; it now yields whenever anything else wants one'
  }

  'affinity' {
    if ($Cores -lt 1) { Fail 'need at least one core' }
    if ($Cores -ge $cpuCount) { Fail "restricting to $Cores of $cpuCount cores would not fence anything" }
    [void](Remember-Original $p)
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
    [void](Remember-Original $p)
    $r = Invoke-Threads $p 'suspend'
    if ($r.done -eq 0) { Fail "could not suspend any of $($p.Threads.Count) threads — the process is probably protected" }
    # Record the DEPTH. SuspendThread increments a per-thread counter, so two suspends need two
    # resumes; without this a second suspend strands the process behind a single release.
    $lad = Read-Ladder; $key = Ladder-Key $p
    if ($lad.ContainsKey($key)) {
      $lad[$key].suspendDepth = [int]$lad[$key].suspendDepth + 1
      # [void], because Write-Ladder now RETURNS a bool and a bare call emits it into the pipeline -
      # which put a literal `True` on stdout ahead of the JSON and broke every caller that parses it.
      # A function that gained a return value turns every existing bare call into an output bug.
      [void](Write-Ladder $lad)
      $out.suspendDepth = $lad[$key].suspendDepth
    }
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
    $lad = Read-Ladder
    $key = Ladder-Key $p
    $orig = if ($lad.ContainsKey($key)) { $lad[$key] } else { $null }

    # UNWIND EXACTLY THE DEPTH WE RECORDED - AND NOTHING WHEN WE RECORDED NOTHING.
    # The first version defaulted the depth to 1 and resumed unconditionally, which is wrong twice.
    # It fabricated the claim ("resumed 12 thread-handles" for a process never suspended, because
    # ResumeThread succeeds on an unsuspended thread), and worse, on a process frozen by SOMETHING
    # ELSE - a debugger, another tool - a bare `release` would have decremented that suspension.
    # This file's whole thesis is that an undo which does not restore what was there is a second
    # change wearing the name of a reversal; resuming a process we never suspended is exactly that.
    $depth = if ($orig) { [int]$orig.suspendDepth } else { 0 }
    $resumed = 0
    for ($i = 0; $i -lt $depth; $i++) { $resumed += (Invoke-Threads $p 'resume').done }
    if ($depth -gt 0) {
      $undone += "resumed $resumed thread-handles across $depth level(s)"
    } elseif (-not $orig) {
      $undone += 'no suspension was recorded for this process, so no threads were resumed'
    }

    if ($orig) {
      try {
        $p.ProcessorAffinity = [IntPtr][int64]$orig.affinity
        $undone += "affinity restored to the mask it had ($($orig.affinity))"
      } catch {}
      try {
        $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::($orig.priority)
        $undone += "priority restored to $($orig.priority)"
      } catch {}
      $lad.Remove($key) | Out-Null
      [void](Write-Ladder $lad)
      $out.restoredFrom = 'the recorded original'
    } else {
      # NO RECORD MEANS NO RESTORE. Guessing Normal/all-cores here is what the old version did, and
      # it is a change, not an undo - so it says so instead of doing it.
      $out.restoredFrom = $null
      $undone += 'no original was recorded for this process, so priority and affinity were left exactly as they are'
    }
    $out.undone = $undone
    $out.note = if ($orig) { 'every rung reversed to its recorded original' }
                else { 'nothing was changed - this process has no record here, so there is nothing to undo' }
  }
}

$out | ConvertTo-Json -Depth 5 -Compress
