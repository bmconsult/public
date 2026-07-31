/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - WINDOWS COLLECTOR PLUG.
 *
 * This is a thin adapter, on purpose. metrics.ps1 is the reference collector and it is not being
 * rewritten: it is the only one of the three that has been measured against real hardware over
 * weeks, and every number in the panel was calibrated against it. Porting to other platforms means
 * teaching the OTHERS to produce this shape, not renegotiating it.
 *
 * ONE long-lived PowerShell child. Spawning a fresh powershell.exe per sample costs ~250 ms of
 * .NET startup; at 1 Hz that would burn a visible slice of a core doing nothing but boot.
 */

const { spawn } = require('child_process');
const path = require('path');

const { PS, PS_ARGS, PS_RESOLVED } = require('../pshost');

function start(root, { onStatic, onTick, onError }) {
  let child = null, stopped = false, fatal = false;

  function boot() {
    if (stopped || fatal) return;
    child = spawn(PS, [...PS_ARGS, '-File', path.join(root, 'metrics.ps1')], { windowsHide: true });
    /* AN UNHANDLED 'error' EVENT ON A ChildProcess KILLS THE PROCESS, not the request. Without this
       listener a missing or unreachable powershell.exe took down the bridge - telemetry, history,
       journal and the MCP server with it - from a failure whose whole consequence should have been
       "no Windows telemetry". This file is the collector; it is allowed to fail alone. */
    child.on('error', (e) => {
      if (stopped) return;
      if (e && e.code === 'ENOENT') {
        /* ENOENT will not fix itself, so retrying it forever is just a slow log flood. Say the true
           thing once and stop: the collector is down and it is not coming back this run. */
        fatal = true;
        onError(PS_RESOLVED
          ? `[metrics] cannot start PowerShell at ${PS} - telemetry is unavailable this run`
          : '[metrics] powershell.exe was not found on PATH and not at its usual location under '
            + '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0 - telemetry is unavailable this run');
        return;
      }
      onError(`[metrics] could not start (${e && e.code || e}); retrying in 2s`);
      setTimeout(boot, 2000);
    });
    let buf = '';

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.t === 'static') onStatic(msg);
        else if (msg.t === 'tick') onTick(msg);
      }
    });

    child.stderr.on('data', (d) => onError('[metrics] ' + d));
    child.on('exit', (code) => {
      /* `fatal` as well as `stopped`: a failed spawn emits 'error' AND 'exit', and without this the
         permanent failure above would still announce a restart that boot() then declines to make. */
      if (stopped || fatal) return;
      onError(`[metrics] exited (${code}); restarting in 2s`);
      setTimeout(boot, 2000);
    });
  }

  boot();
  return { stop() { stopped = true; try { child && child.kill(); } catch {} } };
}

module.exports = { start };
