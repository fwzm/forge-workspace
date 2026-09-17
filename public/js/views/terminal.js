import { h, clear, t } from '../ui.js';
import { post } from '../api.js';

export function render(root, state) {
  clear(root);
  root.appendChild(h('h1', null, t('term.title')));
  root.appendChild(h('p', { class: 'sub' }, t('term.sub')));

  const out = h('div', { class: 'term-out', 'aria-live': 'polite' });
  const input = h('input', { type: 'text', 'aria-label': t('term.title'), autocomplete: 'off', spellcheck: 'false' });
  input.setAttribute('placeholder', t('term.placeholder'));
  const box = h('div', { class: 'term' }, out, h('div', { class: 'term-in' }, h('span', { class: 'p' }, 'forge ❯'), input));
  root.appendChild(box);

  const history = [];
  let histIdx = -1;

  const print = (lines, cls) => {
    for (const line of lines) {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = line;
      out.appendChild(div);
    }
    out.scrollTop = out.scrollHeight;
  };

  print([t('term.welcome', { name: state.name }), t('term.helpHint')], 'p');

  async function run() {
    const cmd = input.value.trim();
    if (!cmd) return;
    history.unshift(cmd);
    histIdx = -1;
    print([`forge ❯ ${cmd}`], 'p');
    input.value = '';
    try {
      const res = await post('/api/terminal', { command: cmd });
      print(res.lines.length ? res.lines : [t('term.noOutput')]);
    } catch (e) {
      print([`error: ${e.message} [${e.code}]`], '');
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histIdx < history.length - 1) {
        histIdx += 1;
        input.value = history[histIdx];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx > 0) {
        histIdx -= 1;
        input.value = history[histIdx];
      } else {
        histIdx = -1;
        input.value = '';
      }
    }
  });
}
