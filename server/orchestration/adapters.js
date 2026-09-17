'use strict';

// ---------------------------------------------------------------------------
// External agent adapters.
//
// Each adapter knows how to (a) probe whether the CLI exists, and (b) run a
// task non-interactively inside a working directory with the prompt fed via
// STDIN. Argument vectors are fixed constants — the only dynamic value is
// the probed absolute binary path; no user input ever reaches argv.
//
// The registry also supports injected FAKE adapters (same interface, no
// process at all) so the full orchestration pipeline is testable offline.
// ---------------------------------------------------------------------------
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAcpClient, autoAllowPermission } = require('./acp-client');

const RUN_TIMEOUT_MS = 15 * 60 * 1000; // 15 min per agent run
const OUTPUT_LIMIT = 512 * 1024;

// First existing candidate path, or null. Candidates may come from an env
// override, PATH-resolved shims, or well-known install locations.
function firstExisting(paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) { /* skip */ }
  }
  return null;
}

function run(bin, constArgs, opts, stdinText) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = execFile(bin, constArgs, {
      cwd: opts.cwd,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 4 * OUTPUT_LIMIT,
      windowsHide: true,
      env: Object.assign({}, process.env, { NO_COLOR: '1' }),
    }, (err, stdout, stderr) => {
      done({
        ok: !err,
        exitCode: err && err.code !== undefined ? err.code : 0,
        timedOut: Boolean(err && err.killed),
        stdout: String(stdout || '').slice(0, OUTPUT_LIMIT),
        stderr: String(stderr || '').slice(0, OUTPUT_LIMIT),
        error: err ? err.message : null,
      });
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
    }, RUN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    if (stdinText !== undefined && stdinText !== null) {
      child.stdin.on('error', () => { /* agent may close stdin early */ });
      child.stdin.write(String(stdinText), 'utf8');
      child.stdin.end();
    } else {
      // Agents that read stdin would block forever on an open pipe; always
      // close it when there is nothing to feed.
      child.stdin.end();
    }
  });
}

// Resolve a Windows npm shim (codex.cmd / claude.cmd) or a real binary to an
// invocable absolute path. Returns null when not found.
function resolveBin(name) {
  const candidates = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, `${name}.cmd`));
    candidates.push(path.join(dir, `${name}.exe`));
    candidates.push(path.join(dir, name));
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) { /* skip */ }
  }
  return null;
}

function isCmdShim(binPath) {
  return /\.cmd$/i.test(binPath) || /\.bat$/i.test(binPath);
}

// Invoke a probed binary through cmd.exe when it is a .cmd shim (Node cannot
// exec .cmd directly). The argument vector stays a fixed constant array.
function runResolved(binPath, constArgs, opts, stdinText) {
  if (!isCmdShim(binPath)) {
    return run(binPath, constArgs, opts, stdinText);
  }
  const shell = process.env.ComSpec || 'cmd.exe';
  const shellArgs = ['/d', '/s', '/c', binPath, ...constArgs];
  return run(shell, shellArgs, opts, stdinText);
}

// ---------------------------------------------------------------------------
// Real adapters
// ---------------------------------------------------------------------------
const codexAdapter = {
  id: 'codex',
  label: 'OpenAI Codex CLI',
  kind: 'real',
  probe: async () => {
    const bin = resolveBin('codex');
    if (!bin) return { ok: false, reason: 'codex not on PATH' };
    const res = await runResolved(bin, ['--version'], { cwd: os.tmpdir() });
    return { ok: res.ok, version: (res.stdout || '').trim(), bin };
  },
  runTask: async (ctx) => {
    const probe = await codexAdapter.probe();
    if (!probe.ok) throw new Error(`codex unavailable: ${probe.reason}`);
    const res = await runResolved(probe.bin, ['exec', '--skip-git-repo-check', '-'], { cwd: ctx.workDir }, ctx.prompt);
    return res;
  },
};

const claudeAdapter = {
  id: 'claude',
  label: 'Claude Code CLI',
  kind: 'real',
  probe: async () => {
    const bin = resolveBin('claude');
    if (!bin) return { ok: false, reason: 'claude not on PATH' };
    const res = await runResolved(bin, ['--version'], { cwd: os.tmpdir() });
    return { ok: res.ok, version: (res.stdout || '').trim(), bin };
  },
  runTask: async (ctx) => {
    const probe = await claudeAdapter.probe();
    if (!probe.ok) throw new Error(`claude unavailable: ${probe.reason}`);
    const res = await runResolved(probe.bin, ['-p', '--permission-mode', 'acceptEdits'], { cwd: ctx.workDir }, ctx.prompt);
    return res;
  },
};

// ---------------------------------------------------------------------------
// ZCode: Electron app with a headless CLI entry (resources/glm/zcode.cjs).
// The task brief travels via TASK.md in the isolated work dir; argv carries
// only a constant instruction plus the work dir path.
// ---------------------------------------------------------------------------
const ZCODE_CONST_PROMPT = 'Read TASK.md in the current directory and complete the task it describes. Stay within this directory.';
const ZCODE_CONST_REVIEW_PROMPT = 'Read PR.md in the current directory and reply with exactly the JSON object it requests. Output only the JSON object.';

function resolveZcodeCjs() {
  return firstExisting([
    process.env.FORGE_ZCODE_CJS,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    'D:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
    'E:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
  ]);
}

const zcodeAdapter = {
  id: 'zcode',
  label: 'ZCode (headless)',
  kind: 'real',
  probe: async () => {
    const cjs = resolveZcodeCjs();
    if (!cjs) return { ok: false, reason: 'zcode.cjs not found (set FORGE_ZCODE_CJS)' };
    const res = await run(process.execPath, [cjs, '--version'], { cwd: os.tmpdir() });
    return { ok: res.ok, version: (res.stdout || '').trim(), bin: cjs };
  },
  runTask: async (ctx) => {
    const cjs = resolveZcodeCjs();
    if (!cjs) throw new Error('zcode unavailable: zcode.cjs not found (set FORGE_ZCODE_CJS)');
    const constPrompt = ctx.kind === 'review' ? ZCODE_CONST_REVIEW_PROMPT : ZCODE_CONST_PROMPT;
    return run(process.execPath, [cjs, '--prompt', constPrompt, '--cwd', ctx.workDir], { cwd: ctx.workDir });
  },
};

// ---------------------------------------------------------------------------
// DeepSeek Harness (dsh): driven through its automation-only ACP server
// (`dsh --profile acp`, JSON-RPC over stdio). The dsh.cmd shim resolves the
// install dir; we launch node against its bin.js directly.
// ---------------------------------------------------------------------------
function resolveDshBinJs() {
  const envBin = process.env.FORGE_DSH_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  const shim = resolveBin('dsh');
  if (shim) {
    const derived = path.join(path.dirname(shim), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(derived)) return derived;
  }
  return null;
}

function collectAssistantText(updates, sessionId) {
  let text = '';
  for (const msg of updates) {
    if (msg.method !== 'session/update') continue;
    const u = msg.params && msg.params.update;
    if (!u || (msg.params.sessionId && sessionId && msg.params.sessionId !== sessionId)) continue;
    if (u.kind === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      text += u.content.text || '';
    } else if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      text += u.content.text || '';
    }
  }
  return text;
}

const dshAdapter = {
  id: 'dsh',
  label: 'DeepSeek Harness (ACP)',
  kind: 'real',
  probe: async () => {
    const binJs = resolveDshBinJs();
    if (!binJs) return { ok: false, reason: 'dsh not found (set FORGE_DSH_BIN)' };
    const client = createAcpClient({
      bin: process.execPath,
      args: [binJs, '--profile', 'acp'],
      timeoutMs: 60 * 1000,
    });
    try {
      const result = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      return { ok: true, version: result && result.agentInfo ? `${result.agentInfo.name} ${result.agentInfo.version}` : 'acp', bin: binJs };
    } catch (e) {
      return { ok: false, reason: e.message };
    } finally {
      client.close();
    }
  },
  runTask: async (ctx) => {
    const binJs = resolveDshBinJs();
    if (!binJs) throw new Error('dsh unavailable: bin.js not found (set FORGE_DSH_BIN)');
    const client = createAcpClient({
      bin: process.execPath,
      args: [binJs, '--profile', 'acp'],
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const updates = [];
    client.onNotification((msg) => {
      if (msg.method === 'session/request_permission') autoAllowPermission(msg, client.reply);
      else updates.push(msg);
    });
    try {
      await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const session = await client.request('session/new', { cwd: ctx.workDir, mcpServers: [] });
      const sessionId = session && session.sessionId;
      if (!sessionId) throw new Error('dsh ACP session/new returned no sessionId');
      await client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: ctx.prompt }],
      });
      const transcript = collectAssistantText(updates, sessionId);
      return {
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: transcript.slice(0, OUTPUT_LIMIT) || `[dsh] turn settled (session ${sessionId})`,
        stderr: '',
        error: null,
      };
    } catch (e) {
      return {
        ok: false,
        exitCode: 1,
        timedOut: e.code === 'E_ACP_TIMEOUT',
        stdout: collectAssistantText(updates, null).slice(0, OUTPUT_LIMIT),
        stderr: e.message,
        error: e.message,
      };
    } finally {
      client.close();
    }
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
const registry = new Map();

function registerAdapter(adapter) {
  if (!adapter || !adapter.id || typeof adapter.runTask !== 'function') {
    throw new Error('adapter must have id and runTask(ctx)');
  }
  registry.set(adapter.id, adapter);
  return adapter;
}

function getAdapter(id) {
  return registry.get(id) || null;
}

function listAdapters() {
  return [...registry.values()];
}

// Test seam: register a fake adapter that mutates files in the work dir and
// returns a canned transcript, without spawning any process. The handler may
// return { stdout } to control the transcript (e.g. a review JSON verdict).
function registerFakeAdapter(id, handler) {
  return registerAdapter({
    id,
    label: `fake:${id}`,
    kind: 'fake',
    probe: async () => ({ ok: true, version: 'fake', bin: null }),
    runTask: async (ctx) => {
      const outcome = handler ? handler(ctx) : null;
      const custom = outcome && typeof outcome === 'object' && typeof outcome.stdout === 'string'
        ? outcome.stdout
        : `[fake:${id}] completed task in ${ctx.workDir}`;
      return {
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: custom,
        stderr: '',
        error: null,
        fakeOutcome: outcome === undefined ? null : outcome,
      };
    },
  });
}

registerAdapter(codexAdapter);
registerAdapter(claudeAdapter);
registerAdapter(zcodeAdapter);
registerAdapter(dshAdapter);

// ---------------------------------------------------------------------------
// Prompt builders (pure, unit-testable)
// ---------------------------------------------------------------------------
function buildImplementPrompt(task, files) {
  const fileList = Object.keys(files).sort().map((p) => `- ${p}`).join('\n');
  return [
    'You are working inside an isolated snapshot of a small repository.',
    'Complete the task described below by editing files directly in this directory.',
    'Rules:',
    '- Edit ONLY files in this directory; do not create files elsewhere.',
    '- Keep changes minimal and focused on the task.',
    '- Make sure the existing tests under tests/ still pass, and add/update tests for your change.',
    '',
    'Repository files:',
    fileList,
    '',
    'Task:',
    task.title,
    '',
    task.description || '(no extra description)',
    task.spec && task.spec.instructions ? `\nExtra instructions:\n${task.spec.instructions}` : '',
  ].filter((x) => x !== undefined).join('\n');
}

function buildReviewPrompt(pr, diffText) {
  return [
    'You are a strict code reviewer. Review the following unified diff and reply with ONLY a JSON object (no prose, no markdown fence) of this exact shape:',
    '{"decision":"approve|request_changes","comment":"short summary","findings":[{"severity":"major|minor","file":"path","line":0,"category":"error-handling|security|testing|style|process","message":"what is wrong","suggestion":"how to fix"}]}',
    'Approve only when there are no major findings.',
    '',
    `Pull request: ${pr.title}`,
    `Source: ${pr.sourceBranch} -> Target: ${pr.targetBranch}`,
    '',
    'Diff:',
    diffText.slice(0, 60 * 1024),
  ].join('\n');
}

// Parse a reviewer reply into { decision, comment, findings }; tolerant of
// markdown fences and stray prose around the JSON object.
function parseReviewReply(text) {
  const raw = String(text || '');
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && (obj.decision === 'approve' || obj.decision === 'request_changes')) {
        return {
          decision: obj.decision,
          comment: typeof obj.comment === 'string' ? obj.comment : '',
          findings: Array.isArray(obj.findings) ? obj.findings.filter((f) => f && typeof f.message === 'string') : [],
        };
      }
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

// ctx.kind lets const-prompt adapters distinguish implement vs review runs.
function withKind(kind, ctx) {
  return Object.assign({}, ctx, { kind });
}

module.exports = {
  registerAdapter,
  registerFakeAdapter,
  getAdapter,
  listAdapters,
  buildImplementPrompt,
  buildReviewPrompt,
  parseReviewReply,
  resolveBin,
  resolveZcodeCjs,
  resolveDshBinJs,
  withKind,
  RUN_TIMEOUT_MS,
};
