'use strict';

// ---------------------------------------------------------------------------
// Minimal ACP (Agent Client Protocol v1) client over line-delimited JSON-RPC
// on a child process's stdio. Used to drive the DeepSeek Harness ACP server
// (`dsh --profile acp`) for one-shot tasks.
//
// The transport is injectable: `spawnImpl(bin, args, opts)` must return a
// ChildProcess-like emitter with .stdin/.stdout writable/readable streams —
// tests substitute a fixture server instead of the real dsh.
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');

class AcpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data === undefined ? null : data;
  }
}

function createAcpClient({ bin, args, spawnImpl, timeoutMs }) {
  const child = (spawnImpl || spawn)(bin, args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  const notificationHandlers = [];
  let buffer = '';
  let nextId = 1;
  let closed = false;

  const requestTimer = setTimeout(() => {
    child.kill();
  }, timeoutMs || 20 * 60 * 1000);
  if (requestTimer.unref) requestTimer.unref();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue; // non-protocol noise on stdout is dropped
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new AcpError(msg.error.code, msg.error.message || 'ACP error', msg.error.data));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const handler of notificationHandlers) {
          try {
            handler(msg);
          } catch (_) { /* handler errors must not break the pump */ }
        }
      }
    }
  });
  child.on('exit', () => {
    closed = true;
    clearTimeout(requestTimer);
    for (const [, { reject, timer }] of pending) {
      clearTimeout(timer);
      reject(new AcpError('E_ACP_CLOSED', 'ACP server exited with a request in flight'));
    }
    pending.clear();
  });

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  function request(method, params) {
    if (closed) return Promise.reject(new AcpError('E_ACP_CLOSED', 'ACP server is closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AcpError('E_ACP_TIMEOUT', `ACP request timed out: ${method}`));
      }, timeoutMs || 20 * 60 * 1000);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function onNotification(handler) {
    notificationHandlers.push(handler);
  }

  function close() {
    closed = true;
    clearTimeout(requestTimer);
    try { child.kill(); } catch (_) { /* already gone */ }
  }

  return { child, request, reply, onNotification, close };
}

// Auto-answer an ACP session/request_permission server->client call by
// choosing the allow option (prefer allow_once; fall back to the first).
function autoAllowPermission(msg, reply) {
  const options = (msg.params && msg.params.options) || [];
  const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
  reply(msg.id, { optionId: (allow || options[0] || {}).id || null });
}

module.exports = { createAcpClient, autoAllowPermission, AcpError };
