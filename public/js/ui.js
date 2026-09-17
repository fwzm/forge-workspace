import * as i18n from './i18n.js';

// ---------------------------------------------------------------------------
// Minimal DOM helpers. All dynamic data is rendered through textContent
// (createTextNode) — no markup sinks.
// ---------------------------------------------------------------------------
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else if (k === 'disabled') el.disabled = Boolean(v);
      else if (k === 'selected') el.selected = Boolean(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) { append(el, c); continue; }
    if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Chip families: the raw value keeps its CSS class, the visible text is the
// localized label when a translation exists for any family.
const CHIP_FAMILIES = ['status', 'prstate', 'cistate', 'reviewtype', 'sev', 'agentstatus'];

export function label(raw) {
  for (const fam of CHIP_FAMILIES) {
    if (i18n.has(`${fam}.${raw}`)) return i18n.t(`${fam}.${raw}`);
  }
  return raw;
}

export function chip(status, text) {
  return h('span', { class: `chip ${status}` }, text === undefined ? label(status) : text);
}

export { t } from './i18n.js';

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtFull(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function fmtDur(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function short(sha) {
  return sha ? String(sha).slice(0, 10) : '—';
}

export function toast(message, kind) {
  const root = document.getElementById('toasts');
  const tEl = h('div', { class: `toast ${kind || ''}`, role: 'status' }, message);
  root.appendChild(tEl);
  setTimeout(() => tEl.remove(), 4200);
}

export function openModal(title, build) {
  const root = clear(document.getElementById('modal-root'));
  const box = h('div', { class: 'box', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const closeBtn = h('button', { class: 'small', onclick: closeModal, 'aria-label': i18n.t('a11y.closeDialog') }, '✕');
  box.appendChild(h('div', { class: 'row', style: 'justify-content: space-between; margin-bottom: 8px;' },
    h('h2', { style: 'margin:0;' }, title), closeBtn));
  const body = h('div');
  box.appendChild(body);
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } }, box);
  root.appendChild(overlay);
  build(body, closeModal);
  const focusable = box.querySelector('input, textarea, select, button');
  if (focusable) focusable.focus();
}

export function closeModal() {
  clear(document.getElementById('modal-root'));
}

export function jsonPreview(obj, maxLen) {
  const text = JSON.stringify(obj);
  if (text === undefined) return 'undefined';
  if (maxLen && text.length > maxLen) return text.slice(0, maxLen) + '…';
  return text;
}

export function kvTable(rows) {
  return h('table', null,
    h('tbody', null, rows.map(([k, v]) => h('tr', null, h('th', { scope: 'row' }, k), h('td', null, v)))));
}
