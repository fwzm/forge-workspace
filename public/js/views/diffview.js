import { h, clear, t } from '../ui.js';
import { get } from '../api.js';

export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('diff.title')));
  root.appendChild(h('p', { class: 'sub' }, t('diff.sub')));

  const refs = [
    ...state.repo.branches.map((b) => ({ value: b.name, label: t('diff.branchOpt', { name: b.name }) })),
    { value: 'HEAD', label: 'HEAD' },
    { value: 'HEAD~1', label: 'HEAD~1' },
    ...state.repo.log.map((c) => ({ value: c.hash, label: `commit: ${c.hash.slice(0, 10)} ${c.message.slice(0, 30)}` })),
    { value: '__WORKTREE__', label: t('diff.worktreeOpt') },
  ];

  const left = h('select', { name: 'diff-left', style: 'min-width: 280px', 'aria-label': 'left ref' });
  const right = h('select', { name: 'diff-right', style: 'min-width: 280px', 'aria-label': 'right ref' });
  for (const r of refs) {
    left.appendChild(h('option', { value: r.value }, r.label));
    right.appendChild(h('option', { value: r.value }, r.label));
  }
  left.value = 'HEAD~1';
  right.value = 'HEAD';
  const out = h('div');

  async function load() {
    while (out.firstChild) out.removeChild(out.firstChild);
    const lv = left.value;
    const rv = right.value;
    if (lv === '__WORKTREE__' && rv === '__WORKTREE__') {
      out.appendChild(h('p', { class: 'muted' }, t('diff.worktreeBoth')));
      return;
    }
    let data;
    if (lv === '__WORKTREE__' || rv === '__WORKTREE__') {
      const paths = state.repo.files;
      const files = [];
      for (const p of paths) {
        const d = await get(`/api/repo/diff?path=${encodeURIComponent(p)}`);
        if (d.patch) files.push({ path: p, kind: d.patch.startsWith('---') ? 'modified' : 'equal', patch: d.patch });
      }
      data = { files: files.filter((f) => f.kind !== 'equal') };
    } else {
      data = await get(`/api/repo/diff-refs?from=${encodeURIComponent(lv)}&to=${encodeURIComponent(rv)}`);
    }
    if (!data.files.length) {
      out.appendChild(h('p', { class: 'muted' }, t('diff.noDiff')));
      return;
    }
    for (const f of data.files) {
      const kindLabel = f.kind === 'added' ? t('diff.kindAdded') : f.kind === 'deleted' ? t('diff.kindDeleted') : t('diff.kindModified');
      const panel = h('div', { class: 'panel', style: 'padding: 8px' });
      panel.appendChild(h('div', { class: 'row' },
        h('strong', { class: 'mono' }, f.path),
        h('span', { class: `chip ${f.kind === 'added' ? 'success' : f.kind === 'deleted' ? 'failed' : 'warning'}` }, kindLabel)));
      const pre = h('pre', { style: 'margin: 6px 0 0' });
      for (const line of (f.patch || '').split('\n')) {
        const span = document.createElement('span');
        span.textContent = line + '\n';
        if (line.startsWith('+') && !line.startsWith('+++')) span.className = 'diff-add';
        else if (line.startsWith('-') && !line.startsWith('---')) span.className = 'diff-del';
        else if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) span.className = 'diff-meta';
        pre.appendChild(span);
      }
      panel.appendChild(pre);
      out.appendChild(panel);
    }
  }

  left.addEventListener('change', load);
  right.addEventListener('change', load);
  root.appendChild(h('div', { class: 'row' }, left, h('span', { class: 'muted' }, '→'), right,
    h('button', { onclick: () => { const tmp = left.value; left.value = right.value; right.value = tmp; load(); } }, t('diff.swap')),
    h('button', { class: 'primary', onclick: load }, t('diff.refresh'))));
  root.appendChild(out);
  load();
}
