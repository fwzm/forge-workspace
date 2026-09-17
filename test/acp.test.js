'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test, assert, equal, includes, throws } = require('./lib');
const { createAcpClient, autoAllowPermission } = require('../server/orchestration/acp-client');
const { resolveZcodeCjs, resolveDshBinJs } = require('../server/orchestration/adapters');

// A fixture "ACP server": speaks the subset of the protocol the client uses.
// Written to a temp file at require-time so tests can spawn it with node.
const FIXTURE_SERVER = `\
const lines = require('readline').createInterface({ input: process.stdin });
let nextSession = 1;
lines.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fixture-acp', version: '0.0.1' } } }) + '\\n');
  } else if (msg.method === 'session/new') {
    const sid = 'sess-fixture-' + nextSession++;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid } }) + '\\n');
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'FIXTURE-DID-WORK' } } } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/request_permission', id: 900, params: { sessionId: sid, options: [{ id: 'opt-reject', kind: 'reject_once', name: 'No' }, { id: 'opt-allow', kind: 'allow_once', name: 'Yes' }] } }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
    }, 50);
  } else if (msg.id === 900) {
    process.stderr.write('PERMISSION-ANSWER ' + JSON.stringify(msg.result) + '\\n');
  }
});
`;

test('acp-client: handshake, session cycle, permission auto-allow, transcript collection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fixture-'));
  const serverPath = path.join(dir, 'fixture-server.js');
  fs.writeFileSync(serverPath, FIXTURE_SERVER, 'utf8');
  const client = createAcpClient({
    bin: process.execPath,
    args: [serverPath],
    timeoutMs: 10 * 1000,
  });
  const permissionAnswer = new Promise((resolve) => {
    client.child.stderr.on('data', (d) => {
      const m = String(d).match(/PERMISSION-ANSWER (\{.*\})/);
      if (m) resolve(JSON.parse(m[1]));
    });
  });
  client.onNotification((msg) => {
    if (msg.method === 'session/request_permission') autoAllowPermission(msg, client.reply);
  });
  try {
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    equal(init.agentInfo.name, 'fixture-acp');
    const session = await client.request('session/new', { cwd: dir, mcpServers: [] });
    assert(session.sessionId.startsWith('sess-fixture-'), session.sessionId);
    const updates = [];
    client.onNotification((msg) => {
      if (msg.method === 'session/update') updates.push(msg);
    });
    const done = await client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    equal(done.stopReason, 'end_turn');
    const answer = await permissionAnswer;
    equal(answer.optionId, 'opt-allow', 'auto-answer picks the allow option');
    const text = updates
      .filter((m) => m.method === 'session/update' && m.params.update.kind === 'agent_message_chunk')
      .map((m) => m.params.update.content.text)
      .join('');
    includes(text, 'FIXTURE-DID-WORK');
  } finally {
    client.close();
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 100);
  }
});

test('acp-client: server exit while a request is in flight rejects cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-exit-'));
  const serverPath = path.join(dir, 'silent-server.js');
  fs.writeFileSync(serverPath, "setTimeout(() => process.exit(0), 100);\n", 'utf8');
  const client = createAcpClient({ bin: process.execPath, args: [serverPath], timeoutMs: 5000 });
  try {
    let err = null;
    try {
      await client.request('initialize', { protocolVersion: 1 });
    } catch (e) {
      err = e;
    }
    // Either the in-flight timeout or the exit rejection — both are clean AcpErrors.
    assert(err && (err.code === 'E_ACP_CLOSED' || err.code === 'E_ACP_TIMEOUT'), `got ${err && err.code}`);
  } finally {
    client.close();
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 100);
  }
});

test('acp-client: autoAllowPermission falls back to the first option and null', () => {
  const sent = [];
  const reply = (id, result) => sent.push({ id, result });
  autoAllowPermission({ id: 7, params: { options: [{ id: 'a', kind: 'reject_once' }, { id: 'b', kind: 'allow_always' }] } }, reply);
  equal(sent[0].result.optionId, 'b', 'allow_always accepted too');
  autoAllowPermission({ id: 8, params: { options: [{ id: 'x', kind: 'unknown' }] } }, reply);
  equal(sent[1].result.optionId, 'x', 'fallback first option');
  autoAllowPermission({ id: 9, params: {} }, reply);
  equal(sent[2].result.optionId, null, 'no options -> null');
});

// -- resolvers ------------------------------------------------------------------

test('orchestration: zcode resolver honors the env override', () => {
  const fake = path.join(os.tmpdir(), 'forge-zcode-fake.cjs');
  fs.writeFileSync(fake, '// fake\n', 'utf8');
  process.env.FORGE_ZCODE_CJS = fake;
  equal(resolveZcodeCjs(), fake);
  delete process.env.FORGE_ZCODE_CJS;
  fs.unlinkSync(fake);
});

test('orchestration: zcode resolver finds the real installation on this machine', () => {
  const found = resolveZcodeCjs();
  assert(found, 'zcode.cjs expected at D:/Program Files/ZCode on this machine');
  includes(found, 'zcode.cjs');
});

test('orchestration: dsh resolver derives bin.js from the PATH shim', () => {
  const found = resolveDshBinJs();
  assert(found, 'dsh expected on PATH on this machine');
  includes(found, 'bin.js');
  includes(found.replace(/\\/g, '/'), '@deepseek-ai/dsh/lib');
});

test('orchestration: new adapters are registered and probe-able', async () => {
  const { getAdapter } = require('../server/orchestration/adapters');
  const zcode = getAdapter('zcode');
  const dsh = getAdapter('dsh');
  assert(zcode && dsh, 'both adapters registered');
  equal(zcode.kind, 'real');
  equal(dsh.kind, 'real');
  const zProbe = await zcode.probe();
  equal(zProbe.ok, true, `zcode probe: ${zProbe.reason}`);
  assert(/\d+\.\d+/.test(zProbe.version || ''), `zcode version: ${zProbe.version}`);
  const dProbe = await dsh.probe();
  equal(dProbe.ok, true, `dsh probe: ${dProbe.reason}`);
  includes(dProbe.version, 'deepseek-harness-acp');
});
