import { h, clear, chip, openModal, fmtTime, t } from '../ui.js';
import { act, taskForm, taskActions, taskDetail } from '../actions.js';

const COLUMNS = ['blocked', 'ready', 'running', 'paused', 'completed', 'failed', 'cancelled'];

export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('kanban.title')));
  root.appendChild(h('p', { class: 'sub' }, t('kanban.sub')));

  const bar = h('div', { class: 'row' });
  bar.appendChild(h('button', {
    class: 'primary',
    onclick: () => openModal(t('actions.createTaskTitle'), (body) => body.appendChild(taskForm(() => {}))),
  }, t('kanban.newTask')));
  const typeFilter = h('select', { name: 'kanban-type-filter', onchange: () => renderBoard(state, boardWrap, typeFilter.value) },
    h('option', { value: '' }, t('kanban.allTypes')),
    ...['plan', 'implement', 'qa', 'review', 'security', 'custom'].map((ty) => h('option', { value: ty }, ty)));
  bar.appendChild(h('span', { class: 'muted' }, `${t('dash.colType')}:`), typeFilter);
  bar.appendChild(h('span', { class: 'muted' }, t('kanban.autoSched', { state: state.config.autoScheduler ? t('kanban.on') : t('kanban.off') })));
  root.appendChild(bar);

  const boardWrap = h('div', { class: 'kanban mt' });
  root.appendChild(boardWrap);
  renderBoard(state, boardWrap, typeFilter.value);

  root.appendChild(h('h2', null, t('kanban.table')));
  const tbl = h('table', null,
    h('thead', null, h('tr', null, [
      t('kanban.colId'), t('kanban.colTitle'), t('kanban.colType'), t('kanban.colStatus'),
      t('kanban.colAssignee'), t('kanban.colDeps'), t('kanban.colStarted'), t('kanban.colError'),
    ].map((x) => h('th', null, x)))),
    h('tbody', null, state.tasks.map((tsk) => h('tr', {
      style: 'cursor: pointer',
      onclick: () => openModal(tsk.title, (b) => { b.appendChild(taskDetail(tsk)); b.appendChild(h('div', { class: 'mt' }, taskActions(tsk, () => {}))); }),
    },
      h('td', { class: 'mono' }, tsk.id),
      h('td', null, tsk.title),
      h('td', null, tsk.type),
      h('td', null, chip(tsk.status)),
      h('td', { class: 'muted' }, tsk.assignee || t('kanban.unassigned')),
      h('td', { class: 'muted' }, String(tsk.dependencies.length)),
      h('td', { class: 'muted' }, tsk.startedAt ? fmtTime(tsk.startedAt) : '—'),
      h('td', { style: 'color: var(--red); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, tsk.lastError || '')))));
  root.appendChild(tbl);
}

function renderBoard(state, boardWrap, typeFilter) {
  while (boardWrap.firstChild) boardWrap.removeChild(boardWrap.firstChild);
  for (const col of COLUMNS) {
    const tasks = state.tasks.filter((tsk) => tsk.status === col && (!typeFilter || tsk.type === typeFilter));
    const colEl = h('div', { class: 'col' },
      h('h3', null, chip(col), h('span', null, String(tasks.length))));
    for (const tsk of tasks) colEl.appendChild(taskCard(tsk));
    boardWrap.appendChild(colEl);
  }
}

function taskCard(tsk) {
  const cardEl = h('div', { class: 'tcard', tabindex: '0', role: 'button', 'aria-label': tsk.title });
  cardEl.appendChild(h('div', { class: 't' }, tsk.title));
  const meta = h('div', { class: 'm' }, chip(tsk.type), h('span', null, tsk.assignee || t('kanban.unassigned')));
  if (tsk.dependencies.length) meta.appendChild(h('span', null, t('kanban.depsN', { n: tsk.dependencies.length })));
  if (tsk.attempts > 1) meta.appendChild(h('span', null, t('kanban.attemptN', { n: tsk.attempts })));
  cardEl.appendChild(meta);
  if (tsk.lastError) cardEl.appendChild(h('div', { class: 'err' }, tsk.lastError));
  cardEl.appendChild(taskActions(tsk, () => {}));
  cardEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      openModal(tsk.title, (b) => { b.appendChild(taskDetail(tsk)); b.appendChild(h('div', { class: 'mt' }, taskActions(tsk, () => {}))); });
    }
  });
  return cardEl;
}
