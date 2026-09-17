'use strict';

const { test, assert, equal, throws, makeWs, makeSeededWs, ADMIN } = require('./lib');

test('scheduler: no automatic run when autoScheduler is off (default)', () => {
  const ws = makeSeededWs();
  const t = ws.createTask(ADMIN, { title: 'QA check', type: 'qa', spec: { suites: ['unit'] } });
  equal(ws.tasks.get(t.id).status, 'ready');
  const ready = ws.tasks.readyTasks().filter((x) => x.id === t.id);
  equal(ready.length, 1, 'task still ready, not executed');
});

test('scheduler: auto-assign + run when autoScheduler is on', async () => {
  const ws = makeSeededWs();
  ws.updateConfig(ADMIN, { autoScheduler: true });
  const t = ws.createTask(ADMIN, { title: 'QA check', type: 'qa', spec: { suites: ['unit'] } });
  // drain is triggered by the mutation; wait for it
  for (let i = 0; i < 50 && ws.tasks.get(t.id).status !== 'completed'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  equal(ws.tasks.get(t.id).status, 'completed');
  equal(ws.tasks.get(t.id).assignee, 'agent-qa-1');
  const audits = ws.audit.filter({ targetId: t.id }).map((e) => e.action);
  assert(audits.includes('task.assigned'), 'auto-assign audited');
  assert(audits.includes('task.completed'), 'auto-run completed');
});

test('scheduler: cascades chained tasks when autoScheduler is on', async () => {
  const ws = makeSeededWs();
  ws.updateConfig(ADMIN, { autoScheduler: true });
  const a = ws.createTask(ADMIN, { title: 'QA-1', type: 'qa', spec: { suites: ['unit'] } });
  const b = ws.createTask(ADMIN, { title: 'Security-1', type: 'security', spec: {}, dependencies: [a.id] });
  for (let i = 0; i < 100 && ws.tasks.get(b.id).status !== 'completed'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  equal(ws.tasks.get(a.id).status, 'completed');
  equal(ws.tasks.get(b.id).status, 'completed');
  const tr = ws.audit.filter({ action: 'task.auto_transition' });
  assert(tr.some((e) => e.details && e.details.id === b.id && e.details.to === 'ready'), 'b was promoted automatically');
});

test('scheduler: agent failure marks task failed and keeps DAG honest', async () => {
  const ws = makeSeededWs();
  const t = ws.createTask(ADMIN, { title: 'Security scan', type: 'security', spec: { branch: 'nonexistent-branch' } });
  await ws.runTask(ADMIN, t.id);
  equal(ws.tasks.get(t.id).status, 'failed');
  assert(ws.tasks.get(t.id).lastError.length > 0, 'failure reason recorded');
  const agent = ws.agents.list().find((a) => a.id === 'agent-security-1');
  equal(agent.tasksFailed, 1);
});

test('scheduler: retry after failure then success', async () => {
  const ws = makeSeededWs();
  const bad = ws.createTask(ADMIN, { title: 'Security scan (bad ref)', type: 'security', spec: { branch: 'nope' } });
  await ws.runTask(ADMIN, bad.id);
  equal(ws.tasks.get(bad.id).status, 'failed');
  ws.setTaskSpec(ADMIN, bad.id, {});
  ws.retryTask(ADMIN, bad.id);
  await ws.runTask(ADMIN, bad.id);
  equal(ws.tasks.get(bad.id).status, 'completed');
});

test('scheduler: blocked task with failed dependency never auto-runs', async () => {
  const ws = makeSeededWs();
  ws.updateConfig(ADMIN, { autoScheduler: true });
  // the gate is born with a broken spec: the scheduler drains it, the agent
  // fails, and the downstream task must stay blocked forever after
  const gate = ws.createTask(ADMIN, { title: 'Gate', type: 'qa', spec: { suites: ['unit'], branch: 'missing-branch' } });
  const down = ws.createTask(ADMIN, { title: 'Downstream security', type: 'security', spec: {}, dependencies: [gate.id] });
  for (let i = 0; i < 50 && ws.tasks.get(gate.id).status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  equal(ws.tasks.get(gate.id).status, 'failed');
  await new Promise((r) => setTimeout(r, 30));
  equal(ws.tasks.get(down.id).status, 'blocked', 'downstream stays blocked');
});

test('scheduler: runTask auto-assigns matching agent when unassigned', async () => {
  const ws = makeSeededWs();
  const t = ws.createTask(ADMIN, { title: 'QA unassigned', type: 'qa', spec: { suites: ['unit'] } });
  await ws.runTask(ADMIN, t.id);
  equal(ws.tasks.get(t.id).assignee, 'agent-qa-1');
  equal(ws.tasks.get(t.id).status, 'completed');
});

test('scheduler: runTask on unknown task id rejected', async () => {
  const ws = makeSeededWs();
  await Promise.resolve();
  let threw = null;
  try {
    await ws.runTask(ADMIN, 'task-ghost');
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === 'FORGE_NOT_FOUND');
});

test('scheduler: runTask resumes a paused task (documented semantics)', async () => {
  const ws = makeSeededWs();
  const t = ws.createTask(ADMIN, { title: 'T', type: 'qa', spec: { suites: ['unit'] } });
  ws.assignTask(ADMIN, t.id, 'agent-qa-1');
  ws.tasks.run(t.id);
  ws.pauseTask(ADMIN, t.id);
  equal(ws.tasks.get(t.id).status, 'paused');
  await ws.runTask(ADMIN, t.id);
  equal(ws.tasks.get(t.id).status, 'completed', 'runTask resumes paused tasks and executes them');
});

test('scheduler: container parent auto-completes after children complete', async () => {
  const ws = makeSeededWs();
  const parent = ws.createTask(ADMIN, { title: 'Epic', type: 'custom' });
  const { children } = ws.splitTask(ADMIN, parent.id, [
    { key: 'c1', title: 'Child 1', type: 'qa', spec: { suites: ['unit'] } },
    { key: 'c2', title: 'Child 2', type: 'security', spec: {} },
  ]);
  await ws.runTask(ADMIN, children[0].id);
  equal(ws.tasks.get(parent.id).status, 'blocked', 'parent waits while a child is open');
  await ws.runTask(ADMIN, children[1].id);
  equal(ws.tasks.get(parent.id).status, 'completed', 'parent auto-completed');
  const auto = ws.audit.filter({ action: 'task.auto_transition' });
  assert(auto.some((e) => e.target && e.target.id === parent.id));
});
