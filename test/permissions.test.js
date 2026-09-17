'use strict';

const { test, assert, equal, throws, makeWs, makeSeededWs, ADMIN, VIEWER, PLANNER, IMPLEMENTER, REVIEWER, QA, SECURITY } = require('./lib');
const { can, ACTIONS } = require('../server/domain/permissions');

test('permissions: viewer role is fully read-only', () => {
  for (const action of ACTIONS) {
    equal(can('viewer', action), false, `viewer denied ${action}`);
  }
});

test('permissions: admin and system can do everything', () => {
  for (const action of ACTIONS) {
    equal(can('admin', action), true, `admin allowed ${action}`);
    equal(can('system', action), true, `system allowed ${action}`);
  }
});

test('permissions: planner can plan but cannot touch the repository or PRs', () => {
  assert(can('planner', 'task.create'));
  assert(can('planner', 'task.split'));
  assert(can('planner', 'issue.create'));
  assert(!can('planner', 'repo.write'));
  assert(!can('planner', 'repo.commit'));
  assert(!can('planner', 'pr.approve'));
  assert(!can('planner', 'pr.merge'));
});

test('permissions: implementer can write/commit/branch/checkout/open PRs, cannot approve', () => {
  for (const action of ['repo.write', 'repo.delete', 'repo.rename', 'repo.commit', 'repo.branch', 'repo.checkout', 'pr.open']) {
    assert(can('implementer', action), `implementer allowed ${action}`);
  }
  assert(!can('implementer', 'pr.approve'));
  assert(!can('implementer', 'issue.create'));
});

test('permissions: reviewer can review/approve/close, cannot write repo', () => {
  for (const action of ['pr.comment', 'pr.request_changes', 'pr.approve', 'pr.close']) {
    assert(can('reviewer', action), `reviewer allowed ${action}`);
  }
  assert(!can('reviewer', 'repo.write'));
  assert(!can('reviewer', 'pr.merge'));
});

test('permissions: qa/security can run their agents, nothing repo-side', () => {
  assert(can('qa', 'task.run'));
  assert(can('security', 'task.run'));
  assert(!can('qa', 'repo.write'));
  assert(!can('security', 'repo.write'));
  assert(!can('qa', 'pr.approve'));
});

test('permissions: unknown role denied', () => {
  equal(can('wizard', 'repo.write'), false);
  equal(can(undefined, 'repo.write'), false);
});

test('permissions: enforcement blocks viewer writes at the workspace boundary', () => {
  const ws = makeSeededWs();
  throws(() => ws.writeFile(VIEWER, 'v.txt', 'x\n'), 'FORGE_PERMISSION_DENIED');
  throws(() => ws.commit(VIEWER, 'nope'), 'FORGE_PERMISSION_DENIED');
  throws(() => ws.createBranch(VIEWER, 'v-branch', undefined), 'FORGE_PERMISSION_DENIED');
  throws(() => ws.resetWorkspace(VIEWER, {}), 'FORGE_PERMISSION_DENIED');
});

test('permissions: role-appropriate actions pass the boundary', () => {
  const ws = makeSeededWs();
  ws.writeFile(IMPLEMENTER, 'impl.txt', 'x\n');
  ws.commit(IMPLEMENTER, 'impl commit');
  const issue = ws.createIssue(PLANNER, { title: 'Plan issue' });
  equal(issue.state, 'open');
  const t = ws.createTask(ADMIN, { title: 'QA task', type: 'qa', spec: { suites: ['unit'] } });
  ws.assignTask(QA, t.id, 'agent-qa-1');
  equal(ws.tasks.get(t.id).assignee, 'agent-qa-1');
});

test('permissions: planner cannot write repo files directly', () => {
  const ws = makeSeededWs();
  throws(() => ws.writeFile(PLANNER, 'p.txt', 'x\n'), 'FORGE_PERMISSION_DENIED');
});

test('permissions: security role cannot run QA suites on repo (repo.write denied)', () => {
  const ws = makeSeededWs();
  throws(() => ws.writeFile(SECURITY, 's.txt', 'x\n'), 'FORGE_PERMISSION_DENIED');
});

test('permissions: enforcement can be disabled by admin (audited)', () => {
  const ws = makeSeededWs();
  ws.updateConfig(ADMIN, { enforcePermissions: false });
  ws.writeFile(VIEWER, 'now-allowed.txt', 'x\n');
  equal(ws.readFile('now-allowed.txt'), 'x\n');
  const audits = ws.audit.filter({ action: 'config.updated' });
  equal(audits.length, 1);
});

test('permissions: non-admin cannot change enforcement', () => {
  const ws = makeSeededWs();
  throws(() => ws.updateConfig(VIEWER, { enforcePermissions: false }), 'FORGE_PERMISSION_DENIED');
  throws(() => ws.updateConfig(IMPLEMENTER, { enforcePermissions: false }), 'FORGE_PERMISSION_DENIED');
  equal(ws.config.enforcePermissions, true, 'still enforced');
});

test('permissions: viewer cannot create tasks or issues', () => {
  const ws = makeSeededWs();
  throws(() => ws.createTask(VIEWER, { title: 'T', type: 'qa' }), 'FORGE_PERMISSION_DENIED');
  throws(() => ws.createIssue(VIEWER, { title: 'I' }), 'FORGE_PERMISSION_DENIED');
});

test('permissions: agent actors carry their role from the registry', () => {
  const ws = makeSeededWs();
  const agent = ws.agents.get('agent-impl-1');
  equal(agent.role, 'implementer');
  // the implementer agent may commit (used by runners)
  ws.writeFile({ type: 'agent', id: agent.id, role: 'implementer' }, 'agent-file.txt', 'x\n');
  equal(ws.readFile('agent-file.txt'), 'x\n');
});
