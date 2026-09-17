'use strict';

const { test, assert, equal, makeSeededWs, ADMIN } = require('./lib');
const { execute: runShell, tokenize } = require('../server/terminal');

function deepEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'mismatch'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

test('terminal: tokenizer respects quotes and whitespace', () => {
  deepEq(tokenize('commit -m "two words"'), ['commit', '-m', 'two words']);
  deepEq(tokenize("write f.txt 'a b'"), ['write', 'f.txt', 'a b']);
  deepEq(tokenize('  a   b  '), ['a', 'b']);
});

test('terminal: help lists commands', async () => {
  const ws = makeSeededWs();
  const { lines } = await runShell(ws, 'help', ADMIN);
  assert(lines.some((l) => l.includes('commit')), 'help mentions commit');
});

test('terminal: write/cat/rm/mv operate on the working tree', async () => {
  const ws = makeSeededWs();
  await runShell(ws, 'write notes.txt first line', ADMIN);
  equal(ws.readFile('notes.txt'), 'first line\n');
  const cat = await runShell(ws, 'cat notes.txt', ADMIN);
  equal(cat.lines.join('\n'), 'first line');
  await runShell(ws, 'mv notes.txt renamed.txt', ADMIN);
  assert(ws.repo.listFiles().includes('renamed.txt'));
  await runShell(ws, 'rm renamed.txt', ADMIN);
  assert(!ws.repo.listFiles().includes('renamed.txt'));
});

test('terminal: ls shows files and directories', async () => {
  const ws = makeSeededWs();
  const { lines } = await runShell(ws, 'ls', ADMIN);
  assert(lines.includes('src/'));
  assert(lines.includes('package.json'));
  const src = await runShell(ws, 'ls src', ADMIN);
  assert(src.lines.includes('userService.js'));
});

test('terminal: status/diff reflect working tree changes', async () => {
  const ws = makeSeededWs();
  await runShell(ws, 'write src/new-file.js const a = 1;\n', ADMIN);
  const st = await runShell(ws, 'status', ADMIN);
  assert(st.lines.some((l) => l.includes('src/new-file.js')), JSON.stringify(st.lines));
  const diff = await runShell(ws, 'diff', ADMIN);
  assert(diff.lines.join('\n').includes('+const a = 1;'), JSON.stringify(diff.lines));
});

test('terminal: commit/log/branch/checkout roundtrip', async () => {
  const ws = makeSeededWs();
  await runShell(ws, 'write term.txt hello\n', ADMIN);
  const c = await runShell(ws, 'commit -m "from the shell"', ADMIN);
  assert(c.lines[0].startsWith('committed '));
  const log = await runShell(ws, 'log 2', ADMIN);
  assert(log.lines.some((l) => l.includes('from the shell')));
  await runShell(ws, 'checkout -b shell-branch', ADMIN);
  equal(ws.repo.head.branch, 'shell-branch');
  await runShell(ws, 'checkout main', ADMIN);
  equal(ws.repo.head.branch, 'main');
  const branch = await runShell(ws, 'branch', ADMIN);
  assert(branch.lines.some((l) => l.includes('shell-branch')));
});

test('terminal: fast-forward merge through the shell', async () => {
  const ws = makeSeededWs();
  await runShell(ws, 'checkout -b ff-branch', ADMIN);
  await runShell(ws, 'write ff.txt content\n', ADMIN);
  await runShell(ws, 'commit -m "ff commit"', ADMIN);
  await runShell(ws, 'checkout main', ADMIN);
  const res = await runShell(ws, 'merge ff-branch', ADMIN);
  assert(res.lines.some((l) => l.includes('fast-forward')));
  assert(ws.repo.listFiles().includes('ff.txt'));
});

test('terminal: conflict flow surfaces resolve/continue commands', async () => {
  const ws = makeSeededWs();
  await runShell(ws, 'checkout -b conflict-branch', ADMIN);
  await runShell(ws, 'write clash.txt feature\n', ADMIN);
  await runShell(ws, 'commit -m "feature side"', ADMIN);
  await runShell(ws, 'checkout main', ADMIN);
  await runShell(ws, 'write clash.txt main\n', ADMIN);
  await runShell(ws, 'commit -m "main side"', ADMIN);
  const res = await runShell(ws, 'merge conflict-branch', ADMIN);
  assert(res.lines.some((l) => l.includes('CONFLICT')), JSON.stringify(res.lines));
  await runShell(ws, 'resolve clash.txt theirs', ADMIN);
  const cont = await runShell(ws, 'merge-continue resolved via shell', ADMIN);
  assert(cont.lines[0].startsWith('merge committed'));
  equal(ws.readFile('clash.txt'), 'feature\n');
});

test('terminal: task/agent/issue listing', async () => {
  const ws = makeSeededWs();
  ws.createTask(ADMIN, { id: 'term-task', title: 'Terminal task', type: 'qa', spec: { suites: ['unit'] } });
  const tasks = await runShell(ws, 'tasks', ADMIN);
  assert(tasks.lines.some((l) => l.includes('term-task')));
  const agents = await runShell(ws, 'agents', ADMIN);
  assert(agents.lines.some((l) => l.includes('agent-planner')));
  const task = await runShell(ws, 'task term-task', ADMIN);
  assert(task.lines.join('').includes('Terminal task'));
});

test('terminal: ci command prints stage statuses', async () => {
  const ws = makeSeededWs();
  const res = await runShell(ws, 'ci', ADMIN);
  assert(res.lines.some((l) => l.includes('-> success')));
  assert(res.lines.some((l) => l.includes('lint')));
});

test('terminal: unknown command is a clear error', async () => {
  const ws = makeSeededWs();
  let code = null;
  try {
    await runShell(ws, 'frobnicate', ADMIN);
  } catch (e) {
    code = e.code;
  }
  equal(code, 'FORGE_INVALID_INPUT');
});

test('terminal: whoami and audit', async () => {
  const ws = makeSeededWs();
  const who = await runShell(ws, 'whoami', ADMIN);
  assert(who.lines[0].includes('admin'));
  await runShell(ws, 'write audit-bait.txt x\n', ADMIN);
  const audit = await runShell(ws, 'audit 3', ADMIN);
  assert(audit.lines.length >= 1 && audit.lines.length <= 3);
});

test('terminal: permission errors propagate (viewer shell)', async () => {
  const ws = makeSeededWs();
  let code = null;
  try {
    await runShell(ws, 'write hack.txt x', { type: 'user', id: 'v', role: 'viewer' });
  } catch (e) {
    code = e.code;
  }
  equal(code, 'FORGE_PERMISSION_DENIED');
});

test('terminal: demo seed and step through', async () => {
  const ws = makeSeededWs();
  await runShell(ws, 'demo seed', ADMIN);
  equal(ws.demo.steps.length, 15);
  const r = await runShell(ws, 'demo next', ADMIN);
  assert(r.lines[0].includes('"ok":true'));
  equal(ws.demo.stepIndex, 1);
});
