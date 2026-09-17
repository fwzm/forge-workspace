'use strict';

// Line-based diff (LCS dynamic programming) used by the diff viewer, the repository
// status output and the 3-way merge engine. Inputs are arrays of lines (no trailing \n).

// Returns an array of ops: { type: 'equal'|'del'|'add', aLine, bLine, text }
// aLine/bLine are 0-based indices into the respective sequences (null when N/A).
function diffLines(aLines, bLines) {
  const n = aLines.length;
  const m = bLines.length;
  // lcs[i][j] = LCS length of a[i..], b[j..]
  const lcs = new Array(n + 1);
  for (let i = 0; i <= n; i++) lcs[i] = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = aLines[i] === bLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({ type: 'equal', aLine: i, bLine: j, text: aLines[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', aLine: i, bLine: null, text: aLines[i] });
      i++;
    } else {
      ops.push({ type: 'add', aLine: null, bLine: j, text: bLines[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: 'del', aLine: i, bLine: null, text: aLines[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', aLine: null, bLine: j, text: bLines[j] }); j++; }
  return ops;
}

// Groups diff ops into hunks: [{ aStart, aEnd, bStart, bEnd, lines: [ops] }]
// aStart/aEnd delimit the replaced base range [aStart, aEnd); bStart/bEnd likewise.
function diffHunks(aLines, bLines) {
  const ops = diffLines(aLines, bLines);
  const hunks = [];
  let cur = null;
  for (const op of ops) {
    if (op.type === 'equal') {
      if (cur) { hunks.push(cur); cur = null; }
      continue;
    }
    if (!cur) {
      cur = {
        aStart: op.type === 'del' ? op.aLine : (prevALine(ops, op)),
        bStart: op.type === 'add' ? op.bLine : (prevBLine(ops, op)),
        aEnd: null, bEnd: null, lines: [],
      };
    }
    cur.lines.push(op);
    if (op.type === 'del') cur.aEnd = op.aLine + 1;
    if (op.type === 'add') cur.bEnd = op.bLine + 1;
  }
  if (cur) hunks.push(cur);
  for (const h of hunks) {
    if (h.aEnd === null) h.aEnd = h.aStart;
    if (h.bEnd === null) h.bEnd = h.bStart;
  }
  return hunks;

  function prevALine(opsAll, op) {
    const idx = opsAll.indexOf(op);
    for (let k = idx - 1; k >= 0; k--) if (opsAll[k].aLine !== null) return opsAll[k].aLine + 1;
    return 0;
  }
  function prevBLine(opsAll, op) {
    const idx = opsAll.indexOf(op);
    for (let k = idx - 1; k >= 0; k--) if (opsAll[k].bLine !== null) return opsAll[k].bLine + 1;
    return 0;
  }
}

// Unified diff text with `context` lines around changes. aLabel/bLabel appear in headers.
function unifiedDiff(aLines, bLines, opts) {
  const o = opts || {};
  const context = o.context === undefined ? 3 : o.context;
  const aLabel = o.aLabel || 'a';
  const bLabel = o.bLabel || 'b';
  const ops = diffLines(aLines, bLines);
  if (ops.every((op) => op.type === 'equal')) return '';

  // Mark ops within context range of a change as "keep".
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === 'equal') return;
    const from = Math.max(0, idx - context);
    const to = Math.min(ops.length - 1, idx + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  });

  const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
  // Build ranges of kept ops (hunks).
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) { idx++; continue; }
    let end = idx;
    while (end < ops.length) {
      if (!keep[end]) {
        // Allow gap only if followed (within context+1) by another kept change region.
        let nxt = end;
        while (nxt < ops.length && !keep[nxt]) nxt++;
        if (nxt >= ops.length) { break; }
        end = nxt;
        continue;
      }
      end++;
    }
    const slice = ops.slice(idx, end);
    const aStart = (slice.find((op) => op.aLine !== null) || { aLine: 0 }).aLine;
    const bStart = (slice.find((op) => op.bLine !== null) || { bLine: 0 }).bLine;
    const aCount = slice.filter((op) => op.type !== 'add').length;
    const bCount = slice.filter((op) => op.type !== 'del').length;
    out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (const op of slice) {
      const sign = op.type === 'equal' ? ' ' : op.type === 'del' ? '-' : '+';
      out.push(sign + op.text);
    }
    idx = end;
  }
  return out.join('\n') + '\n';
}

// Matching pairs [i,j] of an LCS between a and b (increasing in both).
function lcsMatches(aLines, bLines) {
  const ops = diffLines(aLines, bLines);
  return ops.filter((op) => op.type === 'equal').map((op) => [op.aLine, op.bLine]);
}

function splitLines(text) {
  if (text === '' || text === undefined || text === null) return [];
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

module.exports = { diffLines, diffHunks, unifiedDiff, lcsMatches, splitLines };
