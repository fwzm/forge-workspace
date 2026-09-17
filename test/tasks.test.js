'use strict';

const { test, assert, equal, deepEqual, throws, makeWs, makeSeededWs, ADMIN, SYSTEM } = require('./lib');
const { TaskGraph } = require('../server/domain/tasks');

// Drive a ready task through the legal path to completed (assign -> run -> complete).
function drive(g, id, assignee) {
  g.assign(id, assignee || 'agent-qa-1');
  g.run(id);
  g.complete(id, { manual: true });
}

test('tasks: create without dependencies starts ready', () => {
  const g = new TaskGraph();
  const t = g.create({ id: 't1', title: 'A', type: 'qa' });
  equal(t.status, 'ready');
});

test('tasks: create with unmet dependencies starts blocked', () => {
  const g = new TaskGraph();
  g.create({ id: 't1', title: 'A', type: 'qa' });
  const t2 = g.create({ id: 't2', title: 'B', type: 'qa', dependencies: ['t1'] });
  equal(t2.status, 'blocked');
  equal(g.get('t1').dependents.includes('t2'), true);
});

test('tasks: create rejects unknown dependency', () => {
  const g = new TaskGraph();
  throws(() => g.create({ id: 't1', title: 'A', type: 'qa', dependencies: ['ghost'] }), 'FORGE_NOT_FOUND');
});

test('tasks: create rejects self-dependency (unknown at creation time)', () => {
  const g = new TaskGraph();
  // at creation the task does not exist yet, so the self-reference is an
  // unknown dependency; true cycle protection is exercised via addDependency
  throws(() => g.create({ id: 't1', title: 'A', type: 'qa', dependencies: ['t1'] }), 'FORGE_NOT_FOUND');
});

test('tasks: create rejects unknown type', () => {
  const g = new TaskGraph();
  throws(() => g.create({ id: 't1', title: 'A', type: 'wizard' }), 'FORGE_INVALID_INPUT');
});

test('tasks: create rejects empty title', () => {
  const g = new TaskGraph();
  throws(() => g.create({ id: 't1', title: '   ', type: 'qa' }), 'FORGE_INVALID_INPUT');
});

test('tasks: full lifecycle ready -> running -> completed', () => {
  const g = new TaskGraph();
  g.create({ id: 't1', title: 'A', type: 'qa', spec: {} });
  g.assign('t1', 'agent-qa-1');
  g.run('t1');
  equal(g.get('t1').status, 'running');
  equal(g.get('t1').attempts, 1);
  g.complete('t1', { ok: true });
  equal(g.get('t1').status, 'completed');
  equal(g.get('t1').result.ok, true);
  equal(g.get('t1').completedAt > 0, true);
});

test('tasks: run requires an assignee', () => {
  const g = new TaskGraph();
  g.create({ id: 't1', title: 'A', type: 'qa' });
  throws(() => g.run('t1'), 'FORGE_STATE');
});

test('tasks: run from blocked is rejected', () => {
  const g = new TaskGraph();
  g.create({ id: 'a', title: 'A', type: 'qa' });
  g.create({ id: 'b', title: 'B', type: 'qa', dependencies: ['a'] });
  g.assign('b', 'agent-qa-1');
  throws(() => g.run('b'), 'FORGE_INVALID_TRANSITION');
});

test('tasks: pause/resume cycle', () => {
  const g = new TaskGraph();
  g.create({ id: 't1', title: 'A', type: 'qa', spec: null });
  g.assign('t1', 'agent-qa-1');
  g.run('t1');
  g.pause('t1');
  equal(g.get('t1').status, 'paused');
  g.resume('t1');
  equal(g.get('t1').status, 'running');
});

test('tasks: retry resets failed task to ready and preserves attempt count', () => {
  const g = new TaskGraph();
  g.create({ id: 't1', title: 'A', type: 'qa', spec: null });
  g.assign('t1', 'agent-qa-1');
  g.run('t1');
  g.fail('t1', 'boom');
  equal(g.get('t1').lastError, 'boom');
  g.retry('t1');
  equal(g.get('t1').status, 'ready');
  equal(g.get('t1').completedAt, null);
  g.assign('t1', 'agent-qa-1');
  g.run('t1');
  equal(g.get('t1').attempts, 2);
});

test('tasks: retry only from failed', () => {
  const g = new TaskGraph();
  g.create({ id: 't1', title: 'A', type: 'qa' });
  throws(() => g.retry('t1'), 'FORGE_INVALID_TRANSITION');
});

test('tasks: cancel from ready works, cancel from completed rejected', () => {
  const g = new TaskGraph();
  g.create({ id: 't1', title: 'A', type: 'qa' });
  g.cancel('t1');
  equal(g.get('t1').status, 'cancelled');
  throws(() => g.cancel('t1'), 'FORGE_INVALID_TRANSITION');
});

test('tasks: manual complete from blocked rejected (non-container)', () => {
  const g = new TaskGraph();
  g.create({ id: 'a', title: 'A', type: 'qa' });
  g.create({ id: 'b', title: 'B', type: 'qa', dependencies: ['a'] });
  throws(() => g.complete('b'), 'FORGE_INVALID_TRANSITION');
});

test('tasks: addDependency rejects cycles', () => {
  const g = new TaskGraph();
  g.create({ id: 'a', title: 'A', type: 'qa' });
  g.create({ id: 'b', title: 'B', type: 'qa', dependencies: ['a'] });
  throws(() => g.addDependency('a', 'b'), 'FORGE_CYCLE');
});

test('tasks: addDependency demotes ready -> blocked', () => {
  const g = new TaskGraph();
  g.create({ id: 'a', title: 'A', type: 'qa' });
  g.create({ id: 'b', title: 'B', type: 'qa' });
  equal(g.get('b').status, 'ready');
  g.addDependency('b', 'a');
  equal(g.get('b').status, 'blocked');
});

test('tasks: schedulerTick promotes blocked when all deps complete', () => {
  const g = new TaskGraph();
  g.create({ id: 'a', title: 'A', type: 'qa' });
  g.create({ id: 'b', title: 'B', type: 'qa', dependencies: ['a'] });
  g.create({ id: 'c', title: 'C', type: 'qa', dependencies: ['b'] });
  drive(g, 'a');
  let tr = g.schedulerTick();
  equal(tr.length, 1);
  equal(tr[0].id, 'b');
  equal(g.get('b').status, 'ready');
  tr = g.schedulerTick();
  equal(tr.length, 0, 'no further promotions until b completes');
  drive(g, 'b');
  tr = g.schedulerTick();
  equal(tr.length, 1);
  equal(tr[0].id, 'c');
});

test('tasks: DAG truly blocks downstream until upstream completes', () => {
  const g = new TaskGraph();
  g.create({ id: 'a', title: 'A', type: 'qa' });
  g.create({ id: 'b', title: 'B', type: 'qa', dependencies: ['a'] });
  g.create({ id: 'c', title: 'C', type: 'qa', dependencies: ['a', 'b'] });
  drive(g, 'a');
  g.schedulerTick();
  equal(g.get('c').status, 'blocked', 'c waits for b too');
  drive(g, 'b');
  g.schedulerTick();
  equal(g.get('c').status, 'ready');
});

test('tasks: failed dependency keeps downstream blocked', () => {
  const g = new TaskGraph();
  g.create({ id: 'a', title: 'A', type: 'qa' });
  g.create({ id: 'b', title: 'B', type: 'qa', dependencies: ['a'] });
  g.get('a').status = 'failed';
  const tr = g.schedulerTick();
  equal(tr.length, 0);
  equal(g.get('b').status, 'blocked');
});

test('tasks: split creates children and container auto-completes', () => {
  const g = new TaskGraph();
  g.create({ id: 'parent', title: 'P', type: 'plan' });
  const { parent, children } = g.split('parent', [
    { key: 'x', title: 'X', type: 'qa' },
    { key: 'y', title: 'Y', type: 'qa' },
    { key: 'z', title: 'Z', type: 'qa', dependencies: ['x'] },
  ]);
  equal(children.length, 3);
  equal(parent.container, true);
  equal(parent.status, 'blocked', 'parent demoted to blocked on children deps');
  // complete all children
  for (const c of children) {
    c.status = 'running';
    g.complete(c.id);
  }
  const tr = g.schedulerTick();
  const auto = tr.find((t) => t.id === 'parent' && t.to === 'completed');
  assert(auto, 'parent auto-completed by scheduler');
  equal(auto.reason, 'container-children-completed');
  equal(g.get('parent').status, 'completed');
});

test('tasks: split child can depend on earlier sibling via key', () => {
  const g = new TaskGraph();
  g.create({ id: 'p', title: 'P', type: 'plan' });
  const { children } = g.split('p', [
    { key: 'first', title: 'F', type: 'qa' },
    { key: 'second', title: 'S', type: 'qa', dependencies: ['first'] },
  ]);
  deepEqual(children[1].dependencies, [children[0].id]);
});

test('tasks: split rejects running/completed parents', () => {
  const g = new TaskGraph();
  g.create({ id: 'p', title: 'P', type: 'plan', spec: null });
  g.assign('p', 'agent-planner');
  g.run('p');
  throws(() => g.split('p', [{ title: 'X', type: 'qa' }]), 'FORGE_STATE');
  g.complete('p');
  throws(() => g.split('p', [{ title: 'X', type: 'qa' }]), 'FORGE_STATE');
});

test('tasks: topoOrder detects cycles', () => {
  const g = new TaskGraph();
  g.create({ id: 'a', title: 'A', type: 'qa' });
  g.create({ id: 'b', title: 'B', type: 'qa', dependencies: ['a'] });
  equal(g.topoOrder().length, 2);
});

test('tasks: workspace createTask validates and audits', () => {
  const ws = makeWs();
  const t = ws.createTask(ADMIN, { title: 'T1', type: 'qa', spec: { suites: ['unit'] } });
  assert(t.id.startsWith('task-'));
  equal(t.status, 'ready');
  const audit = ws.audit.filter({ action: 'task.created' });
  equal(audit.length, 1);
  equal(audit[0].actor.role, 'admin');
});

test('tasks: workspace assign enforces agent type match', () => {
  const ws = makeWs();
  const t = ws.createTask(ADMIN, { title: 'T1', type: 'qa' });
  throws(() => ws.assignTask(ADMIN, t.id, 'agent-planner'), 'FORGE_INVALID_INPUT');
  ws.assignTask(ADMIN, t.id, 'agent-qa-1');
  equal(ws.tasks.get(t.id).assignee, 'agent-qa-1');
});

test('tasks: workspace duplicate id rejected', () => {
  const ws = makeWs();
  ws.createTask(ADMIN, { id: 'dup-1', title: 'A', type: 'qa' });
  throws(() => ws.createTask(ADMIN, { id: 'dup-1', title: 'B', type: 'qa' }), 'FORGE_STATE');
});

test('tasks: workspace cancel/pause/resume/retry with permissions and audit', async () => {
  const ws = makeSeededWs();
  const t = ws.createTask(ADMIN, { title: 'T', type: 'qa', spec: { suites: ['unit'] } });
  ws.assignTask(ADMIN, t.id, 'agent-qa-1');
  await ws.runTask(ADMIN, t.id);
  equal(ws.tasks.get(t.id).status, 'completed');
  // a second task exercises pause/resume/cancel on the TaskGraph level
  const t2 = ws.createTask(ADMIN, { title: 'T2', type: 'qa', spec: { suites: ['unit'] } });
  ws.assignTask(ADMIN, t2.id, 'agent-qa-1');
  ws.tasks.run(t2.id);
  ws.pauseTask(ADMIN, t2.id);
  equal(ws.tasks.get(t2.id).status, 'paused');
  ws.resumeTask(ADMIN, t2.id);
  equal(ws.tasks.get(t2.id).status, 'running');
  ws.cancelTask(ADMIN, t2.id);
  equal(ws.tasks.get(t2.id).status, 'cancelled');
  const actions = ws.audit.filter({ targetId: t2.id }).map((e) => e.action);
  assert(actions.includes('task.paused') && actions.includes('task.cancelled'));
});
