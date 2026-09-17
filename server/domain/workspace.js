'use strict';

const { id } = require('../core/ids');
const { ForgeError, CODES, notFound, invalidInput } = require('../core/errors');
const { assertString, assertEnum, assertArray, assertObject, assertRepoPath } = require('../core/validation');
const { Repository } = require('./repo');
const { TaskGraph, TASK_TYPES } = require('./tasks');
const { AgentRegistry, postMessage } = require('./agents');
const { PullRequests, PR_REVIEW_TYPES } = require('./pr');
const { AuditLog } = require('./audit');
const { can, assertCan } = require('./permissions');
const { Persistence, validateImportedState } = require('./persistence');
const { createRun, executeStages, evaluateGate } = require('./ci');
const { runners } = require('../agents/runners');
const { assertIssueTransition, ISSUE_STATES, assertPrTransition } = require('../core/statemachine');

const WORKSPACE_FORMAT = 'forge.workspace';
const WORKSPACE_VERSION = 1;

// ---------------------------------------------------------------------------
// Workspace facade: owns all domain stores, enforces permissions, appends the
// audit log, drives the scheduler, persists every mutation, and executes agents.
// ---------------------------------------------------------------------------
class Workspace {
  constructor(options) {
    const opts = options || {};
    this.persistence = new Persistence(opts.dataDir || './data', opts.fileName);
    this.config = {
      name: 'FORGE Workspace',
      autoScheduler: false,          // when true, ready tasks are auto-assigned & executed
      enforcePermissions: true,      // when false, all roles may act (audited)
      requiredChecks: ['lint', 'unit', 'integration', 'security', 'build'],
      securityThreshold: 'high',
      lintMaxLineLength: 140,
    };
    this.agents = new AgentRegistry();
    this.tasks = new TaskGraph();
    this.repo = new Repository('demo-app');
    this.prs = new PullRequests();
    this.issues = [];
    this.messages = [];
    this.audit = new AuditLog();
    this.ciRuns = [];
    this.demo = { scenario: 'none', stepIndex: 0, steps: [], lastStep: null, running: false };
    this._draining = false;
    this._loaded = false;
    if (!opts.skipLoad) this.tryLoad();
  }

  // -- permissions ------------------------------------------------------------
  check(actor, action) {
    if (!this.config.enforcePermissions) return;
    assertCan(actor, action);
  }

  canAct(actor, action) {
    return can(actor && actor.role, action);
  }

  // -- internal helpers ---------------------------------------------------------
  // target: { type, id } | null; details: serializable context (from/to/etc.)
  _afterMutation(actor, action, target, details) {
    if (action) this.audit.append(actor, action, target || null, details === undefined ? null : details);
    const transitions = this.tasks.schedulerTick();
    for (const tr of transitions) {
      this.audit.append(actor, 'task.auto_transition', { type: 'task', id: tr.id }, tr);
    }
    this._save();
    this._maybeDrain();
  }

  _save() {
    try {
      this.persistence.save(this.serialize());
    } catch (e) {
      this.audit.append({ type: 'system', id: 'persistence', role: 'system' }, 'workspace.persist_error', null, { error: e.message });
    }
  }

  _maybeDrain() {
    if (!this.config.autoScheduler || this._draining) return;
    this._drain().catch((e) => {
      this.audit.append({ type: 'system', id: 'scheduler', role: 'system' }, 'scheduler.error', null, { error: e.message });
    });
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      let guard = 0;
      for (;;) {
        const ready = this.tasks.readyTasks().filter((t) => t.status === 'ready');
        if (ready.length === 0 || guard > 200) break;
        guard += 1;
        const t = ready[0];
        try {
          await this.runTask({ type: 'system', id: 'scheduler', role: 'system' }, t.id);
        } catch (e) {
          if (e instanceof ForgeError && e.code === CODES.STATE) break; // cannot run (no agent etc.)
        }
      }
    } finally {
      this._draining = false;
    }
  }

  _system() {
    return { type: 'system', id: 'system', role: 'system' };
  }

  // -- config / agents -----------------------------------------------------------
  updateConfig(actor, patch) {
    this.check(actor, 'workspace.write');
    assertObject(patch, 'config patch');
    const allowed = ['name', 'autoScheduler', 'enforcePermissions', 'requiredChecks', 'securityThreshold', 'lintMaxLineLength'];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) throw invalidInput(`unknown config key: ${key}`, { key });
    }
    if (patch.name !== undefined) this.config.name = assertString(patch.name, 'name', { min: 1, max: 100 });
    if (patch.autoScheduler !== undefined) this.config.autoScheduler = Boolean(patch.autoScheduler);
    if (patch.enforcePermissions !== undefined) this.config.enforcePermissions = Boolean(patch.enforcePermissions);
    if (patch.requiredChecks !== undefined) {
      const checks = assertArray(patch.requiredChecks, 'requiredChecks', { min: 0, max: 5 });
      const valid = ['lint', 'unit', 'integration', 'security', 'build'];
      for (const c of checks) assertEnum(c, 'check', valid);
      this.config.requiredChecks = [...new Set(checks)];
    }
    if (patch.securityThreshold !== undefined) this.config.securityThreshold = assertEnum(patch.securityThreshold, 'securityThreshold', ['critical', 'high', 'medium', 'low']);
    if (patch.lintMaxLineLength !== undefined) {
      const n = Number(patch.lintMaxLineLength);
      if (!Number.isInteger(n) || n < 40 || n > 1000) throw invalidInput('lintMaxLineLength must be an integer 40..1000');
      this.config.lintMaxLineLength = n;
    }
    this._afterMutation(actor, 'config.updated', { type: 'workspace', id: this.config.name }, patch);
    return this.config;
  }

  registerAgent(actor, { name, type }) {
    this.check(actor, 'workspace.write');
    const agent = this.agents.register({ name, type });
    this._afterMutation(actor, 'agent.registered', { type: 'agent', id: agent.id }, { name: agent.name, type: agent.type });
    return agent;
  }

  // -- issues ----------------------------------------------------------------------
  createIssue(actor, { title, body, labels }) {
    this.check(actor, 'issue.create');
    const issue = {
      id: id('iss'),
      title: assertString(title, 'title', { min: 1, max: 200 }),
      body: typeof body === 'string' ? body.slice(0, 8000) : '',
      labels: Array.isArray(labels) ? labels.map(String).slice(0, 10) : [],
      state: 'open',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      author: actor ? actor.id : 'unknown',
    };
    this.issues.push(issue);
    this._afterMutation(actor, 'issue.created', { type: 'issue', id: issue.id }, { title: issue.title });
    return issue;
  }

  updateIssueState(actor, issueId, state) {
    assertEnum(state, 'state', ISSUE_STATES);
    const issue = this.issues.find((i) => i.id === issueId);
    if (!issue) throw notFound('Issue', issueId);
    const from = issue.state;
    assertIssueTransition(issue, state);
    issue.state = state;
    issue.updatedAt = Date.now();
    this._afterMutation(actor, 'issue.state_changed', { type: 'issue', id: issueId }, { from, to: state });
    return issue;
  }

  // -- tasks --------------------------------------------------------------------------
  createTask(actor, input) {
    this.check(actor, 'task.create');
    assertObject(input, 'task input');
    const tid = input.id !== undefined ? assertString(input.id, 'id', { min: 3, max: 64 }) : id('task');
    if (this.tasks.has(tid)) throw new ForgeError(CODES.STATE, `Task id already exists: ${tid}`);
    if (input.type !== undefined) assertEnum(input.type, 'type', TASK_TYPES);
    const task = this.tasks.create({ ...input, id: tid });
    if (input.assignee) {
      const agent = this.agents.requireAgent(input.assignee);
      this._assertAgentType(agent, task);
      this.tasks.assign(tid, agent.id);
    }
    this._afterMutation(actor, 'task.created', { type: 'task', id: tid }, { title: task.title, type: task.type, dependencies: task.dependencies });
    return this.tasks.get(tid);
  }

  splitTask(actor, taskId, children) {
    this.check(actor, 'task.split');
    assertArray(children, 'children', { min: 1 });
    const { parent, children: created } = this.tasks.split(taskId, children);
    this._afterMutation(actor, 'task.split', { type: 'task', id: taskId }, {
      children: created.map((c) => ({ id: c.id, title: c.title })),
    });
    return { parent, children: created };
  }

  assignTask(actor, taskId, agentId) {
    this.check(actor, 'task.assign');
    const task = this.tasks.get(taskId);
    let agent = null;
    if (agentId !== null && agentId !== undefined) {
      agent = this.agents.requireAgent(agentId);
      this._assertAgentType(agent, task);
    }
    this.tasks.assign(taskId, agent ? agent.id : null);
    this._afterMutation(actor, 'task.assigned', { type: 'task', id: taskId }, { assignee: agent ? agent.id : null });
    return this.tasks.get(taskId);
  }

  _assertAgentType(agent, task) {
    if (task.type !== 'custom' && agent.type !== task.type) {
      throw invalidInput(`agent type mismatch: task "${task.id}" requires type "${task.type}" but agent "${agent.id}" is "${agent.type}"`);
    }
  }

  async runTask(actor, taskId) {
    this.check(actor, 'task.run');
    const task = this.tasks.get(taskId);
    let agent;
    if (task.assignee) {
      agent = this.agents.requireAgent(task.assignee);
    } else {
      agent = this.agents.byType(task.type)[0];
      if (!agent) throw new ForgeError(CODES.STATE, `no registered agent of type "${task.type}" to run task ${taskId}`);
      this.tasks.assign(taskId, agent.id);
      this.audit.append(actor, 'task.assigned', { type: 'task', id: taskId }, { assignee: agent.id, auto: true });
    }
    if (task.status === 'paused') {
      this.tasks.resume(taskId);
      task.attempts += 1;
      task.startedAt = Date.now();
    } else {
      this.tasks.run(taskId);
    }
    this.audit.append(actor, 'task.running', { type: 'task', id: taskId }, { agent: agent.id, attempt: task.attempts });
    return this._execute(agent, task);
  }

  async _execute(agent, task) {
    const runner = runners[agent.type];
    if (!runner) throw new ForgeError(CODES.STATE, `no runner registered for agent type "${agent.type}"`);
    this.agents.mark(agent.id, 'working');
    const startMsg = postMessage(this.messages, {
      agentId: agent.id, taskId: task.id, status: 'running',
      input: task.spec, output: null, artifacts: [], dependencies: [...task.dependencies],
    });
    try {
      const res = await runner(this, agent, task);
      const current = this.tasks.get(task.id);
      if (current.status === 'running' || current.status === 'paused') {
        this.tasks.complete(task.id, res ? res.output : null);
      }
      this.agents.mark(agent.id, 'idle');
      this.agents.get(agent.id).tasksDone += 1;
      const done = this.tasks.get(task.id);
      postMessage(this.messages, {
        agentId: agent.id, taskId: task.id, status: done.status,
        input: task.spec, output: done.result,
        artifacts: res ? res.artifacts : [],
        dependencies: [...task.dependencies],
      });
      this._afterMutation(actorFor(agent), 'task.completed', { type: 'task', id: task.id }, {
        agent: agent.id, attempt: done.attempts, summary: summarize(done.result),
      });
      return done;
    } catch (e) {
      const current = this.tasks.get(task.id);
      if (['running', 'paused'].includes(current.status)) {
        this.tasks.fail(task.id, e.message);
      }
      this.agents.mark(agent.id, 'idle');
      this.agents.get(agent.id).tasksFailed += 1;
      const failed = this.tasks.get(task.id);
      postMessage(this.messages, {
        agentId: agent.id, taskId: task.id, status: failed.status,
        input: task.spec, output: { error: e.message },
        artifacts: [], dependencies: [...task.dependencies],
      });
      this._afterMutation(actorFor(agent), 'task.failed', { type: 'task', id: task.id }, {
        agent: agent.id, attempt: failed.attempts, error: e.message,
      });
      return failed;
    }
  }

  pauseTask(actor, taskId) {
    this.check(actor, 'task.pause');
    this.tasks.pause(taskId);
    this._afterMutation(actor, 'task.paused', { type: 'task', id: taskId }, null);
    return this.tasks.get(taskId);
  }

  resumeTask(actor, taskId) {
    this.check(actor, 'task.resume');
    this.tasks.resume(taskId);
    this._afterMutation(actor, 'task.resumed', { type: 'task', id: taskId }, null);
    return this.tasks.get(taskId);
  }

  retryTask(actor, taskId) {
    this.check(actor, 'task.retry');
    this.tasks.retry(taskId);
    this._afterMutation(actor, 'task.retried', { type: 'task', id: taskId }, null);
    return this.tasks.get(taskId);
  }

  cancelTask(actor, taskId) {
    this.check(actor, 'task.cancel');
    this.tasks.cancel(taskId);
    this._afterMutation(actor, 'task.cancelled', { type: 'task', id: taskId }, null);
    return this.tasks.get(taskId);
  }

  // Manual completion is an admin/system override (agents complete via _execute).
  completeTask(actor, taskId, result) {
    this.check(actor, 'task.complete');
    this.tasks.complete(taskId, result === undefined ? { manual: true } : result);
    this._afterMutation(actor, 'task.completed', { type: 'task', id: taskId }, { manual: true });
    return this.tasks.get(taskId);
  }

  setTaskSpec(actor, taskId, spec) {
    this.check(actor, 'task.spec');
    assertObject(spec, 'spec');
    const t = this.tasks.get(taskId);
    t.spec = spec;
    t.updatedAt = Date.now();
    this._afterMutation(actor, 'task.spec_updated', { type: 'task', id: taskId }, spec);
    return t;
  }

  addTaskDependency(actor, taskId, depId) {
    this.check(actor, 'task.create');
    this.tasks.addDependency(taskId, depId);
    this._afterMutation(actor, 'task.dependency_added', { type: 'task', id: taskId }, { dependsOn: depId });
    return this.tasks.get(taskId);
  }

  // -- repository -------------------------------------------------------------------
  writeFile(actor, path, content) {
    this.check(actor, 'repo.write');
    assertRepoPath(path);
    const res = this.repo.writeFile(path, content);
    this._afterMutation(actor, 'repo.file_written', { type: 'file', id: path }, { size: res.size });
    return res;
  }

  deleteFile(actor, path) {
    this.check(actor, 'repo.delete');
    const res = this.repo.deleteFile(path);
    this._afterMutation(actor, 'repo.file_deleted', { type: 'file', id: path }, null);
    return res;
  }

  renameFile(actor, from, to) {
    this.check(actor, 'repo.rename');
    const res = this.repo.renameFile(from, to);
    this._afterMutation(actor, 'repo.file_renamed', { type: 'file', id: from }, { to });
    return res;
  }

  readFile(path) {
    return this.repo.readFile(path);
  }

  commit(actor, message, opts) {
    this.check(actor, 'repo.commit');
    const c = this.repo.commit(message, actor ? actor.id : 'unknown', opts);
    // sync open PR heads pointing at this branch
    for (const pr of this.prs.list()) {
      if (pr.sourceBranch === this.repo.head.branch && ['open', 'changes_requested', 'approved'].includes(pr.state)) {
        const old = pr.headSha;
        this.prs.syncHead(pr, c.hash);
        if (old !== c.hash) this.audit.append(actor, 'pr.head_updated', { type: 'pr', id: pr.id }, { from: old, to: c.hash });
      }
    }
    this._afterMutation(actor, 'repo.commit', { type: 'commit', id: c.hash }, { message: c.message, branch: this.repo.head.branch });
    return c;
  }

  createBranch(actor, name, fromRef) {
    this.check(actor, 'repo.branch');
    const res = this.repo.createBranch(name, fromRef);
    this._afterMutation(actor, 'repo.branch_created', { type: 'branch', id: name }, { commit: res.commit });
    return res;
  }

  deleteBranch(actor, name) {
    this.check(actor, 'repo.branch');
    const res = this.repo.deleteBranch(name);
    this._afterMutation(actor, 'repo.branch_deleted', { type: 'branch', id: name }, null);
    return res;
  }

  checkoutBranch(actor, ref, opts) {
    this.check(actor, 'repo.checkout');
    const res = this.repo.checkoutBranch(ref, opts);
    this._afterMutation(actor, 'repo.checkout', { type: 'branch', id: ref }, { mode: res.mode, commit: res.commit });
    return res;
  }

  mergeRepo(actor, sourceRef, opts) {
    this.check(actor, 'repo.merge');
    const result = this.repo.merge(sourceRef, opts);
    const action = result.status === 'conflict' ? 'repo.merge_conflict' : 'repo.merge_completed';
    this._afterMutation(actor, action, { type: 'branch', id: this.repo.head.branch }, {
      source: sourceRef, status: result.status, commit: result.commit || null, conflicts: result.conflicts || [],
    });
    return result;
  }

  resolveConflict(actor, path, choice, content) {
    this.check(actor, 'repo.merge');
    const res = this.repo.resolveConflict(path, choice, content);
    this._afterMutation(actor, 'repo.conflict_resolved', { type: 'file', id: path }, { choice, remaining: res.remaining });
    return res;
  }

  abortMerge(actor) {
    this.check(actor, 'repo.merge');
    const res = this.repo.abortMerge();
    this._afterMutation(actor, 'repo.merge_aborted', { type: 'branch', id: this.repo.head.branch }, { restored: res.restored });
    return res;
  }

  completeMerge(actor, message, opts) {
    this.check(actor, 'repo.merge');
    const res = this.repo.completeMerge(message, actor ? actor.id : 'unknown', opts);
    this._afterMutation(actor, 'repo.merge_completed', { type: 'branch', id: this.repo.head.branch }, { commit: res.commit });
    return res;
  }

  // -- pull requests -------------------------------------------------------------------
  openPr(actor, { title, sourceBranch, targetBranch, description }) {
    this.check(actor, 'pr.open');
    if (!this.repo.branches.has(sourceBranch)) throw notFound('Branch', sourceBranch);
    if (!this.repo.branches.has(targetBranch)) throw notFound('Branch', targetBranch);
    const pr = this.prs.open({
      id: id('pr'),
      title: assertString(title, 'title', { min: 1, max: 200 }),
      sourceBranch, targetBranch,
      description: typeof description === 'string' ? description.slice(0, 4000) : '',
      author: actor ? actor.id : 'unknown',
      headSha: this.repo.resolveRef(sourceBranch),
    });
    this._afterMutation(actor, 'pr.opened', { type: 'pr', id: pr.id }, { title: pr.title, sourceBranch, targetBranch });
    return pr;
  }

  reviewPr(actor, prId, { type, comment, findings }) {
    assertEnum(type, 'review type', PR_REVIEW_TYPES);
    this.check(actor, type === 'comment' ? 'pr.comment' : `pr.${type === 'approve' ? 'approve' : 'request_changes'}`);
    const pr = this.prs.get(prId);
    if (!['open', 'changes_requested', 'approved'].includes(pr.state)) {
      throw new ForgeError(CODES.STATE, `PR ${prId} is ${pr.state}; reviews are only possible while open`);
    }
    if (type !== 'comment' && actor && actor.id === pr.author) {
      throw new ForgeError(CODES.STATE, `PR author (${pr.author}) cannot ${type === 'approve' ? 'approve' : 'request changes on'} their own PR`);
    }
    const review = this.prs.addReview(pr, {
      reviewer: actor ? actor.id : 'unknown',
      reviewerRole: actor ? actor.role : 'unknown',
      type, comment, findings,
    });
    this._afterMutation(actor, 'pr.review', { type: 'pr', id: prId }, { type, reviewer: review.reviewer, headSha: review.headSha });
    return { pr, review };
  }

  mergePr(actor, prId) {
    this.check(actor, 'pr.merge');
    const pr = this.prs.get(prId);
    assertPrTransition(pr, 'merged');
    if (!['open', 'changes_requested', 'approved'].includes(pr.state)) {
      throw new ForgeError(CODES.STATE, `PR ${prId} cannot be merged from state "${pr.state}"`);
    }
    const gate = evaluateGate(this, pr);
    if (!gate.ok) {
      this.audit.append(actor, 'pr.merge_rejected', { type: 'pr', id: prId }, { missing: gate.missing });
      this._save();
      throw new ForgeError(CODES.MERGE_GATE, `Merge gate failed for ${prId}: ${gate.missing.join('; ')}`, { missing: gate.missing, runId: gate.runId });
    }
    // perform the repository merge into the target branch
    if (this.repo.head.branch !== pr.targetBranch) {
      if (this.repo.isDirty()) {
        const st = this.repo.status();
        throw new ForgeError(CODES.DIRTY_WORKTREE, `Working tree is dirty; commit before merging PR ${prId}`, { status: st });
      }
      this.repo.checkoutBranch(pr.targetBranch, {});
    }
    const srcCommit = this.repo.resolveRef(pr.sourceBranch);
    if (this.repo.isAncestor(srcCommit, this.repo.head.commit)) {
      // already contained (e.g. conflicts were resolved manually): mark merged
      this.prs.markMerged(pr, this.repo.head.commit);
      this._afterMutation(actor, 'pr.merged', { type: 'pr', id: prId }, { mergeCommit: pr.mergeCommit, preMerged: true });
      return pr;
    }
    let result;
    try {
      result = this.repo.merge(pr.sourceBranch, { author: actor ? actor.id : 'unknown' });
    } catch (e) {
      if (e instanceof ForgeError && e.code === CODES.CONFLICT) {
        this.audit.append(actor, 'pr.merge_rejected', { type: 'pr', id: prId }, { reason: 'conflict', conflicts: e.details && e.details.conflicts });
        this._save();
      }
      throw e;
    }
    if (result.status === 'conflict') {
      this.audit.append(actor, 'pr.merge_rejected', { type: 'pr', id: prId }, { reason: 'conflict', conflicts: result.conflicts });
      this._save();
      throw new ForgeError(CODES.CONFLICT, `Merge produced conflicts in: ${result.conflicts.join(', ')}. Resolve them, complete the merge commit, then retry.`, { conflicts: result.conflicts });
    }
    const mergeCommit = result.commit || this.repo.head.commit;
    this.prs.markMerged(pr, mergeCommit);
    this._afterMutation(actor, 'pr.merged', { type: 'pr', id: prId }, { mergeCommit, status: result.status });
    return pr;
  }

  closePr(actor, prId) {
    this.check(actor, 'pr.close');
    const pr = this.prs.get(prId);
    this.prs.close(pr);
    this._afterMutation(actor, 'pr.closed', { type: 'pr', id: prId }, null);
    return pr;
  }

  prDiff(prId) {
    const pr = this.prs.get(prId);
    return this.repo.diffRefs(pr.targetBranch, pr.sourceBranch);
  }

  // -- CI --------------------------------------------------------------------------------
  async runCi(actor, { ref, prId }) {
    this.check(actor, 'ci.run');
    let refName = ref;
    if (prId) {
      const pr = this.prs.get(prId);
      refName = pr.sourceBranch;
    }
    if (!refName) refName = this.repo.head.branch;
    const sha = this.repo.resolveRef(refName);
    const run = createRun({ ref: refName, sha, prId: prId || null, actor });
    this.ciRuns.push(run);
    this.audit.append(actor, 'ci.run_started', { type: 'ci', id: run.id }, { ref: refName, sha });
    await executeStages(this, run, this.repo.snapshot(sha), this.config);
    this._afterMutation(actor, 'ci.run_completed', { type: 'ci', id: run.id }, {
      status: run.status,
      stages: Object.fromEntries(run.stages.map((s) => [s.name, s.status])),
    });
    return run;
  }

  // -- import / export / reset --------------------------------------------------------------
  exportJson() {
    return JSON.stringify(this.serialize(), null, 1);
  }

  importJson(actor, json) {
    this.check(actor, 'workspace.write');
    let data;
    if (typeof json === 'string') {
      try {
        data = JSON.parse(json);
      } catch (e) {
        throw invalidInput(`import payload is not valid JSON: ${e.message}`);
      }
    } else {
      data = json;
    }
    validateImportedState(data);
    const fresh = Workspace.hydrate(data, { dataDir: this.persistence.dataDir, fileName: this.persistence.file.split(/[\\/]/).pop(), skipLoad: true });
    // adopt hydrated state in place
    this.config = fresh.config;
    this.agents = fresh.agents;
    this.tasks = fresh.tasks;
    this.repo = fresh.repo;
    this.prs = fresh.prs;
    this.issues = fresh.issues;
    this.messages = fresh.messages;
    this.audit = fresh.audit;
    this.ciRuns = fresh.ciRuns;
    this.demo = fresh.demo;
    this._afterMutation(actor, 'workspace.imported', { type: 'workspace', id: this.config.name }, { version: data.version });
    return true;
  }

  resetWorkspace(actor, { seed } = {}) {
    this.check(actor, 'workspace.reset');
    this.persistence.clear();
    this.config = {
      name: 'FORGE Workspace',
      autoScheduler: false,
      enforcePermissions: true,
      requiredChecks: ['lint', 'unit', 'integration', 'security', 'build'],
      securityThreshold: 'high',
      lintMaxLineLength: 140,
    };
    this.agents = new AgentRegistry();
    this.tasks = new TaskGraph();
    this.repo = new Repository('demo-app');
    this.prs = new PullRequests();
    this.issues = [];
    this.messages = [];
    this.audit = new AuditLog();
    this.ciRuns = [];
    this.demo = { scenario: 'none', stepIndex: 0, steps: [], lastStep: null, running: false };
    if (seed) {
      const demo = require('../demo/demo'); // lazy to avoid cycles
      demo.seed(this, actor);
    }
    this.audit.append(actor, 'workspace.reset', { type: 'workspace', id: this.config.name }, { seeded: Boolean(seed) });
    this._save();
    return this.viewState();
  }

  // -- demo ------------------------------------------------------------------------------------
  seedDemo(actor) {
    this.check(actor, 'workspace.reset');
    const demo = require('../demo/demo');
    demo.seed(this, actor);
    this._save();
    return this.demo;
  }

  async demoNext(actor) {
    this.check(actor, 'workspace.reset');
    const demo = require('../demo/demo');
    return demo.next(this, actor);
  }

  async demoRunAll(actor) {
    this.check(actor, 'workspace.reset');
    const demo = require('../demo/demo');
    let last;
    for (;;) {
      last = await demo.next(this, actor);
      if (!last || last.done || last.failed) break;
    }
    return last;
  }

  demoReset(actor) {
    this.check(actor, 'workspace.reset');
    this.demo = { scenario: 'none', stepIndex: 0, steps: [], lastStep: null, running: false };
    this._afterMutation(actor, 'demo.reset', { type: 'workspace', id: this.config.name }, null);
    return this.demo;
  }

  // -- serialization ------------------------------------------------------------------------------
  serialize() {
    return {
      format: WORKSPACE_FORMAT,
      version: WORKSPACE_VERSION,
      savedAt: Date.now(),
      config: this.config,
      agents: this.agents.list(),
      tasks: this.tasks.serialize(),
      repo: this.repo.serialize(),
      prs: this.prs.serialize(),
      issues: this.issues,
      messages: this.messages,
      audit: this.audit.serialize(),
      ciRuns: this.ciRuns,
      demo: this.demo,
    };
  }

  static hydrate(data, options) {
    if (!data || data.format !== WORKSPACE_FORMAT) {
      throw invalidInput('state is not a forge workspace');
    }
    const ws = new Workspace({ ...options, skipLoad: true });
    ws.config = { ...ws.config, ...(data.config || {}) };
    ws.agents = new AgentRegistry();
    ws.agents.agents = Array.isArray(data.agents) && data.agents.length ? data.agents : ws.agents.agents;
    ws.tasks = TaskGraph.deserialize(data.tasks);
    ws.repo = Repository.deserialize(data.repo);
    ws.prs = PullRequests.deserialize(data.prs);
    ws.issues = Array.isArray(data.issues) ? data.issues : [];
    ws.messages = Array.isArray(data.messages) ? data.messages : [];
    ws.audit = AuditLog.deserialize(data.audit);
    ws.ciRuns = Array.isArray(data.ciRuns) ? data.ciRuns : [];
    ws.demo = data.demo || { scenario: 'none', stepIndex: 0, steps: [], lastStep: null, running: false };
    return ws;
  }

  tryLoad() {
    const data = this.persistence.load();
    if (!data) return false;
    const fresh = Workspace.hydrate(data, { dataDir: this.persistence.dataDir, fileName: this.persistence.file.split(/[\\/]/).pop(), skipLoad: true });
    this.config = fresh.config;
    this.agents = fresh.agents;
    this.tasks = fresh.tasks;
    this.repo = fresh.repo;
    this.prs = fresh.prs;
    this.issues = fresh.issues;
    this.messages = fresh.messages;
    this.audit = fresh.audit;
    this.ciRuns = fresh.ciRuns;
    this.demo = fresh.demo;
    this._loaded = true;
    return true;
  }

  isLoadedFromDisk() {
    return this._loaded;
  }

  viewState() {
    return {
      format: WORKSPACE_FORMAT,
      version: WORKSPACE_VERSION,
      name: this.config.name,
      config: this.config,
      agents: this.agents.list(),
      issues: this.issues,
      tasks: this.tasks.serialize(),
      repo: {
        name: this.repo.name,
        head: this.repo.head,
        status: this.repo.status(),
        branches: this.repo.listBranches(),
        files: this.repo.listFiles(),
        log: this.repo.log(30),
        commits: this.repo.commits.size,
        mergeState: this.repo.mergeState,
      },
      prs: this.prs.serialize(),
      ciRuns: this.ciRuns.slice(-40),
      messages: this.messages.slice(-300),
      audit: this.audit.tail(300),
      demo: this.demo,
    };
  }
}

function actorFor(agent) {
  return { type: 'agent', id: agent.id, role: agent.role };
}

function summarize(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'object') {
    if (result.planned !== undefined) return `planned ${result.planned} task(s)`;
    if (result.commit) return `${result.branch}: ${result.commit.slice(0, 10)}`;
    if (result.decision) return `${result.decision} (majors ${result.majors}, minors ${result.minors})`;
    if (result.passed !== undefined) return `qa ${result.passed} passed / ${result.failed} failed`;
    if (result.counts) return `scan ${JSON.stringify(result.counts)}`;
    return Object.keys(result).slice(0, 4).join(', ');
  }
  return String(result).slice(0, 120);
}

module.exports = { Workspace, WORKSPACE_FORMAT, WORKSPACE_VERSION };
