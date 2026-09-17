'use strict';

const { test, assert, equal, deepEqual, includes, throws, makeWs, makeSeededWs, ADMIN } = require('./lib');
const { diffLines, diffHunks, unifiedDiff, lcsMatches, splitLines } = require('../server/core/diff');
const { merge3 } = require('../server/domain/merge');

test('diff: no changes produces no ops', () => {
  const ops = diffLines(['a', 'b'], ['a', 'b']);
  assert(ops.every((o) => o.type === 'equal'));
});

test('diff: detects addition', () => {
  const ops = diffLines(['a', 'c'], ['a', 'b', 'c']);
  equal(ops.filter((o) => o.type === 'add').length, 1);
  equal(ops.find((o) => o.type === 'add').text, 'b');
});

test('diff: detects deletion', () => {
  const ops = diffLines(['a', 'b', 'c'], ['a', 'c']);
  equal(ops.filter((o) => o.type === 'del').length, 1);
  equal(ops.find((o) => o.type === 'del').text, 'b');
});

test('diff: detects modification as del+add', () => {
  const ops = diffLines(['old line'], ['new line']);
  equal(ops.filter((o) => o.type === 'del').length, 1);
  equal(ops.filter((o) => o.type === 'add').length, 1);
});

test('diff: hunks carry base and side ranges', () => {
  const hunks = diffHunks(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'd']);
  equal(hunks.length, 1);
  deepEqual([hunks[0].aStart, hunks[0].aEnd], [1, 3]);
  deepEqual([hunks[0].bStart, hunks[0].bEnd], [1, 3]);
});

test('diff: two separate hunks', () => {
  const hunks = diffHunks(['1', '2', '3', '4', '5'], ['1', 'x', '3', '4', 'y']);
  equal(hunks.length, 2);
});

test('diff: unified output has headers and markers', () => {
  const out = unifiedDiff(['a', 'b'], ['a', 'c'], { aLabel: 'a/f', bLabel: 'b/f' });
  includes(out, '--- a/f');
  includes(out, '+++ b/f');
  includes(out, '-b');
  includes(out, '+c');
});

test('diff: unified output empty when identical', () => {
  equal(unifiedDiff(['x'], ['x']), '');
});

test('diff: lcsMatches ascending pairs', () => {
  const m = lcsMatches(['a', 'b', 'c'], ['a', 'x', 'c']);
  deepEqual(m, [[0, 0], [2, 2]]);
});

test('diff: splitLines handles empty and trailing newline', () => {
  deepEqual(splitLines(''), []);
  deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  deepEqual(splitLines('a'), ['a']);
});

test('merge3: no conflicts when only ours changed', () => {
  const r = merge3(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'b', 'c']);
  equal(r.conflicts.length, 0);
  deepEqual(r.lines, ['a', 'B', 'c']);
});

test('merge3: no conflicts when only theirs changed', () => {
  const r = merge3(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'B', 'c']);
  equal(r.conflicts.length, 0);
  deepEqual(r.lines, ['a', 'B', 'c']);
});

test('merge3: both sides changed different regions merges cleanly', () => {
  const base = ['one', 'two', 'three', 'four', 'five'];
  const ours = ['one', 'TWO', 'three', 'four', 'five'];
  const theirs = ['one', 'two', 'three', 'FOUR', 'five'];
  const r = merge3(base, ours, theirs);
  equal(r.conflicts.length, 0);
  deepEqual(r.lines, ['one', 'TWO', 'three', 'FOUR', 'five']);
});

test('merge3: identical change on both sides applies once', () => {
  const r = merge3(['a', 'b'], ['a', 'same', 'b'], ['a', 'same', 'b']);
  equal(r.conflicts.length, 0);
  deepEqual(r.lines, ['a', 'same', 'b']);
});

test('merge3: same region changed differently conflicts', () => {
  const r = merge3(['a', 'b', 'c'], ['a', 'OURS', 'c'], ['a', 'THEIRS', 'c']);
  equal(r.conflicts.length, 1);
  deepEqual(r.conflicts[0].ours, ['OURS']);
  deepEqual(r.conflicts[0].theirs, ['THEIRS']);
  includes(r.text, '<<<<<<< ours');
  includes(r.text, '=======');
  includes(r.text, '>>>>>>> theirs');
});

test('merge3: insertion vs insertion at same point conflicts', () => {
  const r = merge3(['a', 'b'], ['a', 'X', 'b'], ['a', 'Y', 'b']);
  equal(r.conflicts.length, 1);
});

test('merge3: addition by one side passes through', () => {
  const r = merge3(['a', 'b'], ['a', 'mid', 'b'], ['a', 'b']);
  equal(r.conflicts.length, 0);
  deepEqual(r.lines, ['a', 'mid', 'b']);
});

test('merge3: non-overlapping additions from both sides merge', () => {
  const base = ['a', 'b', 'c', 'd', 'e'];
  const ours = ['a', 'b', 'OURS', 'c', 'd', 'e'];
  const theirs = ['a', 'b', 'c', 'd', 'e', 'THEIRS'];
  const r = merge3(base, ours, theirs);
  equal(r.conflicts.length, 0);
  deepEqual(r.lines, ['a', 'b', 'OURS', 'c', 'd', 'e', 'THEIRS']);
});

test('repo merge: fast-forward when base is behind', () => {
  const ws = makeWs();
  ws.repo.writeFile('f.txt', 'one\n');
  ws.repo.commit('c1', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.writeFile('f.txt', 'one\ntwo\n');
  const c2 = ws.repo.commit('c2', 't', {});
  ws.repo.checkout('main', { force: true });
  const res = ws.repo.merge('feature', {});
  equal(res.status, 'fast-forward');
  equal(res.commit, c2.hash);
  equal(ws.repo.readFile('f.txt'), 'one\ntwo\n');
});

test('repo merge: up-to-date when base already contains source', () => {
  const ws = makeWs();
  ws.repo.writeFile('f.txt', 'one\n');
  ws.repo.commit('c1', 't', {});
  ws.repo.createBranch('feature');
  const res = ws.repo.merge('feature', {});
  equal(res.status, 'up-to-date');
});

test('repo merge: clean three-way merge creates merge commit with two parents', () => {
  const ws = makeWs();
  ws.repo.writeFile('f.txt', 'a\nb\nc\nd\ne\n');
  ws.repo.commit('base', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.writeFile('f.txt', 'a\nb\nC-OURS\nd\ne\n');
  ws.repo.commit('ours', 't', {});
  ws.repo.checkout('main', { force: true });
  ws.repo.writeFile('f.txt', 'A-THEIRS\nb\nc\nd\ne\n');
  ws.repo.commit('theirs-main', 't', {});
  const res = ws.repo.merge('feature', { author: 'tester' });
  equal(res.status, 'clean');
  const mc = ws.repo.commits.get(res.commit);
  equal(mc.parents.length, 2, 'two parents');
  includes(ws.repo.readFile('f.txt'), 'C-OURS');
  includes(ws.repo.readFile('f.txt'), 'A-THEIRS');
});

test('repo merge: same-region conflict detected, markers written, merge state set', () => {
  const ws = makeWs();
  ws.repo.writeFile('f.txt', 'a\nb\nc\n');
  ws.repo.commit('base', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.writeFile('f.txt', 'a\nOURS\nc\n');
  ws.repo.commit('ours', 't', {});
  ws.repo.checkout('main', { force: true });
  ws.repo.writeFile('f.txt', 'a\nTHEIRS\nc\n');
  ws.repo.commit('theirs', 't', {});
  const res = ws.repo.merge('feature', {});
  equal(res.status, 'conflict');
  deepEqual(res.conflicts, ['f.txt']);
  const markers = ws.repo.readFile('f.txt');
  includes(markers, '<<<<<<< ours');
  includes(markers, 'THEIRS');
  includes(markers, '>>>>>>> theirs');
  assert(ws.repo.mergeState, 'merge state active');
});

test('repo merge: resolve ours/theirs then complete merge', () => {
  const ws = makeWs();
  ws.repo.writeFile('f.txt', 'a\nb\nc\n');
  ws.repo.commit('base', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.writeFile('f.txt', 'a\nOURS\nc\n');
  ws.repo.commit('ours', 't', {});
  ws.repo.checkout('main', { force: true });
  ws.repo.writeFile('f.txt', 'a\nTHEIRS\nc\n');
  ws.repo.commit('theirs', 't', {});
  ws.repo.merge('feature', {});
  // repo-side "theirs" is the merged-in branch (feature), whose content is OURS
  const r1 = ws.repo.resolveConflict('f.txt', 'theirs');
  equal(r1.remaining.length, 0);
  const done = ws.repo.completeMerge('merged!', 'tester', {});
  equal(done.status, 'clean');
  equal(ws.repo.readFile('f.txt'), 'a\nOURS\nc\n');
  const mc = ws.repo.commits.get(done.commit);
  equal(mc.parents.length, 2);
  equal(ws.repo.mergeState, null);
});

test('repo merge: completeMerge with unresolved conflicts rejected', () => {
  const ws = makeWs();
  ws.repo.writeFile('f.txt', 'a\nb\nc\n');
  ws.repo.commit('base', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.writeFile('f.txt', 'a\nOURS\nc\n');
  ws.repo.commit('ours', 't', {});
  ws.repo.checkout('main', { force: true });
  ws.repo.writeFile('f.txt', 'a\nTHEIRS\nc\n');
  ws.repo.commit('theirs', 't', {});
  ws.repo.merge('feature', {});
  throws(() => ws.repo.completeMerge('x', 't', {}), 'FORGE_CONFLICT');
});

test('repo merge: abort restores pre-merge state', () => {
  const ws = makeWs();
  ws.repo.writeFile('f.txt', 'a\nb\nc\n');
  ws.repo.commit('base', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.writeFile('f.txt', 'a\nOURS\nc\n');
  ws.repo.commit('ours', 't', {});
  ws.repo.checkout('main', { force: true });
  ws.repo.writeFile('f.txt', 'a\nTHEIRS\nc\n');
  const preMergeHead = ws.repo.commit('theirs', 't', {});
  ws.repo.merge('feature', {});
  const res = ws.repo.abortMerge();
  equal(res.restored, preMergeHead.hash);
  equal(ws.repo.mergeState, null);
  equal(ws.repo.readFile('f.txt'), 'a\nTHEIRS\nc\n');
  equal(ws.repo.isDirty(), false);
});

test('repo merge: modify/delete conflict detected', () => {
  const ws = makeWs();
  ws.repo.writeFile('keep.txt', 'content\n');
  ws.repo.commit('base', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.deleteFile('keep.txt');
  ws.repo.commit('feature-deleted', 't', {});
  ws.repo.checkout('main', { force: true });
  ws.repo.writeFile('keep.txt', 'content-modified\n');
  ws.repo.commit('main-modified', 't', {});
  const res = ws.repo.merge('feature', {});
  equal(res.status, 'conflict');
  assert(res.conflicts.includes('keep.txt'), 'modify/delete is a conflict');
});

test('repo merge: delete wins when survivor did not modify', () => {
  const ws = makeWs();
  ws.repo.writeFile('gone.txt', 'content\n');
  ws.repo.writeFile('stay.txt', 'x\n');
  ws.repo.commit('base', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.deleteFile('gone.txt');
  ws.repo.commit('feature-del', 't', {});
  ws.repo.checkout('main', { force: true });
  // main never advanced past base -> merging the deletion fast-forwards
  const res = ws.repo.merge('feature', {});
  equal(res.status, 'fast-forward');
  equal(ws.repo.snapshot('main').gone, undefined, 'file deleted on main after merge');
});

test('repo merge: both added different content conflicts', () => {
  const ws = makeWs();
  ws.repo.writeFile('base.txt', 'x\n');
  ws.repo.commit('base', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.writeFile('new.txt', 'FROM-FEATURE\n');
  ws.repo.commit('f1', 't', {});
  ws.repo.checkout('main', { force: true });
  ws.repo.writeFile('new.txt', 'FROM-MAIN\n');
  ws.repo.commit('m1', 't', {});
  const res = ws.repo.merge('feature', {});
  equal(res.status, 'conflict');
  assert(res.conflicts.includes('new.txt'));
});

test('repo merge: checkout during merge refused', () => {
  const ws = makeWs();
  ws.repo.writeFile('f.txt', 'a\nb\nc\n');
  ws.repo.commit('base', 't', {});
  ws.repo.createBranch('feature');
  ws.repo.checkout('feature', {});
  ws.repo.writeFile('f.txt', 'a\nOURS\nc\n');
  ws.repo.commit('ours', 't', {});
  ws.repo.checkout('main', { force: true });
  ws.repo.writeFile('f.txt', 'a\nTHEIRS\nc\n');
  ws.repo.commit('theirs', 't', {});
  ws.repo.merge('feature', {});
  throws(() => ws.repo.checkout('feature', { force: true }), 'FORGE_STATE');
});

test('repo merge: unrelated histories rejected', () => {
  const ws = makeSeededWs();
  // build a second root by hand: orphan commit chain on a temp branch is not
  // possible through repo APIs (single head), so verify via mergeBase on
  // synthetic commits instead.
  const repo = ws.repo;
  const orphanTree = repo.treeHashFromEntries({ 'x.txt': repo.putBlob('x\n') });
  const payload = JSON.stringify({ tree: orphanTree, parents: [], message: 'orphan', author: 't', timestamp: 1 });
  const { sha256 } = require('../server/domain/repo');
  const orphan = sha256('commit:' + payload);
  repo.commits.set(orphan, { hash: orphan, tree: orphanTree, parents: [], message: 'orphan', author: 't', timestamp: 1 });
  repo.branches.set('orphan-branch', orphan);
  repo.checkout('main', { force: true });
  throws(() => repo.merge('orphan-branch', {}), 'FORGE_CONFLICT');
});

test('repo merge: workspace-level merge routes through permissions and audit', () => {
  const ws = makeSeededWs();
  ws.createBranch(ADMIN, 'wst', undefined);
  ws.checkoutBranch(ADMIN, 'wst', {});
  ws.writeFile(ADMIN, 'wst.txt', 'hi\n');
  ws.commit(ADMIN, 'wst commit');
  ws.checkoutBranch(ADMIN, 'main', {});
  const res = ws.mergeRepo(ADMIN, 'wst', {});
  equal(res.status, 'fast-forward');
  const audits = ws.audit.filter({ action: 'repo.merge_completed' });
  equal(audits.length, 1);
});
