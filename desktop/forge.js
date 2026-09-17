'use strict';

// ---------------------------------------------------------------------------
// FORGE Windows desktop bootstrap (no process spawning here).
// Picks a port, starts the workspace server, and writes a launch info file
// (%LOCALAPPDATA%\FORGE\launch.json) with the port and this process id.
// Start-FORGE.vbs waits for that file, opens the app window, waits for the
// window to close, and then terminates this process by pid.
//
// Env switches (automation/tests):
//   FORGE_DESKTOP_PORT=NNNN   force a specific port
//   FORGE_NO_WINDOW=1         inherit semantics from server/main.js
// ---------------------------------------------------------------------------
const net = require('net');
const fs = require('fs');
const path = require('path');
const core = require('./launcher-core.js');

const PORT_CANDIDATES = [7790, 7789, 7788, 7787];

function launchInfoPath() {
  return path.join(core.appDataDir(), 'launch.json');
}

function writeLaunchInfo(port, pid) {
  const dir = core.appDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const info = { pid: pid === undefined ? process.pid : pid, port, startedAt: Date.now() };
  fs.writeFileSync(launchInfoPath(), JSON.stringify(info, null, 1), 'utf8');
  return info;
}

function readLaunchInfo(file) {
  return JSON.parse(fs.readFileSync(file || launchInfoPath(), 'utf8'));
}

function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

// First bindable port from the candidates; falls back to a random free one.
async function pickDesktopPort() {
  if (process.env.FORGE_DESKTOP_PORT) {
    const forced = Number(process.env.FORGE_DESKTOP_PORT);
    if (!Number.isInteger(forced) || forced < 1 || forced > 65535) {
      throw new Error('FORGE_DESKTOP_PORT must be an integer in [1, 65535]');
    }
    return forced;
  }
  for (const p of PORT_CANDIDATES) {
    if (await canListen(p)) return p; // eslint-disable-line no-await-in-loop
  }
  return core.findFreePort();
}

async function main() {
  const dataDir = path.join(core.appDataDir(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const port = await pickDesktopPort();
  process.env.FORGE_PORT = String(port);
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.FORGE_NO_LISTEN = '1';

  // Requiring main.js builds the workspace (and loads persisted state).
  const { server } = require('../server/main.js');

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const info = writeLaunchInfo(port);
  const logMsg = 'server listening on 127.0.0.1:' + port + ' pid ' + info.pid;
  try {
    fs.appendFileSync(path.join(core.appDataDir(), 'forge.log'), new Date().toISOString() + ' ' + logMsg + '\n', 'utf8');
  } catch (_) { /* logging must never crash */ }
  console.log('[forge-desktop] ' + logMsg);

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FORGE desktop bootstrap failed:', e.message);
    process.exit(1);
  });
}

module.exports = { PORT_CANDIDATES, launchInfoPath, writeLaunchInfo, readLaunchInfo, pickDesktopPort, canListen, main };
