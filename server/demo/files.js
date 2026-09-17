'use strict';

// Seed file contents for the demo repository "demo-app". All seed files are
// clean against the lint/security engines (verified by tests). v1/v2/v3 are the
// three iterations used by the demo scenario.
//
// NOTE: the v1 fixture intentionally contains a hardcoded credential so the
// security engine has something real to detect. The value is assembled at
// runtime from two fragments so this workspace source file itself never
// contains a complete credential literal (defense against secret scanners
// sweeping this repository).
const CRED = 'sk-' + 'live-1234567890abcd';

const README = `# demo-app

A tiny service used to demonstrate the FORGE multi-agent workspace.

- \`src/stringUtils.js\` — string helpers
- \`src/userService.js\` — user records + store
- \`tests/unit\` — unit suites
- \`tests/integration\` — integration suites
`;

const PACKAGE_JSON = `{
  "name": "demo-app",
  "version": "0.1.0",
  "description": "Demo application hosted in the FORGE virtual repository",
  "license": "MIT"
}
`;

const STRING_UTILS = `'use strict';

function capitalize(text) {
  const s = String(text || '');
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { capitalize, slugify };
`;

const USER_SERVICE_V0 = `'use strict';

let nextId = 1;

function createUser(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('input must be an object');
  }
  const name = String(input.name || '').trim();
  if (name.length < 2) {
    throw new RangeError('name must be at least 2 characters');
  }
  return {
    id: 'usr_' + String(nextId++).padStart(4, '0'),
    name,
    email: String(input.email || '').trim(),
    createdAt: new Date().toISOString(),
  };
}

function createUserStore() {
  const byId = new Map();
  return {
    add(input) {
      const user = createUser(input);
      byId.set(user.id, user);
      return user;
    },
    get(id) {
      return byId.get(id) || null;
    },
    size() {
      return byId.size;
    },
  };
}

module.exports = { createUser, createUserStore };
`;

// v1 template: naive normalizeEmail (no validation, swallowed error) plus the
// demo credential placeholder that gets substituted below.
const USER_SERVICE_V1_TEMPLATE = `'use strict';

// Deployment pipeline credential (deliberately committed in this fixture).
const API_KEY = '__K__';

let nextId = 1;

function normalizeEmail(email) {
  const raw = String(email === null || email === undefined ? '' : email);
  let out = raw;
  try {
    out = raw.trim().toLowerCase();
  } catch (e) {}
  return out;
}

function createUser(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('input must be an object');
  }
  const name = String(input.name || '').trim();
  if (name.length < 2) {
    throw new RangeError('name must be at least 2 characters');
  }
  return {
    id: 'usr_' + String(nextId++).padStart(4, '0'),
    name,
    email: normalizeEmail(input.email),
    createdAt: new Date().toISOString(),
  };
}

function createUserStore() {
  const byId = new Map();
  return {
    add(input) {
      const user = createUser(input);
      byId.set(user.id, user);
      return user;
    },
    get(id) {
      return byId.get(id) || null;
    },
    size() {
      return byId.size;
    },
  };
}

module.exports = { createUser, createUserStore, normalizeEmail };
`;

const USER_SERVICE_V1 = USER_SERVICE_V1_TEMPLATE.split('__K__').join(CRED);

// v2: strict normalizeEmail (validation + credential removed), but createUser
// still swallows normalization errors with an empty catch — the reviewer will
// request changes on it.
const USER_SERVICE_V2 = `'use strict';

let nextId = 1;

function normalizeEmail(email) {
  if (typeof email !== 'string') {
    throw new TypeError('invalid email: expected a string');
  }
  const out = email.trim().toLowerCase();
  if (!out.includes('@') || out.startsWith('@') || out.endsWith('@')) {
    throw new RangeError('invalid email: missing or misplaced @');
  }
  return out;
}

function createUser(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('input must be an object');
  }
  const name = String(input.name || '').trim();
  if (name.length < 2) {
    throw new RangeError('name must be at least 2 characters');
  }
  let email;
  try {
    email = normalizeEmail(input.email);
  } catch (e) {}
  return {
    id: 'usr_' + String(nextId++).padStart(4, '0'),
    name,
    email: email || '',
    createdAt: new Date().toISOString(),
  };
}

function createUserStore() {
  const byId = new Map();
  return {
    add(input) {
      const user = createUser(input);
      byId.set(user.id, user);
      return user;
    },
    get(id) {
      return byId.get(id) || null;
    },
    size() {
      return byId.size;
    },
  };
}

module.exports = { createUser, createUserStore, normalizeEmail };
`;

// v3: errors propagate instead of being swallowed (reviewer approves this).
const USER_SERVICE_V3 = `'use strict';

let nextId = 1;

function normalizeEmail(email) {
  if (typeof email !== 'string') {
    throw new TypeError('invalid email: expected a string');
  }
  const out = email.trim().toLowerCase();
  if (!out.includes('@') || out.startsWith('@') || out.endsWith('@')) {
    throw new RangeError('invalid email: missing or misplaced @');
  }
  return out;
}

function createUser(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('input must be an object');
  }
  const name = String(input.name || '').trim();
  if (name.length < 2) {
    throw new RangeError('name must be at least 2 characters');
  }
  let email;
  try {
    email = normalizeEmail(input.email);
  } catch (e) {
    throw new RangeError('invalid email for user: ' + e.message);
  }
  return {
    id: 'usr_' + String(nextId++).padStart(4, '0'),
    name,
    email,
    createdAt: new Date().toISOString(),
  };
}

function createUserStore() {
  const byId = new Map();
  return {
    add(input) {
      const user = createUser(input);
      byId.set(user.id, user);
      return user;
    },
    get(id) {
      return byId.get(id) || null;
    },
    size() {
      return byId.size;
    },
  };
}

module.exports = { createUser, createUserStore, normalizeEmail };
`;

const UNIT_STRING_UTILS = `'use strict';

const { capitalize, slugify } = require('../../src/stringUtils.js');

describe('capitalize', () => {
  it('uppercases the first letter', () => {
    assert.equal(capitalize('forge'), 'Forge');
  });
  it('handles empty input', () => {
    assert.equal(capitalize(''), '');
  });
});

describe('slugify', () => {
  it('slugifies names', () => {
    assert.equal(slugify('Grace Hopper'), 'grace-hopper');
  });
  it('collapses separators', () => {
    assert.equal(slugify('  Multi   Part -- name!! '), 'multi-part-name');
  });
});
`;

const UNIT_USER_SERVICE = `'use strict';

const { createUser, createUserStore } = require('../../src/userService.js');

describe('createUser', () => {
  it('creates a user with a trimmed name', () => {
    const u = createUser({ name: '  Ada  ', email: 'ada@example.com' });
    assert.equal(u.name, 'Ada');
    assert.equal(u.email, 'ada@example.com');
  });
  it('rejects short names', () => {
    assert.throws(() => createUser({ name: 'a', email: 'a@b.co' }));
  });
  it('rejects non-object input', () => {
    assert.throws(() => createUser(null));
  });
});

describe('createUserStore', () => {
  it('stores and retrieves users', () => {
    const store = createUserStore();
    const u = store.add({ name: 'Bob', email: 'bob@example.com' });
    assert.equal(store.get(u.id).name, 'Bob');
    assert.equal(store.size(), 1);
  });
});
`;

// Added together with the feature: the v1 implementation is buggy, so this
// suite fails in the first QA round and passes once v2 lands.
const UNIT_USER_SERVICE_NORMALIZE = `'use strict';

const { normalizeEmail } = require('../../src/userService.js');

describe('normalizeEmail', () => {
  it('trims and lowercases addresses', () => {
    assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
  });
  it('rejects values without an @', () => {
    assert.throws(() => normalizeEmail('not-an-email'), /invalid email/);
  });
  it('rejects non-string input', () => {
    assert.throws(() => normalizeEmail(42), /invalid email/);
  });
});
`;

const INTEGRATION_USER_SERVICE = `'use strict';

const { createUser, createUserStore } = require('../../src/userService.js');
const { slugify, capitalize } = require('../../src/stringUtils.js');

describe('userService integration', () => {
  it('derives handles from user names', () => {
    const store = createUserStore();
    const u = store.add({ name: 'Grace Hopper', email: 'grace@example.com' });
    assert.equal(slugify(u.name), 'grace-hopper');
    assert.ok(u.id.startsWith('usr_'));
  });
  it('formats display names', () => {
    const u = createUser({ name: 'ada lovelace', email: 'ada@example.com' });
    assert.equal(capitalize(u.name), 'Ada lovelace');
  });
  it('keeps the store consistent', () => {
    const store = createUserStore();
    store.add({ name: 'Alan Turing', email: 'alan@example.com' });
    store.add({ name: 'Edsger Dijkstra', email: 'edsger@example.com' });
    assert.equal(store.size(), 2);
    assert.equal(store.get('usr_missing'), null);
  });
});
`;

const SEED_FILES = {
  'README.md': README,
  'package.json': PACKAGE_JSON,
  'src/stringUtils.js': STRING_UTILS,
  'src/userService.js': USER_SERVICE_V0,
  'tests/unit/stringUtils.test.js': UNIT_STRING_UTILS,
  'tests/unit/userService.test.js': UNIT_USER_SERVICE,
  'tests/integration/userService.test.js': INTEGRATION_USER_SERVICE,
};

module.exports = {
  SEED_FILES,
  USER_SERVICE_V1,
  USER_SERVICE_V2,
  USER_SERVICE_V3,
  UNIT_USER_SERVICE_NORMALIZE,
};
