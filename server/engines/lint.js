'use strict';

// Deterministic lint engine over repository file snapshots.
// Findings: { rule, severity: 'error'|'warning', file, line, message }

function lintFiles(files, opts) {
  const o = opts || {};
  const maxLineLength = o.maxLineLength || 140;
  const findings = [];
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    if (typeof content !== 'string') continue;
    if (path.endsWith('.js')) {
      const lines = content.split('\n');
      const nonEmpty = content.trim().length > 0;
      lines.forEach((line, i) => {
        const ln = i + 1;
        if (/[ \t]+$/.test(line)) findings.push(f('trailing-whitespace', 'error', path, ln, 'Line ends with whitespace'));
        if (/^\t/.test(line)) findings.push(f('no-tabs', 'error', path, ln, 'Tab used for indentation; use spaces'));
        if (line.length > maxLineLength) findings.push(f('line-length', 'warning', path, ln, `Line is ${line.length} chars (max ${maxLineLength})`));
        if (/\bvar\s+[A-Za-z_$]/.test(line)) findings.push(f('no-var', 'error', path, ln, 'Use const/let instead of var'));
        if (/\beval\s*\(/.test(line)) findings.push(f('no-eval', 'error', path, ln, 'eval() is forbidden'));
        if (/console\.log\(/.test(line)) findings.push(f('no-console', 'warning', path, ln, 'console.log left in source'));
        if (/\b(TODO|FIXME)\b/.test(line)) findings.push(f('no-todo', 'warning', path, ln, 'TODO/FIXME marker left in source'));
        if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) findings.push(f('no-empty-catch', 'error', path, ln, 'Empty catch block swallows errors'));
        if (/password\s*[:=]\s*['"][^'"]{3,}['"]/i.test(line)) findings.push(f('no-hardcoded-secret', 'error', path, ln, 'Hardcoded password detected'));
        if (/(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{8,}['"]/i.test(line)) findings.push(f('no-hardcoded-secret', 'error', path, ln, 'Hardcoded credential detected'));
      });
      if (nonEmpty && !content.endsWith('\n')) {
        findings.push(f('eof-newline', 'error', path, lines.length, 'File does not end with a newline'));
      }
    } else if (path.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (e) {
        findings.push(f('json-parse', 'error', path, 1, `Invalid JSON: ${e.message}`));
      }
    }
  }
  return {
    findings,
    errors: findings.filter((x) => x.severity === 'error').length,
    warnings: findings.filter((x) => x.severity === 'warning').length,
  };
}

function f(rule, severity, file, line, message) {
  return { rule, severity, file, line, message };
}

module.exports = { lintFiles };
