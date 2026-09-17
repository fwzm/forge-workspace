import { refresh, startPolling, subscribe, getState } from './store.js';
import { h, clear, toast, closeModal, openModal, t } from './ui.js';
import { LANGS, getLang, setLang, init as i18nInit, onChange as onLangChange } from './i18n.js';
import { render as dashboard } from './views/dashboard.js';
import { render as kanban } from './views/kanban.js';
import { render as graphview } from './views/graphview.js';
import { render as logs } from './views/logs.js';
import { render as diffview } from './views/diffview.js';
import { render as files } from './views/files.js';
import { render as terminal } from './views/terminal.js';
import { render as tests } from './views/tests.js';
import { render as metrics } from './views/metrics.js';
import { render as prs } from './views/prs.js';
import { render as settings } from './views/settings.js';

const VIEWS = [
  { id: 'dashboard', num: '1', labelKey: 'nav.dashboard', render },
  { id: 'kanban', num: '2', labelKey: 'nav.kanban', render: kanban },
  { id: 'graph', num: '3', labelKey: 'nav.graph', render: graphview },
  { id: 'prs', num: '4', labelKey: 'nav.prs', render: prs },
  { id: 'files', num: '5', labelKey: 'nav.files', render: files },
  { id: 'diff', num: '6', labelKey: 'nav.diff', render: diffview },
  { id: 'tests', num: '7', labelKey: 'nav.tests', render: tests },
  { id: 'logs', num: '8', labelKey: 'nav.logs', render: logs },
  { id: 'terminal', num: '9', labelKey: 'nav.terminal', render: terminal },
  { id: 'metrics', num: '0', labelKey: 'nav.metrics', render: metrics },
  { id: 'settings', num: 'g s', labelKey: 'nav.settings', render: settings },
];

function currentView() {
  const hash = location.hash.replace(/^#\//, '') || 'dashboard';
  return VIEWS.find((v) => v.id === hash) || VIEWS[0];
}

function renderNav() {
  const nav = clear(document.getElementById('nav'));
  const cur = currentView().id;
  for (const v of VIEWS) {
    const label = t(v.labelKey);
    const a = h('a', { href: `#/${v.id}`, class: v.id === cur ? 'active' : '', title: `${label} (${v.num})` },
      label, h('span', { class: 'key' }, v.num));
    nav.appendChild(a);
  }
}

function applyStaticLabels() {
  const skip = document.querySelector('.skip-link');
  if (skip) skip.textContent = t('a11y.skip');
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.setAttribute('aria-label', t('a11y.nav'));
  const nav = document.getElementById('nav');
  if (nav) nav.setAttribute('aria-label', t('a11y.views'));
  const foot = document.querySelector('.foot-note');
  if (foot) {
    clear(foot);
    foot.appendChild(document.createTextNode(t('foot.local')));
    foot.appendChild(document.createElement('br'));
    foot.appendChild(document.createTextNode(t('foot.private')));
  }
}

function buildLangSwitch() {
  const foot = document.querySelector('.sidebar-foot');
  if (!foot) return;
  const existing = foot.querySelector('select');
  if (existing) existing.remove();
  const sel = h('select', { name: 'lang-quick', 'aria-label': t('foot.language'), style: 'margin-bottom: 6px' });
  for (const l of LANGS) {
    sel.appendChild(h('option', { value: l.code, selected: l.code === getLang() }, l.label));
  }
  sel.addEventListener('change', () => setLang(sel.value));
  const wrap = h('div', null, h('div', { class: 'muted', style: 'margin-bottom: 2px' }, t('foot.language')), sel);
  foot.insertBefore(wrap, foot.firstChild);
}

function render() {
  const view = currentView();
  renderNav();
  applyStaticLabels();
  buildLangSwitch();
  const root = clear(document.getElementById('view'));
  try {
    view.render(root, getState());
  } catch (e) {
    root.appendChild(h('div', { class: 'panel' },
      h('h2', null, 'View failed to render'),
      h('pre', null, String(e && e.stack || e))));
  }
  document.title = `FORGE — ${t(view.labelKey)}`;
}

function shortcutsModal() {
  closeModal();
  openModal(t('shortcuts.title'), (body) => {
    body.appendChild(h('table', null, h('tbody', null, [
      ['1…0', t('shortcuts.switchViews')],
      ['g then s', t('shortcuts.settings')],
      ['?', t('shortcuts.help')],
      ['Esc', t('shortcuts.closeDialog')],
      ['Tab / Shift+Tab', t('shortcuts.moveFocus')],
    ].map(([k, d]) => h('tr', null, h('th', { scope: 'row' }, k), h('td', null, d))))));
  });
}

let gPending = false;
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
  if (typing) return;
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.key === '?') { e.preventDefault(); shortcutsModal(); return; }
  if (e.key === 'g') { gPending = true; setTimeout(() => { gPending = false; }, 900); return; }
  if (gPending && e.key === 's') { gPending = false; location.hash = '#/settings'; return; }
  const view = VIEWS.find((v) => v.num === e.key && v.num.length === 1);
  if (view) {
    e.preventDefault();
    location.hash = `#/${view.id}`;
  }
});

// Global error handlers — every client error is surfaced as a toast.
window.addEventListener('error', (e) => {
  toast(`Client error: ${e.message}`, 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  toast(`Unhandled rejection: ${msg}`, 'error');
});

subscribe(render);
onLangChange(render);
window.addEventListener('hashchange', render);
i18nInit().then(() => {
  render();
  return refresh();
}).then(() => {
  render();
  startPolling(1500);
}).catch((e) => {
  console.error('boot failed', e);
  render();
});
render();
