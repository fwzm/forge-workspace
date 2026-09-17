import { h, clear, t } from '../ui.js';
import { get } from '../api.js';

// Metrics are computed by the server from live runtime state (no synthetic data).
export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('metrics.title')));
  root.appendChild(h('p', { class: 'sub' }, t('metrics.sub')));

  const wrap = h('div', { class: 'panel' }, h('p', { class: 'muted', style: 'margin: 0' }, t('metrics.loading')));
  root.appendChild(wrap);
  get('/api/metrics').then((m) => {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(h('h2', { style: 'margin-top: 0' }, t('metrics.overview')));
    const cards = h('div', { class: 'cards' });
    const card = (num, lbl) => cards.appendChild(h('div', { class: 'card' }, h('div', { class: 'num' }, String(num)), h('div', { class: 'lbl' }, lbl)));
    card(m.tasks.total, t('metrics.tasksTotal'));
    card(m.ci.runs, t('metrics.ciRuns'));
    card(m.ci.success, t('metrics.ciGreen'));
    card(m.ci.failure, t('metrics.ciRed'));
    card(m.prs.total, t('metrics.prs'));
    card(m.prs.avgMergeCycleMs === null ? '—' : Math.round(m.prs.avgMergeCycleMs / 1000) + 's', t('metrics.avgCycle'));
    card(m.repo.commits, t('metrics.commits'));
    card(m.audit.entries, t('metrics.auditEntries'));
    wrap.appendChild(cards);

    wrap.appendChild(h('h2', null, t('metrics.byStatus')));
    wrap.appendChild(barChart(m.tasks.byStatus, statusColor));

    wrap.appendChild(h('h2', null, t('metrics.byType')));
    wrap.appendChild(barChart(m.tasks.byType, () => 'var(--accent)'));

    wrap.appendChild(h('h2', null, t('metrics.stageOutcomes')));
    const stageData = {};
    const stageNotes = {};
    for (const [name, s] of Object.entries(m.ci.stages)) {
      stageData[name] = s.success;
      stageNotes[name] = t('metrics.greenNote', { s: s.success, t: s.total });
    }
    wrap.appendChild(barChart(stageData, () => 'var(--green)', stageNotes));

    wrap.appendChild(h('h2', null, t('metrics.agentProd')));
    const agentData = {};
    const agentNotes = {};
    for (const a of m.agents) {
      agentData[a.type] = a.tasksDone;
      agentNotes[a.type] = t('metrics.agentNote', { d: a.tasksDone, f: a.tasksFailed });
    }
    wrap.appendChild(barChart(agentData, () => 'var(--purple)', agentNotes));

    wrap.appendChild(h('h2', null, t('metrics.commitsChart')));
    wrap.appendChild(barChart(m.commitsByMinute, () => 'var(--yellow)', null, true));

    wrap.appendChild(h('h2', null, t('metrics.avgDuration')));
    wrap.appendChild(barChart(m.tasks.avgDurationByTypeMs, () => 'var(--accent-2)', null, false, (v) => Math.round(v) + 'ms'));
  }).catch((e) => {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(h('p', { style: 'color: var(--red)' }, t('metrics.loadFail', { msg: e.message })));
  });
}

function statusColor(status) {
  const map = { completed: 'var(--green)', failed: 'var(--red)', running: 'var(--yellow)', ready: 'var(--accent-2)', blocked: 'var(--gray)', paused: 'var(--purple)', cancelled: 'var(--gray)' };
  return map[status] || 'var(--accent)';
}

// Simple SVG bar chart rendered from real data.
function barChart(data, colorFn, notes, rotateLabels, fmtVal) {
  const entries = Object.entries(data || {});
  const box = h('div', { style: 'overflow-x: auto' });
  if (!entries.length) {
    box.appendChild(h('p', { class: 'muted' }, t('metrics.noData')));
    return box;
  }
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const barW = 46;
  const chartH = 140;
  const width = entries.length * (barW + 18) + 20;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(chartH + 46));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('metrics.title'));
  entries.forEach(([k, v], i) => {
    const bh = Math.max(2, (v / max) * (chartH - 24));
    const x = 14 + i * (barW + 18);
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(chartH - bh));
    rect.setAttribute('width', String(barW));
    rect.setAttribute('height', String(bh));
    rect.setAttribute('rx', '4');
    rect.setAttribute('fill', colorFn(k));
    rect.setAttribute('opacity', '0.85');
    svg.appendChild(rect);
    const val = document.createElementNS(NS, 'text');
    val.setAttribute('x', String(x + barW / 2));
    val.setAttribute('y', String(chartH - bh - 6));
    val.setAttribute('text-anchor', 'middle');
    val.setAttribute('fill', '#e6edf3');
    val.setAttribute('font-size', '11');
    val.textContent = fmtVal ? fmtVal(v) : String(v);
    svg.appendChild(val);
    const chartLabel = document.createElementNS(NS, 'text');
    chartLabel.setAttribute('x', String(x + barW / 2));
    chartLabel.setAttribute('y', String(chartH + 16));
    chartLabel.setAttribute('text-anchor', 'end');
    chartLabel.setAttribute('fill', '#8b949e');
    chartLabel.setAttribute('font-size', '11');
    chartLabel.setAttribute('transform', `rotate(${rotateLabels ? -40 : 0} ${x + barW / 2} ${chartH + 16})`);
    chartLabel.textContent = k.length > 12 ? k.slice(0, 11) + '…' : k;
    svg.appendChild(chartLabel);
    if (notes && notes[k]) {
      const note = document.createElementNS(NS, 'text');
      note.setAttribute('x', String(x + barW / 2));
      note.setAttribute('y', String(chartH + 34));
      note.setAttribute('text-anchor', 'middle');
      note.setAttribute('fill', '#6e7681');
      note.setAttribute('font-size', '10');
      note.textContent = notes[k];
      svg.appendChild(note);
    }
  });
  box.appendChild(svg);
  return box;
}
