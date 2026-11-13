import { useSyncExternalStore } from 'react';
import { getLocale, normalizeLanguagePreference, resolveLocale, setLocale, subscribeLocale, t } from '../shared/i18n.mjs';
import type { LanguagePreference, Locale } from '../shared/i18n.mjs';
export { t, translate, getLocale } from '../shared/i18n.mjs';
export type { LanguagePreference, Locale } from '../shared/i18n.mjs';

const STORAGE_KEY = 'mosaic.language';
const bootstrap = window.mosaicNative?.bootstrap?.app;
const storedLanguage = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
let preference = normalizeLanguagePreference(bootstrap?.preferences?.language ?? storedLanguage());
let systemLocale = bootstrap?.systemLocale || navigator.language || 'en';
const listeners = new Set<() => void>();
const updateDocumentLanguage = () => {
  document.documentElement.lang = getLocale();
  document.title = t('Mosaic — 여러 화면, 하나의 흐름');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('여러 화면, 하나의 흐름. Mosaic 멀티 브라우저 UI 미리보기.'));
};
const notify = () => { updateDocumentLanguage(); for (const listener of listeners) listener(); };
setLocale(resolveLocale(preference, systemLocale));
updateDocumentLanguage();
subscribeLocale(notify);
window.addEventListener('languagechange', () => {
  if (!window.mosaicNative) systemLocale = navigator.language;
  setLocale(resolveLocale(preference, systemLocale));
});
export const getLanguagePreference = () => preference;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => preference + ':' + getLocale();
export function useLocale(): Locale { useSyncExternalStore(subscribe, snapshot); return getLocale(); }
export async function changeLanguage(next: LanguagePreference) {
  if (!['system', 'ko', 'en'].includes(next)) throw new TypeError('Invalid language');
  if (window.mosaicNative) {
    const info = await window.mosaicNative.setAppPreferences({ language: next });
    systemLocale = info.systemLocale || systemLocale;
  } else {
    // A failed preview save must not pretend that the selection will survive a restart.
    localStorage.setItem(STORAGE_KEY, next);
  }
  preference = next;
  setLocale(resolveLocale(preference, systemLocale));
  notify();
}
