// i18n: loads the dictionary once at boot, exposes t()/setLang()/onChange().
// The language is a pure client preference (localStorage) with browser
// language detection as the default.

const STORAGE_KEY = 'forge.lang';
export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
];

let dict = null;
let lang = null;
const listeners = new Set();
const warned = new Set();

export async function init() {
  if (dict) return;
  const res = await fetch('/js/i18n/messages.json');
  if (!res.ok) {
    console.error('i18n: failed to load messages.json', res.status);
    dict = {};
    lang = 'en';
    return;
  }
  dict = await res.json();
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && dict[saved]) {
    lang = saved;
  } else if (navigator.language && dict[navigator.language]) {
    lang = navigator.language;
  } else if (navigator.language && navigator.language.startsWith('zh') && dict['zh-CN']) {
    lang = 'zh-CN';
  } else {
    lang = 'en';
  }
  document.documentElement.lang = lang;
}

export function t(key, params) {
  if (!dict || !lang) return interpolate(key, params);
  const table = dict[lang];
  const value = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
  if (value === null) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`i18n: missing key "${key}" for "${lang}"`);
    }
    return interpolate(key, params);
  }
  return interpolate(value, params);
}

export function has(key) {
  if (!dict || !lang) return false;
  return Object.prototype.hasOwnProperty.call(dict[lang], key);
}

export function getLang() {
  return lang || 'en';
}

export function setLang(code) {
  if (!dict || !dict[code]) return false;
  if (code === lang) return true;
  lang = code;
  localStorage.setItem(STORAGE_KEY, code);
  document.documentElement.lang = code;
  for (const fn of listeners) {
    try {
      fn(code);
    } catch (e) {
      console.error('i18n listener error', e);
    }
  }
  return true;
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function interpolate(template, params) {
  if (!params) return template;
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (m, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
  ));
}
