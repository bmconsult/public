# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - the three file tools, one script.
#
#   -Mode big     largest files under a root
#   -Mode new     files written most recently under a root ("what did that installer touch?")
#   -Mode locked  WHO has this file open
#
# BIG and NEW share one walker on purpose. Both questions are "enumerate a tree and rank it", and the
# expensive part is the enumeration, not the ranking. Two laws from the earlier disk work are baked in:
#   - DirectoryInfo.EnumerateFiles() yields FileInfo with Length ALREADY populated from the directory
#     entry. Directory.EnumerateFiles() yields strings and every [FileInfo] cast costs a stat syscall:
#     measured 4.2x slower over the same tree.
#   - Skip reparse points or AppData\Local\Application Data (a junction to its own parent) recurses
#     forever, and try/catch every enumeration because .NET Framework has no IgnoreInaccessible and one
#     protected directory otherwise aborts the entire walk.
#
# LOCKED uses the Restart Manager (rstrtmgr.dll), which is what Windows itself uses when an installer
# says "these applications are using files that need to be updated". It is the correct API for this and
# it needs no admin for the user's own files - unlike handle.exe, which needs both a download and
# elevation. It answers with the actual owning processes rather than a guess.

param(
  [ValidateSet('big','new','locked')][string]$Mode = 'big',
  [string]$Root = "$env:USERPROFILE",
  [string]$Path = '',
  [int]$Top = 40,
  [int]$Minutes = 60,
  [int]$MaxSeconds = 20
)

$ErrorActionPreference = 'Continue'

function Walk {
  param([string]$root, [int]$maxSec)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = New-Object Collections.Generic.List[object]
  $stack = New-Object Collections.Stack
  try { $stack.Push((New-Object IO.DirectoryInfo $root)) } catch { return @{ files = $out; truncated = $false; err = "$_" } }
  $truncated = $false
  while ($stack.Count) {
    if ($sw.Elapsed.TotalSeconds -gt $maxSec) { $truncated = $true; break }
    $d = $stack.Pop()
    try { foreach ($f in $d.EnumerateFiles()) { $out.Add($f) } } catch {}
    try {
      foreach ($sd in $d.EnumerateDirectories()) {
        if (-not ($sd.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $stack.Push($sd) }
      }
    } catch {}
  }
  @{ files = $out; truncated = $truncated; secs = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}

switch ($Mode) {

  'big' {
    $w = Walk -root $Root -maxSec $MaxSeconds
    $rows = $w.files | Sort-Object -Property Length -Descending | Select-Object -First $Top |
      ForEach-Object { @{ path = $_.FullName; mb = [math]::Round($_.Length / 1MB, 1)
                          at = $_.LastWriteTime.ToString('s'); ext = $_.Extension } }
    @{ mode = 'big'; root = $Root; scanned = $w.files.Count; truncated = $w.truncated; secs = $w.secs
       rows = @($rows) } | ConvertTo-Json -Depth 4 -Compress
  }

  'new' {
    $cut = (Get-Date).AddMinutes(-$Minutes)
    $w = Walk -root $Root -maxSec $MaxSeconds
    $rows = $w.files | Where-Object { $_.LastWriteTime -gt $cut } |
      Sort-Object -Property LastWriteTime -Descending | Select-Object -First $Top |
      ForEach-Object { @{ path = $_.FullName; mb = [math]::Round($_.Length / 1MB, 2)
                          at = $_.LastWriteTime.ToString('s'); ext = $_.Extension } }
    @{ mode = 'new'; root = $Root; minutes = $Minutes; scanned = $w.files.Count
       truncated = $w.truncated; secs = $w.secs; rows = @($rows) } | ConvertTo-Json -Depth 4 -Compress
  }

  'locked' {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
      @{ mode = 'locked'; err = 'file not found'; path = $Path } | ConvertTo-Json -Compress; break
    }
    Add-Type -Namespace RM -Name Api -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint dwLowDateTime; public uint dwHighDateTime; }
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct RM_UNIQUE_PROCESS { public int dwProcessId; public FILETIME ProcessStartTime; }
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct RM_PROCESS_INFO {
  public RM_UNIQUE_PROCESS Process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string strAppName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string strServiceShortName;
  public int ApplicationType; public uint AppStatus; public uint TSSessionId;
  [MarshalAs(UnmanagedType.Bool)] public bool bRestartable; }
[DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, System.Text.StringBuilder strSessionKey);
[DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint pSessionHandle);
[DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);
[DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In,Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
'@
    $key = New-Object Text.StringBuilder 256
    $sess = 0
    $rc = [RM.Api]::RmStartSession([ref]$sess, 0, $key)
    if ($rc -ne 0) { @{ mode='locked'; err="RmStartSession failed ($rc)" } | ConvertTo-Json -Compress; break }
    try {
      $rc = [RM.Api]::RmRegisterResources($sess, 1, @($Path), 0, [IntPtr]::Zero, 0, $null)
      if ($rc -ne 0) { @{ mode='locked'; err="RmRegisterResources failed ($rc)" } | ConvertTo-Json -Compress; break }
      [uint32]$need = 0; [uint32]$have = 0; [uint32]$reason = 0
      $rc = [RM.Api]::RmGetList($sess, [ref]$need, [ref]$have, $null, [ref]$reason)
      # 234 = ERROR_MORE_DATA, which is the expected first answer: it tells us how many to allocate.
      if ($rc -eq 234 -and $need -gt 0) {
        $arr = New-Object 'RM.Api+RM_PROCESS_INFO[]' $need
        $have = $need
        $rc = [RM.Api]::RmGetList($sess, [ref]$need, [ref]$have, $arr, [ref]$reason)
        if ($rc -eq 0) {
          $rows = @()
          for ($i = 0; $i -lt $have; $i++) {
            $pi = $arr[$i]
            $p = Get-Process -Id $pi.Process.dwProcessId -ErrorAction SilentlyContinue
            $rows += @{ pid = $pi.Process.dwProcessId
                        name = if ($p) { $p.ProcessName } else { $pi.strAppName }
                        app = $pi.strAppName; service = $pi.strServiceShortName
                        restartable = $pi.bRestartable
                        mb = if ($p) { [math]::Round($p.WorkingSet64 / 1MB, 0) } else { $null } }
          }
          @{ mode='locked'; path=$Path; count=$rows.Count; rows=@($rows) } | ConvertTo-Json -Depth 4 -Compress
        } else { @{ mode='locked'; err="RmGetList failed ($rc)" } | ConvertTo-Json -Compress }
      } elseif ($rc -eq 0) {
        # Genuinely nobody has it open. Distinct from an error, and the UI says so.
        @{ mode='locked'; path=$Path; count=0; rows=@() } | ConvertTo-Json -Compress
      } else {
        @{ mode='locked'; err="RmGetList failed ($rc)" } | ConvertTo-Json -Compress
      }
    } finally { [void][RM.Api]::RmEndSession($sess) }
  }
}
