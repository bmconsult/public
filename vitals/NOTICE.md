# Third-party notices

VITALS bundles no npm packages and ships no third-party source. It redistributes exactly three
binaries, all from Microsoft.

## Microsoft Edge WebView2

| File | Version | What it is |
|---|---|---|
| `lib/Microsoft.Web.WebView2.Core.dll` | 1.0.3240.44 | Managed wrapper around the WebView2 runtime |
| `lib/Microsoft.Web.WebView2.WinForms.dll` | 1.0.3240.44 | The WinForms control that hosts it |
| `lib/WebView2Loader.dll` | 1.0.3240.44 | Native loader — resolves the installed WebView2 runtime |

All three are taken unmodified from the `Microsoft.Web.WebView2` NuGet package, version
**1.0.3240.44**, and each carries a valid Authenticode signature from `CN=Microsoft Corporation`.
Verified by hash against the published package rather than by assumption: the managed assemblies
come from `lib/net462/` and the loader from `runtimes/win-x64/native/`.

*(Provenance note, since this is the kind of claim worth being able to check: an earlier build paired
a 1.0.3179.45 loader with 1.0.3240.44 managed assemblies. It worked, but mismatched pairs are the
usual cause of "Couldn't find WebView2 Runtime" reports on other people's machines, so the loader was
replaced with the one from the matching package and the host re-tested before release.)*

### Licence

The package is distributed under the following terms, reproduced here in full because binary
redistribution requires it:

```
Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * The name of Microsoft Corporation, or the names of its contributors
may not be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

These terms govern those three files. The rest of VITALS is under Apache-2.0 — see `LICENSE`.

To be explicit about the third condition: VITALS names Microsoft and WebView2 only to state what it
depends on. Nothing here is an endorsement by Microsoft, implied or otherwise.

The WebView2 package also ships a `NOTICE.txt` covering open-source material incorporated into
Microsoft's own components; Microsoft makes that source available at
`https://3rdpartysource.microsoft.com`.

### Why these are bundled at all

The WebView2 *runtime* is not bundled — that ships with Windows 11 and with modern Edge, and VITALS
uses whatever is installed. Only the loader and wrappers are here, because PowerShell cannot resolve
them from a NuGet package at runtime.

`WebView2Loader.dll` is **x64 only**. On ARM64 Windows the native host cannot load, and VITALS falls
back to a browser window — stated in `INSTALL.md` and detected explicitly in `launch.ps1` rather than
discovered as a window that never appears.

## Node.js

The portable bundles include an unmodified **Node.js v24.18.1** runtime, downloaded from
`nodejs.org` and verified against the project's published `SHASUMS256.txt` at build time. Node.js is
Copyright OpenJS Foundation and contributors, and is distributed under the MIT licence — see
`LICENSE` inside the Node distribution, or <https://github.com/nodejs/node/blob/main/LICENSE>.

Installs that use a system Node bundle nothing and this section does not apply to them.

## Everything else

The collectors, the bridge, the diagnosis engine, the panel and the MCP server are original work
using only the Node.js and .NET standard libraries, PowerShell, and the operating system's own
interfaces. There is no `node_modules` directory and nothing creates one.

The network speed test transfers data against `speed.cloudflare.com` when you press the button. It is
the only outbound connection VITALS makes, and no data about your machine is sent with it.
