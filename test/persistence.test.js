'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, assert, equal, throws, deepEqual, makeWs, makeSeededWs, ADMIN } = require('./lib');
const { Workspace } = require('../server/domain/workspace');
const { Persistence, validateImportedState } = require('../server/domain/persistence');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-persist-'));
}

test('persistence: state is written after mutations and restored on reload', () => {
  const dir = tempDir();
  const ws = new Workspace({ dataDir: dir, skipLoad: true });
  const t = ws.createTask(ADMIN, { title: 'Persisted task', type: 'qa', spec: { suites: ['unit'] } });
  ws.writeFile(ADMIN, 'persisted.txt', 'data\n');
  ws.commit(ADMIN, 'persist commit');
  assert(fs.existsSync(ws.persistence.file), 'state file exists');

  const ws2 = new Workspace({ dataDir: dir }); // loads from disk
  equal(ws2.isLoadedFromDisk(), true);
  equal(ws2.tasks.get(t.id).title, 'Persisted task');
  equal(ws2.tasks.get(t.id).status, 'ready');
  equal(ws2.readFile('persisted.txt'), 'data\n');
  assert(ws2.audit.filter({ action: 'repo.commit' }).length >= 1, 'audit restored');
});

test('persistence: PR and CI state survive a reload', async () => {
  const dir = tempDir();
  const ws = new Workspace({ dataDir: dir, skipLoad: true });
  ws.writeFile(ADMIN, 'baseline.txt', 'root\n');
  ws.commit(ADMIN, 'baseline');
  ws.writeFile(ADMIN, 'tests/unit/smoke.test.js', "it('smoke', () => { assert.ok(true); });\n");
  ws.writeFile(ADMIN, 'tests/integration/smoke.test.js', "it('smoke', () => { assert.ok(true); });\n");
  ws.commit(ADMIN, 'add smoke suites');
  ws.createBranch(ADMIN, 'feature/pr', undefined);
  ws.checkoutBranch(ADMIN, 'feature/pr', {});
  ws.writeFile(ADMIN, 'src/pr.js', "'use strict';\nconst P = 1;\nmodule.exports = { P };\n");
  ws.commit(ADMIN, 'pr commit');
  const pr = ws.openPr(ADMIN, { title: 'Persist PR', sourceBranch: 'feature/pr', targetBranch: 'main' });
  await ws.runCi(ADMIN, { prId: pr.id });
  ws.reviewPr({ type: 'user', id: 'reviewer-1', role: 'reviewer' }, pr.id, { type: 'approve' });

  const ws2 = new Workspace({ dataDir: dir });
  const pr2 = ws2.prs.get(pr.id);
  equal(pr2.state, 'approved');
  equal(pr2.reviews.length, 1);
  equal(ws2.ciRuns.length, 1);
  equal(ws2.ciRuns[0].status, 'success');
  deepEqual(ws2.prs.validApprovals(pr2), ['reviewer-1']);
});

test('persistence: merge state survives a reload', () => {
  const dir = tempDir();
  const ws = new Workspace({ dataDir: dir, skipLoad: true });
  ws.writeFile(ADMIN, 'm.txt', 'a\nb\nc\n');
  ws.commit(ADMIN, 'base');
  ws.createBranch(ADMIN, 'feature/m', undefined);
  ws.checkoutBranch(ADMIN, 'feature/m', {});
  ws.writeFile(ADMIN, 'm.txt', 'a\nOURS\nc\n');
  ws.commit(ADMIN, 'ours');
  ws.checkoutBranch(ADMIN, 'main', {});
  ws.writeFile(ADMIN, 'm.txt', 'a\nTHEIRS\nc\n');
  ws.commit(ADMIN, 'theirs');
  ws.mergeRepo(ADMIN, 'feature/m', {});
  equal(ws.repo.mergeState.status || 'conflict', 'conflict');
  assert(ws.repo.mergeState);

  const ws2 = new Workspace({ dataDir: dir });
  assert(ws2.repo.mergeState, 'merge state restored');
  // repo-side "theirs" is the merged-in feature branch, whose content is OURS
  ws2.resolveConflict(ADMIN, 'm.txt', 'theirs', undefined);
  ws2.completeMerge(ADMIN, 'merged after reload', {});
  includes(ws2.readFile('m.txt'), 'OURS');
  function includes(hay, needle) {
    if (!String(hay).includes(needle)) throw new Error(`expected ${needle} present`);
  }
});

test('persistence: corrupt state file raises a clear IO error', () => {
  const dir = tempDir();
  const ws = new Workspace({ dataDir: dir, skipLoad: true });
  ws.createTask(ADMIN, { title: 'T', type: 'qa' });
  fs.writeFileSync(ws.persistence.file, '{ this is not json !!!', 'utf8');
  throws(() => new Workspace({ dataDir: dir }), 'FORGE_IO');
});

test('persistence: export/import roundtrip preserves the workspace', () => {
  const dir = tempDir();
  const ws = new Workspace({ dataDir: dir, skipLoad: true });
  ws.createTask(ADMIN, { id: 'exp-1', title: 'Exported', type: 'qa', spec: { suites: ['unit'] } });
  ws.writeFile(ADMIN, 'exp.txt', 'x\n');
  ws.commit(ADMIN, 'export commit');
  const json = ws.exportJson();

  const dir2 = tempDir();
  const ws2 = new Workspace({ dataDir: dir2, skipLoad: true });
  ws2.importJson(ADMIN, json);
  equal(ws2.tasks.get('exp-1').title, 'Exported');
  equal(ws2.readFile('exp.txt'), 'x\n');
  equal(ws2.repo.log(1)[0].message, 'export commit');
  assert(ws2.audit.entries.length > 0);
});

test('persistence: importJson rejects malformed payloads', () => {
  const ws = makeWs();
  throws(() => ws.importJson(ADMIN, 'not json {'), 'FORGE_INVALID_INPUT');
  throws(() => ws.importJson(ADMIN, { hello: 1 }), 'FORGE_INVALID_INPUT');
  throws(() => ws.importJson(ADMIN, { format: 'other.workspace', version: 1 }), 'FORGE_INVALID_INPUT');
  throws(() => ws.importJson(ADMIN, { format: 'forge.workspace', version: 99 }), 'FORGE_INVALID_INPUT');
});

test('persistence: validateImportedState accepts proper envelope', () => {
  const data = validateImportedState({ format: 'forge.workspace', version: 1 });
  equal(data.format, 'forge.workspace');
});

test('persistence: clear removes the state file', () => {
  const dir = tempDir();
  const p = new Persistence(dir, 'clear-test.json');
  p.save({ hello: 1 });
  assert(p.exists());
  p.clear();
  equal(p.exists(), false);
});

test('persistence: seeded workspace restores its full scenario state', () => {
  const dir = tempDir();
  const ws = new Workspace({ dataDir: dir, skipLoad: true });
  ws.seedDemo(ADMIN);
  const ws2 = new Workspace({ dataDir: dir });
  equal(ws2.demo.scenario, 'email-normalization');
  equal(ws2.demo.steps.length, 15);
  equal(ws2.tasks.has('demo-plan'), false, 'plan task only exists after the planner step runs');
  equal(ws2.repo.listFiles().length >= 7, true, 'seed files restored');
  equal(ws2.repo.log(5).length, 1, 'seed commit restored');
});

test('persistence: demo progress (step index) survives a reload', async () => {
  const dir = tempDir();
  const ws = new Workspace({ dataDir: dir, skipLoad: true });
  ws.seedDemo(ADMIN);
  await ws.demoNext(ADMIN);
  await ws.demoNext(ADMIN);
  const ws2 = new Workspace({ dataDir: dir });
  equal(ws2.demo.stepIndex, 2);
  equal(ws2.demo.steps[0].status, 'done');
});
