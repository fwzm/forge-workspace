import { h, clear, chip, fmtTime, fmtFull, t } from '../ui.js';
import { post } from '../api.js';
import { act, confirmModal } from '../actions.js';

export function render(root, state) {
  clear(root);
  const tasks = state.tasks || [];
  const byStatus = {};
  for (const tsk of tasks) byStatus[tsk.status] = (byStatus[tsk.status] || 0) + 1;

  root.appendChild(h('h1', null, t('dash.title')));
  root.appendChild(h('p', { class: 'sub' }, t('dash.sub', { name: state.name })));

  const cards = h('div', { class: 'cards' });
  const card = (num, lbl) => cards.appendChild(h('div', { class: 'card' }, h('div', { class: 'num' }, String(num)), h('div', { class: 'lbl' }, lbl)));
  card(tasks.length, t('dash.tasksTotal'));
  card(byStatus.ready || 0, t('dash.ready'));
  card(byStatus.running || 0, t('dash.running'));
  card(byStatus.failed || 0, t('dash.failed'));
  card(byStatus.completed || 0, t('dash.completed'));
  card(state.repo.commits, t('dash.commits'));
  card(state.prs.filter((p) => p.state === 'merged').length, t('dash.prsMerged'));
  card(state.ciRuns.filter((r) => r.status === 'success').length, t('dash.ciGreen'));
  root.appendChild(cards);

  // Agents
  const agentsPanel = h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, t('dash.agents')));
  agentsPanel.appendChild(h('table', null,
    h('thead', null, h('tr', null, [t('dash.colAgent'), t('dash.colType'), t('dash.colStatus'), t('dash.colDone'), t('dash.colFailed'), t('dash.colLastActive')].map((x) => h('th', null, x)))),
    h('tbody', null, state.agents.map((a) => h('tr', null,
      h('td', null, a.name, h('div', { class: 'muted', style: 'font-size:11px' }, a.id)),
      h('td', null, a.type),
      h('td', null, chip(a.status === 'working' ? 'working' : 'idle')),
      h('td', null, String(a.tasksDone)),
      h('td', null, String(a.tasksFailed)),
      h('td', null, a.lastTaskAt ? fmtTime(a.lastTaskAt) : '—'))))));
  root.appendChild(agentsPanel);

  // Demo control
  root.appendChild(buildDemoPanel(state));

  // Issues
  const issuesPanel = h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, t('dash.issues')));
  const titleIn = h('input', { type: 'text', name: 'issue-title', maxlength: '200', style: 'flex:1; min-width: 220px' });
  titleIn.setAttribute('placeholder', t('dash.issueTitlePh'));
  const bodyIn = h('input', { type: 'text', name: 'issue-body', style: 'flex:2; min-width: 260px' });
  bodyIn.setAttribute('placeholder', t('dash.issueBodyPh'));
  issuesPanel.appendChild(h('form', {
    class: 'row',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!titleIn.value.trim()) return;
      await act(post('/api/issues', { title: titleIn.value, body: bodyIn.value }), t('dash.toastIssueCreated'));
      titleIn.value = '';
      bodyIn.value = '';
    },
  }, titleIn, bodyIn, h('button', { class: 'primary', type: 'submit' }, t('dash.reportIssue'))));
  if (!state.issues.length) issuesPanel.appendChild(h('p', { class: 'muted' }, t('dash.noIssues')));
  for (const i of [...state.issues].reverse()) {
    issuesPanel.appendChild(h('div', { class: 'step' },
      h('span', { class: 'n' }, '›'),
      h('span', { style: 'flex:1' }, i.title, h('div', { class: 'muted', style: 'font-size:11px' }, `${i.id} · ${fmtFull(i.createdAt)}`)),
      chip(i.state),
      h('button', {
        class: 'small', onclick: async () => {
          const next = i.state === 'open' ? 'in_progress' : i.state === 'in_progress' ? 'resolved' : 'closed';
          await act(post(`/api/issues/${i.id}/state`, { state: next }), `→ ${next}`);
        },
      }, t('dash.advance')),
      h('button', {
        class: 'small danger', onclick: () => confirmModal(t('dash.closeIssueTitle'), t('dash.closeIssueText', { title: i.title }), async () => {
          await act(post(`/api/issues/${i.id}/state`, { state: 'closed' }), t('dash.toastIssueClosed'));
        }),
      }, t('dash.closeIssue'))));
  }
  root.appendChild(issuesPanel);

  // Recent activity
  const actPanel = h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, t('dash.activity')));
  actPanel.appendChild(h('table', null,
    h('thead', null, h('tr', null, [t('common.time'), t('common.actor'), t('common.action'), t('common.target')].map((x) => h('th', null, x)))),
    h('tbody', null, [...state.audit].reverse().slice(0, 12).map((e) => h('tr', null,
      h('td', { class: 'muted' }, fmtTime(e.timestamp)),
      h('td', null, e.actor.id),
      h('td', { class: 'mono' }, e.action),
      h('td', { class: 'muted' }, e.target ? `${e.target.type}:${String(e.target.id).slice(0, 24)}` : '—'))))));
  root.appendChild(actPanel);
}

function buildDemoPanel(state) {
  const panel = h('div', { class: 'panel' });
  panel.appendChild(h('h2', { style: 'margin-top:0' }, t('dash.demo')));
  panel.appendChild(h('p', { class: 'muted', style: 'margin-top:2px' }, t('dash.demoNote')));

  const demo = state.demo || { steps: [], stepIndex: 0 };
  const hasScenario = demo.scenario && demo.scenario !== 'none';

  const bar = h('div', { class: 'row' });
  bar.appendChild(h('button', {
    class: 'primary',
    onclick: () => confirmModal(t('dash.seedConfirmTitle'), t('dash.seedConfirmText'), async () => {
      await act(post('/api/reset', { seed: true }), t('dash.toastSeeded'));
    }),
  }, t('dash.seed')));
  if (hasScenario) {
    bar.appendChild(h('button', { onclick: async () => { await act(post('/api/demo/next'), t('dash.toastStep')); } }, t('dash.nextStep')));
    bar.appendChild(h('button', { onclick: async () => { await act(post('/api/demo/run-all'), t('dash.toastDemoDone')); } }, t('dash.runAll')));
    bar.appendChild(h('button', { class: 'danger', onclick: async () => { await act(post('/api/demo/reset'), t('dash.toastDemoReset')); } }, t('dash.resetDemo')));
    bar.appendChild(h('span', { class: 'muted' }, t('dash.scenario', { scenario: demo.scenario, n: Math.min(demo.stepIndex + 1, demo.steps.length), m: demo.steps.length })));
  }
  panel.appendChild(bar);

  if (hasScenario) {
    const list = h('div', { class: 'mt' });
    demo.steps.forEach((s, i) => {
      const cls = i === demo.stepIndex ? 'current' : '';
      const mark = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : (i === demo.stepIndex ? '▶' : '·');
      const color = s.status === 'done' ? 'var(--green)' : s.status === 'failed' ? 'var(--red)' : 'var(--muted)';
      const row = h('div', { class: `step ${cls}` },
        h('span', { class: 'n', style: `color:${color}` }, mark),
        h('span', { style: 'flex:1' }, s.name),
        chip(s.status === 'done' ? 'completed' : s.status === 'failed' ? 'failed' : 'pending'));
      if (s.detail && s.status !== 'pending') {
        row.title = JSON.stringify(s.detail).slice(0, 400);
      }
      list.appendChild(row);
    });
    panel.appendChild(list);
    if (demo.lastStep && demo.lastStep.ok === false) {
      panel.appendChild(h('p', { style: 'color: var(--red)' }, t('dash.lastStepFailed', { error: demo.lastStep.error })));
    }
  }
  return panel;
}
