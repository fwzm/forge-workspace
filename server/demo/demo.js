'use strict';

const { Repository } = require('../domain/repo');
const { TaskGraph } = require('../domain/tasks');
const { AgentRegistry } = require('../domain/agents');
const { PullRequests } = require('../domain/pr');
const { AuditLog } = require('../domain/audit');
const { SEED_FILES, USER_SERVICE_V1, USER_SERVICE_V2, USER_SERVICE_V3, UNIT_USER_SERVICE_NORMALIZE } = require('./files');

const SCENARIO = 'email-normalization';

const DEMO_USER = { type: 'user', id: 'admin', role: 'admin' };

// ---------------------------------------------------------------------------
// Demo scenario: every step goes through real workspace APIs and produces real
// state changes (no timers, no canned animation). Steps are re-entrant by index
// so the UI can advance one at a time or run all.
// ---------------------------------------------------------------------------
const STEPS = [
  { name: 'Report issue: "Add email normalization to user service"', run: stepIssue },
  { name: 'Planner agent splits the issue into a task DAG', run: stepPlan },
  { name: 'Implementation agent writes v1 (buggy) on a feature branch', run: stepImplV1 },
  { name: 'QA agent runs unit+integration suites -> FAILURE', run: stepQa1 },
  { name: 'Security agent scans the branch -> FAILURE (hardcoded credential)', run: stepSec1 },
  { name: 'Implementation agent ships v2: strict validation, secret removed', run: stepImplV2 },
  { name: 'QA retry -> PASS', run: stepQa2 },
  { name: 'Security retry -> PASS', run: stepSec2 },
  { name: 'Open pull request feature/email-normalization -> main', run: stepOpenPr },
  { name: 'Reviewer reviews v2 -> REQUEST CHANGES (empty catch block)', run: stepReview1 },
  { name: 'Implementation agent ships v3: errors propagate', run: stepImplV3 },
  { name: 'Reviewer re-reviews v3 -> APPROVED', run: stepReview2 },
  { name: 'CI pipeline on PR head (lint, unit, integration, security, build)', run: stepCi },
  { name: 'Merge PR (gate: required checks + at least one approval)', run: stepMerge },
  { name: 'Verify end state (main contains v3, PR merged, DAG completed)', run: stepVerify },
];

function assert(cond, message) {
  if (!cond) throw new Error(`demo invariant failed: ${message}`);
}

async function stepIssue(ws) {
  const issue = ws.createIssue(DEMO_USER, {
    title: 'Add email normalization to user service',
    body: 'Emails must be stored trimmed and lowercase; invalid addresses must be rejected with a clear error.',
    labels: ['enhancement', 'backend'],
  });
  ws.demo.context = { issueId: issue.id };
  return { issueId: issue.id, title: issue.title };
}

async function stepPlan(ws) {
  const { issueId } = ws.demo.context;
  const planTask = ws.createTask(DEMO_USER, {
    id: 'demo-plan',
    title: 'Plan: email normalization',
    type: 'plan',
    spec: {
      issueId,
      breakdown: [
        {
          key: 'implement',
          title: 'Implement email normalization',
          type: 'implement',
          description: 'Branch + code change for email normalization.',
          spec: {
            issueId,
            branch: 'feature/email-normalization',
            files: {
              'src/userService.js': USER_SERVICE_V1,
              'tests/unit/userService.normalize.test.js': UNIT_USER_SERVICE_NORMALIZE,
            },
            message: 'feat(user): email normalization (first pass)',
          },
        },
        {
          key: 'qa',
          title: 'QA: run unit & integration suites',
          type: 'qa',
          deps: ['implement'],
          spec: { suites: ['unit', 'integration'], branch: 'feature/email-normalization' },
        },
        {
          key: 'security',
          title: 'Security: scan feature branch',
          type: 'security',
          deps: ['implement'],
          spec: { branch: 'feature/email-normalization' },
        },
        {
          key: 'review',
          title: 'Review PR: email normalization',
          type: 'review',
          deps: ['qa', 'security'],
          spec: { prId: null },
        },
      ],
    },
  });
  const done = await ws.runTask(DEMO_USER, planTask.id);
  assert(done.status === 'completed', `plan task expected completed, got ${done.status}`);
  const created = (done.result && done.result.tasks) || [];
  assert(created.length === 4, `planner expected 4 tasks, created ${created.length}`);
  const ids = {};
  for (const t of created) {
    if (t.type === 'implement') ids.implement = t.id;
    if (t.type === 'qa') ids.qa = t.id;
    if (t.type === 'security') ids.security = t.id;
    if (t.type === 'review') ids.review = t.id;
  }
  ws.demo.context.taskIds = ids;
  // DAG sanity: implement is the root worker; qa+security depend on it; review on both.
  const impl = ws.tasks.get(ids.implement);
  const qa = ws.tasks.get(ids.qa);
  const sec = ws.tasks.get(ids.security);
  const rev = ws.tasks.get(ids.review);
  assert(qa.dependencies.includes(impl.id), 'qa must depend on implement');
  assert(sec.dependencies.includes(impl.id), 'security must depend on implement');
  assert(rev.dependencies.includes(qa.id) && rev.dependencies.includes(sec.id), 'review must depend on qa+security');
  return { planTask: planTask.id, tasks: created, issueId };
}

async function stepImplV1(ws) {
  const ids = ws.demo.context.taskIds;
  const done = await ws.runTask(DEMO_USER, ids.implement);
  assert(done.status === 'completed', `implement v1 expected completed, got ${done.status}`);
  const out = done.result;
  assert(ws.repo.branches.has('feature/email-normalization'), 'feature branch must exist');
  assert(out.commit, 'implement must produce a commit');
  ws.demo.context.v1Commit = out.commit;
  return { branch: out.branch, commit: out.commit, files: out.files };
}

async function stepQa1(ws) {
  const ids = ws.demo.context.taskIds;
  const done = await ws.runTask(DEMO_USER, ids.qa);
  assert(done.status === 'failed', `QA expected FAILED on v1, got ${done.status}`);
  assert(/qa suite "unit" failed/.test(done.lastError || ''), `QA error should name the unit suite, got: ${done.lastError}`);
  ws.demo.context.qaError = done.lastError;
  return { expected: 'failure', error: done.lastError };
}

async function stepSec1(ws) {
  const ids = ws.demo.context.taskIds;
  const done = await ws.runTask(DEMO_USER, ids.security);
  assert(done.status === 'failed', `security expected FAILED on v1, got ${done.status}`);
  assert(/CWE-798/.test(done.lastError || ''), `security error should cite CWE-798, got: ${done.lastError}`);
  ws.demo.context.secError = done.lastError;
  return { expected: 'failure', error: done.lastError };
}

async function stepImplV2(ws) {
  const ids = ws.demo.context.taskIds;
  const prev = ws.tasks.get(ids.implement);
  const branch = 'feature/email-normalization';
  // a follow-up implementation task addresses the QA + security findings
  // (the v1 task already completed; the FSM keeps completed tasks terminal)
  const fixTask = ws.createTask(DEMO_USER, {
    title: 'Address QA & security findings (v2)',
    type: 'implement',
    spec: {
      ...prev.spec,
      files: { 'src/userService.js': USER_SERVICE_V2 },
      message: 'fix(user): validate emails strictly, drop embedded credential',
    },
  });
  const done = await ws.runTask(DEMO_USER, fixTask.id);
  assert(done.status === 'completed', `implement v2 expected completed, got ${done.status}`);
  ws.demo.context.impl2 = fixTask.id;
  ws.demo.context.v2Commit = done.result.commit;
  return { branch, commit: done.result.commit };
}

async function stepQa2(ws) {
  const ids = ws.demo.context.taskIds;
  ws.retryTask(DEMO_USER, ids.qa);
  const done = await ws.runTask(DEMO_USER, ids.qa);
  assert(done.status === 'completed', `QA retry expected PASS, got ${done.status}`);
  assert(done.result && done.result.failed === 0, 'QA result must have zero failures');
  ws.demo.context.qaPassed = done.result.passed;
  return { passed: done.result.passed, failed: done.result.failed };
}

async function stepSec2(ws) {
  const ids = ws.demo.context.taskIds;
  ws.retryTask(DEMO_USER, ids.security);
  const done = await ws.runTask(DEMO_USER, ids.security);
  assert(done.status === 'completed', `security retry expected PASS, got ${done.status}`);
  return { counts: done.result.counts, threshold: done.result.threshold };
}

async function stepOpenPr(ws) {
  const pr = ws.openPr(DEMO_USER, {
    title: 'Normalize user emails',
    sourceBranch: 'feature/email-normalization',
    targetBranch: 'main',
    description: 'Adds strict email normalization with validation. Resolves the reported issue.',
  });
  const ids = ws.demo.context.taskIds;
  ws.setTaskSpec(DEMO_USER, ids.review, { prId: pr.id });
  ws.demo.context.prId = pr.id;
  // meanwhile main advances (someone else lands a changelog entry), so the
  // eventual merge exercises a real 3-way merge instead of a fast-forward
  ws.checkoutBranch(DEMO_USER, 'main', {});
  ws.writeFile(DEMO_USER, 'CHANGELOG.md', '## Unreleased\n- email normalization (in review)\n');
  ws.commit(DEMO_USER, 'docs: changelog entry while PR is open');
  ws.checkoutBranch(DEMO_USER, 'feature/email-normalization', {});
  return { prId: pr.id, state: pr.state, headSha: pr.headSha };
}

async function stepReview1(ws) {
  const ids = ws.demo.context.taskIds;
  const done = await ws.runTask(DEMO_USER, ids.review);
  assert(done.status === 'failed', `review gate expected FAILED on v2, got ${done.status}`);
  const pr = ws.prs.get(ws.demo.context.prId);
  assert(pr.state === 'changes_requested', `PR expected changes_requested, got ${pr.state}`);
  const review = pr.reviews[pr.reviews.length - 1];
  const findings = review.findings || [];
  assert(findings.some((f) => f.category === 'error-handling' && f.severity === 'major'), 'reviewer must flag the empty catch as major');
  ws.demo.context.reviewFindings = findings;
  return { decision: 'request_changes', majors: findings.filter((f) => f.severity === 'major').length, findings };
}

async function stepImplV3(ws) {
  const ids = ws.demo.context.taskIds;
  const prev = ws.tasks.get(ids.implement);
  const fixTask = ws.createTask(DEMO_USER, {
    title: 'Address review feedback (v3)',
    type: 'implement',
    spec: {
      ...prev.spec,
      files: { 'src/userService.js': USER_SERVICE_V3 },
      message: 'fix(user): propagate email validation errors (review feedback)',
    },
  });
  const done = await ws.runTask(DEMO_USER, fixTask.id);
  assert(done.status === 'completed', `implement v3 expected completed, got ${done.status}`);
  ws.demo.context.impl3 = fixTask.id;
  const pr = ws.prs.get(ws.demo.context.prId);
  assert(pr.headSha === ws.repo.resolveRef('feature/email-normalization'), 'PR head must track the new commit');
  ws.demo.context.v3Commit = done.result.commit;
  return { commit: done.result.commit, prHead: pr.headSha };
}

async function stepReview2(ws) {
  const ids = ws.demo.context.taskIds;
  // the review task failed on v2 (request_changes); retry it now that v3 landed
  ws.retryTask(DEMO_USER, ids.review);
  const done = await ws.runTask(DEMO_USER, ids.review);
  assert(done.status === 'completed', `review retry expected completed, got ${done.status}`);
  const pr = ws.prs.get(ws.demo.context.prId);
  assert(pr.state === 'approved', `PR expected approved, got ${pr.state}`);
  return { decision: done.result.decision, majors: done.result.majors, minors: done.result.minors };
}

async function stepCi(ws) {
  const run = await ws.runCi(DEMO_USER, { prId: ws.demo.context.prId });
  assert(run.status === 'success', `CI expected success on v3, got ${run.status}: ${JSON.stringify(run.stages.map((s) => [s.name, s.status]))}`);
  return {
    runId: run.id,
    stages: Object.fromEntries(run.stages.map((s) => [s.name, s.status])),
    sha: run.sha,
  };
}

async function stepMerge(ws) {
  const prId = ws.demo.context.prId;
  const pr = ws.mergePr(DEMO_USER, prId);
  assert(pr.state === 'merged', `PR expected merged, got ${pr.state}`);
  const mergeCommit = ws.repo.commits.get(pr.mergeCommit);
  assert(mergeCommit && mergeCommit.parents.length === 2, 'merge commit must have two parents');
  ws.demo.context.mergeCommit = pr.mergeCommit;
  ws.demo.context.issueId = ws.demo.context.issueId;
  ws.updateIssueState(DEMO_USER, ws.demo.context.issueId, 'resolved');
  return { prId, mergeCommit: pr.mergeCommit, issueState: 'resolved' };
}

async function stepVerify(ws) {
  const ids = ws.demo.context.taskIds;
  const mainFile = ws.repo.snapshot('main')['src/userService.js'];
  assert(typeof mainFile === 'string' && mainFile.includes('function normalizeEmail'), 'main must contain normalizeEmail');
  assert(!mainFile.includes('sk-live'), 'main must not contain the credential');
  assert(!/catch\s*\([^)]*\)\s*\{\s*\}/.test(mainFile), 'main must not contain an empty catch');
  for (const key of ['implement', 'qa', 'security', 'review']) {
    const t = ws.tasks.get(ids[key]);
    assert(t.status === 'completed', `task ${key} must be completed, got ${t.status}`);
  }
  const pr = ws.prs.get(ws.demo.context.prId);
  assert(pr.state === 'merged', 'PR must be merged');
  const audits = ws.audit.filter({ action: 'pr.merged' });
  assert(audits.length >= 1, 'audit must record pr.merged');
  const transitions = ws.audit.filter({ action: 'task.auto_transition' });
  return {
    ok: true,
    mergeCommit: pr.mergeCommit,
    autoTransitions: transitions.length,
    auditEntries: ws.audit.entries.length,
    tasksCompleted: ['plan', 'implement', 'qa', 'security', 'review'].map((k) => (k === 'plan' ? 'demo-plan' : ids[k])),
  };
}

// -- seed / stepping -----------------------------------------------------------

function seed(ws, actor) {
  // hard-reset all domain stores, then populate the demo project
  ws.agents = new AgentRegistry();
  ws.tasks = new TaskGraph();
  ws.repo = new Repository('demo-app');
  ws.prs = new PullRequests();
  ws.issues = [];
  ws.messages = [];
  ws.audit = new AuditLog();
  ws.ciRuns = [];
  ws.demo = {
    scenario: SCENARIO,
    stepIndex: 0,
    steps: STEPS.map((s) => ({ name: s.name, status: 'pending', detail: null })),
    lastStep: null,
    context: {},
  };
  const author = actor ? actor.id : 'admin';
  for (const [path, content] of Object.entries(SEED_FILES)) {
    ws.repo.writeFile(path, content);
  }
  ws.repo.commit('chore: seed demo-app baseline', author, {});
  ws.audit.append(actor, 'demo.seeded', { type: 'workspace', id: ws.config.name }, {
    scenario: SCENARIO, files: Object.keys(SEED_FILES).length, steps: STEPS.length,
  });
  return ws.demo;
}

async function next(ws, actor) {
  const st = ws.demo;
  if (!st || st.scenario === 'none' || !st.steps.length) {
    throw new (require('../core/errors').ForgeError)('FORGE_STATE', 'No demo scenario seeded; run Seed Demo first');
  }
  if (st.stepIndex >= st.steps.length) {
    return { done: true, index: st.stepIndex, name: null, ok: true };
  }
  const i = st.stepIndex;
  const step = STEPS[i];
  const record = st.steps[i];
  const started = Date.now();
  try {
    const detail = await step.run(ws, actor);
    record.status = 'done';
    record.detail = safeDetail(detail);
    record.durationMs = Date.now() - started;
    st.stepIndex = i + 1;
    st.lastStep = { index: i, name: step.name, ok: true };
    ws.audit.append(actor, 'demo.step', { type: 'demo', id: SCENARIO }, { index: i, name: step.name, ok: true });
    ws._save();
    return { index: i, name: step.name, ok: true, detail: record.detail, done: st.stepIndex >= st.steps.length };
  } catch (e) {
    record.status = 'failed';
    record.detail = { error: e.message };
    record.durationMs = Date.now() - started;
    st.lastStep = { index: i, name: step.name, ok: false, error: e.message };
    ws.audit.append(actor, 'demo.step_failed', { type: 'demo', id: SCENARIO }, { index: i, name: step.name, error: e.message });
    ws._save();
    return { index: i, name: step.name, ok: false, failed: true, error: e.message };
  }
}

function safeDetail(detail) {
  try {
    JSON.stringify(detail);
    return detail;
  } catch (_) {
    return { repr: String(detail) };
  }
}

async function runAll(ws, actor) {
  let last = null;
  for (;;) {
    last = await next(ws, actor);
    if (!last || last.done || last.failed) break;
  }
  return last;
}

module.exports = { seed, next, runAll, STEPS, SCENARIO };
