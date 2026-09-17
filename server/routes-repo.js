'use strict';

// Repository routes: files, diffs, commits, branches, checkout, merge.
const { sendJson } = require('./jsonio');

function registerRepoRoutes(route, ws) {
  route('GET', '/api/repo/status', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.repo.status() }));
  route('GET', '/api/repo/files', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.repo.listFiles() }));
  route('GET', '/api/repo/file', (ctx) => {
    const p = ctx.url.searchParams.get('path');
    sendJson(ctx.res, 200, { ok: true, data: { path: p, content: ws.readFile(p) } });
  });
  route('PUT', '/api/repo/file', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.writeFile(ctx.actor, ctx.body.path, ctx.body.content) }));
  route('DELETE', '/api/repo/file', (ctx) => {
    const p = ctx.url.searchParams.get('path');
    sendJson(ctx.res, 200, { ok: true, data: ws.deleteFile(ctx.actor, p) });
  });
  route('POST', '/api/repo/rename', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.renameFile(ctx.actor, ctx.body.from, ctx.body.to) }));
  route('GET', '/api/repo/diff', (ctx) => {
    const p = ctx.url.searchParams.get('path');
    sendJson(ctx.res, 200, { ok: true, data: { path: p, patch: ws.repo.diffWorkingTree(p) } });
  });
  route('GET', '/api/repo/diff-refs', (ctx) => {
    const from = ctx.url.searchParams.get('from');
    const to = ctx.url.searchParams.get('to');
    sendJson(ctx.res, 200, { ok: true, data: ws.repo.diffRefs(from === null ? undefined : from, to === null ? undefined : to) });
  });
  route('GET', '/api/repo/log', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.repo.log(Number(ctx.url.searchParams.get('limit') || 30)) }));
  route('GET', '/api/repo/branches', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.repo.listBranches() }));
  route('POST', '/api/repo/commit', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.commit(ctx.actor, ctx.body.message, { timestamp: ctx.body.timestamp }) }));
  route('POST', '/api/repo/branch', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.createBranch(ctx.actor, ctx.body.name, ctx.body.from) }));
  route('DELETE', '/api/repo/branch/:name', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.deleteBranch(ctx.actor, ctx.params.name) }));
  route('POST', '/api/repo/checkout', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.checkoutBranch(ctx.actor, ctx.body.ref, { force: Boolean(ctx.body.force) }) }));
  route('POST', '/api/repo/merge', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.mergeRepo(ctx.actor, ctx.body.source, { message: ctx.body.message }) }));
  route('POST', '/api/repo/merge/resolve', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.resolveConflict(ctx.actor, ctx.body.path, ctx.body.choice, ctx.body.content) }));
  route('POST', '/api/repo/merge/abort', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.abortMerge(ctx.actor) }));
  route('POST', '/api/repo/merge/complete', (ctx) => sendJson(ctx.res, 200, { ok: true, data: ws.completeMerge(ctx.actor, ctx.body.message, {}) }));
}

module.exports = { registerRepoRoutes };
