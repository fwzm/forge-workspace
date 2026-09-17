'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolated server instance for API integration tests.
process.env.FORGE_NO_LISTEN = '1';
process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api-'));

const { server, ws } = require('../server/main');

const { test, assert, equal, includes, throws } = require('./lib');

let base = null;

async function ensureListening() {
  if (base) return base;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

async function api(method, p, body) {
  const b = await ensureListening();
  const res = await fetch(b + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) { /* non-json */ }
  return { status: res.status, json };
}

test('api: GET /api/state returns the full workspace snapshot', async () => {
  const { status, json } = await api('GET', '/api/state');
  equal(status, 200);
  equal(json.ok, true);
  assert(Array.isArray(json.data.tasks));
  assert(json.data.repo && Array.isArray(json.data.repo.branches));
  assert(json.data.agents.length === 5);
});

test('api: unknown routes are 404 with structured error', async () => {
  const { status, json } = await api('GET', '/api/definitely-not-a-route');
  equal(status, 404);
  equal(json.ok, false);
  equal(json.error.code, 'FORGE_NOT_FOUND');
});

test('api: invalid task payload is 400 FORGE_INVALID_INPUT', async () => {
  const { status, json } = await api('POST', '/api/tasks', {});
  equal(status, 400);
  equal(json.error.code, 'FORGE_INVALID_INPUT');
});

test('api: task create + invalid transition surfaced as 409', async () => {
  const created = await api('POST', '/api/tasks', { title: 'API task', type: 'security' });
  equal(created.status, 200);
  const id = created.json.data.id;
  const completed = await api('POST', `/api/tasks/${id}/complete`, { result: { manual: true } });
  equal(completed.status, 409);
  equal(completed.json.error.code, 'FORGE_INVALID_TRANSITION');
  const run = await api('POST', `/api/tasks/${id}/run`, {});
  equal(run.status, 200);
  equal(run.json.data.status, 'completed', 'security scan over the empty baseline completes cleanly');
});

test('api: demo seed + step endpoint advances real state', async () => {
  const seed = await api('POST', '/api/demo/seed', {});
  equal(seed.status, 200);
  equal(seed.json.data.steps.length, 15);
  const step = await api('POST', '/api/demo/next', {});
  equal(step.status, 200);
  equal(step.json.data.ok, true);
  equal(ws.issues.length, 1, 'issue created server-side');
});

test('api: terminal endpoint executes shell commands', async () => {
  const { status, json } = await api('POST', '/api/terminal', { command: 'ls' });
  equal(status, 200);
  assert(json.data.lines.includes('src/'));
});

test('api: terminal unknown command yields 400', async () => {
  const { status, json } = await api('POST', '/api/terminal', { command: 'definitely-not-a-command' });
  equal(status, 400);
  equal(json.error.code, 'FORGE_INVALID_INPUT');
});

test('api: malformed JSON body yields 400', async () => {
  const b = await ensureListening();
  const res = await fetch(b + '/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ broken',
  });
  equal(res.status, 400);
  const json = await res.json();
  equal(json.error.code, 'FORGE_INVALID_INPUT');
});

test('api: PR merge gate rejection surfaces as 409 FORGE_MERGE_GATE', async () => {
  await api('POST', '/api/repo/branch', { name: 'feature/api' });
  await api('POST', '/api/repo/checkout', { ref: 'feature/api' });
  await api('PUT', '/api/repo/file', { path: 'src/api-feature.js', content: "'use strict';\nconst API_FEATURE = 1;\nmodule.exports = { API_FEATURE };\n" });
  await api('POST', '/api/repo/commit', { message: 'feat: api feature' });
  const pr = await api('POST', '/api/pr', { title: 'API PR', sourceBranch: 'feature/api', targetBranch: 'main' });
  equal(pr.status, 200);
  const merge = await api('POST', `/api/pr/${pr.json.data.id}/merge`, {});
  equal(merge.status, 409);
  equal(merge.json.error.code, 'FORGE_MERGE_GATE');
  assert(merge.json.error.details.missing.length >= 1);
  // cleanup: close PR and return to main for later tests
  await api('POST', `/api/pr/${pr.json.data.id}/close`, {});
  await api('POST', '/api/repo/checkout', { ref: 'main' });
});

test('api: metrics endpoint computes from live state', async () => {
  await api('POST', '/api/tasks', { title: 'Metrics bait', type: 'security' });
  const { status, json } = await api('GET', '/api/metrics');
  equal(status, 200);
  assert(typeof json.data.tasks.total === 'number');
  assert(json.data.tasks.total >= 1, 'the metrics-bait task is counted');
  assert(json.data.repo.commits >= 1);
});

test('api: audit and message endpoints return arrays', async () => {
  const audit = await api('GET', '/api/audit?limit=10');
  equal(audit.status, 200);
  assert(Array.isArray(audit.json.data));
  const messages = await api('GET', '/api/messages?limit=10');
  equal(messages.status, 200);
  assert(Array.isArray(messages.json.data));
});

test('api: config update via PUT', async () => {
  const { status, json } = await api('PUT', '/api/config', { lintMaxLineLength: 160 });
  equal(status, 200);
  equal(json.data.lintMaxLineLength, 160);
  const bad = await api('PUT', '/api/config', { lintMaxLineLength: 3 });
  equal(bad.status, 400);
});

test('api: issues create + state transition', async () => {
  const created = await api('POST', '/api/issues', { title: 'API issue' });
  equal(created.status, 200);
  const id = created.json.data.id;
  const moved = await api('POST', `/api/issues/${id}/state`, { state: 'in_progress' });
  equal(moved.status, 200);
  equal(moved.json.data.state, 'in_progress');
});

test('api: export returns full serialized workspace; import restores it', async () => {
  const b = await ensureListening();
  const res = await fetch(b + '/api/export');
  equal(res.status, 200);
  const text = await res.text();
  const parsed = JSON.parse(text);
  equal(parsed.format, 'forge.workspace');
  const imported = await api('POST', '/api/import', { json: parsed });
  equal(imported.status, 200);
  equal(imported.json.ok, true);
});

test('api: reset with seed restores the demo baseline', async () => {
  const { status, json } = await api('POST', '/api/reset', { seed: true });
  equal(status, 200);
  equal(json.data.demo.steps.length, 15);
  assert(ws.tasks.list().length === 0, 'fresh workspace has no tasks until the planner runs');
});

test('api: repo file read/write/delete through endpoints', async () => {
  const put = await api('PUT', '/api/repo/file', { path: 'api-roundtrip.txt', content: 'round trip\n' });
  equal(put.status, 200);
  const get = await api('GET', '/api/repo/file?path=api-roundtrip.txt');
  equal(get.status, 200);
  equal(get.json.data.content, 'round trip\n');
  const del = await api('DELETE', '/api/repo/file?path=api-roundtrip.txt');
  equal(del.status, 200);
  const missing = await api('GET', '/api/repo/file?path=api-roundtrip.txt');
  equal(missing.status, 404);
});

test('api: repo path validation rejects traversal over HTTP', async () => {
  const { status, json } = await api('PUT', '/api/repo/file', { path: '../escape.txt', content: 'x' });
  equal(status, 400);
  equal(json.error.code, 'FORGE_INVALID_INPUT');
});

test('api: static UI entry is served', async () => {
  const b = await ensureListening();
  const res = await fetch(b + '/');
  equal(res.status, 200);
  const type = res.headers.get('content-type') || '';
  assert(type.includes('text/html'), `content type: ${type}`);
  const body = await res.text();
  includes(body, 'FORGE');
});
