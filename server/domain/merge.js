'use strict';

const { diffHunks, splitLines } = require('../core/diff');

// diff3-style 3-way merge on line arrays, built on hunk grouping.
// base/ours/theirs: arrays of lines (no trailing newline entries).
// Returns { lines, text, conflicts } — conflicts: [{ baseRange, base, ours, theirs }].
function merge3(baseLines, oursLines, theirsLines, opts) {
  const o = opts || {};
  const oursLabel = o.oursLabel || 'ours';
  const theirsLabel = o.theirsLabel || 'theirs';
  const ho = diffHunks(baseLines, oursLines);
  const ht = diffHunks(baseLines, theirsLines);
  const events = [];
  for (const h of ho) events.push({ side: 'ours', h });
  for (const h of ht) events.push({ side: 'theirs', h });
  events.sort((x, y) => (x.h.aStart - y.h.aStart) || (x.h.aEnd - y.h.aEnd));

  const out = [];            // { text } | { conflict: index }
  const conflicts = [];
  let bi = 0;
  let idx = 0;
  while (idx < events.length) {
    const first = events[idx].h;
    let s = first.aStart;
    let e = Math.max(first.aEnd, first.aStart);
    const group = [events[idx]];
    idx += 1;
    while (idx < events.length && events[idx].h.aStart <= e) {
      const ev = events[idx];
      e = Math.max(e, ev.h.aEnd);
      group.push(ev);
      idx += 1;
    }
    // Copy unchanged base lines before the region (equal on all three sides).
    while (bi < s) { out.push({ text: baseLines[bi] }); bi += 1; }
    const baseSeg = baseLines.slice(s, e);
    const oursSeg = sideRange(s, e, group.filter((g) => g.side === 'ours').map((g) => g.h), baseLines, oursLines);
    const theirsSeg = sideRange(s, e, group.filter((g) => g.side === 'theirs').map((g) => g.h), baseLines, theirsLines);
    if (arrEq(oursSeg, baseSeg) && arrEq(theirsSeg, baseSeg)) {
      for (const l of baseSeg) out.push({ text: l });
    } else if (arrEq(theirsSeg, baseSeg)) {
      for (const l of oursSeg) out.push({ text: l });
    } else if (arrEq(oursSeg, baseSeg)) {
      for (const l of theirsSeg) out.push({ text: l });
    } else if (arrEq(oursSeg, theirsSeg)) {
      for (const l of oursSeg) out.push({ text: l });
    } else {
      conflicts.push({ baseRange: [s, e], base: baseSeg, ours: oursSeg, theirs: theirsSeg });
      out.push({ conflict: conflicts.length - 1 });
    }
    bi = Math.max(bi, e);
  }
  while (bi < baseLines.length) { out.push({ text: baseLines[bi] }); bi += 1; }

  const textLines = [];
  for (const seg of out) {
    if (seg.text !== undefined) { textLines.push(seg.text); continue; }
    const c = conflicts[seg.conflict];
    textLines.push(`<<<<<<< ${oursLabel}`);
    textLines.push(...c.ours);
    textLines.push('=======');
    textLines.push(...c.theirs);
    textLines.push(`>>>>>>> ${theirsLabel}`);
  }
  const text = textLines.length ? textLines.join('\n') + '\n' : '';
  return { lines: textLines, text, conflicts };
}

// Reconstruct what one side looks like over base range [s, e): hunks inside the
// range contribute their replacement lines; untouched base lines pass through.
// An insertion hunk positioned exactly at e (aStart === aEnd === e) is appended.
function sideRange(s, e, hunks, baseLines, sideLines) {
  const res = [];
  let k = s;
  while (k < e) {
    const h = hunks.find((x) => x.aStart <= k && k < x.aEnd);
    if (h) {
      for (let j = h.bStart; j < h.bEnd; j++) res.push(sideLines[j]);
      k = h.aEnd;
    } else {
      res.push(baseLines[k]);
      k += 1;
    }
  }
  for (const h of hunks) {
    if (h.aStart === e && h.aEnd === e) {
      for (let j = h.bStart; j < h.bEnd; j++) res.push(sideLines[j]);
    }
  }
  return res;
}

function arrEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

module.exports = { merge3 };
