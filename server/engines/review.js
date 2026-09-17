'use strict';

// Deterministic code-review rules evaluated over a PR diff (added lines only).
// Findings follow the required output shape:
// { severity, file, line, category, message, suggestion }

function reviewDiff(diff, opts) {
  // diff: { files: [{ path, kind, patch }] } as produced by Repository.diffRefs
  const o = opts || {};
  const maxLen = o.maxLineLength || 120;
  const findings = [];
  let addsSrc = false;
  let addsTests = false;

  for (const file of diff.files) {
    if (!file.patch) continue;
    const lines = file.patch.split('\n');
    let lineNo = 0;
    let inHunk = false;
    for (const raw of lines) {
      if (raw.startsWith('@@')) {
        const m = raw.match(/\+(\d+)/);
        lineNo = m ? parseInt(m[1], 10) - 1 : 0;
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (raw.startsWith('+')) {
        const content = raw.slice(1);
        lineNo += 1;
        if (file.path.startsWith('src/')) addsSrc = true;
        if (file.path.startsWith('tests/')) addsTests = true;
        if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(content)) {
          findings.push(fi('major', file.path, lineNo, 'error-handling',
            'Empty catch block swallows the error silently.',
            'Handle the error explicitly (log + rethrow, or return a typed failure).'));
        }
        if (/\beval\s*\(/.test(content)) {
          findings.push(fi('major', file.path, lineNo, 'security',
            'eval() on dynamic input is a code-injection risk.',
            'Replace with JSON.parse or explicit parsing.'));
        }
        if (/\b(TODO|FIXME)\b/.test(content)) {
          findings.push(fi('minor', file.path, lineNo, 'process',
            'TODO/FIXME marker committed to the branch.',
            'Resolve it or track it in an issue before merge.'));
        }
        if (/console\.log\(/.test(content)) {
          findings.push(fi('minor', file.path, lineNo, 'style',
            'console.log left in production source.',
            'Remove the debug log or route it through a configurable logger.'));
        }
        if (content.length > maxLen) {
          findings.push(fi('minor', file.path, lineNo, 'style',
            `Line exceeds ${maxLen} characters.`,
            'Wrap the line for readability.'));
        }
      } else if (raw.startsWith('-')) {
        // deleted line: no findings, does not advance new-file line numbers
      } else if (raw.startsWith(' ') || raw === '') {
        if (inHunk) lineNo += raw.startsWith(' ') ? 1 : 0;
      }
    }
  }

  if (addsSrc && !addsTests && !o.skipMissingTests) {
    findings.push(fi('major', '(diff)', 0, 'testing',
      'Source changes without any test changes.',
      'Add or update tests covering the modified behavior.'));
  }
  const order = { major: 2, minor: 1 };
  findings.sort((a, b) => order[b.severity] - order[a.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  return {
    findings,
    majors: findings.filter((x) => x.severity === 'major').length,
    minors: findings.filter((x) => x.severity === 'minor').length,
  };
}

function fi(severity, file, line, category, message, suggestion) {
  return { severity, file, line, category, message, suggestion };
}

module.exports = { reviewDiff };
