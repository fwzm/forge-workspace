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

// Coalesced notification: at most one subscriber pass per animation frame,
// and never more often than MIN_NOTIFY_GAP ms. During agent runs state
// changes constantly; without coalescing every change would rebuild the
// active view and make navigation feel sluggish.
const MIN_NOTIFY_GAP = 700;
let lastNotify = 0;
let trailingTimer = null;

function doNotify() {
  for (const fn of subs) {
    try {
      fn(state);
    } catch (e) {
      console.error('subscriber error', e);
    }
  }
}

function notify() {
  const now = Date.now();
  const gap = now - lastNotify;
  if (gap >= MIN_NOTIFY_GAP) {
    lastNotify = now;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => doNotify());
    } else {
      doNotify();
    }
    return;
  }
  if (trailingTimer) return;
  trailingTimer = setTimeout(() => {
    trailingTimer = null;
    lastNotify = Date.now();
    doNotify();
  }, MIN_NOTIFY_GAP - gap);
  if (trailingTimer.unref) trailingTimer.unref();
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
