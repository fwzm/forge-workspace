'use strict';

const { assertCiRunTransition, assertCiStageTransition } = require('../core/statemachine');
const { id } = require('../core/ids');
const { lintFiles } = require('../engines/lint');
const { scanFiles } = require('../engines/security');
const { build } = require('../engines/build');
const { runTests } = require('../engines/harness');

const CI_STAGES = ['lint', 'unit', 'integration', 'security', 'build'];

// ---------------------------------------------------------------------------
// CI pipeline. Every stage executes a REAL engine over a REAL repository
// snapshot of the given ref. A run is 'success' only if all stages succeed.
// ---------------------------------------------------------------------------

function createRun({ ref, sha, prId, actor }) {
  return {
    id: id('ci'),
    ref,
    sha,
    prId: prId || null,
    status: 'running',
    triggeredBy: actor ? actor.id : 'system',
    stages: CI_STAGES.map((name) => ({ name, status: 'pending', startedAt: null, finishedAt: null, output: null })),
    createdAt: Date.now(),
    finishedAt: null,
  };
}

async function executeStages(ws, run, files, config) {
  for (const stage of run.stages) {
    assertCiStageTransition(stage, 'running');
    stage.status = 'running';
    stage.startedAt = Date.now();
    let output = null;
    try {
      switch (stage.name) {
        case 'lint': {
          const res = lintFiles(files, { maxLineLength: config.lintMaxLineLength || 140 });
          output = { errors: res.errors, warnings: res.warnings, findings: res.findings };
          if (res.errors > 0) throw new Error(`lint failed with ${res.errors} error(s): ${res.findings.filter((x) => x.severity === 'error').map((x) => `${x.file}:${x.line} ${x.rule}`).join('; ')}`);
          break;
        }
        case 'unit': {
          const res = await runTests(files, { timeoutMs: 3000, only: 'tests/unit/' });
          if (res.total === 0) throw new Error('no unit test files found under tests/unit/');
          output = summarize(res);
          if (res.failed > 0) throw new Error(`unit tests failed: ${res.failed}/${res.total} (${failingNames(res)})`);
          break;
        }
        case 'integration': {
          const res = await runTests(files, { timeoutMs: 3000, only: 'tests/integration/' });
          if (res.total === 0) throw new Error('no integration test files found under tests/integration/');
          output = summarize(res);
          if (res.failed > 0) throw new Error(`integration tests failed: ${res.failed}/${res.total} (${failingNames(res)})`);
          break;
        }
        case 'security': {
          const res = scanFiles(files, { threshold: config.securityThreshold || 'high' });
          output = { counts: res.counts, threshold: res.threshold, blocking: res.blocking.map((b) => ({ cwe: b.cwe, severity: b.severity, location: b.location, description: b.description })) };
          if (res.blocking.length > 0) throw new Error(`security scan blocked: ${res.blocking.length} finding(s) at or above "${res.threshold}" (${res.blocking.map((b) => `${b.cwe}@${b.location.file}:${b.location.line}`).join('; ')})`);
          break;
        }
        case 'build': {
          const res = build(files);
          output = { ok: res.ok, artifact: res.artifact, errors: res.errors };
          if (!res.ok) throw new Error(`build failed: ${res.errors.map((e) => `${e.file}: ${e.message}`).join('; ')}`);
          break;
        }
        default:
          throw new Error(`unknown stage: ${stage.name}`);
      }
      assertCiStageTransition(stage, 'success');
      stage.status = 'success';
    } catch (e) {
      assertCiStageTransition(stage, 'failure');
      stage.status = 'failure';
      if (!output) output = { error: e.message };
      else output.error = e.message;
    }
    stage.output = output;
    stage.finishedAt = Date.now();
  }
  assertCiRunTransition(run, 'success');
  const failed = run.stages.some((s) => s.status === 'failure');
  run.status = failed ? 'failure' : 'success';
  run.finishedAt = Date.now();
  return run;
}

function summarize(res) {
  return {
    total: res.total, passed: res.passed, failed: res.failed, durationMs: res.durationMs,
    suites: res.suites.map((s) => ({ file: s.file, passed: s.passed, failed: s.failed, error: s.error, cases: s.cases })),
  };
}

function failingNames(res) {
  const names = [];
  for (const s of res.suites) {
    for (const c of s.cases) if (c.status === 'failed') names.push(`${s.file}::${c.name}`);
  }
  return names.slice(0, 5).join(', ');
}

// Gate evaluation used by PR merge: returns { ok, missing: [], runId }
// GitHub-style semantics: each REQUIRED check must have a successful stage in
// the latest run for the PR head; failures of non-required stages do not block.
function evaluateGate(ws, pr) {
  const required = ws.config.requiredChecks || CI_STAGES;
  const runsForSha = ws.ciRuns.filter((r) => r.sha === pr.headSha);
  const run = runsForSha.length ? runsForSha[runsForSha.length - 1] : null;
  const missing = [];
  if (!run) {
    missing.push(`no CI run for head ${pr.headSha.slice(0, 10)}`);
  } else {
    for (const name of required) {
      const stage = run.stages.find((s) => s.name === name);
      if (!stage) missing.push(`required check "${name}" not part of run ${run.id}`);
      else if (stage.status !== 'success') missing.push(`required check "${name}" is ${stage.status}`);
    }
  }
  const approvals = ws.prs.validApprovals(pr);
  if (approvals.length < 1) missing.push('no valid approval for current head');
  return { ok: missing.length === 0, missing, runId: run ? run.id : null, approvals };
}

module.exports = { CI_STAGES, createRun, executeStages, evaluateGate };
