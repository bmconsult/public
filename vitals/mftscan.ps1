# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS — MFT scanner.  REQUIRES ADMINISTRATOR (raw volume handle).
#
# Parses the NTFS Master File Table directly instead of walking the filesystem. This is what WizTree
# does and why it maps a 476 GB drive in seconds: the MFT is one mostly-contiguous file containing a
# record for EVERY file and directory on the volume, so reading it is a few large sequential reads
# instead of millions of per-file syscalls.
#
#   .\mftscan.ps1                      # scan C:, write snapshot
#   .\mftscan.ps1 -Drive D             # another volume
#   .\mftscan.ps1 -Verify              # cross-check totals against a real directory walk
#
# Output: history\mft-<drive>-<yyyyMMdd-HHmmss>.json   — every directory with its recursive total.
# The bridge reads the newest snapshot; diffing two snapshots is what answers "what grew".

param(
  [string]$Drive = 'C',
  [string]$OutDir,
  [switch]$Verify,
  [switch]$CheckOnly,      # compile the parser and exit — validates the code without needing admin
  [int]$MinMB = 1          # omit directories under this from the snapshot (keeps the file small)
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = Join-Path $here 'history' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public class MftScanner {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sec,
                                           uint disp, uint flags, IntPtr templ);

  const uint GENERIC_READ = 0x80000000, FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;

  public class Dir {
    public long Parent;         // MFT record number of parent
    public string Name;
    public long OwnBytes;       // bytes of files directly inside
    public long TotalBytes;     // filled in during aggregation
    public bool Seen;
  }

  public Dictionary<long, Dir> Dirs = new Dictionary<long, Dir>();
  public long FileCount, DirCount, TotalBytes, AllocBytes;
  public string Error;

  // ---- NTFS geometry, read from the boot sector ----
  int bytesPerSector, sectorsPerCluster, bytesPerCluster, bytesPerRecord;
  long mftLcn;

  static ushort U16(byte[] b, int o) { return BitConverter.ToUInt16(b, o); }
  static uint   U32(byte[] b, int o) { return BitConverter.ToUInt32(b, o); }
  static long   U64(byte[] b, int o) { return BitConverter.ToInt64(b, o); }

  /* Every multi-sector NTFS structure is protected by an Update Sequence Array: the last two bytes
     of each sector are replaced by a check value, and the originals are stashed in the USA. If you
     skip this fixup you read corrupt bytes at every sector boundary — silently, and only for large
     records, which is the worst possible failure mode. */
  static bool ApplyFixup(byte[] rec, int offset, int length, int sectorSize) {
    int usaOff = U16(rec, offset + 0x04);
    int usaCnt = U16(rec, offset + 0x06);
    if (usaCnt == 0 || usaOff + usaCnt * 2 > length) return false;
    ushort usn = U16(rec, offset + usaOff);
    for (int i = 1; i < usaCnt; i++) {
      int tail = offset + i * sectorSize - 2;
      if (tail + 1 >= offset + length) return false;
      if (U16(rec, tail) != usn) return false;                 // torn record — refuse it
      Buffer.BlockCopy(rec, offset + usaOff + i * 2, rec, tail, 2);
    }
    return true;
  }

  // Decode an NTFS data-run list into (startLcn, clusterCount) pairs.
  static List<long[]> ParseRuns(byte[] b, int off, int end) {
    var runs = new List<long[]>();
    long lcn = 0;
    while (off < end) {
      byte hdr = b[off];
      if (hdr == 0) break;
      int lenSz = hdr & 0x0F, offSz = (hdr >> 4) & 0x0F;
      if (lenSz == 0 || off + 1 + lenSz + offSz > end) break;
      off++;
      long len = 0;
      for (int i = 0; i < lenSz; i++) len |= (long)b[off + i] << (8 * i);
      off += lenSz;
      if (offSz > 0) {
        long d = 0;
        for (int i = 0; i < offSz; i++) d |= (long)b[off + i] << (8 * i);
        // the run offset is SIGNED and relative to the previous run's LCN
        long sign = 1L << (offSz * 8 - 1);
        if ((d & sign) != 0) d -= (1L << (offSz * 8));
        lcn += d;
        off += offSz;
        runs.Add(new long[] { lcn, len });
      } else {
        off += offSz;                                          // sparse run — occupies no clusters
        runs.Add(new long[] { -1, len });
      }
    }
    return runs;
  }

  public bool Scan(char drive) {
    try {
      using (var h = CreateFileW(@"\\.\" + drive + ":", GENERIC_READ,
                                 FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero,
                                 OPEN_EXISTING, 0, IntPtr.Zero)) {
        if (h.IsInvalid) { Error = "CreateFile failed: " + Marshal.GetLastWin32Error() + " (need admin)"; return false; }
        using (var fs = new FileStream(h, FileAccess.Read)) {

          // ---- boot sector ----
          var boot = new byte[512];
          fs.Read(boot, 0, 512);
          if (boot[3] != (byte)'N' || boot[4] != (byte)'T') { Error = "not an NTFS volume"; return false; }
          bytesPerSector    = U16(boot, 0x0B);
          sectorsPerCluster = boot[0x0D];
          bytesPerCluster   = bytesPerSector * sectorsPerCluster;
          mftLcn            = U64(boot, 0x30);
          sbyte cpr         = (sbyte)boot[0x40];
          bytesPerRecord    = cpr > 0 ? cpr * bytesPerCluster : 1 << (-cpr);
          if (bytesPerRecord <= 0 || bytesPerRecord > 1 << 20) { Error = "bad record size"; return false; }

          // ---- record 0 is $MFT itself; its $DATA runs tell us where the whole table lives ----
          var rec0 = new byte[bytesPerRecord];
          fs.Seek(mftLcn * bytesPerCluster, SeekOrigin.Begin);
          fs.Read(rec0, 0, bytesPerRecord);
          if (!ApplyFixup(rec0, 0, bytesPerRecord, bytesPerSector)) { Error = "$MFT record fixup failed"; return false; }

          List<long[]> mftRuns = null;
          long mftSize = 0;
          int ao = U16(rec0, 0x14);
          while (ao + 8 < bytesPerRecord) {
            uint type = U32(rec0, ao);
            if (type == 0xFFFFFFFF) break;
            int alen = (int)U32(rec0, ao + 4);
            if (alen <= 0) break;
            if (type == 0x80) {                                  // $DATA
              if (rec0[ao + 8] != 0) {                           // non-resident
                mftSize  = U64(rec0, ao + 0x30);                 // real size
                int rOff = U16(rec0, ao + 0x20);
                mftRuns  = ParseRuns(rec0, ao + rOff, ao + alen);
              }
              break;
            }
            ao += alen;
          }
          if (mftRuns == null || mftSize <= 0) { Error = "could not locate $MFT data runs"; return false; }

          long totalRecords = mftSize / bytesPerRecord;

          /* Per-record arrays rather than dictionaries: 1.4M+ files, and record numbers are dense,
             so flat arrays are both smaller and faster than hashing every lookup.

             ATTRIBUTE LISTS are the reason sizes are keyed by record and resolved afterwards.
             When a file's attributes outgrow its 1 KB MFT record they spill into EXTENSION records,
             and $DATA moves with them. The base record then holds only an $ATTRIBUTE_LIST. Reading
             only base records therefore scores every heavily-fragmented file as ZERO — which is
             precisely the set of large files that matter. An extension record names its owner at
             offset 0x20, so we attribute its $DATA back to the base and resolve parents in a second
             pass, once every base record's $FILE_NAME has been seen. */
          var parentOf = new long[totalRecords + 1];
          var realOf   = new long[totalRecords + 1];
          var allocOf  = new long[totalRecords + 1];
          for (long i = 0; i <= totalRecords; i++) parentOf[i] = -1;

          const int CHUNK = 8 * 1024 * 1024;
          int recsPerChunk = CHUNK / bytesPerRecord;
          var buf = new byte[recsPerChunk * bytesPerRecord];
          var ownBytes = new Dictionary<long, long>();

          long recIndex = 0;
          foreach (var run in mftRuns) {
            if (run[0] < 0) { recIndex += run[1] * bytesPerCluster / bytesPerRecord; continue; }
            long runBytes = run[1] * bytesPerCluster;
            long pos = run[0] * bytesPerCluster;
            long done = 0;
            while (done < runBytes && recIndex < totalRecords) {
              int want = (int)Math.Min(buf.Length, runBytes - done);
              want -= want % bytesPerRecord;
              if (want <= 0) break;
              fs.Seek(pos + done, SeekOrigin.Begin);
              int got = 0;
              while (got < want) { int n = fs.Read(buf, got, want - got); if (n <= 0) break; got += n; }
              if (got < bytesPerRecord) break;

              for (int off = 0; off + bytesPerRecord <= got; off += bytesPerRecord, recIndex++) {
                if (buf[off] != (byte)'F' || buf[off+1] != (byte)'I' ||
                    buf[off+2] != (byte)'L' || buf[off+3] != (byte)'E') continue;
                if (!ApplyFixup(buf, off, bytesPerRecord, bytesPerSector)) continue;
                ushort flags = U16(buf, off + 0x16);
                if ((flags & 0x01) == 0) continue;                // deleted
                bool isDir = (flags & 0x02) != 0;

                // Offset 0x20 is the BASE FILE RECORD reference: zero means this IS a base record,
                // non-zero means it is an extension holding attributes that overflowed from it.
                long baseRef = U64(buf, off + 0x20) & 0x0000FFFFFFFFFFFFL;
                long owner   = baseRef == 0 ? recIndex : baseRef;
                if (owner > totalRecords) continue;

                long parent = -1; string name = null; int bestNs = 99;

                int a = off + U16(buf, off + 0x14);
                while (a + 8 <= off + bytesPerRecord) {
                  uint type = U32(buf, a);
                  if (type == 0xFFFFFFFF) break;
                  int alen = (int)U32(buf, a + 4);
                  if (alen <= 0 || a + alen > off + bytesPerRecord) break;
                  bool nonRes = buf[a + 8] != 0;

                  if (type == 0x30) {                            // $FILE_NAME
                    int c = a + U16(buf, a + 0x14);
                    if (c + 0x42 <= off + bytesPerRecord) {
                      long pref = U64(buf, c) & 0x0000FFFFFFFFFFFFL;
                      int nlen = buf[c + 0x40];
                      int ns   = buf[c + 0x41];
                      // Prefer Win32 / Win32+DOS names over the 8.3 DOS alias.
                      if (ns != 2 && ns < bestNs && c + 0x42 + nlen * 2 <= off + bytesPerRecord) {
                        bestNs = ns;
                        name   = System.Text.Encoding.Unicode.GetString(buf, c + 0x42, nlen * 2);
                        parent = pref;
                      }
                    }
                  } else if (type == 0x80) {                      // $DATA
                    int nameLen = buf[a + 9];
                    if (nameLen == 0) {                            // unnamed stream only (skip ADS)
                      if (nonRes) {
                        /* Only the extent starting at VCN 0 carries the attribute's true sizes;
                           later extents repeat the header with StartingVCN > 0 and garbage there. */
                        if (U64(buf, a + 0x10) == 0) {
                          realOf[owner]  = U64(buf, a + 0x30);     // real size (what the user sees)
                          allocOf[owner] = U64(buf, a + 0x28);     // on-disk size (cluster-rounded)
                        }
                      } else {
                        long rs = U32(buf, a + 0x10);
                        realOf[owner] = rs; allocOf[owner] = rs;   // resident: lives in this record
                      }
                    }
                  }
                  a += alen;
                }

                if (baseRef == 0) {
                  if (isDir) {
                    DirCount++;
                    Dir d;
                    if (!Dirs.TryGetValue(recIndex, out d)) { d = new Dir(); Dirs[recIndex] = d; }
                    d.Name = name; d.Parent = parent; d.Seen = true;
                  } else if (parent >= 0) {
                    parentOf[recIndex] = parent;
                  }
                }
              }
              done += got;
            }
          }

          // ---- second pass: now that every base record's parent is known, attribute sizes ----
          for (long r = 0; r <= totalRecords; r++) {
            long sz = realOf[r];
            if (sz <= 0) continue;
            long par = parentOf[r];
            if (par < 0) continue;                                 // directory, or an orphan
            FileCount++; TotalBytes += sz; AllocBytes += allocOf[r];
            long cur; ownBytes.TryGetValue(par, out cur);
            ownBytes[par] = cur + sz;
          }

          foreach (var kv in ownBytes) {
            Dir d;
            if (!Dirs.TryGetValue(kv.Key, out d)) { d = new Dir(); Dirs[kv.Key] = d; }
            d.OwnBytes = kv.Value;
          }
          Aggregate();
          return true;
        }
      }
    } catch (Exception e) { Error = e.GetType().Name + ": " + e.Message; return false; }
  }

  /* Roll child totals into parents. Iterative, not recursive: directory depth is unbounded and a
     corrupted volume can even contain a parent cycle, which would blow the stack. */
  void Aggregate() {
    foreach (var kv in Dirs) kv.Value.TotalBytes = kv.Value.OwnBytes;
    var order = new List<long>(Dirs.Keys);
    var depth = new Dictionary<long, int>();
    foreach (var id in order) {
      int d = 0; long cur = id;
      var guard = new HashSet<long>();
      while (Dirs.ContainsKey(cur) && Dirs[cur].Parent >= 0 && Dirs[cur].Parent != cur && guard.Add(cur)) {
        cur = Dirs[cur].Parent; d++;
        if (d > 512) break;
      }
      depth[id] = d;
    }
    order.Sort((x, y) => depth[y].CompareTo(depth[x]));          // deepest first
    foreach (var id in order) {
      var d = Dirs[id];
      if (d.Parent >= 0 && d.Parent != id && Dirs.ContainsKey(d.Parent))
        Dirs[d.Parent].TotalBytes += d.TotalBytes;
    }
  }

  public string PathOf(long id) {
    var parts = new List<string>();
    long cur = id; int guard = 0;
    while (Dirs.ContainsKey(cur) && guard++ < 256) {
      var d = Dirs[cur];
      if (cur == 5) break;                                       // record 5 is the volume root
      if (string.IsNullOrEmpty(d.Name)) return null;
      parts.Add(d.Name);
      if (d.Parent < 0 || d.Parent == cur) break;
      cur = d.Parent;
    }
    parts.Reverse();
    return string.Join("\\", parts.ToArray());
  }
}
'@

if ($CheckOnly) {
  $s = New-Object MftScanner
  Write-Host "parser compiled OK — type MftScanner instantiated, $((([MftScanner]).GetMethods() | Where-Object { $_.DeclaringType.Name -eq 'MftScanner' }).Count) public methods" -ForegroundColor Green
  exit 0
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Error "mftscan requires Administrator (it opens \\.\$Drive`: directly). Run from an admin prompt, or use -CheckOnly to validate the parser."; exit 1 }

$sw = [Diagnostics.Stopwatch]::StartNew()
$s = New-Object MftScanner
Write-Host "reading `$MFT on $Drive`: …" -ForegroundColor DarkGray
if (-not $s.Scan([char]$Drive)) { Write-Error "MFT scan failed — $($s.Error)"; exit 1 }
$scanMs = $sw.ElapsedMilliseconds

$minBytes = $MinMB * 1MB
$rows = New-Object System.Collections.ArrayList
foreach ($kv in $s.Dirs.GetEnumerator()) {
  if ($kv.Value.TotalBytes -lt $minBytes) { continue }
  $p = $s.PathOf($kv.Key)
  if ($null -eq $p) { continue }
  [void]$rows.Add([PSCustomObject]@{
    path  = "$Drive`:\$p"
    bytes = $kv.Value.TotalBytes
    own   = $kv.Value.OwnBytes
  })
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $OutDir "mft-$Drive-$stamp.json"
[PSCustomObject]@{
  drive     = "$Drive`:"
  # Bump on ANY change to how sizes are computed. growth() refuses to diff across versions:
  # comparing a v1 snapshot (which missed attribute-list files) against v2 reported a fictional
  # +140 GB of "growth" that was purely the bug being fixed.
  scanner   = 2
  takenAt   = (Get-Date).ToString('o')
  scanMs    = $scanMs
  files     = $s.FileCount
  dirs      = $s.DirCount
  totalBytes= $s.TotalBytes
  allocBytes= $s.AllocBytes
  minMB     = $MinMB
  entries   = @($rows | Sort-Object bytes -Descending)
} | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $out -Encoding utf8

"{0} files / {1} dirs / {2} GB in {3} ms" -f $s.FileCount, $s.DirCount,
  [math]::Round($s.TotalBytes/1GB,1), $scanMs | Write-Host -ForegroundColor Green
Write-Host "snapshot → $out" -ForegroundColor Cyan

if ($Verify) {
  Write-Host "`n--- verification: MFT total vs a real directory walk ---" -ForegroundColor Yellow
  # The verification targets were hard-coded to one machine's account, which meant that on any other
  # machine both paths were ABSENT and the check silently verified nothing while still printing a
  # reassuring heading. Derived from the running user instead, with a fallback that exists on every
  # Windows install so there is always something real to walk.
  $verifyTargets = @(
    (Join-Path $env:USERPROFILE 'Downloads'),
    (Join-Path $env:USERPROFILE 'Documents')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if (-not $verifyTargets) { $verifyTargets = @("$Drive`:\Windows") }
  foreach ($t in $verifyTargets) {
    $m = ($rows | Where-Object { $_.path -eq $t } | Select-Object -First 1)
    $mftGB = if ($m) { [math]::Round($m.bytes/1GB,2) } else { 'ABSENT' }
    $walk = 0
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push($t)
    $RP = [System.IO.FileAttributes]::ReparsePoint
    while ($stack.Count -gt 0) {
      $d = $stack.Pop()
      try { foreach ($f in ([System.IO.DirectoryInfo]$d).EnumerateFiles()) { $walk += $f.Length } } catch {}
      try { foreach ($sd in ([System.IO.DirectoryInfo]$d).EnumerateDirectories()) {
              if (($sd.Attributes -band $RP) -ne $RP) { $stack.Push($sd.FullName) } } } catch {}
    }
    $walkGB = [math]::Round($walk/1GB,2)
    $delta = if ($m) { [math]::Round([math]::Abs($m.bytes - $walk)/1MB,1) } else { '—' }
    "{0,-46} MFT={1,8} GB  walk={2,8} GB  Δ={3} MB" -f $t, $mftGB, $walkGB, $delta | Write-Host
  }
}
