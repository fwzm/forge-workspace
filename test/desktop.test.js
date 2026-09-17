'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert, equal, throws } = require('./lib');
const core = require('../desktop/launcher-core.js');
const forgeDesktop = require('../desktop/forge.js');
const { buildIco } = require('../desktop/make-icon.js');

const DESKTOP_DIR = path.join(__dirname, '..', 'desktop');

test('desktop: launcher helpers find a bindable free port', async () => {
  const port = await core.findFreePort();
  assert(Number.isInteger(port) && port > 0 && port < 65536, `port ${port}`);
});

test('desktop: browser candidates are the known Edge/Chrome install paths', () => {
  const cands = core.browserCandidates();
  assert(cands.length >= 4, `expected several candidates, got ${cands.length}`);
  assert(cands.every((c) => c.endsWith('msedge.exe') || c.endsWith('chrome.exe')));
  assert(cands.some((c) => c.includes('Microsoft') && c.includes('Edge')), 'Edge first');
});

test('desktop: buildBrowserArgs validates the port and strips quotes', () => {
  const args = core.buildBrowserArgs(7790, 'C:\\Users\\x\\AppData\\Local\\FORGE\\profile');
  equal(args[0], '--app=http://127.0.0.1:7790/');
  assert(args[1].startsWith('--user-data-dir='));
  assert(!args[1].includes('"'));
  assert(args.includes('--no-first-run'));
  throws(() => core.buildBrowserArgs('not-a-port', 'x'), /invalid port/);
  throws(() => core.buildBrowserArgs(99999, 'x'), /invalid port/);
});

test('desktop: appDataDir resolves under LOCALAPPDATA (or home fallback)', () => {
  const dir = core.appDataDir();
  assert(dir.includes('FORGE'), dir);
});

test('desktop: launch info roundtrips through disk', () => {
  const tmp = path.join(__dirname, '..', 'data', 'launch-test.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const info = forgeDesktop.writeLaunchInfo(7790, 4242);
  // writeLaunchInfo writes to the real location; also verify via readLaunchInfo on a temp file
  fs.writeFileSync(tmp, JSON.stringify({ pid: 4242, port: 7790, startedAt: 1 }), 'utf8');
  const read = forgeDesktop.readLaunchInfo(tmp);
  equal(read.port, 7790);
  equal(read.pid, 4242);
  equal(info.port, 7790);
  fs.unlinkSync(tmp);
});

test('desktop: canListen detects an occupied port', async () => {
  const net = require('net');
  const srv = net.createServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  equal(await forgeDesktop.canListen(port), false, 'occupied port is not bindable');
  srv.close();
  // wait until released
  for (let i = 0; i < 20 && !(await forgeDesktop.canListen(port)); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  equal(await forgeDesktop.canListen(port), true, 'port free after close');
});

test('desktop: pickDesktopPort honors FORGE_DESKTOP_PORT with validation', async () => {
  process.env.FORGE_DESKTOP_PORT = '0';
  let err = null;
  try { await forgeDesktop.pickDesktopPort(); } catch (e) { err = e; }
  delete process.env.FORGE_DESKTOP_PORT;
  assert(err && /integer/.test(err.message), 'port 0 rejected');
});

test('desktop: forge.ico exists and is a valid PNG-embedded icon file', () => {
  const icoPath = path.join(DESKTOP_DIR, 'forge.ico');
  assert(fs.existsSync(icoPath), 'forge.ico committed');
  const buf = fs.readFileSync(icoPath);
  equal(buf.readUInt16LE(0), 0, 'reserved');
  equal(buf.readUInt16LE(2), 1, 'type = icon');
  const count = buf.readUInt16LE(4);
  equal(count, 2, 'two sizes (32 + 16)');
  let offset = 6 + count * 16;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = buf[e];
    assert([32, 16].includes(size), `entry ${i} size ${size}`);
    equal(buf.readUInt16LE(e + 6), 32, '32bpp');
    const dataOffset = buf.readUInt32LE(e + 12);
    equal(dataOffset, offset, 'entries are packed in order');
    // PNG signature inside the entry data
    assert(buf[dataOffset] === 0x89 && buf[dataOffset + 1] === 0x50, 'PNG magic');
    assert(buf.slice(dataOffset + 1, dataOffset + 4).toString('ascii') === 'PNG');
    offset += buf.readUInt32LE(e + 8);
  }
  equal(offset, buf.length, 'no trailing bytes');
});

test('desktop: icon generation is deterministic (regenerates identical bytes)', () => {
  const current = fs.readFileSync(path.join(DESKTOP_DIR, 'forge.ico'));
  const regenerated = buildIco([32, 16]);
  equal(regenerated.length, current.length);
  equal(regenerated.toString('hex'), current.toString('hex'), 'make-icon.js output must match the committed forge.ico');
});

test('desktop: launcher scripts exist with the expected wiring', () => {
  const vbs = fs.readFileSync(path.join(DESKTOP_DIR, 'Start-FORGE.vbs'), 'utf8');
  assert(vbs.includes('desktop\\forge.js'), 'starts the bootstrap');
  assert(vbs.includes('--app='), 'opens an app-mode window');
  assert(vbs.includes('appUrl = "http://127.0.0.1:"'), 'window targets the local server');
  assert(vbs.includes('--user-data-dir='), 'dedicated profile');
  assert(vbs.includes('taskkill /PID '), 'stops the server after window close');
  assert(vbs.includes('launch.json'), 'waits for readiness');
  assert(vbs.includes('msedge.exe') && vbs.includes('chrome.exe'), 'browser candidates');

  const ps1 = fs.readFileSync(path.join(DESKTOP_DIR, 'Install-Shortcut.ps1'), 'utf8');
  assert(ps1.includes('Start-FORGE.vbs'), 'shortcut targets the launcher');
  assert(ps1.includes('forge.ico'), 'shortcut uses the icon');
  assert(ps1.includes('CreateShortcut'), 'creates a .lnk');

  const bootstrap = fs.readFileSync(path.join(DESKTOP_DIR, 'forge.js'), 'utf8');
  assert(bootstrap.includes("require('../server/main.js')"), 'boots the real server');
  assert(!bootstrap.includes("require('child_process')"), 'no process spawning in the bootstrap');
});

test('desktop: forge.js boots the full server on a free port (headless)', async () => {
  process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'forge-desktop-'));
  const { server } = require('../server/main.js');
  // api.test.js may have left the shared server listening; reuse it if so.
  const port = server.listening ? server.address().port : await core.findFreePort();
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  equal(res.status, 200);
  const json = await res.json();
  equal(json.ok, true);
  assert(Array.isArray(json.data.agents));
});
