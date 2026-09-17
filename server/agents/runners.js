'use strict';

const { runTests } = require('../engines/harness');
const { reviewDiff } = require('../engines/review');
const { scanFiles } = require('../engines/security');

// ---------------------------------------------------------------------------
// Agent execution handlers. Contract: async (ws, agent, task) -> {output, artifacts}.
// Throwing marks the task failed with the error message (e.g. QA failures).
// Every runner performs real work through workspace domain APIs.
// ---------------------------------------------------------------------------
const runners = {
  async plan(ws, agent, task) {
    const spec = task.spec || {};
    const issueId = spec.issueId;
    const issue = ws.issues.find((i) => i.id === issueId);
    if (!issue) throw new Error(`plan task references unknown issue: ${issueId}`);
    const actor = { type: 'agent', id: agent.id, role: agent.role };
    ws.updateIssueState(actor, issueId, 'in_progress');
    const breakdown = Array.isArray(spec.breakdown) && spec.breakdown.length
      ? spec.breakdown
      : defaultBreakdown(issue);
    const created = [];
    const keyToId = new Map();
    for (const item of breakdown) {
      const deps = (item.deps || []).map((k) => {
        if (keyToId.has(k)) return keyToId.get(k);
        throw new Error(`plan breakdown dependency "${k}" is not an earlier key`);
      });
      const t = ws.createTask(actor, {
        title: item.title,
        description: item.description || '',
        type: item.type || 'implement',
        dependencies: deps,
        issueId,
        spec: item.spec || null,
      });
      keyToId.set(item.key || item.title, t.id);
      created.push({ id: t.id, title: t.title, type: t.type, dependencies: t.dependencies });
    }
    return {
      output: { issueId, planned: created.length, tasks: created },
      artifacts: [{ type: 'issue', id: issueId }, { type: 'tasks', ids: created.map((c) => c.id) }],
    };
  },

  async implement(ws, agent, task) {
    const spec = task.spec || {};
    const files = spec.files;
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      throw new Error('implement task spec has no "files" changes to apply');
    }
    const actor = { type: 'agent', id: agent.id, role: agent.role };
    const branch = spec.branch || `task/${task.id}`;
    if (!ws.repo.branches.has(branch)) {
      ws.createBranch(actor, branch, spec.fromBranch || undefined);
    }
    if (ws.repo.head.branch !== branch) {
      ws.checkoutBranch(actor, branch, {});
    }
    const written = [];
    for (const [path, content] of Object.entries(files)) {
      ws.writeFile(actor, path, content);
      written.push(path);
    }
    for (const path of spec.deleteFiles || []) ws.deleteFile(actor, path);
    const commit = ws.commit(actor, spec.message || `work: ${task.title}`);
    return {
      output: { branch, commit: commit.hash, message: commit.message, files: written },
      artifacts: [{ type: 'branch', name: branch }, { type: 'commit', id: commit.hash }],
    };
  },

  async review(ws, agent, task) {
    const spec = task.spec || {};
    const prId = spec.prId;
    if (!prId) throw new Error('review task spec must reference a PR (spec.prId)');
    const pr = ws.prs.get(prId);
    const actor = { type: 'agent', id: agent.id, role: agent.role };
    const diff = ws.prDiff(prId);
    const res = reviewDiff(diff, {
      maxLineLength: ws.config.lintMaxLineLength || 140,
      skipMissingTests: spec.skipMissingTests === true,
    });
    const decision = res.majors > 0 ? 'request_changes' : 'approve';
    const comment = decision === 'request_changes'
      ? `Requested changes: ${res.majors} major finding(s). First: ${res.findings[0].message}`
      : `Approved: no major findings (${res.minors} minor).`;
    ws.reviewPr(actor, prId, { type: decision, comment, findings: res.findings });
    if (decision === 'request_changes') {
      // The review task is a gate: it ends failed when changes are requested,
      // so the follow-up round can retry it after the fixes land.
      throw new Error(`review gate not passed: ${res.majors} major finding(s) on ${prId}`);
    }
    return {
      output: { prId, decision, majors: res.majors, minors: res.minors, findings: res.findings },
      artifacts: [{ type: 'review', pr: prId, decision }, { type: 'findings', count: res.findings.length }],
    };
  },

  async qa(ws, agent, task) {
    const spec = task.spec || {};
    const suites = spec.suites || ['unit', 'integration'];
    const files = spec.branch ? ws.repo.snapshot(spec.branch) : ws.repo.snapshot(null);
    const results = [];
    let totalPassed = 0;
    let totalFailed = 0;
    for (const suite of suites) {
      const res = await runTests(files, { timeoutMs: 3000, only: `tests/${suite}/` });
      if (res.total === 0) {
        throw new Error(`qa suite "${suite}" has no test files under tests/${suite}/`);
      }
      results.push({ suite, ...res });
      totalPassed += res.passed;
      totalFailed += res.failed;
      if (res.failed > 0) {
        const names = [];
        for (const s of res.suites) for (const c of s.cases) if (c.status === 'failed') names.push(`${s.file}::${c.name}`);
        throw new Error(`qa suite "${suite}" failed: ${res.failed}/${res.total} failing (${names.slice(0, 5).join(', ')})`);
      }
    }
    return {
      output: { branch: spec.branch || 'HEAD', suites: results, passed: totalPassed, failed: totalFailed },
      artifacts: [{ type: 'test-results', passed: totalPassed, failed: totalFailed }],
    };
  },

  async security(ws, agent, task) {
    const spec = task.spec || {};
    const threshold = spec.threshold || ws.config.securityThreshold || 'high';
    const files = spec.branch ? ws.repo.snapshot(spec.branch) : ws.repo.snapshot(null);
    const res = scanFiles(files, { threshold });
    if (res.blocking.length > 0) {
      const list = res.blocking.map((b) => `${b.cwe}@${b.location.file}:${b.location.line}`).join('; ');
      throw new Error(`security scan blocked: ${res.blocking.length} finding(s) >= "${threshold}" (${list})`);
    }
    return {
      output: { threshold, counts: res.counts, findings: res.findings },
      artifacts: [{ type: 'security-scan', findings: res.findings.length, threshold }],
    };
  },
};

function defaultBreakdown(issue) {
  return [
    { key: 'implement', title: `Implement: ${issue.title}`, type: 'implement', description: `Code change for ${issue.id}`, spec: { issueId: issue.id } },
    { key: 'qa', title: `QA: verify ${issue.id}`, type: 'qa', deps: ['implement'], spec: { suites: ['unit', 'integration'] } },
    { key: 'security', title: `Security scan: ${issue.id}`, type: 'security', deps: ['implement'], spec: {} },
    { key: 'review', title: `Review: ${issue.title}`, type: 'review', deps: ['qa', 'security'], spec: null },
  ];
}

module.exports = { runners, defaultBreakdown };
