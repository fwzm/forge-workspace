'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, equal, includes, throws, makeWs, makeSeededWs, ADMIN } = require('./lib');
const exchange = require('../server/orchestration/export');
const {
  registerFakeAdapter,
  getAdapter,
  buildImplementPrompt,
  buildReviewPrompt,
  parseReviewReply,
  resolveBin,
} = require('../server/orchestration/adapters');

// -- export.js (sandboxed snapshot exchange) ----------------------------------

test('orchestration/export: safeJoin rejects traversal and absolute paths', () => {
  const dir = exchange.newWorkDir('t');
  throws(() => exchange.safeJoin(dir, '../escape.txt'), /unsafe export path/);
  throws(() => exchange.safeJoin(dir, 'C:/windows/system32'), /unsafe export path/);
  throws(() => exchange.safeJoin(dir, 'a/../../b'), /unsafe export path/);
  equal(exchange.safeJoin(dir, 'src/app.js'), path.resolve(dir, 'src/app.js'));
  exchange.cleanup(dir);
});

test('orchestration/export: snapshot roundtrip detects modified/added/deleted', () => {
  const dir = exchange.newWorkDir('roundtrip');
  const snap = {
    'README.md': 'hello\n',
    'src/a.js': 'const a = 1;\n',
    'src/gone.txt': 'bye\n',
  };
  exchange.exportSnapshot(dir, snap, '# TASK\nbrief');
  // "agent" edits: modify, add, delete
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'const a = 2;\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/new.js'), 'const n = 1;\n', 'utf8');
  fs.unlinkSync(path.join(dir, 'src/gone.txt'));
  const changes = exchange.collectChanges(dir, snap);
  equal(changes.empty, false);
  equal(changes.modified['src/a.js'], 'const a = 2;\n');
  equal(changes.added['src/new.js'], 'const n = 1;\n');
  equal(changes.deleted.length, 1);
  equal(changes.deleted[0], 'src/gone.txt');
  // TASK.md brief never leaks into the changeset
  assert(!Object.keys(changes.added).includes('TASK.md'));
  assert(exchange.cleanup(dir));
  equal(fs.existsSync(dir), false, 'temp dir removed');
});

test('orchestration/export: unchanged tree reports empty changeset', () => {
  const dir = exchange.newWorkDir('empty');
  const snap = { 'a.txt': 'x\n' };
  exchange.exportSnapshot(dir, snap, 'brief');
  const changes = exchange.collectChanges(dir, snap);
  equal(changes.empty, true);
  exchange.cleanup(dir);
});

// -- adapters.js (prompts + parsing) -------------------------------------------

test('orchestration/adapters: implement prompt carries the task and file list', () => {
  const prompt = buildImplementPrompt(
    { title: 'Add a shout() helper', description: 'upper-case a string', spec: { instructions: 'keep it pure' } },
    { 'src/a.js': 'x', 'tests/unit/a.test.js': 'y' },
  );
  includes(prompt, 'Add a shout() helper');
  includes(prompt, 'upper-case a string');
  includes(prompt, 'keep it pure');
  includes(prompt, '- src/a.js');
  includes(prompt, '- tests/unit/a.test.js');
  includes(prompt, 'isolated snapshot');
});

test('orchestration/adapters: review prompt demands the JSON schema', () => {
  const prompt = buildReviewPrompt(
    { title: 'T', sourceBranch: 'b', targetBranch: 'main' },
    '+++ b/f\n+new line\n',
  );
  includes(prompt, '"decision":"approve|request_changes"');
  includes(prompt, '"severity":"major|minor"');
  includes(prompt, '+++ b/f');
});

test('orchestration/adapters: parseReviewReply handles clean/fenced/noisy input', () => {
  const verdict = { decision: 'approve', comment: 'ok', findings: [{ severity: 'minor', file: 'a.js', line: 1, message: 'nit', suggestion: 'none' }] };
  equal(parseReviewReply(JSON.stringify(verdict)).decision, 'approve');
  equal(parseReviewReply('```json\n' + JSON.stringify(verdict) + '\n```').decision, 'approve');
  equal(parseReviewReply('Sure! Here is my review:\n' + JSON.stringify(verdict) + '\nhth').decision, 'approve');
  const rc = parseReviewReply(JSON.stringify({ decision: 'request_changes', comment: 'no', findings: [] }));
  equal(rc.decision, 'request_changes');
  equal(parseReviewReply('I could not produce JSON'), null);
  equal(parseReviewReply('{"decision":"maybe"}'), null);
  equal(parseReviewReply('garbage { broken'), null);
});

test('orchestration/adapters: resolveBin finds node itself', () => {
  const bin = resolveBin('node');
  assert(bin, 'node must be resolvable');
  assert(/node(\.exe)?$/.test(bin), bin);
});

test('orchestration/adapters: fake adapter registry works', async () => {
  registerFakeAdapter('testfake', () => ({ stdout: 'custom transcript' }));
  const adapter = getAdapter('testfake');
  equal(adapter.kind, 'fake');
  const res = await adapter.runTask({ workDir: os.tmpdir(), prompt: 'p' });
  equal(res.ok, true);
  equal(res.stdout, 'custom transcript');
});

// -- orchestrator full pipeline (fake agents, real engines) --------------------

// A deterministic "implementer": adds a pure shout() helper (lint-clean,
// existing tests stay green) plus one new file.
function fakeImplementer(ctx) {
  const utilPath = path.join(ctx.workDir, 'src', 'stringUtils.js');
  const before = fs.readFileSync(utilPath, 'utf8');
  const after = before.replace(
    'module.exports = { capitalize, slugify };',
    'function shout(text) {\n  return String(text || \'\').toUpperCase();\n}\n\nmodule.exports = { capitalize, slugify, shout };',
  );
  fs.writeFileSync(utilPath, after, 'utf8');
  fs.mkdirSync(path.join(ctx.workDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.workDir, 'docs', 'CHANGE.md'), 'added shout()\n', 'utf8');
}

function fakeApprover() {
  return { stdout: JSON.stringify({ decision: 'approve', comment: 'looks good', findings: [] }) };
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

test('orchestration: full pipeline with fake agents reaches the human merge gate', async () => {
  registerFakeAdapter('fakeimpl', fakeImplementer);
  registerFakeAdapter('fakereview', fakeApprover);
  const ws = makeSeededWs();
  // Only dirs created by THIS run count: pre-existing pollution (e.g. from a
  // killed earlier run) must not fail the cleanup assertion.
  const dirsBefore = new Set(fs.readdirSync(os.tmpdir()));
  const summary = ws.orchestrateIssue(ADMIN, {
    title: 'Add a shout() helper to stringUtils',
    description: 'needs an upper-case helper',
    backend: 'fakeimpl',
    reviewBackend: 'fakereview',
  });
  equal(summary.mergeGate, 'human');
  equal(summary.backend, 'fakeimpl');
  assert(summary.branch.startsWith('pipeline/'), summary.branch);

  await waitFor(() => {
    const review = ws.tasks.get(summary.tasks.review);
    return ['completed', 'failed'].includes(review.status);
  }, 8000, 'review task completion');

  const impl = ws.tasks.get(summary.tasks.implement);
  const qa = ws.tasks.get(summary.tasks.qa);
  const security = ws.tasks.get(summary.tasks.security);
  const review = ws.tasks.get(summary.tasks.review);
  equal(impl.status, 'completed', `impl: ${impl.lastError}`);
  equal(qa.status, 'completed', `qa: ${qa.lastError}`);
  equal(security.status, 'completed', `security: ${security.lastError}`);
  equal(review.status, 'completed', `review: ${review.lastError}`);

  // External implementer went through the patch pipeline: branch + commit + files
  const out = impl.result;
  assert(out.commit, 'implement produced a commit');
  includes(JSON.stringify(out.files), 'src/stringUtils.js');
  includes(ws.repo.snapshot(summary.branch)['src/stringUtils.js'], 'function shout');
  assert(ws.repo.snapshot(summary.branch)['docs/CHANGE.md'], 'new file landed');

  // Review opened the PR, approved it, CI ran green — but did NOT merge (gate)
  const prId = review.result.prId;
  const pr = ws.prs.get(prId);
  equal(pr.state, 'approved', `PR state: ${pr.state}`);
  equal(review.result.mergeState, 'awaiting-human-merge');
  equal(review.result.ci, 'success');
  const approveReview = pr.reviews.find((r) => r.type === 'approve');
  assert(approveReview, 'external approval recorded');
  equal(approveReview.reviewer.startsWith('agent-'), true);

  // Human gate: the user merges manually and it succeeds
  ws.mergePr(ADMIN, prId);
  equal(ws.prs.get(prId).state, 'merged');
  includes(ws.repo.snapshot('main')['src/stringUtils.js'], 'function shout');

  // Audit trail covers the orchestration
  const actions = ws.audit.filter({ action: 'orchestrator.' }).map((e) => e.action);
  includes(actions.join(','), 'orchestrator.pipeline_started');

  // The sandbox temp dirs are gone (only dirs created by this run).
  const leftovers = fs.readdirSync(os.tmpdir())
    .filter((d) => !dirsBefore.has(d))
    .filter((d) => d.startsWith('forge-fakeimpl-') || d.startsWith('forge-review-'));
  equal(leftovers.length, 0, `leftover temp dirs: ${leftovers.join(',')}`);
});

test('orchestration: autoMergeExternal=true merges without a human', async () => {
  registerFakeAdapter('fakeimpl', fakeImplementer);
  registerFakeAdapter('fakereview', fakeApprover);
  const ws = makeSeededWs();
  ws.updateConfig(ADMIN, { autoMergeExternal: true });
  const summary = ws.orchestrateIssue(ADMIN, {
    title: 'Add shout helper (auto-merge)',
    backend: 'fakeimpl',
    reviewBackend: 'fakereview',
  });
  await waitFor(() => ['completed', 'failed'].includes(ws.tasks.get(summary.tasks.review).status), 8000, 'review completion');
  equal(ws.tasks.get(summary.tasks.review).status, 'completed', ws.tasks.get(summary.tasks.review).lastError);
  const pr = ws.prs.get(ws.tasks.get(summary.tasks.review).result.prId);
  equal(pr.state, 'merged', 'auto-merged');
  equal(ws.issues.find((i) => i.id === summary.issueId).state, 'resolved');
});

test('orchestration: request_changes gates the review task and records findings', async () => {
  registerFakeAdapter('fakeimpl', fakeImplementer);
  registerFakeAdapter('pickyreview', () => ({
    stdout: JSON.stringify({
      decision: 'request_changes',
      comment: 'needs tests',
      findings: [{ severity: 'major', file: 'src/stringUtils.js', line: 1, category: 'testing', message: 'no test for shout', suggestion: 'add one' }],
    }),
  }));
  const ws = makeSeededWs();
  const summary = ws.orchestrateIssue(ADMIN, { title: 'Add shout helper (RC)', backend: 'fakeimpl', reviewBackend: 'pickyreview' });
  await waitFor(() => ['completed', 'failed'].includes(ws.tasks.get(summary.tasks.review).status), 8000, 'review completion');
  const review = ws.tasks.get(summary.tasks.review);
  equal(review.status, 'failed', 'RC fails the review gate task');
  includes(review.lastError, 'review gate not passed');
  const prId = review.spec.prId;
  const pr = ws.prs.get(prId);
  equal(pr.state, 'changes_requested');
  assert(pr.reviews.some((r) => r.type === 'request_changes' && r.findings.length === 1));
});

test('orchestration: empty agent output fails the task (no silent no-op)', async () => {
  registerFakeAdapter('noopagent', () => { /* produces nothing */ });
  const ws = makeSeededWs();
  const summary = ws.orchestrateIssue(ADMIN, { title: 'Do nothing at all', backend: 'noopagent' });
  await waitFor(() => ['completed', 'failed'].includes(ws.tasks.get(summary.tasks.implement).status), 8000, 'implement completion');
  const impl = ws.tasks.get(summary.tasks.implement);
  equal(impl.status, 'failed');
  includes(impl.lastError, 'no changes');
});

test('orchestration: circuit breaker pauses the auto-scheduler after 3 external failures', async () => {
  registerFakeAdapter('brokenagent', () => { throw new Error('adapter exploded'); });
  const ws = makeSeededWs();
  equal(ws.config.autoScheduler, false);
  // Three orchestrated issues, each failing once in its external implement task.
  for (let i = 0; i < 3; i++) {
    ws.orchestrateIssue(ADMIN, { title: `Break things #${i}`, backend: 'brokenagent' });
    await waitFor(() => ws.tasks.list().some((t) => t.type === 'implement' && t.title.includes(`#${i}`) && t.status === 'failed'), 8000, `implement #${i} failure`);
  }
  const breaker = ws.audit.filter({ action: 'orchestrator.circuit_breaker' });
  assert(breaker.length >= 1, 'breaker audited');
  equal(ws.config.autoScheduler, false, 'scheduler disabled by the breaker');
});

test('orchestration: external tasks lazily register a backend-bound agent', () => {
  registerFakeAdapter('fakeimpl', fakeImplementer);
  const ws = makeWs();
  const t = ws.createTask(ADMIN, {
    title: 'External task without a pre-registered agent',
    type: 'implement',
    spec: { backend: 'fakeimpl', branch: 'feature/x' },
  });
  const runP = ws.runTask(ADMIN, t.id);
  assert(ws.agents.list().some((a) => a.backend === 'fakeimpl' && a.type === 'implement'), 'backend-bound agent auto-registered');
  return runP.then((done) => {
    equal(done.status, 'failed', 'no seeded repo on this ws: commit fails, but routing worked');
    assert(/not found|no changes|failed/i.test(done.lastError), `failure is from the pipeline, not routing: ${done.lastError}`);
  });
});
