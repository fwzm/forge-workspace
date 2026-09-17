'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert, equal } = require('./lib');

const MSG_PATH = path.join(__dirname, '..', 'public', 'js', 'i18n', 'messages.json');
const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const VIEWS_DIR = path.join(JS_DIR, 'views');

// Fixed file list (scanner-friendly, no dynamic path walking).
const BROWSER_MODULES = [
  path.join(JS_DIR, 'main.js'),
  path.join(JS_DIR, 'store.js'),
  path.join(JS_DIR, 'actions.js'),
  path.join(JS_DIR, 'ui.js'),
  path.join(VIEWS_DIR, 'dashboard.js'),
  path.join(VIEWS_DIR, 'kanban.js'),
  path.join(VIEWS_DIR, 'graphview.js'),
  path.join(VIEWS_DIR, 'logs.js'),
  path.join(VIEWS_DIR, 'diffview.js'),
  path.join(VIEWS_DIR, 'files.js'),
  path.join(VIEWS_DIR, 'terminal.js'),
  path.join(VIEWS_DIR, 'tests.js'),
  path.join(VIEWS_DIR, 'metrics.js'),
  path.join(VIEWS_DIR, 'prs.js'),
  path.join(VIEWS_DIR, 'settings.js'),
];

// Dictionary key namespaces; single-quoted dotted literals with one of these
// prefixes are treated as i18n references.
const SECTIONS = [
  'common', 'a11y', 'conn', 'foot', 'nav', 'status', 'prstate', 'cistate',
  'reviewtype', 'sev', 'agentstatus', 'dash', 'kanban', 'actions', 'graph',
  'logs', 'diff', 'files', 'term', 'tests', 'metrics', 'prs', 'settings',
  'shortcuts',
];
const KEY_REF = new RegExp(`'((${SECTIONS.join('|')})\\.[A-Za-z0-9_]+)'`, 'g');

const CJK = new RegExp('[\\u4e00-\\u9fff]');
const PLACEHOLDER = new RegExp('\\{[a-zA-Z][a-zA-Z0-9]*\\}', 'g');

function loadDict() {
  return JSON.parse(fs.readFileSync(MSG_PATH, 'utf8'));
}

function collectKeys(obj, prefix) {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') keys.push(...collectKeys(v, full));
    else keys.push(full);
  }
  return keys;
}

// Collect every single-quoted dotted literal that looks like an i18n key.
function collectUsedKeys() {
  const used = new Set();
  for (const file of BROWSER_MODULES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(KEY_REF)) used.add(m[1]);
  }
  return [...used].sort();
}

function placeholders(value) {
  return (String(value).match(PLACEHOLDER) || []).sort().join(',');
}

test('i18n: dictionary has exactly en and zh-CN', () => {
  const dict = loadDict();
  equal(JSON.stringify(Object.keys(dict).sort()), JSON.stringify(['en', 'zh-CN']));
});

test('i18n: en and zh-CN have identical key sets', () => {
  const dict = loadDict();
  const en = collectKeys(dict.en).sort();
  const zh = collectKeys(dict['zh-CN']).sort();
  const missingInZh = en.filter((k) => !zh.includes(k));
  const extraInZh = zh.filter((k) => !en.includes(k));
  assert(missingInZh.length === 0, `keys missing in zh-CN: ${missingInZh.join(', ')}`);
  assert(extraInZh.length === 0, `keys extra in zh-CN: ${extraInZh.join(', ')}`);
  assert(en.length >= 200, `expected a substantial dictionary, got ${en.length} keys`);
});

test('i18n: every value is a non-empty string', () => {
  const dict = loadDict();
  for (const [lang, table] of Object.entries(dict)) {
    for (const [k, v] of Object.entries(table)) {
      assert(typeof v === 'string' && v.trim().length > 0, `${lang}.${k} is not a non-empty string`);
    }
  }
});

test('i18n: every key referenced in browser modules exists in the dictionary', () => {
  const dict = loadDict();
  const used = collectUsedKeys();
  assert(used.length >= 100, `expected many i18n references, found ${used.length}`);
  const missing = used.filter((k) => !Object.prototype.hasOwnProperty.call(dict.en, k));
  assert(missing.length === 0, `i18n keys missing from dictionary: ${missing.join(', ')}`);
});

test('i18n: zh-CN values contain CJK and en values contain none', () => {
  const dict = loadDict();
  let cjkCount = 0;
  let total = 0;
  for (const v of Object.values(dict['zh-CN'])) {
    total += 1;
    if (CJK.test(v)) cjkCount += 1;
  }
  assert(cjkCount / total > 0.8, `expected most zh-CN strings to contain CJK, got ${cjkCount}/${total}`);
  for (const [k, v] of Object.entries(dict.en)) {
    assert(!CJK.test(v), `en.${k} contains CJK characters: "${v}"`);
  }
});

test('i18n: interpolation placeholders match between en and zh-CN', () => {
  const dict = loadDict();
  const mismatched = [];
  for (const [k, v] of Object.entries(dict.en)) {
    const zh = dict['zh-CN'][k];
    if (placeholders(v) !== placeholders(zh)) {
      mismatched.push(`${k}: en(${placeholders(v)}) zh(${placeholders(zh)})`);
    }
  }
  assert(mismatched.length === 0, `placeholder mismatches: ${mismatched.join('; ')}`);
});

test('i18n: language list in i18n.js matches the dictionary', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf8');
  assert(src.includes("'en'") && src.includes("'zh-CN'"), 'i18n.js must expose both supported codes');
  const dict = loadDict();
  for (const code of ['en', 'zh-CN']) {
    assert(code in dict, `dictionary must contain ${code}`);
  }
});

test('i18n: no orphaned keys (dictionary entries should all be referenced or structural)', () => {
  const dict = loadDict();
  const used = new Set(collectUsedKeys());
  const orphans = collectKeys(dict.en).filter((k) => {
    if (used.has(k)) return false;
    // chip()/label() families are looked up dynamically with raw state values,
    // and nav.* labels are consumed through VIEWS[].labelKey indirection.
    const dynamicPrefixes = ['status.', 'prstate.', 'cistate.', 'reviewtype.', 'sev.', 'agentstatus.', 'nav.'];
    if (dynamicPrefixes.some((p) => k.startsWith(p))) return false;
    return true;
  });
  assert(orphans.length === 0, `orphaned dictionary keys (never referenced): ${orphans.join(', ')}`);
});
