/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - WHERE POWERSHELL ACTUALLY IS.
 *
 * Everything Windows-side in VITALS runs through powershell.exe, and three separate files used to
 * name it three separate ways. start.js resolved it to an absolute path; bridge.js and
 * collect/win32.js passed the bare string and let PATH decide. That is one fix living in one file
 * while two callers keep the bug, which is the shape of every duplication problem.
 *
 * WHY THE BARE NAME IS NOT GOOD ENOUGH. powershell.exe does not live in System32 - it lives in
 * System32\WindowsPowerShell\v1.0\. Windows itself does not need that directory on PATH, so a
 * trimmed, truncated or replaced PATH leaves the binary present and unreachable. It looks like
 * "PowerShell is missing" and it is really "PATH is short". Found by running a portable build with
 * PATH cut to System32: the collector died with `spawn powershell.exe ENOENT` and, having no
 * 'error' handler, took the whole bridge down with it.
 *
 * WHY NOT FALL BACK TO pwsh. PowerShell 7 is a different runtime, not a newer one. These scripts
 * are written against Windows PowerShell 5.1 and at least one carries a documented 5.1-specific
 * quirk. Silently running them on pwsh would trade a loud failure for a quiet behaviour change,
 * and quiet behaviour changes are the expensive kind.
 */

const fs = require('fs');
const path = require('path');

function resolve() {
  if (process.platform !== 'win32') return 'powershell.exe';
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = [
    /* Sysnative FIRST, and only a 32-bit process ever sees it. If a 32-bit Node is running on
       64-bit Windows, "System32" is silently redirected to SysWOW64 by the filesystem redirector;
       Sysnative is the documented door back to the real one. On a 64-bit process the path does not
       exist, so it costs one failed stat. */
    path.join(root, 'Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe'),
    path.join(root, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* unreadable is as good as absent */ }
  }
  /* Last resort: let PATH try. It may well work, and a bare name produces a better error message
     than a made-up absolute path that was never going to exist. */
  return 'powershell.exe';
}

const PS = resolve();
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/* True when PS was found at a real location rather than guessed. Callers that want to explain a
   failure - rather than just suffer it - can say which of the two situations they are in. */
const PS_RESOLVED = PS !== 'powershell.exe';

module.exports = { PS, PS_ARGS, PS_RESOLVED };
