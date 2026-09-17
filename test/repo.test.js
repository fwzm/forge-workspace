'use strict';

const { test, assert, equal, deepEqual, throws, includes, makeWs, makeSeededWs, ADMIN } = require('./lib');
const { Repository, sha256 } = require('../server/domain/repo');

test('repo: identical content reuses the same blob hash (content addressing)', () => {
  const r = new Repository('r');
  const h1 = r.putBlob('same content');
  const h2 = r.putBlob('same content');
  equal(h1, h2);
  equal(h1, sha256('same content'));
  const h3 = r.putBlob('different');
  assert(h1 !== h3);
});

test('repo: commit hash covers tree, parents, message, author, timestamp', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', 'hello\n');
  const c1 = r.commit('first', 'alice', { timestamp: 1000 });
  equal(c1.hash, r.head.commit);
  // same inputs -> same hash (deterministic)
  r2: {
    const r2 = new Repository('r');
    r2.writeFile('a.txt', 'hello\n');
    const c2 = r2.commit('first', 'alice', { timestamp: 1000 });
    equal(c2.hash, c1.hash);
    break r2;
  }
  // different message -> different hash
  const r3 = new Repository('r');
  r3.writeFile('a.txt', 'hello\n');
  const c3 = r3.commit('other', 'alice', { timestamp: 1000 });
  assert(c3.hash !== c1.hash);
});

test('repo: tree hash shared when content identical', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', 'x\n');
  const c1 = r.commit('one', 't', { timestamp: 1 });
  r.writeFile('a.txt', 'y\n');
  const c2 = r.commit('two', 't', { timestamp: 2 });
  r.writeFile('a.txt', 'x\n');
  r.writeFile('b.txt', 'z\n');
  const c3 = r.commit('three', 't', { timestamp: 3 });
  const t1 = r.commits.get(c1.hash).tree;
  const t3 = r.commits.get(c3.hash).tree;
  const entries1 = r.trees.get(t1);
  const entries3 = r.trees.get(t3);
  equal(entries1['a.txt'], entries3['a.txt'], 'blob for a.txt shared');
  assert(t1 !== c2.hash);
});

test('repo: status classifies modified/added/deleted and clean flag', () => {
  const r = new Repository('r');
  r.writeFile('mod.txt', 'v1\n');
  r.writeFile('del.txt', 'x\n');
  r.commit('base', 't', {});
  r.writeFile('mod.txt', 'v2\n');
  r.writeFile('add.txt', 'new\n');
  r.deleteFile('del.txt');
  const st = r.status();
  deepEqual(st.modified, ['mod.txt']);
  deepEqual(st.added, ['add.txt']);
  deepEqual(st.deleted, ['del.txt']);
  equal(st.clean, false);
});

test('repo: readFile falls back to HEAD when worktree copy absent', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', 'v\n');
  r.commit('c', 't', {});
  // commit() drops shadow copies equal to HEAD
  equal(r.readFile('a.txt'), 'v\n');
  throws(() => r.readFile('missing.txt'), 'FORGE_NOT_FOUND');
});

test('repo: path validation rejects traversal and weird paths', () => {
  const r = new Repository('r');
  throws(() => r.writeFile('../etc/passwd', 'x'), 'FORGE_INVALID_INPUT');
  throws(() => r.writeFile('/abs/path', 'x'), 'FORGE_INVALID_INPUT');
  throws(() => r.writeFile('a//b', 'x'), 'FORGE_INVALID_INPUT');
  r.writeFile('ok/dir_name/file-1.txt', 'x');
});

test('repo: rename moves content and marks delete of source', () => {
  const r = new Repository('r');
  r.writeFile('old.txt', 'data\n');
  r.commit('c', 't', {});
  r.renameFile('old.txt', 'new.txt');
  const st = r.status();
  deepEqual(st.added, ['new.txt']);
  deepEqual(st.deleted, ['old.txt']);
  r.commit('renamed', 't', {});
  equal(r.readFile('new.txt'), 'data\n');
  throws(() => r.readFile('old.txt'), 'FORGE_NOT_FOUND');
});

test('repo: rename missing file rejected', () => {
  const r = new Repository('r');
  throws(() => r.renameFile('ghost.txt', 'x.txt'), 'FORGE_NOT_FOUND');
});

test('repo: branch create/checkout/delete lifecycle', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', '1\n');
  r.commit('base', 't', {});
  r.createBranch('feature');
  r.checkout('feature', {});
  r.writeFile('a.txt', '2\n');
  r.commit('feat', 't', {});
  equal(r.branches.get('feature'), r.head.commit);
  r.checkout('main', {});
  equal(r.readFile('a.txt'), '1\n', 'main untouched');
  r.deleteBranch('feature');
  equal(r.branches.has('feature'), false);
  throws(() => r.deleteBranch('main'), 'FORGE_STATE', 'cannot delete checked-out branch');
  throws(() => r.deleteBranch('ghost'), 'FORGE_NOT_FOUND');
  r.createBranch('feature', undefined);
  equal(r.branches.has('feature'), true, 'recreate after delete works');
  assert(!r.branches.has('clash'), 'sanity');
});

test('repo: checkout refuses dirty worktree without force', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', '1\n');
  r.commit('base', 't', {});
  r.createBranch('other');
  r.writeFile('a.txt', 'dirty\n');
  throws(() => r.checkout('other', {}), 'FORGE_DIRTY_WORKTREE');
  r.checkout('other', { force: true });
  equal(r.readFile('a.txt'), '1\n');
});

test('repo: checkout unknown ref rejected with clear error', () => {
  const r = new Repository('r');
  r.commit('c', 't', {});
  throws(() => r.checkout('nope', {}), 'FORGE_NOT_FOUND');
});

test('repo: log walks first-parent chain', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', '1\n');
  const c1 = r.commit('one', 't', {});
  r.writeFile('a.txt', '2\n');
  const c2 = r.commit('two', 't', {});
  const log = r.log(10);
  equal(log[0].hash, c2.hash);
  equal(log[1].hash, c1.hash);
  deepEqual(log[0].parents, [c1.hash]);
});

test('repo: resolveRef supports branches, commits, HEAD, HEAD~1', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', '1\n');
  const c1 = r.commit('one', 't', {});
  r.writeFile('a.txt', '2\n');
  const c2 = r.commit('two', 't', {});
  equal(r.resolveRef('HEAD'), c2.hash);
  equal(r.resolveRef('HEAD~1'), c1.hash);
  equal(r.resolveRef('main'), c2.hash);
  equal(r.resolveRef(c1.hash), c1.hash);
  throws(() => r.resolveRef('bogus'), 'FORGE_NOT_FOUND');
});

test('repo: diffRefs produces patches for changed files only', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', 'x\n');
  r.writeFile('b.txt', 'same\n');
  const one = r.commit('one', 't', {});
  r.writeFile('a.txt', 'y\n');
  r.writeFile('c.txt', 'new\n');
  const two = r.commit('two', 't', {});
  const d = r.diffRefs(one.hash, two.hash);
  const paths = d.files.map((f) => f.path).sort();
  deepEqual(paths, ['a.txt', 'c.txt']);
  const a = d.files.find((f) => f.path === 'a.txt');
  equal(a.kind, 'modified');
  includes(a.patch, '+y');
  includes(a.patch, '-x');
});

test('repo: isAncestor and mergeBase', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', '1\n');
  const base = r.commit('base', 't', {});
  r.createBranch('f');
  r.writeFile('a.txt', '2\n');
  const m = r.commit('main2', 't', {});
  r.checkout('f', { force: true });
  r.writeFile('a.txt', '3\n');
  const f1 = r.commit('f1', 't', {});
  equal(r.isAncestor(base.hash, f1.hash), true);
  equal(r.isAncestor(f1.hash, base.hash), false);
  equal(r.mergeBase(m.hash, f1.hash), base.hash);
});

test('repo: serialize/deserialize roundtrip preserves everything', () => {
  const r = new Repository('r');
  r.writeFile('a.txt', '1\n');
  r.commit('one', 't', {});
  r.createBranch('f');
  r.writeFile('b.txt', 'dirty\n');
  const data = JSON.parse(JSON.stringify(r.serialize()));
  const r2 = Repository.deserialize(data);
  equal(r2.head.commit, r.head.commit);
  equal(r2.readFile('b.txt'), 'dirty\n');
  deepEqual(r2.listBranches().map((b) => b.name), r.listBranches().map((b) => b.name));
  throws(() => Repository.deserialize({ blobs: 'nope' }), 'FORGE_INVALID_INPUT');
});

test('repo: commit during merge state without merge flag rejected', () => {
  const r = new Repository('r');
  r.writeFile('f.txt', 'a\nb\nc\n');
  r.commit('base', 't', {});
  r.createBranch('feature');
  r.checkout('feature', {});
  r.writeFile('f.txt', 'a\nOURS\nc\n');
  r.commit('ours', 't', {});
  r.checkout('main', { force: true });
  r.writeFile('f.txt', 'a\nTHEIRS\nc\n');
  r.commit('theirs', 't', {});
  r.merge('feature', {});
  throws(() => r.commit('normal', 't', {}), 'FORGE_STATE');
});

test('repo: workspace-level file ops require permissions and persist', () => {
  const ws = makeWs();
  ws.writeFile(ADMIN, 'hello.txt', 'world\n');
  equal(ws.readFile('hello.txt'), 'world\n');
  ws.commit(ADMIN, 'add hello');
  const files = ws.repo.listFiles();
  assert(files.includes('hello.txt'));
  const audits = ws.audit.filter({ action: 'repo.file_written' });
  equal(audits.length, 1);
});

test('repo: seeded demo repository has the expected baseline', () => {
  const ws = makeSeededWs();
  const files = ws.repo.listFiles();
  for (const f of ['README.md', 'package.json', 'src/stringUtils.js', 'src/userService.js', 'tests/unit/stringUtils.test.js', 'tests/integration/userService.test.js']) {
    assert(files.includes(f), `missing seed file ${f}`);
  }
  equal(ws.repo.status().clean, true);
  equal(ws.repo.log(5).length, 1, 'exactly the seed commit');
});
