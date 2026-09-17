'use strict';

// ---------------------------------------------------------------------------
// Sandboxed workspace exchange for external agents.
//
// Safety model ("patch mode"): an external agent never touches the virtual
// repository or the host project. Instead:
//   1. exportSnapshot() materializes a branch snapshot into a fresh temp dir
//      plus a TASK.md brief;
//   2. the agent works inside that temp dir only;
//   3. collectChanges() diffs the temp dir back against the snapshot and
//      returns a { path -> content } changeset;
//   4. the orchestrator applies that changeset to the virtual repository;
//   5. cleanup() removes the temp dir (always, via try/finally).
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

// A snapshot path is safe to materialize only if it stays inside `dir`.
function safeJoin(dir, rel) {
  const clean = String(rel).replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.includes('..') || clean.includes('\0')) {
    throw new Error(`unsafe export path: ${rel}`);
  }
  const root = path.resolve(dir);
  const full = path.resolve(root, clean);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`path escapes export dir: ${rel}`);
  }
  return full;
}

function newWorkDir(label) {
  const safe = String(label || 'agent').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'agent';
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-${safe}-`));
}

// Materialize `files` ({path: content}) + TASK.md into dir. Returns dir.
function exportSnapshot(dir, files, brief) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    const full = safeJoin(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(content), 'utf8');
  }
  fs.writeFileSync(safeJoin(dir, 'TASK.md'), brief, 'utf8');
  return dir;
}

// Walk dir (excluding TASK.md) collecting path -> content for text files.
function readTree(dir) {
  const out = {};
  const walk = (cur, prefix) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (entry.name === 'TASK.md' && prefix === '') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = safeJoin(dir, rel);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(full);
        // Binary guard: skip files with NUL bytes or over 1 MiB.
        if (buf.length > 1024 * 1024 || buf.includes(0)) continue;
        out[rel] = buf.toString('utf8');
      }
    }
  };
  walk(dir, '');
  return out;
}

// Compare the agent's tree against the original snapshot.
// Returns { modified: {path: content}, added: {path: content},
//           deleted: [path], empty: bool }
function collectChanges(dir, snapshotFiles) {
  const now = readTree(dir);
  const modified = {};
  const added = {};
  const deleted = [];
  for (const [p, content] of Object.entries(now)) {
    if (Object.prototype.hasOwnProperty.call(snapshotFiles, p)) {
      if (snapshotFiles[p] !== content) modified[p] = content;
    } else {
      added[p] = content;
    }
  }
  for (const p of Object.keys(snapshotFiles)) {
    if (!Object.prototype.hasOwnProperty.call(now, p)) deleted.push(p);
  }
  const count = Object.keys(modified).length + Object.keys(added).length + deleted.length;
  return { modified, added, deleted, empty: count === 0 };
}

// Always remove the temp dir; never throws.
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { newWorkDir, exportSnapshot, readTree, collectChanges, cleanup, safeJoin };
