'use strict';

// ---------------------------------------------------------------------------
// Orchestrator: routes tasks to external agent adapters in "patch mode".
//
// externalImplement: export branch snapshot -> agent edits temp dir ->
//   collect changeset -> apply to virtual repo -> commit (same output shape
//   as the internal implement runner, so QA/security/review/CI downstream
//   work unchanged).
// externalReview: send the PR diff, parse the agent's JSON verdict, record a
//   real PR review.
//
// The merge gate is HUMAN by default (config.autoMergeExternal === false):
// the pipeline parks the PR in "approved + CI green" and the user clicks
// Merge in the UI.
// ---------------------------------------------------------------------------
const fs = require('fs');
const { newWorkDir, exportSnapshot, collectChanges, cleanup } = require('./export');
const {
  getAdapter,
  buildImplementPrompt,
  buildReviewPrompt,
  parseReviewReply,
} = require('./adapters');

const MAX_ATTEMPTS_DEFAULT = 3;

function briefFor(task, repoFiles) {
  return buildImplementPrompt(task, repoFiles);
}

// Implements the external implement flow. Actor is the owning agent.
async function externalImplement(ws, agent, task) {
  const spec = task.spec || {};
  const adapter = getAdapter(spec.backend || agent.backend);
  if (!adapter) throw new Error(`no adapter registered for backend "${spec.backend || agent.backend}"`);

  const branch = spec.branch || `task/${task.id}`;
  const fromBranch = spec.fromBranch || ws.repo.head.branch;
  const actor = { type: 'agent', id: agent.id, role: agent.role };

  // Ensure the task branch exists (based on the requested starting branch).
  if (!ws.repo.branches.has(branch)) {
    const baseCommit = ws.repo.resolveRef(fromBranch);
    ws.repo.createBranch(branch, baseCommit);
  }

  const baseFiles = ws.repo.snapshot(branch);
  const workDir = newWorkDir(`${adapter.id}-${task.id}`);
  try {
    exportSnapshot(workDir, baseFiles, briefFor(task, baseFiles));
    const result = await adapter.runTask({
      workDir,
      prompt: fs.readFileSync(`${workDir}/TASK.md`, 'utf8'),
      task,
      ws,
    });
    if (!result.ok) {
      throw new Error(`agent run failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}): ${String(result.stderr || result.stdout || result.error || 'no output').slice(0, 400)}`);
    }
    const changes = collectChanges(workDir, baseFiles);
    if (changes.empty) {
      throw new Error('agent produced no changes');
    }
    // Apply the changeset to the virtual repository on the task branch.
    ws.checkoutBranch({ type: 'system', id: 'orchestrator', role: 'system' }, branch, { force: true });
    const touched = [];
    for (const [p, content] of Object.entries(changes.modified)) {
      ws.writeFile(actor, p, content);
      touched.push(p);
    }
    for (const [p, content] of Object.entries(changes.added)) {
      ws.writeFile(actor, p, content);
      touched.push(p);
    }
    for (const p of changes.deleted) {
      try { ws.deleteFile(actor, p); } catch (_) { /* already absent */ }
      touched.push(p);
    }
    const commit = ws.commit(actor, `${spec.commitPrefix || 'feat'}: ${task.title} [${adapter.id}]`);
    return {
      output: { branch, commit: commit.hash, message: commit.message, files: touched.sort(), backend: adapter.id },
      artifacts: [
        { type: 'branch', name: branch },
        { type: 'commit', id: commit.hash },
        { type: 'agent-transcript', chars: result.stdout.length },
      ],
    };
  } finally {
    cleanup(workDir);
  }
}

// External review: ensure the pipeline PR exists, ask an agent to review the
// diff, record the verdict, then run CI. The merge itself is a human gate
// unless config.autoMergeExternal is true.
async function externalReview(ws, agent, task) {
  const spec = task.spec || {};
  const adapter = getAdapter(spec.backend || agent.backend);
  if (!adapter) throw new Error(`no adapter registered for backend "${spec.backend || agent.backend}"`);
  const actor = { type: 'agent', id: agent.id, role: agent.role };
  const system = { type: 'system', id: 'orchestrator', role: 'system' };

  // Open the pipeline PR lazily (the implement branch now has commits).
  if (!spec.prId) {
    const branch = spec.branch || `pipeline/${task.spec && task.spec.issueId}`;
    const pr = ws.openPr(system, {
      title: task.title.replace(/^Review:\s*/i, 'Resolve: '),
      sourceBranch: branch,
      targetBranch: 'main',
      description: `Automated pipeline (${spec.backend || agent.backend}). Human merge gate: ${ws.config.autoMergeExternal ? 'OFF (auto-merge enabled)' : 'ON'}.`,
    });
    spec.prId = pr.id;
    task.spec = spec;
  }
  const prId = spec.prId;
  const pr = ws.prs.get(prId);
  const diff = ws.prDiff(prId);
  const diffText = diff.files.map((f) => f.patch).join('\n');
  const workDir = newWorkDir(`review-${task.id}`);
  try {
    exportSnapshot(workDir, {}, 'review-only');
    fs.writeFileSync(`${workDir}/PR.md`, buildReviewPrompt(pr, diffText), 'utf8');
    const result = await adapter.runTask({
      workDir,
      prompt: fs.readFileSync(`${workDir}/PR.md`, 'utf8'),
      task,
      ws,
    });
    if (!result.ok) {
      throw new Error(`agent review failed (exit ${result.exitCode}): ${String(result.stderr || result.stdout || 'no output').slice(0, 300)}`);
    }
    const verdict = parseReviewReply(result.stdout);
    if (!verdict) {
      throw new Error(`agent review reply was not parseable JSON: ${String(result.stdout).slice(0, 200)}`);
    }
    const type = verdict.decision === 'approve' ? 'approve' : 'request_changes';
    ws.reviewPr(actor, prId, {
      type,
      comment: verdict.comment || (type === 'approve' ? 'approved by external reviewer' : 'changes requested by external reviewer'),
      findings: verdict.findings,
    });
    if (type === 'request_changes') {
      // Gate semantics: the review task ends failed so the follow-up round
      // can retry it after fixes land (mirrors the internal reviewer).
      throw new Error(`review gate not passed: ${verdict.findings.filter((f) => f.severity === 'major').length} major finding(s)`);
    }
    // Approved: run CI, then respect the merge gate.
    const run = await ws.runCi(system, { prId });
    let mergeState = 'ci-failed';
    if (run.status === 'success') {
      if (!ws.config.autoMergeExternal) {
        mergeState = 'awaiting-human-merge';
      } else {
        ws.mergePr(system, prId);
        mergeState = 'auto-merged';
        ws.updateIssueState(system, task.issueId, 'resolved');
      }
    }
    return {
      output: { prId, decision: 'approve', findings: verdict.findings, ci: run.status, mergeState },
      artifacts: [{ type: 'review', pr: prId, decision: 'approve' }, { type: 'ci-run', id: run.id }],
    };
  } finally {
    cleanup(workDir);
  }
}

// ---------------------------------------------------------------------------
// One-shot issue pipeline: builds a DAG that combines an external implementer
// with the internal engines, ending in a human merge gate.
// ---------------------------------------------------------------------------
function buildIssuePipeline(ws, actor, { issueId, backend, reviewBackend, fromBranch, instructions }) {
  const issue = ws.issues.find((i) => i.id === issueId);
  if (!issue) throw new Error(`unknown issue: ${issueId}`);
  const adapter = getAdapter(backend);
  if (!adapter) throw new Error(`unknown backend: ${backend}`);
  const reviewerBackend = reviewBackend || backend;
  if (!getAdapter(reviewerBackend)) throw new Error(`unknown review backend: ${reviewerBackend}`);

  const branch = `pipeline/${issue.id}`;
  const impl = ws.createTask(actor, {
    title: `Implement: ${issue.title}`,
    type: 'implement',
    issueId,
    spec: { backend, branch, fromBranch: fromBranch || 'main', instructions },
  });
  const qa = ws.createTask(actor, {
    title: `QA: verify ${issue.id}`,
    type: 'qa',
    dependencies: [impl.id],
    issueId,
    spec: { suites: ['unit', 'integration'], branch },
  });
  const security = ws.createTask(actor, {
    title: `Security: scan ${issue.id}`,
    type: 'security',
    dependencies: [impl.id],
    issueId,
    spec: { branch },
  });
  const review = ws.createTask(actor, {
    title: `Review: ${issue.title}`,
    type: 'review',
    dependencies: [qa.id, security.id],
    issueId,
    spec: { backend: reviewerBackend, branch, prId: null },
  });
  ws.updateIssueState(actor, issueId, 'in_progress');
  return { tasks: { implement: impl, qa, security, review }, branch, backend, reviewerBackend };
}

// Final stage helper kept for direct API use: run CI on a PR and respect the
// merge gate (autoMergeExternal, default false).
async function finalizePipeline(ws, actor, prId) {
  const run = await ws.runCi(actor, { prId });
  if (run.status !== 'success') {
    return { prId, merged: false, reason: `CI failed: ${run.stages.filter((s) => s.status === 'failure').map((s) => s.name).join(', ')}` };
  }
  if (!ws.config.autoMergeExternal) {
    return { prId, merged: false, reason: 'human merge gate: waiting for manual merge (PR is approved + CI green)' };
  }
  ws.mergePr(actor, prId);
  return { prId, merged: true, reason: 'auto-merged' };
}

module.exports = {
  externalImplement,
  externalReview,
  buildIssuePipeline,
  finalizePipeline,
  MAX_ATTEMPTS_DEFAULT,
};
