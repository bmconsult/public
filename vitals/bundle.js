/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - PORTABLE BUNDLE BUILDER.  node bundle.js [target...]
 *
 * Takes the source build that pack.js produces and turns it into five self-contained folders, one
 * per platform, each carrying its own Node runtime. The result needs nothing installed: unpack it
 * and run it.
 *
 * THREE THINGS HERE ARE DELIBERATE AND EASY TO GET WRONG.
 *
 * 1. EVERY DOWNLOAD IS HASH-CHECKED against nodejs.org's own SHASUMS256.txt, fetched over the same
 *    TLS connection family. We are placing an executable inside something people will run; taking
 *    it on trust because the URL looked right is not a standard this codebase holds elsewhere.
 *    A mismatch is fatal, never a warning.
 *
 * 2. UNIX TARGETS SHIP AS .tar.gz, NOT .zip. Zip has no portable executable bit. A macOS user who
 *    unzipped this would get a node binary and a vitals.sh that both refuse to run, and the error
 *    ("permission denied") points at nothing. tar carries mode, so ./vitals.sh works on the first
 *    try. This is a correctness decision wearing a format decision's clothes.
 *
 * 3. ONLY THE NODE BINARY IS TAKEN, not the whole distribution. VITALS has no npm dependencies, so
 *    npm, the C++ headers and the docs are ballast - they roughly double the download for nothing.
 *
 * Archives are byte-reproducible: fixed mtimes, fixed ordering, no timestamps of our own. Build it
 * twice and you get the same SHA256, which is what makes the published checksums worth anything.
 */

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const VERSION = require('./package.json').version;
const SRC = path.join(HERE, 'dist', `vitals-${VERSION}`);
const OUT = path.join(HERE, 'dist', 'bundles');
const CACHE = path.join(HERE, '.bundle-cache');

/* Pinned, not "latest". A build that silently changes its runtime between runs is not reproducible,
   and "it worked last week" stops being a usable sentence. Bump this deliberately. */
const NODE = 'v24.18.1';

/* A FIXED TIMESTAMP so two builds of the same input produce identical bytes. 2026-01-01T00:00:00Z.
   Real mtimes would make every rebuild a different archive and every published checksum a one-off. */
const MTIME = 1767225600;

const TARGETS = [
  { id: 'win-x64',    node: `node-${NODE}-win-x64.zip`,          member: 'node.exe',  dest: 'runtime/node.exe',  fmt: 'zip' },
  { id: 'win-arm64',  node: `node-${NODE}-win-arm64.zip`,        member: 'node.exe',  dest: 'runtime/node.exe',  fmt: 'zip' },
  { id: 'mac-arm64',  node: `node-${NODE}-darwin-arm64.tar.gz`,  member: 'bin/node',  dest: 'runtime/bin/node',  fmt: 'tgz' },
  { id: 'mac-x64',    node: `node-${NODE}-darwin-x64.tar.gz`,    member: 'bin/node',  dest: 'runtime/bin/node',  fmt: 'tgz' },
  { id: 'linux-x64',  node: `node-${NODE}-linux-x64.tar.gz`,     member: 'bin/node',  dest: 'runtime/bin/node',  fmt: 'tgz' },
];

/* Which files must be executable in a unix bundle. Everything else ships 0644. */
const EXEC = new Set(['vitals.sh', 'setup.sh', 'runtime/bin/node']);

const MB = (n) => (n / 1048576).toFixed(1) + ' MB';

/* ---------------------------------------------------------------- fetch */

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': `vitals-bundler/${VERSION}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (!redirects) return reject(new Error('too many redirects: ' + url));
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* The cache is keyed by filename AND re-verified on every hit. A truncated download that got cached
   would otherwise be a permanent, silent failure that only reproduces on someone else's machine. */
async function fetchVerified(file, sums) {
  const want = sums.get(file);
  if (!want) throw new Error(`${file} is not listed in SHASUMS256.txt - wrong version or wrong name`);
  const cached = path.join(CACHE, file);
  if (fs.existsSync(cached)) {
    const buf = fs.readFileSync(cached);
    if (sha256(buf) === want) { console.log(`    cached   ${file}  ${MB(buf.length)}`); return buf; }
    console.log(`    cache MISS (hash changed) - refetching ${file}`);
  }
  const url = `https://nodejs.org/dist/${NODE}/${file}`;
  const buf = await get(url);
  const got = sha256(buf);
  if (got !== want) {
    throw new Error(`CHECKSUM MISMATCH for ${file}\n  expected ${want}\n  got      ${got}\nRefusing to bundle it.`);
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, buf);
  console.log(`    verified ${file}  ${MB(buf.length)}`);
  return buf;
}

/* ---------------------------------------------------------------- read archives */

/* Minimal ZIP reader: enough to pull one known member out of a Node windows distribution. Walks the
   central directory rather than scanning local headers, because only the central directory is
   authoritative about where an entry starts. */
function zipExtract(buf, endsWith) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name.endsWith(endsWith)) {
      /* The local header repeats the name and extra fields, and its extra field length routinely
         DIFFERS from the central one. Reading the central value here is a classic off-by-a-few
         that yields a file starting a dozen bytes late. */
      const lnLen = buf.readUInt16LE(lho + 26);
      const leLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnLen + leLen;
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error(`no zip member ending in ${endsWith}`);
}

/* Minimal TAR reader over a gunzipped buffer. Node's tarballs are plain ustar with short paths. */
function tarExtract(gz, endsWith) {
  const buf = zlib.gunzipSync(gz);
  for (let p = 0; p + 512 <= buf.length; ) {
    const name = buf.toString('utf8', p, p + 100).replace(/\0.*$/, '');
    if (!name) { p += 512; continue; }
    const size = parseInt(buf.toString('ascii', p + 124, p + 136).replace(/[\0 ]/g, ''), 8) || 0;
    const type = String.fromCharCode(buf[p + 156]);
    const start = p + 512;
    if ((type === '0' || type === '\0') && name.endsWith(endsWith)) {
      return Buffer.from(buf.subarray(start, start + size));
    }
    p = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`no tar member ending in ${endsWith}`);
}

/* ---------------------------------------------------------------- write archives */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xFF];
    return (c ^ -1) >>> 0;
  };
})();

function writeZip(entries, outPath) {
  const locals = [];
  const central = [];
  let offset = 0;
  /* DOS time/date for the fixed MTIME, so the archive is byte-identical between builds. */
  const d = new Date(MTIME * 1000);
  const dosTime = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const dosDate = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const crc = CRC(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const out = Buffer.concat([...locals, cd, eocd]);
  fs.writeFileSync(outPath, out);
  return out.length;
}

function tarHeader(name, size, mode) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long (>100 bytes): ${name}`);
  const h = Buffer.alloc(512);
  const put = (s, off, len) => h.write(String(s).slice(0, len - 1), off, 'utf8');
  const oct = (n, off, len) => h.write(n.toString(8).padStart(len - 1, '0') + '\0', off, 'ascii');
  put(name, 0, 100);
  oct(mode, 100, 8); oct(0, 108, 8); oct(0, 116, 8);
  oct(size, 124, 12); oct(MTIME, 136, 12);
  h.write('        ', 148, 'ascii');          // checksum field is spaces while summing
  h.write('0', 156, 'ascii');                  // regular file
  h.write('ustar\0', 257, 'ascii'); h.write('00', 263, 'ascii');
  put('root', 265, 32); put('root', 297, 32);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

function writeTarGz(entries, outPath) {
  const parts = [];
  for (const e of entries) {
    parts.push(tarHeader(e.name, e.data.length, e.mode));
    parts.push(e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));              // two zero blocks = end of archive
  /* mtime:0 in the gzip header, or the wrapper defeats the reproducibility the tar just bought. */
  const out = zlib.gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 });
  fs.writeFileSync(outPath, out);
  return out.length;
}

/* ---------------------------------------------------------------- assemble */

/* Sorted, so entry order is a property of the content and not of the filesystem's mood. */
function listFiles(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

async function main() {
  const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targets = want.length ? TARGETS.filter((t) => want.includes(t.id)) : TARGETS;
  if (!targets.length) {
    console.error(`unknown target. known: ${TARGETS.map((t) => t.id).join(', ')}`);
    process.exit(2);
  }
  if (!fs.existsSync(SRC)) {
    console.error(`no source build at ${SRC}\nRun:  node pack.js`);
    process.exit(2);
  }

  console.log(`VITALS ${VERSION} portable bundles`);
  console.log(`  source  ${SRC}`);
  console.log(`  runtime Node ${NODE}\n`);

  console.log('fetching SHASUMS256.txt...');
  const sums = new Map();
  for (const line of (await get(`https://nodejs.org/dist/${NODE}/SHASUMS256.txt`)).toString('utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+?)\s*$/);
    if (m) sums.set(m[2], m[1]);
  }
  console.log(`  ${sums.size} checksums\n`);

  const files = listFiles(SRC);
  const srcEntries = files.map((rel) => ({ rel, data: fs.readFileSync(path.join(SRC, rel)) }));
  const srcBytes = srcEntries.reduce((a, e) => a + e.data.length, 0);

  fs.mkdirSync(OUT, { recursive: true });
  const built = [];

  for (const t of targets) {
    console.log(`${t.id}`);
    const archive = await fetchVerified(t.node, sums);
    const node = t.fmt === 'zip' ? zipExtract(archive, t.member) : tarExtract(archive, t.member);
    console.log(`    runtime  ${MB(node.length)} extracted`);

    const root = `vitals-${VERSION}-${t.id}`;
    const entries = srcEntries.map((e) => ({
      name: `${root}/${e.rel}`,
      data: e.data,
      mode: EXEC.has(e.rel) ? 0o755 : 0o644,
    }));
    entries.push({ name: `${root}/${t.dest}`, data: node, mode: 0o755 });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));

    const isWin = t.fmt === 'zip';
    const outFile = path.join(OUT, `${root}.${isWin ? 'zip' : 'tar.gz'}`);
    const size = isWin ? writeZip(entries, outFile) : writeTarGz(entries, outFile);
    const digest = sha256(fs.readFileSync(outFile));
    console.log(`    -> ${path.basename(outFile)}  ${MB(size)}  (${MB(srcBytes + node.length)} unpacked)`);
    built.push({ file: path.basename(outFile), size, sha: digest });
  }

  const sumsPath = path.join(OUT, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsPath, built.map((b) => `${b.sha}  ${b.file}`).join('\n') + '\n');

  console.log(`\n${built.length} bundle(s) in ${OUT}`);
  console.log(`total ${MB(built.reduce((a, b) => a + b.size, 0))}, checksums in SHA256SUMS.txt`);
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
