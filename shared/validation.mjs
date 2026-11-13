import { t } from './i18n.mjs';
const sampleKinds = {
  'research.mosaic.demo': 'research',
  'docs.mosaic.demo': 'document',
  'analytics.mosaic.demo': 'analytics',
  'chat.mosaic.demo': 'chat',
};
export function normalizeUrl(input) {
  if (typeof input !== 'string') throw new Error(t("주소를 입력해 주세요."));
  const value = input.trim();
  if (!value) throw new Error(t("주소를 입력해 주세요."));
  if (/\s/.test(value)) throw new Error(t("주소에는 공백을 넣을 수 없어요."));
  const hostWithPort = /^(?:localhost|(?:[a-z\d-]+\.)+[a-z\d-]+):\d+(?:[/?#]|$)/i.test(value);
  const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value);
  const candidate =
    /^[a-z][a-z\d+.-]*:/i.test(value) && !hostWithPort
      ? value
      : (localHost ? 'http://' : 'https://') + value;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(t("올바른 웹 주소를 입력해 주세요."));
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  )
    throw new Error(t("http 또는 https 웹 주소를 입력해 주세요."));
  if (parsed.href.length > 2048)
    throw new Error(t("변환된 주소는 2048자 이하여야 해요. 더 짧은 주소를 입력해 주세요."));
  return parsed.href;
}
export function validState(value) {
  try {
    if (!value || typeof value !== 'object') return false;
    const v = value;
    if (
      v.version !== 1 ||
      !['light', 'dark'].includes(v.theme) ||
      !Array.isArray(v.profiles) ||
      !v.profiles.length ||
      v.profiles.length > 100 ||
      !Array.isArray(v.savedSets) ||
      v.savedSets.length > (Array.isArray(v.openSetIds) ? 202 : 200)
    )
      return false;
    const string = (s, limit = 2048) => typeof s === 'string' && s.length > 0 && s.length <= limit;
    const id = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
    if (
      !v.profiles.every(
        (p) =>
          p &&
          id(p.id) &&
          string(p.name, 40) &&
          typeof p.note === 'string' &&
          p.note.length <= 80 &&
          /^#[0-9a-f]{6}$/i.test(p.color) &&
          (p.googleEmail === undefined ||
            (typeof p.googleEmail === 'string' &&
              p.googleEmail.length <= 254 &&
              (p.googleEmail === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.googleEmail)))),
      )
    )
      return false;
    const profiles = new Set(v.profiles.map((p) => p.id));
    if (profiles.size !== v.profiles.length) return false;
    const workspace = (w) =>
      w &&
      id(w.id) &&
      string(w.name, 60) &&
      Number.isInteger(w.columns) &&
      w.columns >= 1 &&
      w.columns <= 4 &&
      Number.isInteger(w.rows) &&
      w.rows >= 1 &&
      w.rows <= 4 &&
      Array.isArray(w.panes) &&
      w.panes.length <= 32 &&
      new Set(w.panes.map((p) => p?.id)).size === w.panes.length &&
      w.panes.every(
        (p) =>
          p &&
          id(p.id) &&
          string(p.title, 120) &&
          profiles.has(p.profileId) &&
          typeof p.addressOpen === 'boolean' &&
          (p.browser === undefined || ['mosaic', 'chrome'].includes(p.browser)) &&
          ['research', 'document', 'analytics', 'chat', 'external'].includes(p.kind) &&
          string(p.url) &&
          normalizeUrl(p.url) === p.url &&
          (p.kind === 'external' || sampleKinds[new URL(p.url).hostname] === p.kind),
      );
    const baseValid =
      !!workspace(v.workspace) &&
      (!v.previousWorkspace || !!workspace(v.previousWorkspace)) &&
      new Set(v.savedSets.map((s) => s?.id)).size === v.savedSets.length &&
      v.savedSets.every(
        (s) =>
          s &&
          id(s.id) &&
          string(s.savedAt) &&
          Number.isFinite(Date.parse(s.savedAt)) &&
          workspace(s.workspace),
      );
    if (!baseValid) return false;
    if (!Object.hasOwn(v, 'activeSetId') && !Object.hasOwn(v, 'openSetIds')) return true;
    if (!Array.isArray(v.openSetIds) || new Set(v.openSetIds).size !== v.openSetIds.length)
      return false;
    const byId = new Map(v.savedSets.map((set) => [set.id, set]));
    if (v.openSetIds.some((openId) => !byId.has(openId))) return false;
    if (v.savedSets.some((set) => set.workspace.id !== set.id)) return false;
    const paneIds = v.savedSets.flatMap((set) => set.workspace.panes.map((pane) => pane.id));
    if (new Set(paneIds).size !== paneIds.length) return false;
    if (
      v.openSetIds.reduce((sum, openId) => sum + byId.get(openId).workspace.panes.length, 0) > 128
    )
      return false;
    if (v.activeSetId === null) return v.openSetIds.length === 0 && v.workspace.panes.length === 0;
    return (
      v.openSetIds.includes(v.activeSetId) &&
      JSON.stringify(v.workspace) === JSON.stringify(byId.get(v.activeSetId).workspace)
    );
  } catch {
    return false;
  }
}

export function validPaneDescriptors(panes, profiles) {
  if (
    !Array.isArray(panes) ||
    panes.length > 128 ||
    new Set(panes.map((pane) => pane?.id)).size !== panes.length
  )
    return false;
  for (let offset = 0; offset < Math.max(1, panes.length); offset += 32) {
    if (
      !validState({
        version: 1,
        theme: 'light',
        profiles,
        savedSets: [],
        workspace: {
          id: 'sync',
          name: 'sync',
          columns: 1,
          rows: 1,
          panes: panes.slice(offset, offset + 32),
        },
      })
    )
      return false;
  }
  return true;
}
