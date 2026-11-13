import appEnglish from './locales/app-en.mjs';
import uiEnglish from './locales/ui-en.mjs';
import aiEnglish from './locales/ai-en.mjs';
import desktopEnglish from './locales/desktop-en.mjs';

export const messages = Object.freeze({ en: Object.freeze(Object.assign(Object.create(null), appEnglish, uiEnglish, aiEnglish, desktopEnglish)) });
export const normalizeLanguagePreference = value => ['system', 'ko', 'en'].includes(value) ? value : 'system';
export function resolveLocale(preference, systemLocale = 'en') {
  const selected = normalizeLanguagePreference(preference);
  return selected === 'system' ? (/^ko(?:[-_]|$)/i.test(String(systemLocale)) ? 'ko' : 'en') : selected;
}
export function translate(locale, message, values = {}) {
  const text = locale === 'en' && Object.hasOwn(messages.en, message) ? messages.en[message] : message;
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

let currentLocale = 'ko';
const listeners = new Set();
export const getLocale = () => currentLocale;
export function setLocale(locale) {
  const next = locale === 'en' ? 'en' : 'ko';
  if (next === currentLocale) return;
  currentLocale = next;
  for (const listener of listeners) listener();
}
export function subscribeLocale(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export const t = (message, values) => translate(currentLocale, message, values);
