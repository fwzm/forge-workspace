'use strict';

const { permissionDenied } = require('../core/errors');

const ROLES = ['admin', 'planner', 'implementer', 'reviewer', 'qa', 'security', 'viewer', 'system'];

const ACTIONS = [
  'task.create', 'task.split', 'task.assign', 'task.run', 'task.pause', 'task.resume',
  'task.retry', 'task.cancel', 'task.complete', 'task.fail', 'task.spec',
  'repo.write', 'repo.delete', 'repo.rename', 'repo.commit', 'repo.branch', 'repo.checkout', 'repo.merge',
  'pr.open', 'pr.comment', 'pr.request_changes', 'pr.approve', 'pr.merge', 'pr.close',
  'ci.run', 'qa.run', 'security.run',
  'issue.create', 'issue.update',
  'workspace.write', 'workspace.reset',
];

// '*' grants everything. 'system' is the internal scheduler actor.
const MATRIX = {
  system: '*',
  admin: '*',
  planner: ['task.create', 'task.split', 'task.assign', 'task.pause', 'task.resume', 'task.retry', 'task.cancel', 'task.spec', 'issue.create', 'issue.update'],
  implementer: ['repo.write', 'repo.delete', 'repo.rename', 'repo.commit', 'repo.branch', 'repo.checkout', 'pr.open', 'task.run', 'task.retry', 'task.assign'],
  reviewer: ['pr.comment', 'pr.request_changes', 'pr.approve', 'pr.close', 'task.run', 'task.retry', 'task.assign'],
  qa: ['qa.run', 'task.run', 'task.retry', 'task.assign'],
  security: ['security.run', 'task.run', 'task.retry', 'task.assign'],
  viewer: [],
};

function can(role, action) {
  if (role === 'system' || role === 'admin') return true;
  const granted = MATRIX[role];
  if (!granted) return false;
  return granted.includes(action);
}

function assertCan(actor, action) {
  const role = actor && actor.role;
  if (!can(role, action)) {
    throw permissionDenied(action, { role: role || String(role) });
  }
}

// Role used when an agent acts: derived from its type.
function agentActor(agent, action) {
  return { type: 'agent', id: agent.id, role: agent.role, agentType: agent.type };
}

module.exports = { ROLES, ACTIONS, MATRIX, can, assertCan, agentActor };
