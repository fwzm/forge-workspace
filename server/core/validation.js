'use strict';

const { invalidInput } = require('./errors');

function assertString(v, name, opts) {
  const o = opts || {};
  if (typeof v !== 'string') throw invalidInput(`${name} must be a string`, { field: name, got: typeof v });
  const s = v.trim();
  if (o.min !== undefined && s.length < o.min) throw invalidInput(`${name} must be at least ${o.min} chars`, { field: name, length: s.length });
  if (o.max !== undefined && s.length > o.max) throw invalidInput(`${name} must be at most ${o.max} chars`, { field: name, length: s.length });
  if (o.pattern && !o.pattern.test(s)) throw invalidInput(`${name} has invalid format`, { field: name });
  return s;
}

function assertEnum(v, name, allowed) {
  if (typeof v !== 'string' || !allowed.includes(v)) {
    throw invalidInput(`${name} must be one of [${allowed.join(', ')}]`, { field: name, got: v });
  }
  return v;
}

function assertArray(v, name, opts) {
  const o = opts || {};
  if (!Array.isArray(v)) throw invalidInput(`${name} must be an array`, { field: name, got: typeof v });
  if (o.min !== undefined && v.length < o.min) throw invalidInput(`${name} must have at least ${o.min} items`, { field: name });
  if (o.max !== undefined && v.length > o.max) throw invalidInput(`${name} must have at most ${o.max} items`, { field: name });
  return v;
}

function assertObject(v, name) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw invalidInput(`${name} must be an object`, { field: name, got: v === null ? 'null' : typeof v });
  }
  return v;
}

// Repository paths: forward slashes, no traversal, no absolute paths, printable segments.
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9 ._+-]*(\/[A-Za-z0-9_][A-Za-z0-9 ._+-]*)*$/;

function assertRepoPath(v, name) {
  const s = assertString(v, name || 'path', { min: 1, max: 512 });
  if (!PATH_RE.test(s)) {
    throw invalidInput(`${name || 'path'} is not a valid repository path: "${s}"`, { field: name || 'path', value: s });
  }
  return s;
}

function assertBranchName(v, name) {
  const s = assertString(v, name || 'branch', { min: 1, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(s) || s.includes('..') || s.endsWith('.lock') || s.endsWith('/')) {
    throw invalidInput(`${name || 'branch'} is not a valid branch name: "${s}"`, { field: name || 'branch' });
  }
  return s;
}

module.exports = { assertString, assertEnum, assertArray, assertObject, assertRepoPath, assertBranchName };
