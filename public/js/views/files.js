import { h, clear, chip, fmtTime, short, openModal, toast, t } from '../ui.js';
import { get, post, put, del } from '../api.js';
import { act, confirmModal } from '../actions.js';

// Files & Repo view: tree + editor + branch bar + merge panel + commit log.
export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('files.title')));
  root.appendChild(h('p', { class: 'sub' }, t('files.sub', { branch: state.repo.head.branch, sha: short(state.repo.head.commit) })));

  const grid = h('div', { class: 'grid-files' });
  root.appendChild(grid);
  buildBranchBar(root, state);
  const treeBox = h('div', { class: 'panel', style: 'padding: 8px' });
  const editorBox = h('div');
  grid.appendChild(treeBox);
  grid.appendChild(editorBox);
  buildTree(treeBox, state, editorBox);
  buildEditor(editorBox, state, null);
  buildMergePanel(root, state);
  buildLog(root, state);
}

function buildBranchBar(root, state) {
  const bar = h('div', { class: 'row' });
  const branchSel = h('select', { name: 'repo-branch', 'aria-label': t('files.mergeBranch') });
  for (const b of state.repo.branches) {
    branchSel.appendChild(h('option', { value: b.name, selected: b.current }, `${b.current ? '● ' : ''}${b.name}`));
  }
  bar.appendChild(h('span', { class: 'muted' }, `${t('files.branchLabel')}:`), branchSel);
  branchSel.addEventListener('change', async () => {
    await act(post('/api/repo/checkout', { ref: branchSel.value }), `→ ${branchSel.value}`);
  });
  const newName = h('input', { type: 'text', name: 'new-branch-name', style: 'width: 160px' });
  newName.setAttribute('placeholder', t('files.newBranchPh'));
  bar.appendChild(newName);
  bar.appendChild(h('button', {
    onclick: async () => {
      if (!newName.value.trim()) return;
      await act(post('/api/repo/branch', { name: newName.value.trim() }), t('files.toastCreated', { path: newName.value.trim() }));
    },
  }, t('files.createBranch')));
  bar.appendChild(h('button', {
    onclick: async () => {
      if (!newName.value.trim()) return;
      await act(post('/api/repo/checkout', { ref: newName.value.trim() }), `→ ${newName.value.trim()}`);
    },
  }, t('files.createCheckout')));
  root.appendChild(bar);
}

function buildTree(box, state, editorBox) {
  while (box.firstChild) box.removeChild(box.firstChild);
  box.appendChild(h('h2', { style: 'margin-top: 0' }, t('files.wsFiles')));
  const st = state.repo.status;
  const changedSet = new Set([...st.modified, ...st.added, ...st.deleted]);
  const files = state.repo.files;
  if (!files.length) {
    box.appendChild(h('p', { class: 'muted' }, t('files.emptyRepo')));
    return;
  }
  const openFile = { path: null };
  const list = h('div');
  for (const p of files) {
    const item = h('div', { class: 'treeitem', tabindex: '0', role: 'button' },
      h('span', { class: 'path mono' }, p),
      changedSet.has(p) ? chip(st.added.includes(p) ? 'success' : st.deleted.includes(p) ? 'failure' : 'warning') : null);
    item.addEventListener('click', () => {
      [...list.children].forEach((c) => c.classList.remove('sel'));
      item.classList.add('sel');
      openFile.path = p;
      buildEditor(editorBox, state, p);
    });
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') item.dispatchEvent(new Event('click')); });
    list.appendChild(item);
  }
  box.appendChild(list);
  const newBar = h('div', { class: 'row mt' });
  const newFile = h('input', { type: 'text', name: 'new-file-path', style: 'width: 200px' });
  newFile.setAttribute('placeholder', t('files.newFilePh'));
  newBar.appendChild(newFile);
  newBar.appendChild(h('button', {
    onclick: async () => {
      const p = newFile.value.trim();
      if (!p) return;
      await act(put('/api/repo/file', { path: p, content: '' }), t('files.toastCreated', { path: p }));
    },
  }, t('files.newFile')));
  newBar.appendChild(h('button', {
    onclick: () => {
      if (!openFile.path) { noFileSelected(); return; }
      const from = openFile.path;
      openModal(t('files.renameTitle'), (body, close) => {
        const to = h('input', { type: 'text', name: 'rename-to', style: 'width: 100%' });
        to.setAttribute('placeholder', t('files.renamePh'));
        to.value = from;
        body.appendChild(h('label', null, `${t('files.renameLabel')}: ${from}`));
        body.appendChild(to);
        body.appendChild(h('div', { class: 'row mt' },
          h('button', {
            class: 'primary',
            onclick: async () => {
              if (!to.value.trim()) return;
              close();
              await act(post('/api/repo/rename', { from, to: to.value.trim() }), t('files.toastRenamed'));
            },
          }, t('common.confirm')),
          h('button', { onclick: close }, t('common.cancel'))));
      });
    },
  }, t('files.rename')));
  newBar.appendChild(h('button', {
    class: 'danger',
    onclick: () => {
      if (!openFile.path) { noFileSelected(); return; }
      const p = openFile.path;
      confirmModal(t('files.deleteTitle'), t('files.deleteText', { path: p }), async () => {
        await act(del(`/api/repo/file?path=${encodeURIComponent(p)}`), t('files.toastDeleted'));
      });
    },
  }, t('files.deleteFile')));
  box.appendChild(newBar);
  return openFile;

  function noFileSelected() {
    toast(t('files.selectFirst'), 'error');
  }
}

function buildEditor(box, state, path) {
  while (box.firstChild) box.removeChild(box.firstChild);
  const status = state.repo.status;
  box.appendChild(h('h2', { style: 'margin-top: 0' }, path || t('files.editor')));
  if (!path) {
    box.appendChild(h('p', { class: 'muted' }, t('files.selectFile')));
    buildCommitBox(box, state);
    return;
  }
  const area = h('textarea', { name: 'file-editor', rows: '18', style: 'width: 100%', 'aria-label': path });
  const meta = h('div', { class: 'row', style: 'margin: 6px 0' });
  get(`/api/repo/file?path=${encodeURIComponent(path)}`).then((d) => {
    area.value = d.content;
  }).catch((e) => {
    area.value = '';
    meta.appendChild(h('span', { style: 'color: var(--red)' }, e.message));
  });
  if (status.modified.includes(path)) meta.appendChild(chip('warning'));
  if (status.added.includes(path)) meta.appendChild(chip('success'));
  if (status.deleted.includes(path)) meta.appendChild(chip('failure'));
  box.appendChild(meta);
  box.appendChild(area);
  box.appendChild(h('div', { class: 'row mt' },
    h('button', {
      class: 'primary',
      onclick: async () => {
        await act(put('/api/repo/file', { path, content: area.value }), t('files.toastWritten', { path }));
      },
    }, t('files.saveWt')),
    h('button', {
      onclick: async () => {
        const d = await get(`/api/repo/diff?path=${encodeURIComponent(path)}`);
        openModal(`${t('files.diffHead')}: ${path}`, (b) => {
          const pre = h('pre');
          pre.textContent = d.patch || t('files.noChanges');
          b.appendChild(pre);
        });
      },
    }, t('files.diffHead'))));

  buildCommitBox(box, state);
}

function buildCommitBox(box, state) {
  box.appendChild(h('h2', null, t('files.commit')));
  const msg = h('input', { type: 'text', name: 'commit-message', style: 'flex:1; min-width: 240px', maxlength: '512' });
  msg.setAttribute('placeholder', t('files.commitPh'));
  box.appendChild(h('form', {
    class: 'row',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!msg.value.trim()) return;
      await act(post('/api/repo/commit', { message: msg.value.trim() }), t('files.toastCommitted'));
      msg.value = '';
    },
  }, msg, h('button', { class: 'primary', type: 'submit' }, t('files.commitOn', { branch: state.repo.head.branch }))));
  const st = state.repo.status;
  if (st.merging) {
    box.appendChild(h('p', { style: 'color: var(--yellow)' }, t('files.merging', { source: st.merging.source })));
  }
}

function buildMergePanel(root, state) {
  const st = state.repo.status;
  const panel = h('div', { class: 'panel' });
  panel.appendChild(h('h2', { style: 'margin-top: 0' }, t('files.merge')));
  if (st.merging) {
    panel.appendChild(h('p', null, `${t('files.merging', { source: st.merging.source })} ${t('files.conflicts')}`));
    for (const p of st.merging.conflicts) {
      panel.appendChild(h('div', { class: 'row', style: 'margin: 4px 0' },
        h('code', { style: 'flex:1' }, p),
        h('button', { class: 'small', onclick: async () => { await act(post('/api/repo/merge/resolve', { path: p, choice: 'ours' }), `${p}: ours`); } }, t('files.takeOurs')),
        h('button', { class: 'small', onclick: async () => { await act(post('/api/repo/merge/resolve', { path: p, choice: 'theirs' }), `${p}: theirs`); } }, t('files.takeTheirs'))));
    }
    panel.appendChild(h('div', { class: 'row mt' },
      h('button', { class: 'primary', onclick: async () => { await act(post('/api/repo/merge/complete', { message: `Merge ${st.merging.source}` }), t('files.toastCommitted')); } }, t('files.completeMerge')),
      h('button', { class: 'danger', onclick: async () => { await act(post('/api/repo/merge/abort'), t('files.toastMergeStatus', { status: 'abort' })); } }, t('files.abortMerge'))));
  } else {
    const src = h('select', { name: 'merge-source', 'aria-label': t('files.mergeBranch') });
    for (const b of state.repo.branches) {
      if (!b.current) src.appendChild(h('option', { value: b.name }, b.name));
    }
    panel.appendChild(h('div', { class: 'row' },
      h('span', { class: 'muted' }, t('files.mergeBranch')), src,
      h('span', { class: 'muted' }, t('files.mergeInto')), h('code', null, state.repo.head.branch),
      h('button', {
        class: 'primary',
        onclick: async () => {
          try {
            const res = await post('/api/repo/merge', { source: src.value });
            if (res.status === 'conflict') toast(t('files.toastMergeConflict', { paths: res.conflicts.join(', ') }), 'error');
            else toast(t('files.toastMergeStatus', { status: res.status }), 'ok');
          } catch (e) {
            toast(`${e.code}: ${e.message}`, 'error');
          }
        },
      }, t('files.mergeBtn'))));
    panel.appendChild(h('p', { class: 'muted', style: 'margin-bottom: 0' }, t('files.mergeHint')));
  }
  root.appendChild(panel);
}

function buildLog(root, state) {
  const panel = h('div', { class: 'panel' });
  panel.appendChild(h('h2', { style: 'margin-top: 0' }, t('files.commitLog')));
  panel.appendChild(h('table', null,
    h('thead', null, h('tr', null, [
      t('files.colHash'), t('files.colMessage'), t('files.colAuthor'), t('files.colWhen'), t('files.colParents'),
    ].map((x) => h('th', null, x)))),
    h('tbody', null, state.repo.log.map((c) => h('tr', null,
      h('td', { class: 'mono' }, short(c.hash)),
      h('td', null, c.message),
      h('td', { class: 'muted' }, c.author),
      h('td', { class: 'muted' }, fmtTime(c.timestamp)),
      h('td', { class: 'muted mono' }, c.parents.map(short).join(' ')))))));
  root.appendChild(panel);
}
