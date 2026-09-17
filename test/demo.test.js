'use strict';

const { test, assert, equal, includes, makeWs, ADMIN } = require('./lib');
const demo = require('../server/demo/demo');

test('demo: seed resets stores and installs the 15-step scenario', () => {
  const ws = makeWs();
  const st = demo.seed(ws, ADMIN);
  equal(st.scenario, 'email-normalization');
  equal(st.steps.length, 15);
  equal(st.stepIndex, 0);
  equal(ws.repo.listFiles().length >= 7, true, 'seed files present');
  equal(ws.repo.log(1)[0].message, 'chore: seed demo-app baseline');
  equal(ws.tasks.has('demo-plan'), false, 'plan task only exists after step 2');
  assert(ws.demo.steps.every((s) => s.status === 'pending'));
});

test('demo: step 1 reports the issue', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  const r = await demo.next(ws, ADMIN);
  equal(r.ok, true);
  equal(r.index, 0);
  assert(ws.issues.length === 1);
  includes(ws.issues[0].title, 'email normalization');
});

test('demo: step 2 planner splits the issue into a real DAG', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  await demo.next(ws, ADMIN);
  await demo.next(ws, ADMIN);
  const ids = ws.demo.context.taskIds;
  const impl = ws.tasks.get(ids.implement);
  const qa = ws.tasks.get(ids.qa);
  const sec = ws.tasks.get(ids.security);
  const rev = ws.tasks.get(ids.review);
  equal(impl.status, 'ready');
  equal(qa.status, 'blocked');
  equal(sec.status, 'blocked');
  equal(rev.status, 'blocked');
  assert(qa.dependencies.includes(impl.id));
  assert(sec.dependencies.includes(impl.id));
  assert(rev.dependencies.includes(qa.id) && rev.dependencies.includes(sec.id));
  equal(ws.tasks.get('demo-plan').status, 'completed');
  assert(ws.messages.filter((m) => m.agent === 'agent-planner').length >= 2, 'planner posted protocol messages');
});

test('demo: steps 3-5 implementation v1, QA failure, security failure', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  for (let i = 0; i < 3; i++) await demo.next(ws, ADMIN);
  const ids = ws.demo.context.taskIds;
  equal(ws.tasks.get(ids.implement).status, 'completed');
  assert(ws.repo.branches.has('feature/email-normalization'));
  const feature = ws.repo.snapshot('feature/email-normalization')['src/userService.js'];
  includes(feature, 'normalizeEmail');
  includes(feature, 'sk-live-');
  for (let i = 0; i < 2; i++) await demo.next(ws, ADMIN);
  equal(ws.tasks.get(ids.qa).status, 'failed', 'unit test fails on v1');
  includes(ws.tasks.get(ids.qa).lastError, 'qa suite "unit" failed');
  equal(ws.tasks.get(ids.security).status, 'failed', 'credential detected on v1');
  includes(ws.tasks.get(ids.security).lastError, 'CWE-798');
});

test('demo: steps 6-8 fixes land and QA/security pass', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  for (let i = 0; i < 8; i++) await demo.next(ws, ADMIN);
  const ids = ws.demo.context.taskIds;
  equal(ws.tasks.get(ids.qa).status, 'completed');
  equal(ws.tasks.get(ids.security).status, 'completed');
  const feature = ws.repo.snapshot('feature/email-normalization')['src/userService.js'];
  assert(!feature.includes('sk-live-'), 'credential removed in v2');
});

test('demo: step 9 opens the PR, step 10 reviewer requests changes', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  for (let i = 0; i < 10; i++) await demo.next(ws, ADMIN);
  const pr = ws.prs.get(ws.demo.context.prId);
  equal(pr.state, 'changes_requested');
  const review = pr.reviews[pr.reviews.length - 1];
  equal(review.type, 'request_changes');
  assert(review.findings.some((f) => f.severity === 'major' && f.category === 'error-handling'), 'empty catch flagged');
  equal(ws.tasks.get(ws.demo.context.taskIds.review).status, 'failed', 'review gate task fails on request_changes');
});

test('demo: steps 11-12 v3 fixes review findings, reviewer approves', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  for (let i = 0; i < 12; i++) await demo.next(ws, ADMIN);
  const pr = ws.prs.get(ws.demo.context.prId);
  equal(pr.state, 'approved');
  const feature = ws.repo.snapshot('feature/email-normalization')['src/userService.js'];
  assert(!/catch\s*\([^)]*\)\s*\{\s*\}/.test(feature), 'empty catch gone in v3');
});

test('demo: step 13 CI all green on PR head', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  for (let i = 0; i < 13; i++) await demo.next(ws, ADMIN);
  const run = ws.ciRuns[ws.ciRuns.length - 1];
  equal(run.status, 'success');
  equal(run.sha, ws.prs.get(ws.demo.context.prId).headSha);
  for (const s of run.stages) equal(s.status, 'success', `stage ${s.name}`);
});

test('demo: steps 14-15 merge gated by checks+approval, then verified', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  for (let i = 0; i < 15; i++) await demo.next(ws, ADMIN);
  const pr = ws.prs.get(ws.demo.context.prId);
  equal(pr.state, 'merged');
  assert(pr.mergeCommit);
  equal(ws.repo.commits.get(pr.mergeCommit).parents.length, 2);
  const main = ws.repo.snapshot('main')['src/userService.js'];
  includes(main, 'normalizeEmail');
  assert(!main.includes('sk-live-'));
  equal(ws.issues[0].state, 'resolved');
  const last = ws.demo.steps[14];
  equal(last.status, 'done');
});

test('demo: runAll completes the whole scenario in one call', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  const last = await demo.runAll(ws, ADMIN);
  equal(last.done, true);
  equal(ws.demo.stepIndex, 15);
  assert(ws.demo.steps.every((s) => s.status === 'done'), JSON.stringify(ws.demo.steps.filter((s) => s.status !== 'done')));
  const audits = ws.audit.filter({ action: 'demo.step' });
  equal(audits.length, 15);
});

test('demo: next() after completion reports done', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  await demo.runAll(ws, ADMIN);
  const r = await demo.next(ws, ADMIN);
  equal(r.done, true);
});

test('demo: next() without seed fails clearly', async () => {
  const ws = makeWs();
  let code = null;
  try {
    await demo.next(ws, ADMIN);
  } catch (e) {
    code = e.code;
  }
  equal(code, 'FORGE_STATE');
});

test('demo: agent messages follow the unified protocol fields', async () => {
  const ws = makeWs();
  demo.seed(ws, ADMIN);
  await demo.runAll(ws, ADMIN);
  for (const m of ws.messages) {
    for (const key of ['id', 'agent', 'timestamp', 'task', 'status', 'input', 'output', 'artifacts', 'dependencies']) {
      assert(Object.prototype.hasOwnProperty.call(m, key), `message missing ${key}`);
    }
    assert(m.agent && m.timestamp > 0);
    assert(Array.isArray(m.artifacts));
    assert(Array.isArray(m.dependencies));
  }
  assert(ws.messages.length >= 10, 'planner/impl/qa/security/reviewer all posted');
});
