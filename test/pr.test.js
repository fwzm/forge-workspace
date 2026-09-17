'use strict';

const { test, assert, equal, includes, deepEqual, throws, makeSeededWs, ADMIN, IMPLEMENTER, REVIEWER } = require('./lib');

const CLEAN_FILE = "'use strict';\n\nconst GREETING = 'hello';\n\nmodule.exports = { GREETING };\n";

function landFeature(ws, { branch = 'feature/greeting', file = 'src/greeting.js', content = CLEAN_FILE, message = 'feat: greeting' } = {}) {
  ws.createBranch(IMPLEMENTER, branch, undefined);
  ws.checkoutBranch(IMPLEMENTER, branch, {});
  ws.writeFile(IMPLEMENTER, file, content);
  const commit = ws.commit(IMPLEMENTER, message);
  return { branch, commit };
}

test('pr: open validates branches and duplicate open PRs', () => {
  const ws = makeSeededWs();
  throws(() => ws.openPr(IMPLEMENTER, { title: 'X', sourceBranch: 'ghost', targetBranch: 'main' }), 'FORGE_NOT_FOUND');
  throws(() => ws.openPr(IMPLEMENTER, { title: 'X', sourceBranch: 'main', targetBranch: 'main' }), 'FORGE_INVALID_INPUT');
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'Add greeting', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  equal(pr.state, 'open');
  equal(pr.headSha, ws.repo.resolveRef('feature/greeting'));
  throws(() => ws.openPr(IMPLEMENTER, { title: 'Dup', sourceBranch: 'feature/greeting', targetBranch: 'main' }), 'FORGE_STATE');
});

test('pr: comment review records reviewer and head without state change', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  const { review } = ws.reviewPr(REVIEWER, pr.id, { type: 'comment', comment: 'looks big' });
  equal(ws.prs.get(pr.id).state, 'open');
  equal(review.reviewer, 'reviewer-1');
  equal(review.reviewerRole, 'reviewer');
  equal(review.headSha, pr.headSha);
});

test('pr: approve transitions to approved', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  ws.reviewPr(REVIEWER, pr.id, { type: 'approve', comment: 'ship it' });
  equal(ws.prs.get(pr.id).state, 'approved');
  deepEqual(ws.prs.validApprovals(ws.prs.get(pr.id)), ['reviewer-1']);
});

test('pr: request changes transitions to changes_requested; later approve recovers', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  ws.reviewPr(REVIEWER, pr.id, { type: 'request_changes', comment: 'needs work' });
  equal(ws.prs.get(pr.id).state, 'changes_requested');
  ws.reviewPr(REVIEWER, pr.id, { type: 'approve', comment: 'better' });
  equal(ws.prs.get(pr.id).state, 'approved');
});

test('pr: author cannot self-approve even with admin rights', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(ADMIN, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  throws(() => ws.reviewPr(ADMIN, pr.id, { type: 'approve' }), 'FORGE_STATE');
  throws(() => ws.reviewPr(ADMIN, pr.id, { type: 'request_changes' }), 'FORGE_STATE');
});

test('pr: implementer cannot approve at all (permission precedes authorship)', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(ADMIN, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  throws(() => ws.reviewPr(IMPLEMENTER, pr.id, { type: 'approve' }), 'FORGE_PERMISSION_DENIED');
});

test('pr: merge gate rejects when no approval', async () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  await ws.runCi(ADMIN, { prId: pr.id });
  const err = throws(() => ws.mergePr(ADMIN, pr.id), 'FORGE_MERGE_GATE');
  assert(err.details.missing.some((m) => m.includes('approval')), JSON.stringify(err.details.missing));
  const rejected = ws.audit.filter({ action: 'pr.merge_rejected' });
  equal(rejected.length, 1);
});

test('pr: merge gate rejects when no CI run exists', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  ws.reviewPr(REVIEWER, pr.id, { type: 'approve' });
  const err = throws(() => ws.mergePr(ADMIN, pr.id), 'FORGE_MERGE_GATE');
  assert(err.details.missing.some((m) => m.includes('no CI run')), JSON.stringify(err.details.missing));
});

test('pr: merge gate rejects when CI failed', async () => {
  const ws = makeSeededWs();
  landFeature(ws, { content: 'const X = 1;   \n' });
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  ws.reviewPr(REVIEWER, pr.id, { type: 'approve' });
  const run = await ws.runCi(ADMIN, { prId: pr.id });
  equal(run.status, 'failure');
  const err = throws(() => ws.mergePr(ADMIN, pr.id), 'FORGE_MERGE_GATE');
  assert(err.details.missing.some((m) => m.includes('lint')), JSON.stringify(err.details.missing));
});

test('pr: merge gate rejects when head moved after CI (stale run)', async () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  await ws.runCi(ADMIN, { prId: pr.id });
  ws.reviewPr(REVIEWER, pr.id, { type: 'approve' });
  const before = ws.prs.get(pr.id).headSha;
  ws.writeFile(IMPLEMENTER, 'src/extra.js', CLEAN_FILE);
  ws.commit(IMPLEMENTER, 'feat: extra');
  const after = ws.prs.get(pr.id).headSha;
  assert(before !== after, 'head sha tracked');
  throws(() => ws.mergePr(ADMIN, pr.id), 'FORGE_MERGE_GATE');
});

test('pr: non-required failing check does not block merge (configured subset)', async () => {
  const ws = makeSeededWs();
  landFeature(ws, { content: 'const X = 1;   \n' }); // lint fails
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  ws.reviewPr(REVIEWER, pr.id, { type: 'approve' });
  await ws.runCi(ADMIN, { prId: pr.id });
  ws.updateConfig(ADMIN, { requiredChecks: ['unit', 'integration', 'security', 'build'] });
  const merged = ws.mergePr(ADMIN, pr.id);
  equal(merged.state, 'merged');
});

test('pr: full merge flow lands the feature on main with a merge commit', async () => {
  const ws = makeSeededWs();
  landFeature(ws);
  // diverge main so the merge is a true 3-way merge commit (not fast-forward)
  ws.checkoutBranch(ADMIN, 'main', {});
  ws.writeFile(ADMIN, 'docs.md', 'main-side change\n');
  ws.commit(ADMIN, 'docs: main side progress');
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  await ws.runCi(ADMIN, { prId: pr.id });
  ws.reviewPr(REVIEWER, pr.id, { type: 'approve' });
  const merged = ws.mergePr(ADMIN, pr.id);
  equal(merged.state, 'merged');
  assert(merged.mergeCommit);
  const mc = ws.repo.commits.get(merged.mergeCommit);
  equal(mc.parents.length, 2, 'merge commit has two parents');
  assert(Object.keys(ws.repo.snapshot('main')).includes('src/greeting.js'), 'feature file on main');
  assert(ws.audit.filter({ action: 'pr.merged' }).length === 1);
});

test('pr: merged PR rejects re-merge', async () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  await ws.runCi(ADMIN, { prId: pr.id });
  ws.reviewPr(REVIEWER, pr.id, { type: 'approve' });
  ws.mergePr(ADMIN, pr.id);
  throws(() => ws.mergePr(ADMIN, pr.id), 'FORGE_INVALID_TRANSITION');
});

test('pr: close then merge rejected; reviews after close rejected', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  ws.closePr(ADMIN, pr.id);
  equal(ws.prs.get(pr.id).state, 'closed');
  throws(() => ws.mergePr(ADMIN, pr.id), 'FORGE_INVALID_TRANSITION');
  throws(() => ws.reviewPr(REVIEWER, pr.id, { type: 'comment' }), 'FORGE_STATE');
});

test('pr: conflicting PR merge surfaces conflicts; manual resolution path merges', async () => {
  const ws = makeSeededWs();
  // branch FIRST, then diverge both sides from the same base
  ws.createBranch(IMPLEMENTER, 'feature/conflict', undefined);
  ws.checkoutBranch(IMPLEMENTER, 'feature/conflict', {});
  ws.writeFile(IMPLEMENTER, 'docs.md', 'feature version\n');
  ws.commit(IMPLEMENTER, 'feature side');
  ws.checkoutBranch(ADMIN, 'main', {});
  ws.writeFile(ADMIN, 'docs.md', 'main version\n');
  ws.commit(ADMIN, 'main side');
  const pr = ws.openPr(IMPLEMENTER, { title: 'Conflicting', sourceBranch: 'feature/conflict', targetBranch: 'main' });
  await ws.runCi(ADMIN, { prId: pr.id });
  ws.reviewPr(REVIEWER, pr.id, { type: 'approve' });
  const err = throws(() => ws.mergePr(ADMIN, pr.id), 'FORGE_CONFLICT');
  assert(ws.repo.mergeState, 'repository enters merging state');
  ws.resolveConflict(ADMIN, 'docs.md', 'theirs', undefined);
  ws.completeMerge(ADMIN, 'manual merge after conflict', {});
  const merged = ws.mergePr(ADMIN, pr.id);
  equal(merged.state, 'merged');
  equal(merged.mergeCommit, ws.repo.head.commit);
});

test('pr: prDiff returns changed files between branches', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  const diff = ws.prDiff(pr.id);
  assert(diff.files.some((f) => f.path === 'src/greeting.js' && f.kind === 'added'));
});

test('pr: head sha syncs on new commits with audit trail', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  const before = pr.headSha;
  ws.writeFile(IMPLEMENTER, 'src/greeting.js', CLEAN_FILE + '\n');
  ws.commit(IMPLEMENTER, 'feat: more');
  const after = ws.prs.get(pr.id).headSha;
  assert(before !== after);
  assert(ws.audit.filter({ action: 'pr.head_updated' }).length >= 1);
});

test('pr: review on unknown PR rejected', () => {
  const ws = makeSeededWs();
  throws(() => ws.reviewPr(REVIEWER, 'pr-ghost', { type: 'approve' }), 'FORGE_NOT_FOUND');
});

test('pr: permissions — viewer cannot approve, qa cannot open PR', () => {
  const ws = makeSeededWs();
  landFeature(ws);
  const pr = ws.openPr(IMPLEMENTER, { title: 'T', sourceBranch: 'feature/greeting', targetBranch: 'main' });
  throws(() => ws.reviewPr({ type: 'user', id: 'v', role: 'viewer' }, pr.id, { type: 'approve' }), 'FORGE_PERMISSION_DENIED');
  throws(() => ws.openPr({ type: 'user', id: 'q', role: 'qa' }, { title: 'X', sourceBranch: 'feature/greeting', targetBranch: 'main' }), 'FORGE_PERMISSION_DENIED');
});
