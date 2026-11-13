import { t } from './i18n.mjs';
import { normalizeUrl } from './validation.mjs';

function looksLikeWebAddress(value) {
  if (/\s/.test(value)) return false;
  // A bare email is search text, not an implicit URL with login credentials.
  if (/^[^/@:?#]+@[^/@:?#]+$/.test(value)) return false;
  try {
    const parsed = new URL('https://' + value);
    const hostname = parsed.hostname.replace(/\.$/, '');
    return (
      hostname === 'localhost' ||
      hostname.startsWith('[') ||
      /\.[a-z][a-z\d-]*$/i.test(hostname) ||
      /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/.test(value)
    );
  } catch {
    return false;
  }
}

// Only user-facing address fields accept search terms. Stored URLs and agent
// navigation continue to use strict normalizeUrl validation.
export function resolveAddressInput(input) {
  if (typeof input !== 'string' || !input.trim())
    throw new Error(t("주소나 검색어를 입력해 주세요."));
  const value = input.trim();
  if (value.startsWith('//')) return normalizeUrl('https:' + value);
  // Keep explicit URLs and executable schemes on the strict validation path.
  // Search operators such as site:example.com should still become searches.
  if (
    /^(?:https?:|[a-z][a-z\d+.-]*:\/\/|(?:javascript|data|file|vbscript|about|chrome|chrome-extension):)/i.test(value) ||
    looksLikeWebAddress(value)
  )
    return normalizeUrl(value);

  const search = new URL('https://www.google.com/search');
  search.searchParams.set('q', value);
  return normalizeUrl(search.href);
}
