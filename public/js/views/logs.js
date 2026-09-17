import { h, clear, chip, fmtTime, fmtFull, jsonPreview, t } from '../ui.js';

export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('logs.title')));
  root.appendChild(h('p', { class: 'sub' }, t('logs.sub')));

  const tabs = h('div', { class: 'row', role: 'tablist' });
  const body = h('div', { class: 'mt' });
  let current = 'audit';

  const auditFilterIn = h('input', { type: 'text', name: 'audit-action-filter', style: 'min-width: 260px' });
  auditFilterIn.setAttribute('placeholder', t('logs.actionPh'));
  const actorFilterIn = h('input', { type: 'text', name: 'audit-actor-filter', style: 'min-width: 160px' });
  actorFilterIn.setAttribute('placeholder', t('logs.actorPh'));

  const auditView = () => {
    while (body.firstChild) body.removeChild(body.firstChild);
    const af = auditFilterIn.value.trim();
    const actor = actorFilterIn.value.trim();
    const entries = state.audit.filter((e) =>
      (!af || e.action.startsWith(af)) && (!actor || e.actor.id.includes(actor)));
    body.appendChild(h('p', { class: 'muted' }, t('logs.entries', { n: entries.length, total: state.audit.length })));
    body.appendChild(h('table', null,
      h('thead', null, h('tr', null, [
        t('logs.colSeq'), t('common.time'), t('common.actor'), t('logs.colRole'), t('common.action'), t('common.target'), t('logs.colDetails'),
      ].map((x) => h('th', null, x)))),
      h('tbody', null, [...entries].reverse().slice(0, 200).map((e) => h('tr', null,
        h('td', { class: 'muted' }, '#' + e.seq),
        h('td', { class: 'muted' }, fmtFull(e.timestamp)),
        h('td', null, e.actor.id),
        h('td', { class: 'muted' }, e.actor.role),
        h('td', { class: 'mono' }, e.action),
        h('td', { class: 'muted' }, e.target ? `${e.target.type}:${String(e.target.id).slice(0, 26)}` : '—'),
        h('td', { class: 'mono', style: 'max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, e.details ? jsonPreview(e.details, 90) : ''))))));
  };

  const msgView = () => {
    while (body.firstChild) body.removeChild(body.firstChild);
    body.appendChild(h('p', { class: 'muted' }, `${t('logs.showingLast', { n: Math.min(60, state.messages.length) })} ${t('logs.protocolNote')}`));
    for (const m of [...state.messages].reverse().slice(0, 60)) {
      const box = h('div', { class: 'panel', style: 'padding: 10px' });
      box.appendChild(h('div', { class: 'row' },
        h('strong', null, m.agent || '—'),
        h('span', { class: 'muted mono' }, m.id),
        chip(m.status || 'pending'),
        h('span', { class: 'muted' }, `${m.task ? 'task: ' + m.task : t('tests.taskNone')}`),
        h('span', { class: 'muted' }, fmtTime(m.timestamp)),
        h('span', { class: 'muted' }, `artifacts: ${m.artifacts.length}`),
        h('span', { class: 'muted' }, `deps: ${m.dependencies.length}`)));
      const pre = h('pre', { class: 'hidden' });
      pre.textContent = JSON.stringify(m, null, 2);
      box.appendChild(h('button', {
        class: 'small', style: 'margin-top: 6px',
        onclick: () => pre.classList.toggle('hidden'),
      }, t('logs.toggleFull')));
      box.appendChild(pre);
      body.appendChild(box);
    }
  };

  const tab = (id, label, fn) => {
    const b = h('button', {
      class: id === current ? 'primary' : '',
      role: 'tab',
      onclick: () => {
        current = id;
        [...tabs.children].forEach((c) => { c.className = ''; });
        b.className = 'primary';
        fn();
      },
    }, label);
    tabs.appendChild(b);
  };
  tab('audit', t('logs.tabAudit'), auditView);
  tab('messages', t('logs.tabMessages'), msgView);
  root.appendChild(tabs);
  root.appendChild(h('div', { class: 'row' }, auditFilterIn, actorFilterIn));
  root.appendChild(body);
  auditView();
}
