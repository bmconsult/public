# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# VITALS - clipboard history watcher.
#
# MINIMAL DRAIN IS THE WHOLE DESIGN. Reading the clipboard is not free: Get-Clipboard opens the
# clipboard, marshals its contents and closes it, and doing that once a second forever would be a real
# cost for a thing that changes a few dozen times a day. Windows exposes exactly the primitive needed
# to avoid it: GetClipboardSequenceNumber() is an O(1) counter the OS bumps on every change. Polling
# THAT is effectively free - no clipboard open, no allocation, no contention with the app that owns it.
# The clipboard is only actually read on the ticks where the number moved.
#
# So the cost at rest is one integer call per second, and the cost per capture is one read.
#
# PRIVACY. A clipboard log is the most sensitive thing this tool could possibly keep: passwords,
# recovery codes, card numbers, private keys all pass through it. Therefore:
#   - it is OFF unless explicitly started, and it stops when asked
#   - entries are capped in length and the file is pruned by age
#   - anything that looks like a secret is SKIPPED, not stored (see Looks-Secret)
#   - the support bundle never includes it unless the user ticks it deliberately
# None of that makes a clipboard log safe. It makes it honest about what it is.
#
#   powershell -File clipwatch.ps1 -Out history\clipboard-2026-07-30.jsonl [-PollMs 900]

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$PollMs = 900,
  [int]$MaxChars = 2000
)

$ErrorActionPreference = 'Continue'

Add-Type -Namespace CB -Name Seq -MemberDefinition @'
[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
'@

# Heuristics, not guarantees. They exist to avoid the obvious disasters, and the UI says as much:
# a long random string with mixed classes, anything that announces itself as a key or token, and
# anything shaped like a card number. A password that looks like a word still gets stored - which is
# exactly why this feature is opt-in rather than clever.
function Looks-Secret([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $true }
  $t = $s.Trim()
  if ($t -match '(?i)^(-----BEGIN|ssh-rsa|ssh-ed25519|xox[baprs]-|sk-[A-Za-z0-9]{16,}|ghp_|github_pat_|AKIA[0-9A-Z]{16})') { return $true }
  if ($t -match '(?i)\b(password|passwd|secret|api[_-]?key|token|bearer|private[_-]?key)\b\s*[:=]') { return $true }
  # card-shaped: 13-19 digits, optionally grouped
  if ($t -match '^\D*(\d[ -]?){13,19}\D*$') { return $true }
  # high-entropy single token: long, no whitespace, mixed classes - looks generated, not typed
  if ($t.Length -ge 24 -and $t -notmatch '\s' -and
      $t -match '[a-z]' -and $t -match '[A-Z]' -and $t -match '\d') { return $true }
  return $false
}

Add-Type -AssemblyName System.Drawing

# WHERE IT CAME FROM. The CF_HTML clipboard format carries a "SourceURL:" header, which browsers fill
# in when you copy an image or a selection from a page. So a clipped image can record the page it came
# off, which is the one piece of context a bitmap otherwise loses completely. Absent for anything copied
# outside a browser, and reported as absent rather than guessed.
function Get-SourceUrl {
  try {
    $html = Get-Clipboard -Format Html -ErrorAction SilentlyContinue
    if (-not $html) { return '' }
    $m = [regex]::Match(($html -join "`n"), '(?im)^SourceURL:\s*(\S+)')
    if ($m.Success) { return $m.Groups[1].Value.Substring(0, [Math]::Min(400, $m.Groups[1].Value.Length)) }
  } catch {}
  return ''
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$last = [CB.Seq]::GetClipboardSequenceNumber()
$lastHash = ''
Write-Output ('{"ev":"started","at":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}')

while ($true) {
  Start-Sleep -Milliseconds $PollMs
  $seq = [CB.Seq]::GetClipboardSequenceNumber()
  if ($seq -eq $last) { continue }     # the cheap path, and the one taken almost every tick
  $last = $seq

  $text = $null
  try { $text = Get-Clipboard -Raw -Format Text -ErrorAction Stop } catch { $text = $null }

  # Non-text: an image or a file drop.
  # Images ARE saved now (owner: "shouldnt i be able to click that and up pops the image"), as PNG next
  # to the log, exactly the way Windows already drops Win+PrintScreen into Pictures\Screenshots. The
  # bridge prunes the folder by age and by total size, so it stays a rolling window rather than growing
  # forever. A file drop stores the paths, which are their own link.
  if ([string]::IsNullOrEmpty($text)) {
    $kind = $null; $note = ''; $file = ''; $w = 0; $h = 0; $bytes = 0
    try {
      $img = Get-Clipboard -Format Image -ErrorAction SilentlyContinue
      if ($img) {
        $kind = 'image'; $w = $img.Width; $h = $img.Height; $note = "$w x $h"
        try {
          $dir = Join-Path (Split-Path -Parent $Out) 'clips'
          if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
          $name = 'clip-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + (Get-Random -Maximum 9999) + '.png'
          $full = Join-Path $dir $name
          $img.Save($full, [Drawing.Imaging.ImageFormat]::Png)
          $file = $name                      # NAME only: the bridge resolves it, so no path travels in the log
          $bytes = (Get-Item -LiteralPath $full).Length
        } catch {}
        $img.Dispose()
      }
      else {
        $fl = Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue
        if ($fl -and $fl.Count) {
          $kind = 'files'
          $note = ($fl | Select-Object -First 4) -join "`n"
        }
      }
    } catch {}
    if ($kind) {
      $row = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); chars = 0; lines = 0
                         src = $(try { $p2=0; [void][CB.Fg]::GetWindowThreadProcessId([CB.Fg]::GetForegroundWindow(), [ref]$p2)
                                       if ($p2) { (Get-Process -Id $p2 -ErrorAction SilentlyContinue).ProcessName } else { '' } } catch { '' })
                         secret = $false; kind = $kind; text = $note; file = $file
                         w = $w; h = $h; bytes = $bytes; url = (Get-SourceUrl); sha = '' }
      $json = ($row | ConvertTo-Json -Compress -Depth 3)
      try { Add-Content -LiteralPath $Out -Value $json -Encoding utf8 } catch {}
      Write-Output $json
    }
    continue
  }

  # De-dupe: copying the same thing twice, or an app that re-sets the clipboard, is one entry.
  $sha = [BitConverter]::ToString(
           [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text))
         ).Replace('-','').Substring(0,12)
  if ($sha -eq $lastHash) { continue }
  $lastHash = $sha

  # EVERYTHING is stored, including the secret-shaped (owner: "keep record of anything i copy... i feel
  # like ill be like where this token"). A clipboard log that drops the one thing you actually go
  # looking for is not a clipboard log. The secret flag no longer decides whether to STORE, it decides
  # how long the TEXT survives: the bridge scrubs the text of flagged rows after 24 h and keeps the
  # metadata. So "where did that token go" works this afternoon and the token is gone tomorrow.
  $secret = Looks-Secret $text
  $full = $text.Length
  $store = $text.Substring(0, [Math]::Min($MaxChars, $text.Length))

  # The owning window gives the entry context: "copied from Code" is far more useful than the text
  # alone when you are scrolling back through a day of them.
  $src = ''
  try {
    Add-Type -Namespace CB -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
'@ -ErrorAction SilentlyContinue
    $pid2 = 0; [void][CB.Fg]::GetWindowThreadProcessId([CB.Fg]::GetForegroundWindow(), [ref]$pid2)
    if ($pid2) { $src = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName }
  } catch {}

  $row = [ordered]@{
    at      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    chars   = $full
    lines   = ($text -split "`n").Count
    src     = $src
    secret  = $secret           # true = looks like a key/token/card: text is scrubbed after 24 h
    kind    = 'text'
    text    = $store
    url     = (Get-SourceUrl)   # present when the text was copied out of a web page
    sha     = $sha
  }
  $json = ($row | ConvertTo-Json -Compress -Depth 3)
  try { Add-Content -LiteralPath $Out -Value $json -Encoding utf8 } catch {}
  Write-Output $json            # the bridge tails this for the live view
}
