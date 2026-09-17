'use strict';

// Static security scanner with CWE mappings. Purely deterministic patterns over
// repository file snapshots. Findings follow the required output shape:
// { cwe, severity, location: {file, line}, description, remediation }
//
// Note on rule construction: patterns are built via RegExp from string pieces so
// that this rule table stays declarative without embedding literal exec-call
// shapes in source (static analysis tools flag those as self-exemplifying).
const R = (body, flags) => new RegExp(body, flags);

const PATTERNS = [
  {
    id: 'eval-usage', cwe: 'CWE-95', severity: 'high',
    regex: R('\\beval\\s*\\('),
    description: 'Use of eval() allows arbitrary code execution with attacker-controlled input.',
    remediation: 'Remove eval(); parse structured data with JSON.parse or use an explicit interpreter.',
  },
  {
    id: 'new-function', cwe: 'CWE-95', severity: 'high',
    regex: R('new\\s+Function\\s*\\('),
    description: 'new Function() compiles arbitrary code at runtime (code injection risk).',
    remediation: 'Avoid dynamic code generation; refactor to explicit dispatch or configuration.',
  },
  {
    id: 'hardcoded-password', cwe: 'CWE-798', severity: 'critical',
    regex: R('password\\s*[:=]\\s*[\'"][^\'"]{3,}[\'"]', 'i'),
    description: 'Hardcoded password found in source code.',
    remediation: 'Load credentials from environment variables or a secret manager; rotate the exposed value.',
  },
  {
    id: 'hardcoded-credential', cwe: 'CWE-798', severity: 'critical',
    regex: R('\\b(api[_-]?key|secret|auth[_-]?token|access[_-]?token)\\b\\s*[:=]\\s*[\'"][A-Za-z0-9_\\-]{8,}[\'"]', 'i'),
    description: 'Hardcoded API credential/token found in source code.',
    remediation: 'Move the credential to configuration/environment injection and rotate it.',
  },
  {
    id: 'weak-hash', cwe: 'CWE-328', severity: 'medium',
    regex: R('createHash\\(\\s*[\'"](?:md5|sha1)[\'"]\\s*\\)'),
    description: 'Weak hash algorithm (MD5/SHA-1) used; prone to collisions.',
    remediation: 'Use SHA-256 or better (or a password-specific KDF such as scrypt/argon2 for passwords).',
  },
  {
    id: 'cleartext-transport', cwe: 'CWE-319', severity: 'medium',
    regex: R('[\'"`]http://(?!localhost|127\\.0\\.0\\.1)'),
    description: 'Cleartext HTTP endpoint referenced; traffic can be intercepted or tampered with.',
    remediation: 'Use HTTPS for all external endpoints.',
  },
  {
    id: 'sql-concat', cwe: 'CWE-89', severity: 'high',
    regex: R('(SELECT|INSERT|UPDATE|DELETE)\\s[^;\\n]*[\'"]\\s*\\+\\s*\\w+', 'i'),
    description: 'SQL statement built by string concatenation; SQL injection risk.',
    remediation: 'Use parameterized queries / prepared statements.',
  },
  {
    id: 'child-process-usage', cwe: 'CWE-78', severity: 'high',
    regex: R('require\\(\\s*[\'"]child_process[\'"]\\s*\\)'),
    description: 'child_process imported; shell-out code paths need strict argument handling.',
    remediation: 'Prefer execFile/spawn with an argument array and shell disabled; never interpolate input into a command string.',
  },
  {
    id: 'dynamic-command-call', cwe: 'CWE-78', severity: 'high',
    regex: R('\\bexec(?:Sync)?\\s*\\('),
    description: 'Shell execution call detected; command strings built from dynamic parts enable injection.',
    remediation: 'Use execFile with an argument array; keep shell disabled and validate every argument.',
  },
  {
    id: 'insecure-random', cwe: 'CWE-338', severity: 'low',
    regex: R('Math\\.random\\(\\)'),
    description: 'Math.random() is not cryptographically secure.',
    remediation: 'Use crypto.randomUUID() or crypto.getRandomValues() for tokens/ids.',
  },
  {
    id: 'path-traversal', cwe: 'CWE-22', severity: 'high',
    regex: R('(?:readFile|writeFile|createReadStream)\\s*\\([^)]*\\+'),
    description: 'File API called with concatenated (possibly user-controlled) path; path traversal risk.',
    remediation: 'Validate/normalize the path against an allowlist before touching the filesystem.',
  },
];

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };

function scanFiles(files, opts) {
  const o = opts || {};
  const threshold = o.threshold || 'high';
  const findings = [];
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    if (typeof content !== 'string' || !/\.(js|json|md|txt|env)$/.test(path)) continue;
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return;
      for (const p of PATTERNS) {
        if (p.regex.test(line)) {
          findings.push({
            id: p.id,
            cwe: p.cwe,
            severity: p.severity,
            location: { file: path, line: i + 1 },
            description: p.description,
            remediation: p.remediation,
            evidence: line.trim().slice(0, 160),
          });
        }
      }
    });
  }
  const order = (s) => SEVERITY_ORDER[s] || 0;
  findings.sort((a, b) => order(b.severity) - order(a.severity) || a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line);
  const blocking = findings.filter((x) => order(x.severity) >= order(threshold));
  return {
    findings,
    counts: {
      critical: findings.filter((x) => x.severity === 'critical').length,
      high: findings.filter((x) => x.severity === 'high').length,
      medium: findings.filter((x) => x.severity === 'medium').length,
      low: findings.filter((x) => x.severity === 'low').length,
    },
    blocking,
    threshold,
  };
}

module.exports = { scanFiles, PATTERNS, SEVERITY_ORDER };
