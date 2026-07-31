/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - COLLECTOR DISPATCH. One socket, three plugs.
 *
 * Everything above this line in the stack - the diagnosis rules, the history ring, the pages, the
 * MCP server, the Ask panel - consumes exactly one shape: the `tick` object. This file's whole job
 * is to pick the plug that fits the machine underneath and hand that shape upward.
 *
 * The shape is defined by the Windows collector, because that is the one with weeks of calibration
 * behind it. Porting means teaching a new platform to speak it, and where a platform genuinely
 * cannot answer a field, the plug emits NULL and caps.js declares the gap. Null travels; zero lies.
 *
 * An unrecognised platform is not a crash. The panel loads, says what it is running on, and reports
 * that it has no collector for it - which is a far more useful thing to hand someone than a stack
 * trace on startup.
 */

const { manifest } = require('./caps');

const PLUGS = {
  win32: () => require('./win32'),
  linux: () => require('./linux'),
  darwin: () => require('./darwin'),
};

function collector() {
  const caps = manifest();
  const load = PLUGS[caps.platform];

  if (!load) {
    return {
      caps,
      start() {
        console.error(`[collect] no collector for platform "${process.platform}". ` +
                      `Telemetry will not arrive; the panel will still load and will say so.`);
        return { stop() {} };
      },
    };
  }

  const plug = load();
  return {
    caps,
    start(root, handlers) {
      const verdict = caps.verified === false
        ? 'UNVERIFIED - never run on real hardware'
        : (typeof caps.verified === 'string' ? caps.verified : 'verified');
      console.error(`[collect] ${caps.name} plug: ${caps.collector}`);
      console.error(`[collect] status: ${verdict}`);
      if (caps.missing.length) {
        console.error(`[collect] unavailable here: ${caps.missing.join(', ')}`);
      }
      return plug.start(root, handlers);
    },
  };
}

module.exports = { collector, manifest };
