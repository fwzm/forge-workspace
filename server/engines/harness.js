'use strict';

const vm = require('vm');

// ---------------------------------------------------------------------------
// Real test execution: repo test files run inside a locked-down vm sandbox with
// a mini describe/it/assert harness and a repository-module `require`.
// No access to process/fs/net — the sandbox has none of them.
// ---------------------------------------------------------------------------
function miniAssert() {
  function ok(cond, message) {
    if (!cond) throw new Error(message || 'assert.ok failed');
  }
  function equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message || `assert.equal failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  function notEqual(actual, expected, message) {
    if (actual === expected) throw new Error(message || 'assert.notEqual failed');
  }
  function deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(message || `assert.deepEqual failed: expected ${b}, got ${a}`);
  }
  function throws(fn, message) {
    try {
      fn();
    } catch (e) {
      return e;
    }
    throw new Error(message || 'assert.throws failed: function did not throw');
  }
  function fail(message) {
    throw new Error(message || 'assert.fail');
  }
  return { ok, equal, notEqual, deepEqual, throws, fail };
}

// Run repo test files inside the sandbox. `files` is the FULL repository
// snapshot (so tests can require src modules); `opts.only` restricts which
// files are executed as suites (e.g. "tests/unit/"). Async: returns a promise
// that settles after every async case has been recorded.
async function runTests(files, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 3000;
  const only = o.only || null;
  const paths = Object.keys(files).filter((p) => !only || p.startsWith(only)).sort();
  const suites = [];
  let totalPassed = 0;
  let totalFailed = 0;
  const startedAll = Date.now();
  const pending = [];

  for (const path of paths) {
    const suite = { file: path, cases: [], passed: 0, failed: 0, error: null, console: [] };
    suites.push(suite);
    const logs = suite.console;
    const sandboxConsole = {
      log: (...args) => { if (logs.length < 100) logs.push(args.map(String).join(' ')); },
      error: (...args) => { if (logs.length < 100) logs.push('[error] ' + args.map(String).join(' ')); },
      warn: (...args) => { if (logs.length < 100) logs.push('[warn] ' + args.map(String).join(' ')); },
    };
    const assert = miniAssert();
    const expect = (actual) => ({
      toBe: (exp) => assert.equal(actual, exp),
      toEqual: (exp) => assert.deepEqual(actual, exp),
      toBeTruthy: () => assert.ok(actual, 'expected truthy'),
      toBeFalsy: () => assert.ok(!actual, 'expected falsy'),
      toThrow: () => assert.throws(() => (typeof actual === 'function' ? actual() : actual)),
    });
    const registered = [];
    const sandbox = {
      describe: (name, fn) => {
        registered.push({ name, fn });
      },
      it: (name, fn) => registered.push({ name, fn, case: true }),
      test: (name, fn) => registered.push({ name, fn, case: true }),
      assert,
      expect,
      console: sandboxConsole,
      JSON,
      Math,
      Date,
      RegExp,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      Error,
      TypeError,
      RangeError,
      isNaN,
      parseInt,
      parseFloat,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };
    sandbox.globalThis = sandbox;
    const moduleCache = new Map();

    const repoRequire = (fromPath, spec) => {
      let resolved;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const dirParts = fromPath.split('/').slice(0, -1);
        const parts = (spec.startsWith('/') ? spec.slice(1) : [...dirParts, spec].join('/')).split('/');
        const stack = [];
        for (const part of parts) {
          if (part === '.' || part === '') continue;
          if (part === '..') stack.pop();
          else stack.push(part);
        }
        resolved = stack.join('/');
      } else {
        resolved = spec;
      }
      if (!Object.prototype.hasOwnProperty.call(files, resolved) && Object.prototype.hasOwnProperty.call(files, resolved + '.js')) {
        resolved = resolved + '.js';
      }
      if (!Object.prototype.hasOwnProperty.call(files, resolved)) {
        throw new Error(`module not found in repository: ${spec} (from ${fromPath})`);
      }
      if (moduleCache.has(resolved)) return moduleCache.get(resolved).exports;
      const mod = { exports: {} };
      moduleCache.set(resolved, mod);
      const wrapper = `(function (module, exports, require, __filename) {\n${files[resolved]}\n})`;
      const script = new vm.Script(wrapper, { filename: `repo://${resolved}` });
      const fn = script.runInContext(vm.createContext(sandbox));
      fn(mod, mod.exports, (s) => repoRequire(resolved, s), resolved);
      return mod.exports;
    };
    sandbox.require = (spec) => repoRequire(path, spec);

    try {
      const wrapper = `(function (module, exports, require, __filename) {\n${files[path]}\n})`;
      const script = new vm.Script(wrapper, { filename: `repo://${path}` });
      const fn = script.runInContext(vm.createContext(sandbox));
      fn({ exports: {} }, {}, sandbox.require, path);
    } catch (e) {
      suite.error = `suite failed to load: ${e.message}`;
      suite.failed = 1;
      continue;
    }

    for (const entry of registered) {
      if (entry.case) {
        pending.push(runCase(suite, entry, timeoutMs));
      } else {
        // describe block: run nested cases inline (flat semantics)
        let nested;
        try {
          const collect = [];
          const oldIt = sandbox.it;
          const oldTest = sandbox.test;
          sandbox.it = (n, f) => collect.push({ name: n, fn: f, case: true });
          sandbox.test = sandbox.it;
          entry.fn();
          sandbox.it = oldIt;
          sandbox.test = oldTest;
          nested = collect;
        } catch (e) {
          suite.cases.push({ name: entry.name, status: 'failed', error: `describe failed: ${e.message}`, durationMs: 0 });
          suite.failed += 1;
          totalFailed += 1;
          continue;
        }
        for (const c of nested) pending.push(runCase(suite, c, timeoutMs));
      }
    }
  }

  await Promise.all(pending);
  for (const s of suites) {
    totalPassed += s.passed;
    totalFailed += s.failed;
  }

  return {
    suites,
    total: totalPassed + totalFailed,
    passed: totalPassed,
    failed: totalFailed,
    durationMs: Date.now() - startedAll,
  };

  function runCase(suite, entry, timeout) {
    return new Promise((resolve) => {
      const started = Date.now();
      const record = (status, error) => {
        const dur = Date.now() - started;
        suite.cases.push({ name: entry.name, status, error: error || null, durationMs: dur });
        if (status === 'passed') suite.passed += 1;
        else suite.failed += 1;
        resolve();
      };
      let syncThrew = null;
      let result;
      try {
        result = entry.fn();
      } catch (e) {
        syncThrew = e;
      }
      if (syncThrew) {
        record('failed', syncThrew.message);
        return;
      }
      if (result && typeof result.then === 'function') {
        let timer = null;
        const timeoutPromise = new Promise((r2) => {
          timer = setTimeout(() => r2({ timeout: true }), timeout);
        });
        if (timer && timer.unref) timer.unref();
        Promise.race([result, timeoutPromise]).then((outcome) => {
          if (outcome && outcome.timeout) record('failed', `test timed out after ${timeout}ms`);
          else record('passed', null);
        }).catch((e) => record('failed', e.message));
      } else {
        record('passed', null);
      }
    });
  }
}

module.exports = { runTests, miniAssert };
