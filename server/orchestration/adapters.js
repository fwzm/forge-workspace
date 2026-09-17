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

const RUN_TIMEOUT_MS = 15 * 60 * 1000; // 15 min per agent run
const OUTPUT_LIMIT = 512 * 1024;

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

module.exports = {
  registerAdapter,
  registerFakeAdapter,
  getAdapter,
  listAdapters,
  buildImplementPrompt,
  buildReviewPrompt,
  parseReviewReply,
  resolveBin,
  RUN_TIMEOUT_MS,
};
