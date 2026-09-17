'use strict';

const http = require('http');
const path = require('path');

const { Workspace } = require('./domain/workspace');
const { ForgeError, isForgeError } = require('./core/errors');
const { execute: runTerminal } = require('./terminal');
const { serveStatic } = require('./static');
const { sendJson } = require('./jsonio');
const { registerCoreRoutes } = require('./routes-core');
const { registerRepoRoutes } = require('./routes-repo');
const { registerCollabRoutes } = require('./routes-collab');

const PORT = Number(process.env.FORGE_PORT || 7788);
const DATA_DIR = process.env.FORGE_DATA_DIR || path.join(__dirname, '..', 'data');
const MAX_BODY = 8 * 1024 * 1024;

// Single-operator local workspace: every API call acts as the admin user.
const ADMIN = { type: 'user', id: 'admin', role: 'admin' };

const STATUS_FOR_CODE = {
  FORGE_INVALID_INPUT: 400,
  FORGE_INVALID_TRANSITION: 409,
  FORGE_CYCLE: 400,
  FORGE_STATE: 409,
  FORGE_NOT_FOUND: 404,
  FORGE_DIRTY_WORKTREE: 409,
  FORGE_CONFLICT: 409,
  FORGE_MERGE_GATE: 409,
  FORGE_PERMISSION_DENIED: 403,
  FORGE_IO: 500,
};

const ws = new Workspace({ dataDir: DATA_DIR });

// ---------------------------------------------------------------------------
// Metrics: computed from live runtime state only (no synthetic numbers).
// ---------------------------------------------------------------------------
function computeMetrics() {
  const tasks = ws.tasks.list();
  const byStatus = {};
  const byType = {};
  const durations = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byType[t.type] = (byType[t.type] || 0) + 1;
    if (t.startedAt && t.completedAt) {
      const d = t.completedAt - t.startedAt;
      (durations[t.type] = durations[t.type] || []).push(d);
    }
  }
  const avgDurationByType = {};
  for (const [k, arr] of Object.entries(durations)) {
    avgDurationByType[k] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  const runs = ws.ciRuns;
  const stageStats = {};
  for (const run of runs) {
    for (const s of run.stages) {
      const st = stageStats[s.name] = stageStats[s.name] || { total: 0, success: 0, failure: 0 };
      st.total += 1;
      if (s.status === 'success') st.success += 1;
      if (s.status === 'failure') st.failure += 1;
    }
  }
  const prs = ws.prs.list();
  const prByState = {};
  let cycleSum = 0;
  let cycleCount = 0;
  for (const pr of prs) {
    prByState[pr.state] = (prByState[pr.state] || 0) + 1;
    if (pr.mergedAt) {
      cycleSum += pr.mergedAt - pr.createdAt;
      cycleCount += 1;
    }
  }
  const commitsByMinute = {};
  for (const c of ws.repo.log(100)) {
    const key = new Date(c.timestamp).toISOString().slice(0, 16);
    commitsByMinute[key] = (commitsByMinute[key] || 0) + 1;
  }
  return {
    generatedAt: Date.now(),
    tasks: { total: tasks.length, byStatus, byType, avgDurationByTypeMs: avgDurationByType },
    ci: { runs: runs.length, success: runs.filter((r) => r.status === 'success').length, failure: runs.filter((r) => r.status === 'failure').length, stages: stageStats },
    prs: { total: prs.length, byState: prByState, avgMergeCycleMs: cycleCount ? Math.round(cycleSum / cycleCount) : null },
    repo: { commits: ws.repo.commits.size, branches: ws.repo.branches.size, blobs: ws.repo.blobs.size, files: ws.repo.listFiles().length },
    agents: ws.agents.list().map((a) => ({ id: a.id, type: a.type, status: a.status, tasksDone: a.tasksDone, tasksFailed: a.tasksFailed })),
    audit: { entries: ws.audit.entries.length },
    messages: { total: ws.messages.length },
    commitsByMinute,
  };
}

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) {
  const names = [];
  const regex = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, (m) => {
    names.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  routes.push({ method, regex, names, handler });
}

registerCoreRoutes(route, ws, computeMetrics);
registerRepoRoutes(route, ws);
registerCollabRoutes(route, ws, runTerminal);

// ---------------------------------------------------------------------------
// Server plumbing
// ---------------------------------------------------------------------------
function parseTarget(req) {
  const raw = req.url || '/';
  const q = raw.indexOf('?');
  const pathname = (q === -1 ? raw : raw.slice(0, q)) || '/';
  const query = q === -1 ? '' : raw.slice(q + 1);
  return { pathname, searchParams: new URLSearchParams(query) };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ForgeError('FORGE_INVALID_INPUT', `request body exceeds ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new ForgeError('FORGE_INVALID_INPUT', `request body is not valid JSON: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  let matched = null;
  let params = {};
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.regex);
    if (m) {
      matched = r;
      params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      break;
    }
  }
  if (!matched) {
    sendJson(res, 404, { ok: false, error: { code: 'FORGE_NOT_FOUND', message: `no route: ${req.method} ${url.pathname}`, details: null } });
    return;
  }
  const body = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const ctx = { req, res, url, body, params, actor: ADMIN };
  await matched.handler(ctx);
}

const server = http.createServer((req, res) => {
  const url = parseTarget(req);
  const run = url.pathname.startsWith('/api/')
    ? handleApi(req, res, url)
    : Promise.resolve().then(() => serveStatic(res, url.pathname));
  run.catch((e) => {
    try {
      if (isForgeError(e)) {
        sendJson(res, STATUS_FOR_CODE[e.code] || 400, { ok: false, error: { code: e.code, message: e.message, details: e.details } });
      } else {
        ws.audit.append({ type: 'system', id: 'http', role: 'system' }, 'server.error', { type: 'http', id: url.pathname }, { error: e.message });
        sendJson(res, 500, { ok: false, error: { code: 'FORGE_INTERNAL', message: e.message, details: null } });
      }
    } catch (_) { /* response already closed */ }
  });
});

process.on('uncaughtException', (e) => {
  console.error('[forge] uncaughtException:', e);
  try { ws.audit.append({ type: 'system', id: 'process', role: 'system' }, 'server.uncaught_exception', null, { error: e.message }); } catch (_) { /* ignore */ }
});
process.on('unhandledRejection', (e) => {
  console.error('[forge] unhandledRejection:', e);
  try { ws.audit.append({ type: 'system', id: 'process', role: 'system' }, 'server.unhandled_rejection', null, { error: String((e && e.message) || e) }); } catch (_) { /* ignore */ }
});

function shutdown(signal) {
  console.log(`[forge] ${signal} received; persisting state and closing`);
  try { ws._save(); } catch (_) { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Auto-listen unless the test suite sets FORGE_NO_LISTEN=1.
if (process.env.FORGE_NO_LISTEN !== '1') {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[forge] FORGE workspace listening on http://127.0.0.1:${PORT}`);
    console.log(`[forge] state file: ${ws.persistence.file}`);
    if (!ws.isLoadedFromDisk()) {
      console.log('[forge] empty workspace — open the UI and click "Seed Demo", or POST /api/reset {"seed":true}');
    }
  });
}

module.exports = { server, ws, computeMetrics };
