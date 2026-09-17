import { h, clear, t } from '../ui.js';
import { get, post, put } from '../api.js';
import { act, confirmModal } from '../actions.js';
import { LANGS, getLang, setLang } from '../i18n.js';

export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('settings.title')));
  root.appendChild(h('p', { class: 'sub' }, t('settings.sub')));

  buildLanguage(root);
  buildConfig(root, state);
  buildPermissions(root, state);
  buildDataOps(root, state);
}

function buildLanguage(root) {
  const panel = h('div', { class: 'panel' }, h('h2', { style: 'margin-top: 0' }, t('settings.language')));
  const sel = h('select', { name: 'ui-language' });
  for (const l of LANGS) {
    sel.appendChild(h('option', { value: l.code, selected: l.code === getLang() }, l.label));
  }
  sel.addEventListener('change', () => {
    setLang(sel.value);
  });
  panel.appendChild(h('div', { class: 'row' }, sel,
    h('span', { class: 'muted' }, '·')));
  root.appendChild(panel);
}

function buildConfig(root, state) {
  const cfg = state.config;
  const panel = h('div', { class: 'panel' }, h('h2', { style: 'margin-top: 0' }, t('settings.config')));
  const name = h('input', { type: 'text', name: 'ws-name', maxlength: '100', value: cfg.name });
  const maxLen = h('input', { type: 'number', name: 'lint-max-line-length', min: '40', max: '1000', style: 'width: 110px', value: String(cfg.lintMaxLineLength) });
  const threshold = h('select', { name: 'security-threshold' }, ...['critical', 'high', 'medium', 'low'].map((th) => h('option', { value: th, selected: th === cfg.securityThreshold }, th)));
  const auto = h('input', { type: 'checkbox', name: 'auto-scheduler', checked: cfg.autoScheduler });
  const enforce = h('input', { type: 'checkbox', name: 'enforce-permissions', checked: cfg.enforcePermissions });
  const checks = h('div', { class: 'pill-row' });
  for (const c of ['lint', 'unit', 'integration', 'security', 'build']) {
    const cb = h('input', { type: 'checkbox', name: `check-${c}`, checked: cfg.requiredChecks.includes(c), dataset: { check: c } });
    checks.appendChild(h('label', { class: 'row', style: 'margin: 0; gap: 4px; text-transform: none; font-size: 13px; color: var(--text)' }, cb, c));
  }
  panel.appendChild(h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const requiredChecks = [...checks.querySelectorAll('input:checked')].map((i) => i.dataset.check);
      await act(put('/api/config', {
        name: name.value,
        lintMaxLineLength: Number(maxLen.value),
        securityThreshold: threshold.value,
        autoScheduler: auto.checked,
        enforcePermissions: enforce.checked,
        requiredChecks,
      }), t('settings.toastSaved'));
    },
  },
  h('label', null, t('settings.wsName')), name,
  h('label', null, t('settings.lintLen')), maxLen,
  h('label', null, t('settings.secThreshold')), threshold,
  h('label', { class: 'row', style: 'margin-top: 10px; gap: 6px; color: var(--text); font-size: 13px' }, auto, t('settings.autoSched')),
  h('label', { class: 'row', style: 'gap: 6px; color: var(--text); font-size: 13px' }, enforce, t('settings.enforce')),
  h('label', { style: 'margin-top: 10px' }, t('settings.requiredChecks')), checks,
  h('div', { class: 'row mt' }, h('button', { class: 'primary', type: 'submit' }, t('settings.save')))));
  root.appendChild(panel);
}

async function buildPermissions(root, state) {
  const panel = h('div', { class: 'panel' }, h('h2', { style: 'margin-top: 0' }, t('settings.permissions')));
  root.appendChild(panel);
  try {
    const perms = await get('/api/permissions');
    const tbl = h('table', { style: 'font-size: 11px' });
    tbl.appendChild(h('thead', null, h('tr', null, [h('th', null, t('common.action')), ...perms.roles.map((r) => h('th', null, r))])));
    const tbody = h('tbody');
    for (const action of perms.actions) {
      const tr = h('tr', null, h('th', { scope: 'row', class: 'mono' }, action));
      for (const role of perms.roles) {
        tr.appendChild(h('td', null, perms.matrix[role][action] ? '✓' : '·'));
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    panel.appendChild(h('p', { class: 'muted' }, t('settings.enforceState', { state: perms.enforce ? 'ON' : 'OFF' })));
    panel.appendChild(tbl);
  } catch (e) {
    panel.appendChild(h('p', { style: 'color: var(--red)' }, t('settings.matrixFail', { msg: e.message })));
  }
}

function buildDataOps(root, state) {
  const panel = h('div', { class: 'panel' }, h('h2', { style: 'margin-top: 0' }, t('settings.data')));
  panel.appendChild(h('p', { class: 'muted' }, t('settings.dataNote')));

  const row1 = h('div', { class: 'row' });
  row1.appendChild(h('a', { class: 'btn', href: '/api/export', download: 'forge-workspace-export.json' }, t('settings.exportBtn')));

  const fileIn = h('input', { type: 'file', name: 'import-file', accept: 'application/json,.json', style: 'font-size: 12px' });
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files[0];
    if (!file) return;
    const text = await file.text();
    await doImport(text);
  });
  row1.appendChild(h('span', { class: 'muted' }, t('settings.importFile')), fileIn);
  panel.appendChild(row1);

  const paste = h('textarea', { name: 'import-paste', rows: '4', style: 'width: 100%; margin-top: 8px' });
  paste.setAttribute('placeholder', t('settings.importPastePh'));
  panel.appendChild(paste);
  panel.appendChild(h('div', { class: 'row mt' },
    h('button', { onclick: async () => { await doImport(paste.value); } }, t('settings.importPasted')),
    h('button', {
      onclick: () => confirmModal(t('settings.resetTitle'), t('settings.resetText'), async () => {
        await act(post('/api/reset', { seed: false }), t('settings.toastReset'));
      }),
    }, t('settings.resetEmpty')),
    h('button', {
      onclick: () => confirmModal(t('settings.resetSeedTitle'), t('settings.resetSeedText'), async () => {
        await act(post('/api/reset', { seed: true }), t('settings.toastResetSeed'));
      }),
    }, t('settings.resetSeed'))));

  async function doImport(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      act(Promise.reject(Object.assign(new Error(t('settings.invalidJson')), { code: 'FORGE_INVALID_INPUT' })), null);
      return;
    }
    await act(post('/api/import', parsed), t('settings.toastImported'));
  }

  root.appendChild(panel);
  root.appendChild(h('p', { class: 'muted mono', style: 'font-size: 11px' },
    t('settings.stateFile', { n: state.version || 1 })));
}
