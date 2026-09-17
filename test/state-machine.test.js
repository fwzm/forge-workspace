'use strict';

const { test, assert, equal, throws } = require('./lib');
const {
  canTransitionTask, assertTaskTransition,
  assertPrTransition, assertCiRunTransition, assertCiStageTransition, assertIssueTransition,
} = require('../server/core/statemachine');

const T = (status, extra) => ({ status, container: false, viaDependency: false, ...(extra || {}) });

test('state machine: blocked -> ready is legal', () => {
  assert(canTransitionTask('blocked', 'ready', T('blocked')));
});

test('state machine: ready -> running is legal', () => {
  assert(canTransitionTask('ready', 'running', T('ready')));
});

test('state machine: running -> completed is legal', () => {
  assert(canTransitionTask('running', 'completed', T('running')));
});

test('state machine: running -> failed is legal', () => {
  assert(canTransitionTask('running', 'failed', T('running')));
});

test('state machine: running -> paused and paused -> running are legal', () => {
  assert(canTransitionTask('running', 'paused', T('running')));
  assert(canTransitionTask('paused', 'running', T('paused')));
});

test('state machine: failed -> ready (retry) is legal', () => {
  assert(canTransitionTask('failed', 'ready', T('failed')));
});

test('state machine: cancel allowed from blocked/ready/running/paused', () => {
  for (const s of ['blocked', 'ready', 'running', 'paused']) {
    assert(canTransitionTask(s, 'cancelled', T(s)), `cancel from ${s}`);
  }
});

test('state machine: completed and cancelled are terminal', () => {
  for (const to of ['ready', 'running', 'failed', 'cancelled', 'blocked', 'paused']) {
    assert(!canTransitionTask('completed', to, T('completed')), `completed -> ${to}`);
    assert(!canTransitionTask('cancelled', to, T('cancelled')), `cancelled -> ${to}`);
  }
});

test('state machine: blocked -> completed rejected for normal tasks', () => {
  assert(!canTransitionTask('blocked', 'completed', T('blocked')));
  throws(() => assertTaskTransition(T('blocked'), 'completed'), /Illegal state transition/);
});

test('state machine: blocked/ready -> completed allowed only for container tasks', () => {
  assert(canTransitionTask('blocked', 'completed', T('blocked', { container: true })));
  assert(canTransitionTask('ready', 'completed', T('ready', { container: true })));
});

test('state machine: ready -> blocked only via dependency demotion', () => {
  assert(!canTransitionTask('ready', 'blocked', T('ready')));
  assert(canTransitionTask('ready', 'blocked', T('ready', { viaDependency: true })));
});

test('state machine: every illegal task transition throws with explicit message', () => {
  const illegal = [
    ['blocked', 'running'], ['blocked', 'paused'], ['blocked', 'failed'],
    ['ready', 'paused'], ['ready', 'failed'], ['ready', 'completed'],
    ['running', 'ready'], ['running', 'blocked'],
    ['paused', 'completed'], ['paused', 'failed'], ['paused', 'ready'],
    ['failed', 'running'], ['failed', 'completed'], ['failed', 'paused'],
  ];
  for (const [from, to] of illegal) {
    const err = throws(() => assertTaskTransition(T(from), to), 'FORGE_INVALID_TRANSITION');
    if (!err.message.includes(`${from} -> ${to}`)) {
      throw new Error(`error message should name the transition ${from} -> ${to}: ${err.message}`);
    }
  }
});

test('state machine: unknown from-state is rejected', () => {
  throws(() => assertTaskTransition(T('invented'), 'ready'), 'FORGE_INVALID_TRANSITION');
});

test('state machine: PR open -> approved legal, merged/closed terminal', () => {
  assertPrTransition({ state: 'open' }, 'approved');
  assertPrTransition({ state: 'approved' }, 'merged');
  assertPrTransition({ state: 'changes_requested' }, 'closed');
  for (const to of ['open', 'approved', 'merged', 'closed']) {
    throws(() => assertPrTransition({ state: 'merged' }, to), 'FORGE_INVALID_TRANSITION', `merged -> ${to}`);
    throws(() => assertPrTransition({ state: 'closed' }, to), 'FORGE_INVALID_TRANSITION', `closed -> ${to}`);
  }
});

test('state machine: PR open -> merged legal only through gate (state-level check)', () => {
  assertPrTransition({ state: 'open' }, 'merged');
  assertPrTransition({ state: 'changes_requested' }, 'merged');
});

test('state machine: CI run states', () => {
  assertCiRunTransition({ status: 'running' }, 'success');
  assertCiRunTransition({ status: 'running' }, 'failure');
  throws(() => assertCiRunTransition({ status: 'success' }, 'failure'), 'FORGE_INVALID_TRANSITION');
  throws(() => assertCiRunTransition({ status: 'failure' }, 'success'), 'FORGE_INVALID_TRANSITION');
  throws(() => assertCiRunTransition({ status: 'success' }, 'running'), 'FORGE_INVALID_TRANSITION');
});

test('state machine: CI stage states', () => {
  assertCiStageTransition({ status: 'pending' }, 'running');
  assertCiStageTransition({ status: 'running' }, 'success');
  assertCiStageTransition({ status: 'running' }, 'failure');
  assertCiStageTransition({ status: 'pending' }, 'skipped');
  throws(() => assertCiStageTransition({ status: 'success' }, 'running'), 'FORGE_INVALID_TRANSITION');
  throws(() => assertCiStageTransition({ status: 'pending' }, 'success'), 'FORGE_INVALID_TRANSITION');
});

test('state machine: issue states', () => {
  assertIssueTransition({ state: 'open' }, 'in_progress');
  assertIssueTransition({ state: 'in_progress' }, 'resolved');
  assertIssueTransition({ state: 'resolved' }, 'closed');
  assertIssueTransition({ state: 'resolved' }, 'open');
  throws(() => assertIssueTransition({ state: 'closed' }, 'open'), 'FORGE_INVALID_TRANSITION');
  throws(() => assertIssueTransition({ state: 'open' }, 'nope'), 'FORGE_INVALID_TRANSITION');
});
