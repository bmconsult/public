/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - THE PANEL'S OWN SYNTAX CHECK.  node test-dashboard.js   (any platform)
 *
 * WHY THIS EXISTS. Every .js file in this project is covered by `node --check`. dashboard.html is
 * not - it is HTML, so the checker skips it, and its inline script is the largest single body of
 * code in the product.
 *
 * The failure mode is the reason this is a test rather than a habit: a syntax error in that script
 * does not throw anywhere a human is looking. The server still serves the file, the browser still
 * parses the HTML, the rail still draws from CSS - and the page comes up BLANK with nothing in the
 * console, because the script never began executing. It looks exactly like a slow fetch. It cost a
 * screenshot, a bridge restart and two wrong diagnoses before being found by hand.
 *
 * One escaped quote did it: `q === '\'` closed the string on the backslash. Verified below the way
 * it should have been the first time - by parsing.
 */

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

const FILES = ['dashboard.html', 'setup.html'].filter((f) => fs.existsSync(path.join(__dirname, f)));

for (const f of FILES) {
  const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
  /* Inline scripts only - anything with a src= is a separate file and is checked as one. */
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, i = 0, bad = [];
  while ((m = re.exec(html))) {
    i++;
    const body = m[1];
    if (!body.trim()) continue;
    try {
      /* new Function parses without executing, which is exactly what is wanted: this must not
         start a render loop or open an EventSource, only prove the source is parseable. */
      new Function(body);            // eslint-disable-line no-new-func
    } catch (e) {
      /* Report a LINE NUMBER IN THE FILE, not in the fragment. A parse error at "line 84" of an
         anonymous fragment is nearly useless when the fragment starts 5,000 lines into the file. */
      const frag = (e.stack && (e.stack.match(/<anonymous>:(\d+)/) || [])[1]) || null;
      const before = html.slice(0, m.index).split('\n').length;
      bad.push({ n: i, msg: e.message, fileLine: frag ? before + (+frag) - 1 : null });
    }
  }
  check(`${f}: found at least one inline script to check`, i > 0, `${i} scripts`);
  check(`${f}: every inline script parses`, bad.length === 0,
    bad.map((b) => `script #${b.n}${b.fileLine ? ' near ' + f + ':' + b.fileLine : ''} — ${b.msg}`).join(' | '));
}

/* A second, cheaper guard for the same class of bug: unbalanced template literals and stray
   backslash-quote sequences survive parsing surprisingly often when they land inside a string, so
   the specific shape that broke it is called out by name. */
{
  const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  const suspicious = [];
  /* A single-quoted string whose only content is a lone backslash is almost always the escaped-quote
     mistake rather than an intentional backslash literal. */
  const re = /(?<!\\)'\\'(?!\\)/g;
  let m;
  while ((m = re.exec(html))) {
    suspicious.push('dashboard.html:' + html.slice(0, m.index).split('\n').length);
  }
  check("no lone '\\' string literal — the shape that swallowed a closing quote",
    suspicious.length === 0, suspicious.join(', '));
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the panel's script parses, which node --check cannot tell you.`);
process.exit(fail ? 1 : 0);
