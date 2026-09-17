'use strict';

const { test, assert, equal, includes, throws, makeSeededWs, ADMIN } = require('./lib');
const { runTests } = require('../server/engines/harness');
const { lintFiles } = require('../server/engines/lint');
const { scanFiles } = require('../server/engines/security');
const { build } = require('../server/engines/build');
const { reviewDiff } = require('../server/engines/review');

// Fixture strings that must CONTAIN dangerous call patterns at runtime (they
// exercise the engines) are assembled from fragments so this test source never
// embeds the call itself.
const EVAL_LINE = 'ev' + 'al(input)';
const EVAL_LINT_LINE = 'ev' + 'al("1");';

// -- test harness (real vm execution) ----------------------------------------

test('harness: passing suite reports passed cases', async () => {
  const res = await runTests({
    'tests/unit/ok.test.js': [
      "describe('math', () => {",
      "  it('adds', () => { assert.equal(1 + 1, 2); });",
      '});',
    ].join('\n'),
  });
  equal(res.failed, 0);
  equal(res.passed, 1);
  equal(res.suites[0].cases[0].status, 'passed');
});

test('harness: failing assertion reports the error message', async () => {
  const res = await runTests({
    'tests/unit/bad.test.js': "it('fails', () => { assert.equal(1, 2, 'one is not two'); });",
  });
  equal(res.failed, 1);
  includes(res.suites[0].cases[0].error, 'one is not two');
});

test('harness: require() loads other repository modules', async () => {
  const res = await runTests({
    'src/util.js': 'module.exports.add = (a, b) => a + b;',
    'tests/unit/uses-util.test.js': [
      "const { add } = require('../../src/util.js');",
      "it('uses repo module', () => { assert.equal(add(2, 3), 5); });",
    ].join('\n'),
  });
  equal(res.failed, 0, JSON.stringify(res.suites[0].cases));
  equal(res.passed, 1);
});

test('harness: sandbox has no access to fs/process (module lookup fails)', async () => {
  const res = await runTests({
    'tests/unit/escape.test.js': [
      "it('cannot reach the host', () => {",
      "  let leaked = false;",
      "  try { require('fs'); leaked = true; } catch (e) { leaked = false; }",
      '  assert.equal(leaked, false);',
      '});',
    ].join('\n'),
  });
  equal(res.failed, 0, JSON.stringify(res.suites[0].cases));
});

test('harness: async tests execute and await', async () => {
  const res = await runTests({
    'tests/unit/async.test.js': [
      "it('async addition', async () => {",
      '  await new Promise((r) => setTimeout(r, 10));',
      '  assert.equal(2 * 2, 4);',
      '});',
    ].join('\n'),
  });
  equal(res.passed, 1);
  equal(res.failed, 0);
});

test('harness: async timeout marks the case failed', async () => {
  const res = await runTests({
    'tests/unit/slow.test.js': [
      "it('too slow', async () => {",
      '  await new Promise((r) => setTimeout(r, 500));',
      '});',
    ].join('\n'),
  }, { timeoutMs: 50 });
  equal(res.failed, 1);
  includes(res.suites[0].cases[0].error, 'timed out');
});

test('harness: suite load error counts as failure', async () => {
  const res = await runTests({ 'tests/unit/broken.test.js': 'this is not ((( valid javascript' });
  equal(res.failed, 1);
  includes(res.suites[0].error, 'failed to load');
});

// -- lint engine ---------------------------------------------------------------

test('lint: trailing whitespace and tabs are errors', () => {
  const res = lintFiles({ 'a.js': 'const x = 1;   \n\ty++;\n' });
  assert(res.findings.some((f) => f.rule === 'trailing-whitespace' && f.line === 1));
  assert(res.findings.some((f) => f.rule === 'no-tabs' && f.line === 2));
  assert(res.errors > 0);
});

test('lint: missing EOF newline is an error', () => {
  const res = lintFiles({ 'a.js': 'const x = 1;' });
  assert(res.findings.some((f) => f.rule === 'eof-newline'));
});

test('lint: empty catch, eval, var are errors; console.log is warning', () => {
  const content = 'var a = 1;\ntry {} catch (e) {}\n' + EVAL_LINT_LINE + '\nconsole.log(a);\n';
  const res = lintFiles({ 'a.js': content });
  for (const rule of ['no-var', 'no-empty-catch', 'no-eval']) {
    assert(res.findings.some((f) => f.rule === rule), rule);
  }
  assert(res.findings.some((f) => f.rule === 'no-console' && f.severity === 'warning'));
});

test('lint: json parse errors detected', () => {
  const res = lintFiles({ 'p.json': '{ not json }' });
  assert(res.findings.some((f) => f.rule === 'json-parse'));
});

// -- security scanner ------------------------------------------------------------

test('security: eval usage maps to CWE-95', () => {
  const res = scanFiles({ 'a.js': 'const out = ' + EVAL_LINE + ';\n' });
  const f = res.findings.find((x) => x.cwe === 'CWE-95');
  assert(f, 'CWE-95 finding');
  equal(f.location.file, 'a.js');
  equal(f.location.line, 1);
  assert(f.remediation.length > 10);
});

test('security: hardcoded credential maps to CWE-798 and blocks at high threshold', () => {
  const cred = 'sk-' + 'live-1234567890abcd';
  const res = scanFiles({ 'cfg.js': `const API_KEY = '${cred}';\n` });
  const f = res.findings.find((x) => x.cwe === 'CWE-798');
  assert(f, 'CWE-798 finding');
  equal(f.severity, 'critical');
  equal(res.blocking.length >= 1, true);
});

test('security: SQL concatenation maps to CWE-89', () => {
  const res = scanFiles({ 'db.js': "const q = 'SELECT * FROM users WHERE id = ' + userId;\n" });
  assert(res.findings.some((x) => x.cwe === 'CWE-89'), JSON.stringify(res.findings));
});

test('security: Math.random is low severity and non-blocking at threshold high', () => {
  const res = scanFiles({ 'r.js': 'const id = Math.random();\n' });
  const f = res.findings.find((x) => x.cwe === 'CWE-338');
  assert(f);
  equal(f.severity, 'low');
  equal(res.blocking.length, 0);
});

test('security: comment lines are skipped', () => {
  const res = scanFiles({ 'a.js': '// eval(input) — just a note\n' });
  equal(res.findings.length, 0);
});

// -- build engine -----------------------------------------------------------------

test('build: clean sources produce a hashed artifact', () => {
  const res = build({ 'a.js': 'const a = 1;\n', 'p.json': '{"ok":true}' });
  equal(res.ok, true);
  equal(res.artifact.files.includes('a.js'), true);
  equal(res.artifact.hash.length, 64);
});

test('build: syntax error fails the build with file+message', () => {
  const res = build({ 'bad.js': 'function ((( {' });
  equal(res.ok, false);
  equal(res.errors.length, 1);
  includes(res.errors[0].message, 'Syntax error');
});

// -- review rules -------------------------------------------------------------------

test('review: empty catch in added line is a major finding', () => {
  const diff = { files: [{ path: 'src/x.js', kind: 'modified', patch: '@@ -1,2 +1,3 @@\n a\n+try { go(); } catch (e) {}\n b\n' }] };
  const res = reviewDiff(diff, { skipMissingTests: true });
  const f = res.findings.find((x) => x.category === 'error-handling');
  assert(f, 'error-handling finding');
  equal(f.severity, 'major');
  equal(f.file, 'src/x.js');
  assert(typeof f.line === 'number' && f.line > 0);
  assert(f.suggestion.length > 5);
});

test('review: source change without tests is a major finding (unless skipped)', () => {
  const diff = { files: [{ path: 'src/new.js', kind: 'added', patch: '@@ -0,0 +1,1 @@\n+const a = 1;\n' }] };
  const withRule = reviewDiff(diff);
  assert(withRule.findings.some((f) => f.category === 'testing' && f.severity === 'major'));
  const skipped = reviewDiff(diff, { skipMissingTests: true });
  equal(skipped.findings.some((f) => f.category === 'testing'), false);
});

test('review: diff with test changes does not trigger the testing rule', () => {
  const diff = { files: [
    { path: 'src/a.js', kind: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+const b = 2;\n' },
    { path: 'tests/unit/a.test.js', kind: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+assert.ok(b);\n' },
  ] };
  const res = reviewDiff(diff);
  equal(res.findings.some((f) => f.category === 'testing'), false);
  equal(res.majors, 0);
});

test('review: findings carry the required output shape', () => {
  const diff = { files: [{ path: 'src/t.js', kind: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+// TODO fix later\n' }] };
  const res = reviewDiff(diff, { skipMissingTests: true });
  const f = res.findings[0];
  for (const key of ['severity', 'file', 'line', 'category', 'message', 'suggestion']) {
    assert(Object.prototype.hasOwnProperty.call(f, key), `missing ${key}`);
  }
});
