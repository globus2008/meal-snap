// Tiny i18n: UI strings live in locales/<lang>.json.
// Markup uses data-i18n (text), data-i18n-html (trusted HTML from our own locale files),
// data-i18n-placeholder, data-i18n-aria (aria-label + title).

export const LANGS = { en: 'English', cs: 'Čeština' };
const STORE_KEY = 'ms.lang';

let lang = 'en';
let dict = {};

export function getLang() {
  return lang;
}

export function initialLang() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && LANGS[saved]) return saved;
  } catch { /* storage unavailable */ }
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('cs') || nav.startsWith('sk') ? 'cs' : 'en';
}

export async function setLang(next) {
  lang = LANGS[next] ? next : 'en';
  try { localStorage.setItem(STORE_KEY, lang); } catch { /* ignore */ }
  const res = await fetch(`locales/${lang}.json`);
  dict = await res.json();
  document.documentElement.lang = lang;
  applyI18n();
}

export function t(key, vars) {
  let s = dict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const s = t(el.dataset.i18nAria);
    el.setAttribute('aria-label', s);
    el.title = s;
  });
  const title = t('app.title');
  if (title !== 'app.title' && !document.body.dataset.page) document.title = title;
}
