import { h, clear, chip, fmtFull, short, label, t } from '../ui.js';
import { get, post } from '../api.js';
import { act, confirmModal } from '../actions.js';

export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('prs.title')));
  root.appendChild(h('p', { class: 'sub' }, t('prs.sub')));

  const openForm = h('div', { class: 'panel' });
  openForm.appendChild(h('h2', { style: 'margin-top: 0' }, t('prs.openPanel')));
  const title = h('input', { type: 'text', name: 'pr-title', maxlength: '200', style: 'flex: 2; min-width: 220px' });
  title.setAttribute('placeholder', t('prs.titlePh'));
  const src = h('select', { name: 'pr-source', 'aria-label': 'source branch' });
  const tgt = h('select', { name: 'pr-target', 'aria-label': 'target branch' });
  for (const b of state.repo.branches) {
    src.appendChild(h('option', { value: b.name }, b.name));
    tgt.appendChild(h('option', { value: b.name, selected: b.name === 'main' }, b.name));
  }
  openForm.appendChild(h('form', {
    class: 'row',
    onsubmit: async (e) => {
      e.preventDefault();
      await act(post('/api/pr', { title: title.value, sourceBranch: src.value, targetBranch: tgt.value }), t('prs.toastOpened'));
    },
  }, title, src, h('span', { class: 'muted' }, '→'), tgt,
  h('button', { class: 'primary', type: 'submit' }, t('prs.openBtn'))));
  root.appendChild(openForm);

  if (!state.prs.length) {
    root.appendChild(h('p', { class: 'muted' }, t('prs.none')));
  }
  for (const pr of [...state.prs].reverse()) {
    root.appendChild(prPanel(pr, state));
  }
}

function prPanel(pr, state) {
  const panel = h('div', { class: 'panel' });
  const head = h('div', { class: 'row' },
    h('strong', null, pr.title),
    chip(pr.state),
    h('span', { class: 'muted mono' }, pr.id),
    h('span', { class: 'muted mono' }, `${pr.sourceBranch} → ${pr.targetBranch}`),
    h('span', { class: 'muted' }, t('prs.headLabel', { sha: short(pr.headSha) })),
    h('span', { class: 'muted' }, fmtFull(pr.createdAt)));
  panel.appendChild(head);
  if (pr.description) panel.appendChild(h('p', { class: 'muted', style: 'margin-bottom: 4px' }, pr.description));

  const isOpen = ['open', 'changes_requested', 'approved'].includes(pr.state);

  // Reviews timeline
  if (pr.reviews.length) {
    panel.appendChild(h('h2', null, t('prs.reviews')));
    for (const r of pr.reviews) {
      panel.appendChild(h('div', { class: 'step' },
        h('span', { class: 'n' }, r.type === 'approve' ? '👍' : r.type === 'request_changes' ? '✗' : '💬'),
        h('span', { style: 'flex: 1' },
          h('strong', null, r.reviewer), ' ', chip(r.type), ' ',
          h('span', { class: 'muted' }, `${t('prs.headLabel', { sha: short(r.headSha) })} · ${fmtFull(r.timestamp)}`),
          r.comment ? h('div', { class: 'muted' }, r.comment) : null,
          r.findings && r.findings.length ? findingsTable(r.findings) : null)));
    }
  }

  // Checks
  if (isOpen) {
    const runs = state.ciRuns.filter((r) => r.sha === pr.headSha);
    const latest = runs.length ? runs[runs.length - 1] : null;
    const checks = h('div', null, h('h2', null, t('prs.checks')));
    if (!latest) {
      checks.appendChild(h('p', { class: 'muted' }, t('prs.noCi')));
    } else {
      checks.appendChild(h('div', { class: 'pill-row' },
        h('span', { class: 'muted mono' }, latest.id), chip(latest.status),
        latest.stages.map((s) => h('span', { class: `chip ${s.status}` }, `${s.name} ${s.status === 'success' ? '✓' : s.status === 'failure' ? '✗' : '…'}`))));
    }
    panel.appendChild(checks);
  }

  // Actions
  if (isOpen) {
    const comment = h('input', { type: 'text', name: 'review-comment', style: 'flex: 1; min-width: 200px' });
    comment.setAttribute('placeholder', t('prs.commentPh'));
    const bar = h('div', { class: 'row mt' });
    bar.appendChild(comment);
    bar.appendChild(h('button', {
      onclick: async () => { await act(post(`/api/pr/${pr.id}/review`, { type: 'approve', comment: comment.value }), t('prs.toastApproved')); },
    }, t('prs.approve')));
    bar.appendChild(h('button', {
      onclick: async () => { await act(post(`/api/pr/${pr.id}/review`, { type: 'request_changes', comment: comment.value || label('request_changes') }), t('prs.toastRC')); },
    }, t('prs.requestChanges')));
    bar.appendChild(h('button', {
      onclick: async () => { await act(post(`/api/pr/${pr.id}/review`, { type: 'comment', comment: comment.value || 'comment' }), t('prs.toastComment')); },
    }, t('prs.commentBtn')));
    bar.appendChild(h('button', {
      class: 'primary',
      onclick: () => confirmModal(t('prs.mergeConfirmTitle'), t('prs.mergeConfirmText', { src: pr.sourceBranch, tgt: pr.targetBranch }), async () => {
        await act(post(`/api/pr/${pr.id}/merge`), t('prs.toastMerged'));
      }),
    }, t('prs.merge')));
    bar.appendChild(h('button', {
      class: 'danger',
      onclick: () => confirmModal(t('prs.closeConfirmTitle'), t('prs.closeConfirmText', { id: pr.id }), async () => {
        await act(post(`/api/pr/${pr.id}/close`), t('prs.toastClosed'));
      }),
    }, t('prs.close')));
    panel.appendChild(bar);
  } else if (pr.state === 'merged') {
    panel.appendChild(h('p', { class: 'muted', style: 'margin: 6px 0 0' },
      t('prs.mergedAt', { time: fmtFull(pr.mergedAt), sha: short(pr.mergeCommit) })));
  } else {
    panel.appendChild(h('p', { class: 'muted', style: 'margin: 6px 0 0' }, t('prs.closedAt', { time: fmtFull(pr.closedAt) })));
  }

  // Diff (collapsed by default)
  const diffBox = h('div', { class: 'hidden' });
  const diffBtn = h('button', { class: 'small', style: 'margin-top: 8px' }, t('prs.showDiff'));
  diffBtn.addEventListener('click', async () => {
    if (diffBox.classList.contains('hidden')) {
      while (diffBox.firstChild) diffBox.removeChild(diffBox.firstChild);
      try {
        const d = await get(`/api/pr/${pr.id}/diff`);
        for (const f of d.files) {
          const pre = h('pre', { style: 'margin: 6px 0' });
          const title = document.createElement('div');
          title.textContent = f.path + ' (' + (f.kind === 'added' ? t('diff.kindAdded') : f.kind === 'deleted' ? t('diff.kindDeleted') : t('diff.kindModified')) + ')';
          title.className = 'diff-meta';
          pre.appendChild(title);
          for (const line of (f.patch || '').split('\n')) {
            const span = document.createElement('span');
            span.textContent = line + '\n';
            if (line.startsWith('+') && !line.startsWith('+++')) span.className = 'diff-add';
            else if (line.startsWith('-') && !line.startsWith('---')) span.className = 'diff-del';
            else if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) span.className = 'diff-meta';
            pre.appendChild(span);
          }
          diffBox.appendChild(pre);
        }
        if (!d.files.length) diffBox.appendChild(h('p', { class: 'muted' }, t('prs.noDiffFiles')));
      } catch (e) {
        diffBox.appendChild(h('p', { style: 'color: var(--red)' }, e.message));
      }
      diffBox.classList.remove('hidden');
      diffBtn.textContent = t('prs.hideDiff');
    } else {
      diffBox.classList.add('hidden');
      diffBtn.textContent = t('prs.showDiff');
    }
  });
  panel.appendChild(diffBtn);
  panel.appendChild(diffBox);
  return panel;
}

function findingsTable(findings) {
  return h('table', { style: 'margin: 6px 0' },
    h('thead', null, h('tr', null, [
      t('prs.colSeverity'), t('prs.colFile'), t('prs.colLine'), t('prs.colCategory'), t('prs.colMessage'), t('prs.colSuggestion'),
    ].map((x) => h('th', null, x)))),
    h('tbody', null, findings.map((f) => h('tr', null,
      h('td', null, chip(f.severity)),
      h('td', { class: 'mono muted' }, f.file),
      h('td', null, String(f.line)),
      h('td', { class: 'muted' }, f.category),
      h('td', null, f.message),
      h('td', { class: 'muted' }, f.suggestion || '')))));
}
