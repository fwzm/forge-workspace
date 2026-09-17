'use strict';

const { assertTaskTransition, TASK_STATES } = require('../core/statemachine');
const { notFound, invalidInput, ForgeError, CODES } = require('../core/errors');
const { assertString, assertEnum, assertArray, assertObject } = require('../core/validation');
const { id } = require('../core/ids');

const TASK_TYPES = ['plan', 'implement', 'qa', 'review', 'security', 'custom'];
const TERMINAL = new Set(['completed', 'cancelled']);

// ---------------------------------------------------------------------------
// Task DAG with an enforced state machine and a dependency-driven scheduler.
// States: blocked -> ready -> running -> completed | failed | paused/cancelled.
// failed --retry--> ready. Container tasks (split parents) are auto-completed by
// the scheduler once every child is completed. Downstream tasks stay blocked
// until every dependency is completed.
// ---------------------------------------------------------------------------
class TaskGraph {
  constructor() {
    this.tasks = new Map();
  }

  get(id) {
    const t = this.tasks.get(id);
    if (!t) throw notFound('Task', id);
    return t;
  }

  list() {
    return [...this.tasks.values()];
  }

  has(id) {
    return this.tasks.has(id);
  }

  validateDeps(deps, selfId) {
    const seen = new Set();
    for (const dep of deps || []) {
      if (typeof dep !== 'string') throw invalidInput('dependencies must be task id strings', { dep });
      if (dep === selfId) throw new ForgeError(CODES.CYCLE, `Task cannot depend on itself: ${dep}`);
      if (!this.tasks.has(dep)) throw notFound('Task (dependency)', dep);
      if (seen.has(dep)) throw invalidInput(`duplicate dependency: ${dep}`, { dep });
      seen.add(dep);
    }
    return [...seen];
  }

  wouldCycle(taskId, depId) {
    // Would adding depId to taskId's dependencies create a cycle? (i.e., taskId reachable from depId)
    const seen = new Set();
    const stack = [depId];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === taskId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const t = this.tasks.get(cur);
      if (t) for (const d of t.dependencies) stack.push(d);
    }
    return false;
  }

  create(input) {
    assertObject(input, 'task input');
    const title = assertString(input.title, 'title', { min: 1, max: 200 });
    const type = assertEnum(input.type || 'custom', 'type', TASK_TYPES);
    const dependencies = this.validateDeps(input.dependencies, null);
    const task = {
      id: input.id || id('task'),
      title,
      description: typeof input.description === 'string' ? input.description : '',
      type,
      status: dependencies.length ? 'blocked' : 'ready',
      assignee: null,
      dependencies,
      dependents: [],
      parentId: input.parentId || null,
      issueId: input.issueId || null,
      spec: input.spec && typeof input.spec === 'object' ? input.spec : null,
      priority: Number.isInteger(input.priority) ? input.priority : 3,
      container: false,
      createdAt: input.createdAt !== undefined ? input.createdAt : Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      attempts: 0,
      result: null,
      lastError: null,
      viaDependency: false,
    };
    this.tasks.set(task.id, task);
    for (const dep of dependencies) this.get(dep).dependents.push(task.id);
    return task;
  }

  split(parentId, children) {
    const parent = this.get(parentId);
    if (!['blocked', 'ready'].includes(parent.status)) {
      throw new ForgeError(CODES.STATE, `Cannot split a task in state "${parent.status}" (only blocked or ready)`, { taskId: parentId, state: parent.status });
    }
    assertArray(children, 'children', { min: 1, max: 20 });
    const created = [];
    const keyToId = new Map();
    for (const child of children) {
      assertObject(child, 'child task');
      const resolvedDeps = (child.dependencies || []).map((d) => {
        if (this.tasks.has(d)) return d;
        if (keyToId.has(d)) return keyToId.get(d);
        throw notFound('Task (split dependency)', d);
      });
      const t = this.create({
        title: child.title,
        description: child.description,
        type: child.type || parent.type,
        dependencies: resolvedDeps,
        parentId,
        spec: child.spec,
        priority: child.priority,
      });
      if (child.key) keyToId.set(child.key, t.id);
      created.push(t);
    }
    // parent becomes a container depending on all children
    parent.container = true;
    for (const t of created) {
      if (!parent.dependencies.includes(t.id)) {
        parent.dependencies.push(t.id);
        t.dependents.push(parent.id);
      }
    }
    if (parent.status === 'ready') {
      parent.viaDependency = true;
      assertTaskTransition(parent, 'blocked', 'split added child dependencies');
      parent.status = 'blocked';
    }
    parent.updatedAt = Date.now();
    return { parent, children: created };
  }

  assign(taskId, agentId) {
    const t = this.get(taskId);
    if (!['blocked', 'ready'].includes(t.status)) {
      throw new ForgeError(CODES.STATE, `Cannot assign a task in state "${t.status}" (only blocked or ready)`, { taskId, state: t.status });
    }
    if (agentId !== null && typeof agentId !== 'string') throw invalidInput('assignee must be an agent id or null');
    t.assignee = agentId;
    t.updatedAt = Date.now();
    return t;
  }

  run(taskId) {
    const t = this.get(taskId);
    assertTaskTransition(t, 'running', 'run requires state ready');
    if (!t.assignee) throw new ForgeError(CODES.STATE, `Task ${taskId} has no assignee; assign an agent first`, { taskId });
    t.status = 'running';
    t.attempts += 1;
    t.startedAt = Date.now();
    t.updatedAt = t.startedAt;
    return t;
  }

  complete(taskId, result) {
    const t = this.get(taskId);
    assertTaskTransition(t, 'completed');
    t.status = 'completed';
    t.completedAt = Date.now();
    t.updatedAt = t.completedAt;
    t.result = result === undefined ? null : result;
    return t;
  }

  fail(taskId, error) {
    const t = this.get(taskId);
    assertTaskTransition(t, 'failed');
    t.status = 'failed';
    t.completedAt = Date.now();
    t.updatedAt = t.completedAt;
    t.lastError = error === undefined ? null : String(error);
    return t;
  }

  pause(taskId) {
    const t = this.get(taskId);
    assertTaskTransition(t, 'paused');
    t.status = 'paused';
    t.updatedAt = Date.now();
    return t;
  }

  resume(taskId) {
    const t = this.get(taskId);
    assertTaskTransition(t, 'running', 'resume requires state paused');
    t.status = 'running';
    t.updatedAt = Date.now();
    return t;
  }

  retry(taskId) {
    const t = this.get(taskId);
    assertTaskTransition(t, 'ready', 'retry requires state failed');
    t.status = 'ready';
    t.completedAt = null;
    t.startedAt = null;
    t.updatedAt = Date.now();
    return t;
  }

  cancel(taskId) {
    const t = this.get(taskId);
    assertTaskTransition(t, 'cancelled');
    t.status = 'cancelled';
    t.completedAt = Date.now();
    t.updatedAt = t.completedAt;
    return t;
  }

  addDependency(taskId, depId) {
    const t = this.get(taskId);
    this.get(depId);
    if (t.dependencies.includes(depId)) throw invalidInput(`dependency already exists: ${depId}`);
    if (this.wouldCycle(taskId, depId)) throw new ForgeError(CODES.CYCLE, `Adding ${depId} as a dependency of ${taskId} would create a cycle`);
    if (!['blocked', 'ready'].includes(t.status)) {
      throw new ForgeError(CODES.STATE, `Cannot add dependencies to a task in state "${t.status}"`, { taskId, state: t.status });
    }
    t.dependencies.push(depId);
    this.get(depId).dependents.push(taskId);
    if (t.status === 'ready') {
      t.viaDependency = true;
      assertTaskTransition(t, 'blocked', 'new unmet dependency added');
      t.status = 'blocked';
    }
    t.updatedAt = Date.now();
    return t;
  }

  childrenOf(taskId) {
    return this.list().filter((t) => t.parentId === taskId);
  }

  // Event-driven scheduler pass. Returns performed automatic transitions:
  // [{ id, from, to, reason }]
  schedulerTick() {
    const performed = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of this.list()) {
        if (t.status === 'blocked') {
          const deps = t.dependencies.map((d) => this.tasks.get(d));
          const allDone = deps.every((d) => d.status === 'completed');
          if (allDone) {
            t.viaDependency = false;
            assertTaskTransition(t, 'ready', 'all dependencies completed');
            t.status = 'ready';
            t.updatedAt = Date.now();
            performed.push({ id: t.id, from: 'blocked', to: 'ready', reason: 'dependencies-satisfied' });
            changed = true;
          }
        }
      }
      // Container auto-completion (children all completed).
      for (const t of this.list()) {
        if (!t.container || TERMINAL.has(t.status)) continue;
        const kids = this.childrenOf(t.id);
        if (kids.length && kids.every((k) => k.status === 'completed') && ['blocked', 'ready'].includes(t.status)) {
          t.viaDependency = false;
          assertTaskTransition(t, 'completed', 'container: all children completed');
          t.status = 'completed';
          t.completedAt = Date.now();
          t.updatedAt = t.completedAt;
          performed.push({ id: t.id, from: 'blocked', to: 'completed', reason: 'container-children-completed' });
          changed = true;
        }
      }
    }
    return performed;
  }

  readyTasks() {
    return this.list().filter((t) => t.status === 'ready');
  }

  // Topological order (Kahn) — used by the graph view and cycle sanity checks.
  topoOrder() {
    const indeg = new Map();
    for (const t of this.list()) indeg.set(t.id, t.dependencies.filter((d) => this.tasks.has(d)).length);
    const queue = this.list().filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const dep of this.get(id).dependents) {
        indeg.set(dep, indeg.get(dep) - 1);
        if (indeg.get(dep) === 0) queue.push(dep);
      }
    }
    if (order.length !== this.tasks.size) {
      throw new ForgeError(CODES.CYCLE, 'Task graph contains a cycle (topological sort failed)');
    }
    return order;
  }

  serialize() {
    return this.list();
  }

  static deserialize(arr) {
    const g = new TaskGraph();
    for (const t of arr || []) {
      const copy = { ...t };
      copy.dependencies = [...(t.dependencies || [])];
      copy.dependents = [...(t.dependents || [])];
      g.tasks.set(copy.id, copy);
    }
    return g;
  }
}

module.exports = { TaskGraph, TASK_TYPES, TASK_STATES };
