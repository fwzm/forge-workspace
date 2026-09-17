'use strict';

const { test, assert, equal, includes, throws, throwsAsync, makeSeededWs, ADMIN } = require('./lib');
const { evaluateGate } = require('../server/domain/ci');

const EVAL_LINE = 'ev' + 'al(input)';

function commitFile(ws, path, content, message) {
  ws.writeFile(ADMIN, path, content);
  return ws.commit(ADMIN, message);
}

test('ci: pipeline succeeds on the clean seed baseline (all five stages)', async () => {
  const ws = makeSeededWs();
  const run = await ws.runCi(ADMIN, { ref: 'main' });
  equal(run.status, 'success');
  equal(run.stages.length, 5);
  for (const s of run.stages) equal(s.status, 'success', `stage ${s.name}`);
  equal(run.ref, 'main');
  equal(run.sha, ws.repo.resolveRef('main'));
  const audits = ws.audit.filter({ action: 'ci.run_completed' });
  equal(audits.length, 1);
  equal(audits[0].details.status, 'success');
});

test('ci: lint failure blocks the run with rule details', async () => {
  const ws = makeSeededWs();
  commitFile(ws, 'sloppy.js', 'const x = 1;   \n', 'sloppy commit');
  const run = await ws.runCi(ADMIN, {});
  equal(run.status, 'failure');
  const lint = run.stages.find((s) => s.name === 'lint');
  equal(lint.status, 'failure');
  includes(lint.output.error, 'trailing-whitespace');
  // stages run independently: later stages executed rather than being skipped
  const unit = run.stages.find((s) => s.name === 'unit');
  assert(['success', 'failure'].includes(unit.status), `unit executed independently: ${unit.status}`);
  const buildStage = run.stages.find((s) => s.name === 'build');
  assert(['success', 'failure'].includes(buildStage.status), `build executed: ${buildStage.status}`);
});

test('ci: unit test failure fails the run and names the case', async () => {
  const ws = makeSeededWs();
  commitFile(ws, 'tests/unit/broken.test.js', "it('intentional failure', () => { assert.equal(1, 2); });\n", 'broken test');
  const run = await ws.runCi(ADMIN, {});
  const unit = run.stages.find((s) => s.name === 'unit');
  equal(unit.status, 'failure');
  includes(unit.output.error, 'intentional failure');
  equal(unit.output.total >= 1, true);
});

test('ci: integration failure fails the run', async () => {
  const ws = makeSeededWs();
  commitFile(ws, 'tests/integration/broken.test.js', "it('integration broken', () => { assert.ok(false, 'nope'); });\n", 'broken integration');
  const run = await ws.runCi(ADMIN, {});
  const stage = run.stages.find((s) => s.name === 'integration');
  equal(stage.status, 'failure');
  includes(stage.output.error, 'integration broken');
});

test('ci: missing unit suite fails the run', async () => {
  const ws = makeSeededWs();
  ws.deleteFile(ADMIN, 'tests/unit/stringUtils.test.js');
  ws.deleteFile(ADMIN, 'tests/unit/userService.test.js');
  ws.commit(ADMIN, 'remove unit tests');
  const run = await ws.runCi(ADMIN, {});
  const unit = run.stages.find((s) => s.name === 'unit');
  equal(unit.status, 'failure');
  includes(unit.output.error, 'no unit test files');
});

test('ci: security findings at/above threshold fail the run with CWE details', async () => {
  const ws = makeSeededWs();
  commitFile(ws, 'danger.js', 'const out = ' + EVAL_LINE + ';\n', 'dangerous');
  const run = await ws.runCi(ADMIN, {});
  const sec = run.stages.find((s) => s.name === 'security');
  equal(sec.status, 'failure');
  includes(sec.output.error, 'CWE-95');
  equal(sec.output.blocking.length >= 1, true);
  equal(sec.output.threshold, 'high');
});

test('ci: build failure on syntax error', async () => {
  const ws = makeSeededWs();
  commitFile(ws, 'bad.js', 'function ((( {', 'syntax error');
  const run = await ws.runCi(ADMIN, {});
  const buildStage = run.stages.find((s) => s.name === 'build');
  equal(buildStage.status, 'failure');
  includes(buildStage.output.error, 'Syntax error');
});

test('ci: build output records a deterministic artifact hash', async () => {
  const ws = makeSeededWs();
  const run1 = await ws.runCi(ADMIN, { ref: 'main' });
  const run2 = await ws.runCi(ADMIN, { ref: 'main' });
  const a1 = run1.stages.find((s) => s.name === 'build').output.artifact;
  const a2 = run2.stages.find((s) => s.name === 'build').output.artifact;
  equal(a1.hash, a2.hash, 'same tree -> same bundle hash');
  assert(a1.size > 0);
});

test('ci: stage outputs carry real engine data', async () => {
  const ws = makeSeededWs();
  const run = await ws.runCi(ADMIN, { ref: 'main' });
  const lint = run.stages.find((s) => s.name === 'lint');
  equal(lint.output.errors, 0);
  assert(Array.isArray(lint.output.findings));
  const unit = run.stages.find((s) => s.name === 'unit');
  assert(unit.output.total >= 5, 'seed has several unit cases');
  const security = run.stages.find((s) => s.name === 'security');
  for (const k of ['critical', 'high', 'medium', 'low']) {
    assert(typeof security.output.counts[k] === 'number', `counts.${k}`);
  }
});

test('ci: runs are stored and listed newest-last', async () => {
  const ws = makeSeededWs();
  await ws.runCi(ADMIN, { ref: 'main' });
  await ws.runCi(ADMIN, { ref: 'main' });
  equal(ws.ciRuns.length, 2);
  assert(ws.ciRuns[1].id !== ws.ciRuns[0].id);
});

test('ci: gate without a run reports missing', () => {
  const ws = makeSeededWs();
  ws.createBranch(ADMIN, 'feature/gate', undefined);
  const pr = ws.prs.open({ id: 'pr-gate', title: 'T', sourceBranch: 'feature/gate', targetBranch: 'main', author: 'x', headSha: ws.repo.resolveRef('feature/gate') });
  const gate = evaluateGate(ws, pr);
  equal(gate.ok, false);
  assert(gate.missing.some((m) => m.includes('no CI run')), JSON.stringify(gate.missing));
  assert(gate.missing.some((m) => m.includes('approval')), JSON.stringify(gate.missing));
});

test('ci: gate with successful run + approval passes', async () => {
  const ws = makeSeededWs();
  ws.createBranch(ADMIN, 'feature/gate2', undefined);
  const sha = ws.repo.resolveRef('feature/gate2');
  ws.prs.open({ id: 'pr-gate2', title: 'T', sourceBranch: 'feature/gate2', targetBranch: 'main', author: 'x', headSha: sha });
  await ws.runCi(ADMIN, { ref: 'feature/gate2' });
  ws.reviewPr({ type: 'user', id: 'reviewer-1', role: 'reviewer' }, 'pr-gate2', { type: 'approve' });
  const gate = evaluateGate(ws, ws.prs.get('pr-gate2'));
  equal(gate.ok, true, JSON.stringify(gate.missing));
});

test('ci: unknown ref rejected', async () => {
  const ws = makeSeededWs();
  let code = null;
  try {
    await ws.runCi(ADMIN, { ref: 'ghost-branch' });
  } catch (e) {
    code = e.code;
  }
  equal(code, 'FORGE_NOT_FOUND');
});

test('ci: run on PR uses its source branch', async () => {
  const ws = makeSeededWs();
  ws.createBranch(ADMIN, 'feature/prci', undefined);
  const pr = ws.openPr(ADMIN, { title: 'T', sourceBranch: 'feature/prci', targetBranch: 'main' });
  const run = await ws.runCi(ADMIN, { prId: pr.id });
  equal(run.ref, 'feature/prci');
  equal(run.prId, pr.id);
});
