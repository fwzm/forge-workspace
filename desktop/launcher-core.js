'use strict';

// Pure helpers for the FORGE desktop launcher (no process spawning here, so
// this module is fully unit-testable).
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

function appDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'FORGE');
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Known install locations, most preferred first (Edge ships with Windows).
function browserCandidates() {
  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const exes = [];
  for (const root of roots) {
    exes.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  for (const root of roots) {
    exes.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return exes;
}

function findBrowser() {
  for (const exe of browserCandidates()) {
    try {
      if (fs.existsSync(exe)) return exe;
    } catch (_) { /* not accessible */ }
  }
  return null;
}

// Fixed browser argument list; the only dynamic values are the validated
// port number and the launcher-owned profile directory path.
function buildBrowserArgs(port, profileDir) {
  const safePort = Number(port);
  if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
  const safeProfile = String(profileDir).replace(/["']/g, '');
  return [
    `--app=http://127.0.0.1:${safePort}/`,
    `--user-data-dir=${safeProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
  ];
}

module.exports = { appDataDir, findFreePort, browserCandidates, findBrowser, buildBrowserArgs };
