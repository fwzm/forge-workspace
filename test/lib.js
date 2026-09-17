'use strict';

// Minimal zero-dependency test runner. Each test file requires this module and
// registers tests with test(name, fn). run-all.js executes the registry.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Workspace } = require('../server/domain/workspace');
const demo = require('../server/demo/demo');

const registry = [];

function test(name, fn) {
  registry.push({ name, fn });
}

function getRegistry() {
  return registry;
}

// Fresh isolated workspace (temp data dir, no disk load).
function makeWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  return new Workspace({ dataDir: dir, skipLoad: true });
}

// Workspace pre-populated with the demo repository baseline (files + initial commit).
function makeSeededWs() {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  return ws;
}

const ADMIN = { type: 'user', id: 'admin', role: 'admin' };
const VIEWER = { type: 'user', id: 'viewer-1', role: 'viewer' };
const PLANNER = { type: 'user', id: 'planner-1', role: 'planner' };
const IMPLEMENTER = { type: 'user', id: 'impl-1', role: 'implementer' };
const REVIEWER = { type: 'user', id: 'reviewer-1', role: 'reviewer' };
const QA = { type: 'user', id: 'qa-1', role: 'qa' };
const SECURITY = { type: 'user', id: 'sec-1', role: 'security' };
const SYSTEM = { type: 'system', id: 'system', role: 'system' };

// Tiny assertion helpers with expressive failure messages.
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'deepEqual'}: expected ${b}, got ${a}`);
}

function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message || 'includes'}: expected "${needle}" in "${String(haystack).slice(0, 300)}"`);
  }
}

function throws(fn, codeOrMatch, message) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(message || 'expected function to throw');
  if (codeOrMatch) {
    if (typeof codeOrMatch === 'string' && codeOrMatch.startsWith('FORGE_')) {
      if (err.code !== codeOrMatch) {
        throw new Error(`${message || 'throws'}: expected code ${codeOrMatch}, got ${err.code} (${err.message})`);
      }
    } else if (codeOrMatch instanceof RegExp) {
      if (!codeOrMatch.test(err.message)) {
        throw new Error(`${message || 'throws'}: expected message matching ${codeOrMatch}, got "${err.message}"`);
      }
    }
  }
  return err;
}

async function throwsAsync(fn, codeOrMatch, message) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(message || 'expected async function to throw');
  if (typeof codeOrMatch === 'string' && codeOrMatch.startsWith('FORGE_')) {
    if (err.code !== codeOrMatch) {
      throw new Error(`${message || 'throwsAsync'}: expected code ${codeOrMatch}, got ${err.code} (${err.message})`);
    }
  }
  return err;
}

module.exports = {
  test, getRegistry, makeWs, makeSeededWs,
  ADMIN, VIEWER, PLANNER, IMPLEMENTER, REVIEWER, QA, SECURITY, SYSTEM,
  assert, equal, deepEqual, includes, throws, throwsAsync,
};
