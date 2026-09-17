'use strict';

const { invalidTransition } = require('./errors');

// Task lifecycle states.
const TASK_STATES = ['blocked', 'ready', 'running', 'paused', 'completed', 'failed', 'cancelled'];

// Legal task transitions. blocked|ready -> completed is allowed ONLY for container
// tasks (created via split) auto-completed by the scheduler; the guard receives the task.
const TASK_TRANSITIONS = {
  blocked: ['ready', 'cancelled', 'completed'],
  ready: ['running', 'blocked', 'cancelled', 'completed'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  failed: ['ready', 'cancelled'],
  completed: [],
  cancelled: [],
};

function canTransitionTask(from, to, task) {
  const allowed = TASK_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) return false;
  if ((from === 'blocked' || from === 'ready') && to === 'completed') {
    return Boolean(task && task.container === true);
  }
  if (from === 'ready' && to === 'blocked') {
    return Boolean(task && task.viaDependency === true);
  }
  return true;
}

function assertTaskTransition(task, to, reason) {
  const from = task.status;
  if (!canTransitionTask(from, to, task)) {
    let why = reason;
    if (!why && (from === 'blocked' || from === 'ready') && to === 'completed') {
      why = 'only container tasks may jump to completed via the scheduler';
    }
    if (!why && from === 'ready' && to === 'blocked') {
      why = 'only adding a dependency may demote a ready task';
    }
    throw invalidTransition(from, to, why);
  }
}

// Pull-request lifecycle states.
const PR_STATES = ['open', 'changes_requested', 'approved', 'merged', 'closed'];
const PR_TRANSITIONS = {
  open: ['changes_requested', 'approved', 'merged', 'closed'],
  changes_requested: ['changes_requested', 'approved', 'merged', 'closed'],
  approved: ['changes_requested', 'approved', 'merged', 'closed'],
  merged: [],
  closed: [],
};

function assertPrTransition(pr, to) {
  const from = pr.state;
  if (!PR_TRANSITIONS[from] || !PR_TRANSITIONS[from].includes(to)) {
    throw invalidTransition(from, to, `PR ${pr.id} is ${from}`);
  }
}

// CI run / stage states.
const CI_RUN_STATES = ['running', 'success', 'failure'];
const CI_STAGE_STATES = ['pending', 'running', 'success', 'failure', 'skipped'];

function assertCiRunTransition(run, to) {
  const legal = { running: ['success', 'failure'], success: [], failure: [] };
  if (!legal[run.status] || !legal[run.status].includes(to)) {
    throw invalidTransition(run.status, to, `CI run ${run.id} is ${run.status}`);
  }
}

function assertCiStageTransition(stage, to) {
  const legal = {
    pending: ['running', 'skipped'],
    running: ['success', 'failure'],
    success: [], failure: [], skipped: [],
  };
  if (!legal[stage.status] || !legal[stage.status].includes(to)) {
    throw invalidTransition(stage.status, to, `CI stage ${stage.name} is ${stage.status}`);
  }
}

// Issue states.
const ISSUE_STATES = ['open', 'in_progress', 'resolved', 'closed'];
const ISSUE_TRANSITIONS = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['resolved', 'closed', 'open'],
  resolved: ['closed', 'open'],
  closed: [],
};

function assertIssueTransition(issue, to) {
  const from = issue.state;
  if (!ISSUE_TRANSITIONS[from] || !ISSUE_TRANSITIONS[from].includes(to)) {
    throw invalidTransition(from, to, `Issue ${issue.id} is ${from}`);
  }
}

module.exports = {
  TASK_STATES, TASK_TRANSITIONS, canTransitionTask, assertTaskTransition,
  PR_STATES, PR_TRANSITIONS, assertPrTransition,
  CI_RUN_STATES, CI_STAGE_STATES, assertCiRunTransition, assertCiStageTransition,
  ISSUE_STATES, ISSUE_TRANSITIONS, assertIssueTransition,
};
