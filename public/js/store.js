import { get } from './api.js';
import { t } from './i18n.js';

// State store: polls /api/state, notifies view re-render subscribers.
let state = null;
let timer = null;
let connOk = true;
const subs = new Set();

export function getState() {
  return state;
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function notify() {
  for (const fn of subs) {
    try {
      fn(state);
    } catch (e) {
      console.error('subscriber error', e);
    }
  }
}

function setConn(ok) {
  if (ok !== connOk) {
    connOk = ok;
    const el = document.getElementById('conn-status');
    if (el) {
      el.className = `conn ${ok ? 'ok' : 'bad'}`;
      el.textContent = ok ? t('conn.connected') : t('conn.offline');
    }
  }
}

export async function refresh() {
  try {
    const s = await get('/api/state');
    const changed = JSON.stringify(s) !== JSON.stringify(state);
    state = s;
    setConn(true);
    if (changed) notify();
  } catch (e) {
    setConn(false);
  }
}

export function startPolling(intervalMs) {
  stopPolling();
  timer = setInterval(() => {
    if (!document.hidden) refresh();
  }, intervalMs || 1500);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

export function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}
