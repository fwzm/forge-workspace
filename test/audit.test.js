'use strict';

const { test, assert, equal, makeWs, makeSeededWs, ADMIN, SYSTEM } = require('./lib');
const { AuditLog } = require('../server/domain/audit');

test('audit: transitions append entries with increasing seq and full actor', () => {
  const ws = makeSeededWs();
  const t = ws.createTask(ADMIN, { title: 'A', type: 'qa' });
  const created = ws.audit.filter({ action: 'task.created' });
  equal(created.length, 1);
  equal(created[0].actor.role, 'admin');
  equal(created[0].actor.id, 'admin');
  equal(created[0].target.id, t.id);
  assert(created[0].seq > 0);
});

test('audit: agent actions are attributed to the agent', async () => {
  const ws = makeSeededWs();
  const t = ws.createTask(ADMIN, { title: 'QA', type: 'qa', spec: { suites: ['unit'] } });
  await ws.runTask(ADMIN, t.id);
  const done = ws.audit.filter({ action: 'task.completed' });
  equal(done.length, 1);
  equal(done[0].actor.type, 'agent');
  equal(done[0].actor.id, 'agent-qa-1');
  equal(done[0].actor.role, 'qa');
});

test('audit: failed agent runs are audited with the error', async () => {
  const ws = makeSeededWs();
  const t = ws.createTask(ADMIN, { title: 'Bad scan', type: 'security', spec: { branch: 'nope' } });
  await ws.runTask(ADMIN, t.id);
  const failed = ws.audit.filter({ action: 'task.failed' });
  equal(failed.length, 1);
  assert(failed[0].details.error.length > 0);
});

test('audit: auto transitions are recorded by the scheduler', async () => {
  const ws = makeSeededWs();
  const a = ws.createTask(ADMIN, { title: 'A', type: 'qa', spec: { suites: ['unit'] } });
  ws.createTask(ADMIN, { title: 'B', type: 'security', spec: {}, dependencies: [a.id] });
  await ws.runTask(ADMIN, a.id);
  equal(ws.tasks.get(a.id).status, 'completed');
  const autos = ws.audit.filter({ action: 'task.auto_transition' });
  equal(autos.length, 1);
  equal(autos[0].details.to, 'ready');
  equal(autos[0].details.reason, 'dependencies-satisfied');
  equal(autos[0].details.id, ws.tasks.list().find((t) => t.title === 'B').id);
});

test('audit: PR lifecycle events are traceable end to end', async () => {
  const ws = makeSeededWs();
  ws.createBranch(ADMIN, 'feature/aud', undefined);
  ws.checkoutBranch(ADMIN, 'feature/aud', {});
  ws.writeFile(ADMIN, 'src/aud.js', "'use strict';\nconst A = 1;\nmodule.exports = { A };\n");
  ws.commit(ADMIN, 'aud');
  const pr = ws.openPr(ADMIN, { title: 'T', sourceBranch: 'feature/aud', targetBranch: 'main' });
  await ws.runCi(ADMIN, { prId: pr.id });
  ws.reviewPr({ type: 'user', id: 'reviewer-1', role: 'reviewer' }, pr.id, { type: 'approve' });
  ws.mergePr(ADMIN, pr.id);
  const actions = ws.audit.filter({ targetId: pr.id }).map((e) => e.action);
  for (const expected of ['pr.opened', 'pr.review', 'pr.merged']) {
    assert(actions.includes(expected), `missing ${expected} in ${JSON.stringify(actions)}`);
  }
});

test('audit: filter by action prefix, actor and target', () => {
  const ws = makeSeededWs();
  ws.writeFile(ADMIN, 'f1.txt', 'x\n');
  ws.writeFile(ADMIN, 'f2.txt', 'y\n');
  const allRepo = ws.audit.filter({ action: 'repo.' });
  assert(allRepo.length >= 2);
  const byActor = ws.audit.filter({ actorId: 'admin' });
  assert(byActor.every((e) => e.actor.id === 'admin'));
  const byTarget = ws.audit.filter({ targetId: 'f1.txt' });
  equal(byTarget.length, 1);
  equal(byTarget[0].target.type, 'file');
});

test('audit: tail returns the last n entries', () => {
  const ws = makeSeededWs();
  for (let i = 0; i < 10; i++) ws.writeFile(ADMIN, `t${i}.txt`, 'x\n');
  const tail = ws.audit.tail(5);
  equal(tail.length, 5);
  equal(tail[4].target.id, 't9.txt');
});

test('audit: AuditLog serialize/deserialize roundtrip', () => {
  const log = new AuditLog();
  log.append(ADMIN, 'x.y', { type: 'task', id: 't1' }, { a: 1 });
  log.append(SYSTEM, 'z.w', null, null);
  const data = JSON.parse(JSON.stringify(log.serialize()));
  const log2 = AuditLog.deserialize(data);
  equal(log2.entries.length, 2);
  equal(log2.seq, log.seq);
  equal(log2.entries[0].details.a, 1);
});

test('audit: workspace reset is audited', () => {
  const ws = makeSeededWs();
  ws.resetWorkspace(ADMIN, { seed: true });
  // demo.seed wipes the audit trail as part of the hard reset; the reset and
  // seed markers are appended afterwards and must both be present
  assert(ws.audit.filter({ action: 'workspace.reset' }).length === 1, 'reset audited');
  assert(ws.audit.filter({ action: 'demo.seeded' }).length === 1, 'seed audited');
});

test('audit: filter combinations narrow results', () => {
  const ws = makeSeededWs();
  ws.writeFile(ADMIN, 'combo.txt', 'x\n');
  const combo = ws.audit.filter({ action: 'repo.file_written', targetId: 'combo.txt', actorId: 'admin' });
  equal(combo.length, 1);
});
