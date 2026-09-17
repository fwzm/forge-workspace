'use strict';

// Collaboration routes: pull requests, CI, audit, messages, terminal,
// import/export, demo scenario control.
const { sendJson, sendAttachment } = require('./jsonio');

function registerCollabRoutes(route, ws, runTerminal) {
  route('GET', '/api/prs', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.prs.serialize() }));
  route('POST', '/api/pr', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.openPr(ctx.actor, ctx.body) }));
  route('GET', '/api/pr/:id', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.prs.get(ctx.params.id) }));
  route('GET', '/api/pr/:id/diff', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.prDiff(ctx.params.id) }));
  route('POST', '/api/pr/:id/review', (ctx) => {
    const { pr, review } = ws.reviewPr(ctx.actor, ctx.params.id, ctx.body);
    sendJson(ctx.res, 200, { ok: true, data: { prId: pr.id, state: pr.state, review } });
  });
  route('POST', '/api/pr/:id/merge', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.mergePr(ctx.actor, ctx.params.id) }));
  route('POST', '/api/pr/:id/close', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.closePr(ctx.actor, ctx.params.id) }));

  route('GET', '/api/ci', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.ciRuns }));
  route('POST', '/api/ci', async (ctx) => sendJson(ctx.res, 200, { ok: true, data: await ws.runCi(ctx.actor, ctx.body || {}) }));

  route('GET', '/api/audit', (ctx) => {
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') || 200), 2000);
    const entries = ws.audit.filter({
      action: ctx.url.searchParams.get('action') || undefined,
      actorId: ctx.url.searchParams.get('actor') || undefined,
    });
    sendJson(ctx.res, 200, { ok: true, data: entries.slice(-limit) });
  });
  route('GET', '/api/messages', (ctx) => {
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') || 100), 1000);
    sendJson(ctx.res, 200, { ok: true, data: ws.messages.slice(-limit) });
  });

  route('POST', '/api/terminal', async (ctx) => {
    const result = await runTerminal(ws, ctx.body.command, ctx.actor);
    sendJson(ctx.res, 200, { ok: true, data: { lines: result.lines } });
  });

  route('GET', '/api/export', (ctx) => sendAttachment(ctx.res, 'forge-workspace-export.json', ws.serialize()));
  route('POST', '/api/import', (ctx) => {
    ws.importJson(ctx.actor, ctx.body.json !== undefined ? ctx.body.json : ctx.body);
    sendJson(ctx.res, 200, { ok: true, data: ws.viewState() });
  });
  route('POST', '/api/reset', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.resetWorkspace(ctx.actor, { seed: Boolean(ctx.body.seed) }) }));

  route('POST', '/api/demo/seed', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.seedDemo(ctx.actor) }));
  route('POST', '/api/demo/next', async (ctx) => sendJson(ctx.res, 200, { ok: true, data: await ws.demoNext(ctx.actor) }));
  route('POST', '/api/demo/run-all', async (ctx) => sendJson(ctx.res, 200, { ok: true, data: await ws.demoRunAll(ctx.actor) }));
  route('POST', '/api/demo/reset', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.demoReset(ctx.actor) }));
}

module.exports = { registerCollabRoutes };
