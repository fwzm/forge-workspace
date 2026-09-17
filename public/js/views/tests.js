import { h, clear, chip, fmtFull, short, openModal, label, t } from '../ui.js';

// Test results: CI run history with per-stage drill-down, plus the latest QA
// agent messages (artifacts carry suite outcomes).
export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('tests.title')));
  root.appendChild(h('p', { class: 'sub' }, t('tests.sub')));

  root.appendChild(h('h2', null, t('tests.ciRuns')));
  if (!state.ciRuns.length) {
    root.appendChild(h('p', { class: 'muted' }, t('tests.noRuns')));
  }
  for (const run of [...state.ciRuns].reverse().slice(0, 12)) {
    const panel = h('div', { class: 'panel', style: 'padding: 10px' });
    panel.appendChild(h('div', { class: 'row' },
      h('strong', { class: 'mono' }, run.id),
      chip(run.status),
      h('span', { class: 'muted mono' }, `${run.ref}@${short(run.sha)}`),
      run.prId ? h('span', { class: 'muted' }, t('tests.prTag', { n: run.prId.slice(-6) })) : null,
      h('span', { class: 'muted' }, fmtFull(run.createdAt)),
      h('span', { class: 'muted' }, t('tests.byRun', { who: run.triggeredBy }))));
    const stages = h('div', { class: 'pill-row', style: 'margin-top: 6px' });
    for (const s of run.stages) {
      const stageBtn = h('button', {
        class: 'small',
        style: 'border-color: ' + (s.status === 'success' ? 'var(--green)' : s.status === 'failure' ? 'var(--red)' : 'var(--border)'),
      }, `${s.name} ${s.status === 'success' ? '✓' : s.status === 'failure' ? '✗' : label(s.status)}`);
      stageBtn.addEventListener('click', () => stageDetail(run, s));
      stages.appendChild(stageBtn);
    }
    panel.appendChild(stages);
    root.appendChild(panel);
  }

  root.appendChild(h('h2', null, t('tests.qaRuns')));
  const qaMsgs = state.messages.filter((m) => {
    const agent = state.agents.find((a) => a.id === m.agent);
    return agent && agent.type === 'qa' && m.status !== 'running';
  }).reverse().slice(0, 8);
  if (!qaMsgs.length) root.appendChild(h('p', { class: 'muted' }, t('tests.noQa')));
  for (const m of qaMsgs) {
    const panel = h('div', { class: 'panel', style: 'padding: 10px' });
    panel.appendChild(h('div', { class: 'row' },
      chip(m.status),
      h('span', { class: 'muted mono' }, m.task ? `task ${m.task}` : t('tests.taskNone')),
      h('span', { class: 'muted' }, fmtFull(m.timestamp))));
    const out = m.output || {};
    if (out.suites) {
      for (const s of out.suites) {
        panel.appendChild(h('p', { style: 'margin: 6px 0 2px' }, h('strong', null, s.suite), ` — ${t('tests.passedFailed', { p: s.passed, f: s.failed, total: s.total, ms: s.durationMs })}`));
        panel.appendChild(h('table', null,
          h('thead', null, h('tr', null, [
            t('prs.colFile'), t('tests.colCase'), t('dash.colStatus'), t('kanban.colError'),
          ].map((x) => h('th', null, x)))),
          h('tbody', null, s.suites.flatMap((su) => su.cases.map((c) => h('tr', null,
            h('td', { class: 'mono muted' }, su.file),
            h('td', null, c.name),
            h('td', null, chip(c.status === 'passed' ? 'success' : 'failure')),
            h('td', { style: 'color: var(--red)' }, c.error || '')))))));
      }
    } else if (out.error) {
      panel.appendChild(h('pre', { style: 'color: var(--red)' }, out.error));
    }
    root.appendChild(panel);
  }
}

function stageDetail(run, stage) {
  const pre = h('pre');
  pre.textContent = JSON.stringify(stage.output, null, 2);
  openModal(t('tests.stageTitle', { id: run.id, stage: stage.name, status: label(stage.status) }), (b) => {
    b.appendChild(h('p', { class: 'muted' }, t('tests.stageTimes', { s: new Date(stage.startedAt).toLocaleString(), e: new Date(stage.finishedAt).toLocaleString() })));
    b.appendChild(pre);
  });
}
