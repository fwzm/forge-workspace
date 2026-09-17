'use strict';

// Core workspace routes: state, metrics, config, tasks, agents, issues.
const { sendJson } = require('./jsonio');

function registerCoreRoutes(route, ws, computeMetrics) {
  route('GET', '/api/state', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.viewState() }));
  route('GET', '/api/metrics', (ctx) => sendJson(ctx.res, 200, { ok: true, data: computeMetrics() }));
  route('GET', '/api/permissions', (ctx) => {
    const { ROLES, ACTIONS, MATRIX, can } = require('./domain/permissions');
    const matrix = {};
    for (const role of ROLES) {
      matrix[role] = {};
      for (const action of ACTIONS) matrix[role][action] = can(role, action);
    }
    sendJson(ctx.res, 200, { ok: true, data: { roles: ROLES, actions: ACTIONS, matrix, enforce: ws.config.enforcePermissions } });
  });

  route('GET', '/api/config', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.config }));
  route('PUT', '/api/config', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.updateConfig(ctx.actor, ctx.body) }));

  route('GET', '/api/tasks', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.tasks.list() }));
  route('POST', '/api/tasks', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.createTask(ctx.actor, ctx.body) }));
  route('POST', '/api/tasks/:id/assign', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.assignTask(ctx.actor, ctx.params.id, ctx.body.agentId) }));
  route('POST', '/api/tasks/:id/run', async (ctx) => sendJson(ctx.res, 200, { ok: true, data: await ws.runTask(ctx.actor, ctx.params.id) }));
  route('POST', '/api/tasks/:id/pause', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.pauseTask(ctx.actor, ctx.params.id) }));
  route('POST', '/api/tasks/:id/resume', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.resumeTask(ctx.actor, ctx.params.id) }));
  route('POST', '/api/tasks/:id/retry', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.retryTask(ctx.actor, ctx.params.id) }));
  route('POST', '/api/tasks/:id/cancel', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.cancelTask(ctx.actor, ctx.params.id) }));
  route('POST', '/api/tasks/:id/complete', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.completeTask(ctx.actor, ctx.params.id, ctx.body.result) }));
  route('POST', '/api/tasks/:id/split', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.splitTask(ctx.actor, ctx.params.id, ctx.body.children) }));
  route('POST', '/api/tasks/:id/spec', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.setTaskSpec(ctx.actor, ctx.params.id, ctx.body.spec) }));
  route('POST', '/api/tasks/:id/dependency', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.addTaskDependency(ctx.actor, ctx.params.id, ctx.body.depId) }));

  route('GET', '/api/agents', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.agents.list() }));
  route('POST', '/api/agents', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.registerAgent(ctx.actor, ctx.body) }));

  route('GET', '/api/issues', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.issues }));
  route('POST', '/api/issues', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.createIssue(ctx.actor, ctx.body) }));
  route('POST', '/api/issues/:id/state', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.updateIssueState(ctx.actor, ctx.params.id, ctx.body.state) }));
}

module.exports = { registerCoreRoutes };
