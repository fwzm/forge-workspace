import { h, clear, chip, openModal, label, t } from '../ui.js';

export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('graph.title')));
  root.appendChild(h('p', { class: 'sub' }, t('graph.sub')));
  const wrap = h('div', { class: 'graph-wrap' });
  root.appendChild(wrap);
  drawDag(wrap, state);
}

export function drawDag(container, state) {
  while (container.firstChild) container.removeChild(container.firstChild);
  const tasks = state.tasks;
  if (!tasks.length) {
    container.appendChild(h('p', { class: 'muted', style: 'padding: 20px' }, t('graph.empty')));
    return;
  }
  const byId = new Map(tasks.map((tsk) => [tsk.id, tsk]));
  // level = longest path from any root
  const level = new Map();
  const visiting = new Set();
  function lvl(id) {
    if (level.has(id)) return level.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const tsk = byId.get(id);
    const l = tsk.dependencies.length ? Math.max(...tsk.dependencies.map((d) => (byId.has(d) ? lvl(d) + 1 : 0))) : 0;
    visiting.delete(id);
    level.set(id, l);
    return l;
  }
  tasks.forEach((tsk) => lvl(tsk.id));
  const maxLevel = Math.max(0, ...[...level.values()]);
  const cols = [];
  for (let i = 0; i <= maxLevel; i++) cols.push(tasks.filter((tsk) => level.get(tsk.id) === i));

  const NODE_W = 190;
  const NODE_H = 54;
  const GAP_X = 40;
  const GAP_Y = 18;
  const colHeight = Math.max(...cols.map((c) => c.length));
  const width = (maxLevel + 1) * (NODE_W + GAP_X) + GAP_X;
  const height = (colHeight + 1) * (NODE_H + GAP_Y) + GAP_Y;
  const pos = new Map();
  cols.forEach((c, ci) => {
    c.forEach((tsk, ri) => {
      pos.set(tsk.id, {
        x: GAP_X + ci * (NODE_W + GAP_X),
        y: GAP_Y + ri * (NODE_H + GAP_Y),
      });
    });
  });

  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('width', String(width));
  svgEl.setAttribute('height', String(height));
  svgEl.setAttribute('role', 'img');
  svgEl.setAttribute('aria-label', t('graph.title'));
  const defs = document.createElementNS(NS, 'defs');
  const marker = document.createElementNS(NS, 'marker');
  marker.setAttribute('id', 'arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto-start-reverse');
  const mpath = document.createElementNS(NS, 'path');
  mpath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  mpath.setAttribute('fill', '#2d333d');
  marker.appendChild(mpath);
  defs.appendChild(marker);
  svgEl.appendChild(defs);

  for (const tsk of tasks) {
    for (const dep of tsk.dependencies) {
      const p1 = pos.get(dep);
      const p2 = pos.get(tsk.id);
      if (!p1 || !p2) continue;
      const edge = document.createElementNS(NS, 'path');
      const x1 = p1.x + NODE_W;
      const y1 = p1.y + NODE_H / 2;
      const x2 = p2.x;
      const y2 = p2.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      edge.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
      edge.setAttribute('class', 'gedge');
      svgEl.appendChild(edge);
    }
  }
  for (const tsk of tasks) {
    const p = pos.get(tsk.id);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `gnode ${tsk.status}`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${tsk.title}: ${label(tsk.status)}`);
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(p.x));
    rect.setAttribute('y', String(p.y));
    rect.setAttribute('width', String(NODE_W));
    rect.setAttribute('height', String(NODE_H));
    rect.setAttribute('rx', '7');
    g.appendChild(rect);
    const nodeLabel = document.createElementNS(NS, 'text');
    nodeLabel.setAttribute('x', String(p.x + 10));
    nodeLabel.setAttribute('y', String(p.y + 21));
    nodeLabel.textContent = tsk.title.length > 26 ? tsk.title.slice(0, 25) + '…' : tsk.title;
    g.appendChild(nodeLabel);
    const sub = document.createElementNS(NS, 'text');
    sub.setAttribute('x', String(p.x + 10));
    sub.setAttribute('y', String(p.y + 39));
    sub.setAttribute('fill', '#8b949e');
    sub.textContent = `${tsk.type} · ${label(tsk.status)}${tsk.assignee ? ' · ' + tsk.assignee.replace('agent-', '') : ''}`;
    g.appendChild(sub);
    g.addEventListener('click', () => {
      openModal(tsk.title, (b) => {
        b.appendChild(h('div', null, chip(tsk.status), ' ', chip(tsk.type)));
        b.appendChild(taskDetailMini(tsk));
      });
    });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') g.dispatchEvent(new Event('click'));
    });
    svgEl.appendChild(g);
  }
  container.appendChild(svgEl);
}

function taskDetailMini(tsk) {
  const rows = [
    ['id', tsk.id],
    ['type', tsk.type],
    ['status', label(tsk.status)],
    ['assignee', tsk.assignee || '—'],
    ['dependencies', tsk.dependencies.join(', ') || '—'],
    ['attempts', String(tsk.attempts)],
    ['error', tsk.lastError || '—'],
  ];
  return h('table', null, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('th', { scope: 'row' }, k), h('td', null, v)))));
}
