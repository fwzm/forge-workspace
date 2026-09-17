'use strict';

const fs = require('fs');
const path = require('path');
const { getRegistry } = require('./lib');

const files = [];
function use(file) {
  const before = getRegistry().length;
  require(file);
  const after = getRegistry().length;
  for (let i = before; i < after; i++) getRegistry()[i].file = file;
}

// Static require list (deterministic order, scanner-friendly).
use('./state-machine.test.js');
use('./tasks.test.js');
use('./scheduler.test.js');
use('./diff-merge.test.js');
use('./repo.test.js');
use('./engines.test.js');
use('./pr.test.js');
use('./ci.test.js');
use('./permissions.test.js');
use('./audit.test.js');
use('./persistence.test.js');
use('./terminal.test.js');
use('./demo.test.js');
use('./api.test.js');
use('./i18n.test.js');
use('./desktop.test.js');

(async () => {
  const results = [];
  let passed = 0;
  let failed = 0;
  const startedAll = Date.now();
  for (const t of getRegistry()) {
    const started = Date.now();
    try {
      await t.fn();
      passed += 1;
      results.push({ file: t.file, name: t.name, status: 'pass', durationMs: Date.now() - started });
    } catch (e) {
      failed += 1;
      const stackLine = (e.stack || '').split('\n').slice(1, 3).join(' | ');
      results.push({ file: t.file, name: t.name, status: 'fail', error: e.message, stack: stackLine, durationMs: Date.now() - started });
      console.error(`FAIL [${t.file}] ${t.name}\n      ${e.message}`);
    }
  }
  const durationMs = Date.now() - startedAll;
  const byFile = {};
  for (const r of results) {
    const e = byFile[r.file] = byFile[r.file] || { pass: 0, fail: 0 };
    if (r.status === 'pass') e.pass += 1; else e.fail += 1;
  }
  console.log('\n==== FORGE test report ====');
  for (const [f, e] of Object.entries(byFile)) {
    console.log(`  ${f.padEnd(28)} pass ${String(e.pass).padStart(3)}  fail ${e.fail}`);
  }
  console.log(`TOTAL: ${results.length} tests — ${passed} passed, ${failed} failed in ${durationMs}ms`);
  fs.writeFileSync(path.join(__dirname, '..', 'test-report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: results.length, passed, failed, durationMs,
    files: byFile,
    results,
  }, null, 1));
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('runner crashed:', e);
  process.exit(2);
});
