// Only the release configuration can supply this external link.
export function normalizeSupportUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value) || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
