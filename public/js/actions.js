import { h, toast, openModal, closeModal, chip, fmtFull, kvTable, t } from './ui.js';
import { post } from './api.js';

// Guards every mutating call with a toast on failure.
export async function act(promise, okMsg) {
  try {
    const data = await promise;
    if (okMsg) toast(okMsg, 'ok');
    return data;
  } catch (e) {
    toast(`${e.code || 'ERROR'}: ${e.message}`, 'error');
    throw e;
  }
}

export function confirmModal(title, text, onYes) {
  openModal(title, (body, close) => {
    body.appendChild(h('p', null, text));
    body.appendChild(h('div', { class: 'row mt' },
      h('button', { class: 'danger', onclick: async () => { close(); await onYes(); } }, t('common.confirm')),
      h('button', { onclick: close }, t('common.cancel'))));
  });
}

export function field(labelText, input) {
  return h('div', null, h('label', null, labelText), input);
}

export function select(options, value, attrs) {
  const sel = h('select', attrs);
  for (const opt of options) {
    const o = typeof opt === 'object' ? opt : { value: opt, label: opt };
    sel.appendChild(h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label));
  }
  return sel;
}

export function taskForm(onDone) {
  const titleField = h('input', { type: 'text', name: 'task-title', maxlength: '200' });
  titleField.setAttribute('placeholder', t('actions.titleLabel'));
  const type = select(['plan', 'implement', 'qa', 'review', 'security', 'custom'], 'qa', { name: 'task-type' });
  const deps = h('input', { type: 'text', name: 'task-deps' });
  deps.setAttribute('placeholder', t('actions.depsPh'));
  const spec = h('textarea', { name: 'task-spec', rows: '6' });
  spec.setAttribute('placeholder', t('actions.specPh'));
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      let specObj = null;
      if (spec.value.trim()) {
        try {
          specObj = JSON.parse(spec.value);
        } catch (_) {
          toast(t('actions.toastSpecJson'), 'error');
          return;
        }
      }
      const depsList = deps.value.split(',').map((s) => s.trim()).filter(Boolean);
      await act(post('/api/tasks', { title: titleField.value, type: type.value, dependencies: depsList, spec: specObj }), t('actions.toastTaskCreated'));
      closeModal();
      if (onDone) onDone();
    },
  },
  field(t('actions.titleLabel'), titleField),
  field(t('actions.typeLabel'), type),
  field(t('actions.depsLabel'), deps),
  field(t('actions.specLabel'), spec),
  h('div', { class: 'row mt' }, h('button', { class: 'primary', type: 'submit' }, t('actions.createTask'))));
  return form;
}

export function splitForm(taskId, onDone) {
  const c1 = h('input', { type: 'text', name: 'split-child-1', maxlength: '200' });
  const c2 = h('input', { type: 'text', name: 'split-child-2', maxlength: '200' });
  const t1 = select(['plan', 'implement', 'qa', 'review', 'security', 'custom'], 'qa', { name: 'split-type' });
  return h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!c1.value.trim() || !c2.value.trim()) {
        toast(t('actions.bothRequired'), 'error');
        return;
      }
      await act(post(`/api/tasks/${taskId}/split`, {
        children: [
          { key: 'a', title: c1.value, type: t1.value },
          { key: 'b', title: c2.value, type: t1.value },
        ],
      }), t('actions.toastSplit'));
      closeModal();
      if (onDone) onDone();
    },
  },
  field(t('actions.sub1'), c1),
  field(t('actions.sub2'), c2),
  field(t('actions.subType'), t1),
  h('div', { class: 'row mt' }, h('button', { class: 'primary', type: 'submit' }, t('actions.split'))));
}

export function taskActions(tsk, refreshNow) {
  const acts = h('div', { class: 'acts' });
  const add = (label, fn, cls, disabled) => {
    if (disabled) return;
    acts.appendChild(h('button', { class: `small ${cls || ''}`, onclick: () => fn() }, label));
  };
  const after = (p, msg) => async () => { await act(p, msg); refreshNow(); };
  if (tsk.status === 'ready' || tsk.status === 'blocked') {
    add(t('actions.run'), after(post(`/api/tasks/${tsk.id}/run`), t('actions.toastDispatched', { id: tsk.id })), 'primary');
    add(t('actions.splitBtn'), () => openModal(t('actions.splitTitle', { title: tsk.title }), (body) => body.appendChild(splitForm(tsk.id, refreshNow))));
    add(t('actions.cancel'), () => confirmModal(t('actions.cancelTitle'), t('actions.cancelText', { title: tsk.title }), after(post(`/api/tasks/${tsk.id}/cancel`), t('actions.toastCancelled'))), 'danger');
  }
  if (tsk.status === 'running') {
    add(t('actions.pause'), after(post(`/api/tasks/${tsk.id}/pause`), t('actions.toastPaused')));
    add(t('actions.cancel'), () => confirmModal(t('actions.cancelTitle'), t('actions.cancelText', { title: tsk.title }), after(post(`/api/tasks/${tsk.id}/cancel`), t('actions.toastCancelled'))), 'danger');
  }
  if (tsk.status === 'paused') {
    add(t('actions.resume'), after(post(`/api/tasks/${tsk.id}/resume`), t('actions.toastResumed')), 'primary');
    add(t('actions.cancel'), () => confirmModal(t('actions.cancelTitle'), t('actions.cancelText', { title: tsk.title }), after(post(`/api/tasks/${tsk.id}/cancel`), t('actions.toastCancelled'))), 'danger');
  }
  if (tsk.status === 'failed') {
    add(t('actions.retry'), after(post(`/api/tasks/${tsk.id}/retry`), t('actions.toastRetried')), 'primary');
    add(t('actions.editSpec'), () => openModal(t('actions.specFor', { id: tsk.id }), (body) => body.appendChild(specForm(tsk, refreshNow))));
    add(t('actions.cancel'), () => confirmModal(t('actions.cancelTitle'), t('actions.cancelText', { title: tsk.title }), after(post(`/api/tasks/${tsk.id}/cancel`), t('actions.toastCancelled'))), 'danger');
  }
  return acts;
}

export function specForm(tsk, onDone) {
  const area = h('textarea', { name: 'task-spec-edit', rows: '10', style: 'width:100%' });
  area.setAttribute('placeholder', t('actions.workSpecPh'));
  area.value = tsk.spec ? JSON.stringify(tsk.spec, null, 2) : '';
  return h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      let specObj;
      try {
        specObj = JSON.parse(area.value || 'null');
      } catch (_) {
        toast(t('actions.toastSpecJson'), 'error');
        return;
      }
      await act(post(`/api/tasks/${tsk.id}/spec`, { spec: specObj }), t('actions.toastSpecUpdated'));
      closeModal();
      if (onDone) onDone();
    },
  },
  field(t('actions.specLabel'), area),
  h('div', { class: 'row mt' }, h('button', { class: 'primary', type: 'submit' }, t('actions.saveSpec'))));
}

export function taskDetail(tsk) {
  return kvTable([
    ['id', h('code', null, tsk.id)],
    ['title', tsk.title],
    ['type', tsk.type],
    ['status', chip(tsk.status)],
    ['assignee', tsk.assignee || '—'],
    ['dependencies', tsk.dependencies.length ? tsk.dependencies.map((d) => h('code', { style: 'margin-right:6px' }, d)) : '—'],
    ['attempts', String(tsk.attempts)],
    ['created', fmtFull(tsk.createdAt)],
    ['completed', fmtFull(tsk.completedAt)],
    ['result', tsk.result ? h('code', null, JSON.stringify(tsk.result)) : '—'],
    ['last error', tsk.lastError ? h('span', { style: 'color: var(--red)' }, tsk.lastError) : '—'],
    ['spec', tsk.spec ? h('code', null, JSON.stringify(tsk.spec)) : '—'],
  ]);
}
