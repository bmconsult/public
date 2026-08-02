/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS ctl.js — the machine's own dials (2026-07-29).
 *
 * Discipline (owner's constraints, taken literally):
 *  - Every action here was WRITE-PROVEN unelevated on this machine first (probe-ctl.ps1,
 *    2026-07-29): powercfg /setactive, HKCU Personalize/DWM/Explorer-Advanced, SPI mouse
 *    speed/trails, own-process priority. Anything that failed the probe (HAGS: HKLM write
 *    denied) or whose apply-path is unverified (refresh rate — DEVMODE read came back zeroed;
 *    visual-effects preset; cursor/sound schemes; wallpaper — owned here by the BingWallpaper
 *    daemon, which would silently repaint over us) is NOT an action. It is listed on the CTRL
 *    page behind an honest label instead. A switch that can silently fail does not ship.
 *  - BASELINE FIRST: the first time any key is written, its prior value is captured to
 *    history/ctl-baseline.json — the machine as it was, bottled. /api/ctl/restore replays it.
 *  - EVERY PULL IS ON THE RECORD: history/control.jsonl gets {ts, act, params, before, snap}
 *    where snap is the live tick's cpu/ram/queue/faults at the moment of the pull. v1 records
 *    the moment; measured before/after deltas ride the outcomes-ledger pattern next pass.
 *  - The bridge stays unelevated forever. Elevation, when it comes, is a UAC one-shot like
 *    mftscan.ps1 — never this process.
 */
'use strict';
const fs = require('fs');
const path = require('path');
/* One selector for the system volume, shared with the engine. See snap() for why it is imported
   rather than written again. */
const { systemVolume } = require('./diagnose');

const BROADCAST = `
Add-Type -Name N -Namespace X -MemberDefinition '[DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);'
[UIntPtr]$rr=[UIntPtr]::Zero
[X.N]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'ImmersiveColorSet',2,2000,[ref]$rr)|Out-Null`;

const SPI = `
Add-Type -Name U -Namespace X2 -MemberDefinition '[DllImport("user32.dll",SetLastError=true)] public static extern bool SystemParametersInfo(uint a,uint b,IntPtr c,uint f);
[DllImport("user32.dll",SetLastError=true,EntryPoint="SystemParametersInfoW")] public static extern bool SystemParametersInfoRef(uint a,uint b,ref int c,uint f);'`;

/* Each action: validate(params) -> clean params or null; write(clean) -> PS script whose stdout
 * is JSON {ok:...}; readKey -> which field of state() holds this action's current value. */
const ACTS = {
  powerplan: {
    label: 'power plan', readKey: 'powerActive',
    validate: (b) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.guid || '') ? { guid: b.guid.toLowerCase() } : null,
    write: (p) => `powercfg /setactive ${p.guid}; @{ok=($LASTEXITCODE -eq 0)} | ConvertTo-Json -Compress`,
  },
  appsmode: {   // 1 = light, 0 = dark; sets apps + system together, like Settings' "choose your mode"
    label: 'windows mode', readKey: 'appsLight',
    validate: (b) => (b.light === 0 || b.light === 1) ? { light: b.light } : null,
    write: (p) => `
$pz='HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
Set-ItemProperty $pz AppsUseLightTheme ${p.light}
Set-ItemProperty $pz SystemUsesLightTheme ${p.light}
${BROADCAST}
@{ok=$true} | ConvertTo-Json -Compress`,
  },
  transparency: {
    label: 'shell transparency', readKey: 'transparency',
    validate: (b) => (b.on === 0 || b.on === 1) ? { on: b.on } : null,
    write: (p) => `
Set-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' EnableTransparency ${p.on}
${BROADCAST}
@{ok=$true} | ConvertTo-Json -Compress`,
  },
  accent: {     // DWM accent (window chrome). ABGR uint32. Partial by design: the full Settings
                // accent path (AccentPalette blob) is unverified — labeled on the page.
    label: 'accent colour', readKey: 'accentColor',
    validate: (b) => Number.isInteger(b.abgr) && b.abgr >= 0 && b.abgr <= 0xFFFFFFFF ? { abgr: b.abgr >>> 0 } : null,
    write: (p) => `
$d='HKCU:\\SOFTWARE\\Microsoft\\Windows\\DWM'
Set-ItemProperty $d AccentColor ([uint32]${p.abgr})
Set-ItemProperty $d ColorizationColor ([uint32]${p.abgr})
Set-ItemProperty $d ColorizationAfterglow ([uint32]${p.abgr})
${BROADCAST}
@{ok=$true} | ConvertTo-Json -Compress`,
  },
  colorprev: {  // accent on start/taskbar (ColorPrevalence)
    label: 'accent on taskbar', readKey: 'colorPrevalence',
    validate: (b) => (b.on === 0 || b.on === 1) ? { on: b.on } : null,
    write: (p) => `
Set-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\DWM' ColorPrevalence ${p.on}
Set-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' ColorPrevalence ${p.on} -EA SilentlyContinue
${BROADCAST}
@{ok=$true} | ConvertTo-Json -Compress`,
  },
  taskbaral: {  // 0 = left, 1 = center. Explorer watches this key live.
    label: 'taskbar alignment', readKey: 'taskbarAl',
    validate: (b) => (b.center === 0 || b.center === 1) ? { center: b.center } : null,
    write: (p) => `
Set-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' TaskbarAl ${p.center} -Type DWord
@{ok=$true} | ConvertTo-Json -Compress`,
  },
  fileext: {    // show file extensions (HideFileExt inverted). Explorer applies on next refresh.
    label: 'file extensions', readKey: 'hideExt',
    validate: (b) => (b.show === 0 || b.show === 1) ? { show: b.show } : null,
    write: (p) => `
Set-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' HideFileExt ${p.show ? 0 : 1}
@{ok=$true} | ConvertTo-Json -Compress`,
  },
  hiddenfiles: { // 1 = show, 2 = hide (Explorer's own convention)
    label: 'hidden files', readKey: 'showHidden',
    validate: (b) => (b.show === 0 || b.show === 1) ? { show: b.show } : null,
    write: (p) => `
Set-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' Hidden ${p.show ? 1 : 2}
@{ok=$true} | ConvertTo-Json -Compress`,
  },
  mousespeed: { // 1..20, SPIF_UPDATEINIFILE|SPIF_SENDCHANGE so it persists and applies now
    label: 'pointer speed', readKey: 'mouseSpeed',
    validate: (b) => Number.isInteger(b.v) && b.v >= 1 && b.v <= 20 ? { v: b.v } : null,
    write: (p) => `${SPI}
$ok=[X2.U]::SystemParametersInfo(0x71,0,[IntPtr]${p.v},3)
@{ok=$ok} | ConvertTo-Json -Compress`,
  },
  mousetrails: { // 0 = off, 2..7 sensible. The Plus!-era dial Windows 11 buried.
    label: 'pointer trails', readKey: 'mouseTrails',
    validate: (b) => Number.isInteger(b.n) && b.n >= 0 && b.n <= 10 ? { n: b.n } : null,
    write: (p) => `${SPI}
$ok=[X2.U]::SystemParametersInfo(0x5D,${p.n},[IntPtr]0,3)
@{ok=$ok} | ConvertTo-Json -Compress`,
  },
  priority: {   // own-user processes only (that is all unelevated CAN touch — honesty for free).
    label: 'process priority', readKey: null,
    validate: (b) => {
      const L = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High'];
      if (!L.includes(b.level)) return null;
      if (typeof b.name !== 'string' || !/^[\w .#()+-]{1,60}$/.test(b.name)) return null;
      return { name: b.name, level: b.level };
    },
    write: (p) => `
$set=0; $skip=0
Get-Process -Name '${p.name.replace(/'/g, "''")}' -EA SilentlyContinue | ForEach-Object {
  try { $_.PriorityClass='${p.level}'; $set++ } catch { $skip++ }
}
@{ok=($set -gt 0); set=$set; denied=$skip} | ConvertTo-Json -Compress`,
  },
};

/* one fast read of everything the page shows — same keys the probe verified */
const STATE_PS = `
$ErrorActionPreference='SilentlyContinue'
$r=@{}
$pl=powercfg /l 2>$null
$r.powerPlans=@($pl | Select-String 'GUID: ([0-9a-f-]+)\\s+\\((.+?)\\)(\\s*\\*)?' | ForEach-Object{
  @{guid=$_.Matches[0].Groups[1].Value;name=$_.Matches[0].Groups[2].Value;active=[bool]$_.Matches[0].Groups[3].Value.Trim()}})
$r.powerActive=($r.powerPlans | Where-Object{$_.active} | Select-Object -First 1).guid
$pz=Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
$r.appsLight=$pz.AppsUseLightTheme; $r.transparency=$pz.EnableTransparency
$dw=Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\DWM'
$r.accentColor=$dw.AccentColor; $r.colorPrevalence=$dw.ColorPrevalence
$ad=Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
$r.taskbarAl=$ad.TaskbarAl; $r.hideExt=$ad.HideFileExt; $r.showHidden=$ad.Hidden
${SPI}
$v=0; [X2.U]::SystemParametersInfoRef(0x70,0,[ref]$v,0)|Out-Null; $r.mouseSpeed=$v
$t=0; [X2.U]::SystemParametersInfoRef(0x5E,0,[ref]$t,0)|Out-Null; $r.mouseTrails=$t
$r.wallpaper=(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop').WallPaper
$r.cursorScheme=(Get-ItemProperty 'HKCU:\\Control Panel\\Cursors').'(default)'
$r.soundScheme=(Get-ItemProperty 'HKCU:\\AppEvents\\Schemes').'(default)'
$r | ConvertTo-Json -Depth 5 -Compress`;

class Ctl {
  constructor(histDir, psRunner) {
    this.dir = histDir;
    this.ps = psRunner;                       // bridge's ps(script, cb)
    this.basePath = path.join(histDir, 'ctl-baseline.json');
    this.logPath = path.join(histDir, 'control.jsonl');
    try { this.baseline = JSON.parse(fs.readFileSync(this.basePath, 'utf8')); }
    catch { this.baseline = {}; }
  }
  state(cb) { this.ps(STATE_PS, cb); }
  saveBaseline() { try { fs.writeFileSync(this.basePath, JSON.stringify(this.baseline, null, 1)); } catch {} }
  log(entry) { try { fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n'); } catch {} }
  recent(n) {
    try {
      const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n');
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch { return []; }
  }
  /* THE SAME TWO DEFECTS OUTCOMES.JS WAS JUST FIXED FOR, in the function that writes the OTHER half
   * of the same ledger - found by review after the first fix, which is the argument for grepping the
   * whole tree rather than the file the bug was reported in.
   *
   *   `find(v => v.id === 'C:')` matches nothing on Linux or macOS, where the root volume is '/'.
   *   Every CTRL lever pull on those platforms recorded `dfree: null` while looking like a full row.
   *   This class has no platform guard and is constructed unconditionally (bridge.js), so it runs
   *   there.
   *
   *   `pagesSec || 0` turns "not measured on this platform" into 0 - and a hard-fault rate of zero
   *   is a REAL, common reading on an idle machine, so the substitution is invisible. This is the
   *   column the ledger later differences to decide whether a lever helped; a null that became a
   *   zero produces a confident measured delta out of two absent readings.
   */
  snap(latest) {
    if (!latest) return null;
    const c = systemVolume(latest);
    const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    return {
      cpu: latest.cpu ? n(latest.cpu.total) : null,
      ram: latest.mem ? n(latest.mem.pct) : null,
      dq: latest.disk && latest.disk.io ? n(latest.disk.io.queue) : null,
      flt: latest.mem ? n(latest.mem.pagesSec) : null,
      dfree: c ? n(c.freeGB) : null,
    };
  }
  /* act: validate → read current (for baseline + ledger 'before') → write → verify-read */
  act(name, body, latest, cb) {
    const A = ACTS[name];
    if (!A) return cb(new Error('unknown action'));
    const p = A.validate(body || {});
    if (!p) return cb(new Error('bad params for ' + name));
    this.state((se, st) => {
      let before = (!se && st && A.readKey) ? st[A.readKey] : undefined;
      // TaskbarAl absent means "center" (Win11 default) — an absent key must still be restorable
      if (name === 'taskbaral' && before === undefined && !se) before = 1;
      this.ps(A.write(p), (we, wd) => {
        if (we || !wd || wd.ok === false) return cb(we || new Error(name + ' reported failure'), wd);
        if (A.readKey && before !== undefined && !(name in this.baseline)) {
          this.baseline[name] = before; this.saveBaseline();   // the machine as it was, bottled
        }
        this.log({ ts: Date.now(), act: name, params: p, before, snap: this.snap(latest) });
        cb(null, { ok: true, act: name, before, detail: wd });
      });
    });
  }
  /* restore one action's key (or all) to the first-captured value */
  restore(name, latest, cb) {
    const keys = name ? [name] : Object.keys(this.baseline);
    const jobs = keys.filter((k) => k in this.baseline && ACTS[k]);
    if (!jobs.length) return cb(null, { ok: true, restored: [] });
    const done = []; let i = 0;
    const step = () => {
      if (i >= jobs.length) return cb(null, { ok: true, restored: done });
      const k = jobs[i++]; const v = this.baseline[k];
      const body = this.baselineToBody(k, v);
      if (!body) { step(); return; }
      const A = ACTS[k];
      this.ps(A.write(A.validate(body)), (e) => {
        if (!e) { done.push(k); this.log({ ts: Date.now(), act: 'restore:' + k, params: body, snap: this.snap(latest) }); }
        step();
      });
    };
    step();
  }
  baselineToBody(k, v) {
    switch (k) {
      case 'powerplan': return { guid: v };
      case 'appsmode': return { light: v ? 1 : 0 };
      case 'transparency': return { on: v ? 1 : 0 };
      case 'accent': return { abgr: v >>> 0 };
      case 'colorprev': return { on: v ? 1 : 0 };
      case 'taskbaral': return { center: (v === 0) ? 0 : 1 };   // absent key = center default
      case 'fileext': return { show: v ? 0 : 1 };               // stored value is HideFileExt
      case 'hiddenfiles': return { show: (v === 1) ? 1 : 0 };   // stored value is Hidden (1 show / 2 hide)
      case 'mousespeed': return { v: v };
      case 'mousetrails': return { n: v };
      default: return null;
    }
  }
}

module.exports = { Ctl, ACTS };
