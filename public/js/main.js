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
  { id: 'dashboard', num: '1', labelKey: 'nav.dashboard', render: dashboard, sig: sigDashboard },
  { id: 'kanban', num: '2', labelKey: 'nav.kanban', render: kanban, sig: sigTasks },
  { id: 'graph', num: '3', labelKey: 'nav.graph', render: graphview, sig: sigTasks },
  { id: 'prs', num: '4', labelKey: 'nav.prs', render: prs, sig: sigPrs },
  { id: 'files', num: '5', labelKey: 'nav.files', render: files, sig: sigFiles },
  { id: 'diff', num: '6', labelKey: 'nav.diff', render: diffview, sig: sigRefs },
  { id: 'tests', num: '7', labelKey: 'nav.tests', render: tests, sig: sigRuns },
  { id: 'logs', num: '8', labelKey: 'nav.logs', render: logs, sig: sigLogs },
  { id: 'terminal', num: '9', labelKey: 'nav.terminal', render: terminal, sig: (s, lang) => lang + '|' + s.name },
  { id: 'metrics', num: '0', labelKey: 'nav.metrics', render: metrics, sig: (s, lang) => lang },
  { id: 'settings', num: 'g s', labelKey: 'nav.settings', render: settings, sig: (s, lang) => lang + '|' + JSON.stringify(s.config) },
];

// Cheap per-view fingerprints: when a poll produces state that a view does
// not display, skip that view's re-render entirely (heavy tables/SVGs stay
// put instead of being rebuilt every 1.5s).
function sigTasks(state, lang) {
  return lang + '|' + state.tasks.map((t) => `${t.id}:${t.status}:${t.assignee}:${t.attempts}:${t.dependencies.length}:${t.updatedAt}:${t.lastError ? 1 : 0}`).join(',');
}

function sigDashboard(state, lang) {
  return [
    lang,
    state.tasks.map((t) => t.status).join(','),
    state.agents.map((a) => `${a.tasksDone}/${a.tasksFailed}`).join(','),
    state.repo.commits,
    state.prs.filter((p) => p.state === 'merged').length,
    state.ciRuns.filter((r) => r.status === 'success').length,
    state.issues.length,
    state.audit.length,
    state.demo ? `${state.demo.stepIndex}:${state.demo.steps.map((s) => s.status).join('')}` : '-',
  ].join('|');
}

function sigPrs(state, lang) {
  return lang + '|' + JSON.stringify([
    state.prs.map((p) => [p.id, p.state, p.reviews.length, p.headSha, p.mergeCommit]),
    state.ciRuns.map((r) => [r.id, r.status]),
    state.repo.branches.map((b) => b.name),
  ]);
}

function sigFiles(state, lang) {
  const st = state.repo.status;
  return lang + '|' + [state.repo.head.branch, state.repo.head.commit, st.modified.join(','), st.added.join(','), st.deleted.join(','), state.repo.branches.length, state.repo.files.length, state.repo.log.length].join('|');
}

function sigRefs(state, lang) {
  return lang + '|' + state.repo.branches.map((b) => b.name).join(',') + '|' + (state.repo.log[0] ? state.repo.log[0].hash : '');
}

function sigRuns(state, lang) {
  return lang + '|' + JSON.stringify([
    state.ciRuns.map((r) => [r.id, r.status, r.stages.map((s) => s.status).join('')]),
    state.messages.length,
  ]);
}

function sigLogs(state, lang) {
  const last = state.audit[state.audit.length - 1];
  return lang + '|' + [state.audit.length, last ? last.seq : 0, state.messages.length].join('|');
}

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
  // Idempotent: one wrapper, rebuilt in place — never accumulate on re-render.
  const existing = document.getElementById('lang-quick-wrap');
  if (existing) existing.remove();
  const sel = h('select', { name: 'lang-quick', 'aria-label': t('foot.language'), style: 'margin-bottom: 6px' });
  for (const l of LANGS) {
    sel.appendChild(h('option', { value: l.code, selected: l.code === getLang() }, l.label));
  }
  sel.addEventListener('change', () => setLang(sel.value));
  const wrap = h('div', { id: 'lang-quick-wrap' }, h('div', { class: 'muted', style: 'margin-bottom: 2px' }, t('foot.language')), sel);
  foot.insertBefore(wrap, foot.firstChild);
}

// View dispatch with per-view signature skipping. Manual navigations
// (hashchange / language change) always render; poll-driven renders only
// when the active view's fingerprint actually changed.
let lastSig = null;

function currentSig() {
  const view = currentView();
  return view.sig ? view.sig(getState(), getLang()) : null;
}

function render() {
  renderNav();
  applyStaticLabels();
  buildLangSwitch();
  const state = getState();
  if (!state) {
    // Boot has not fetched state yet; nav chrome is painted, the view body
    // arrives with the first refresh().
    return;
  }
  const view = currentView();
  const root = clear(document.getElementById('view'));
  try {
    view.render(root, state);
  } catch (e) {
    root.appendChild(h('div', { class: 'panel' },
      h('h2', null, 'View failed to render'),
      h('pre', null, String(e && e.stack || e))));
  }
  lastSig = currentSig();
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

subscribe((s) => {
  const view = currentView();
  if (!s) return;
  const sig = view.sig ? view.sig(s, getLang()) : null;
  if (sig !== null && sig === lastSig) return; // nothing this view displays changed
  render();
});
onLangChange(render);
window.addEventListener('hashchange', () => { lastSig = null; render(); });
i18nInit().then(() => refresh()).then(() => {
  render();
  startPolling(1500);
}).catch((e) => {
  console.error('boot failed', e);
  render();
});
