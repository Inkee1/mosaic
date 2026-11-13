import { t } from './i18n.mjs';
import { normalizeUrl } from './validation.mjs';

export const MAX_LIVE_PANES = 128;
const timestamp = () => new Date().toISOString();
const freshId = () => globalThis.crypto.randomUUID();
const emptyWorkspace = () => ({
  id: 'empty-workspace',
  name: t("열린 세트 없음"),
  columns: 2,
  rows: 2,
  panes: [],
});

export function migrateSets(value) {
  if (Array.isArray(value.openSetIds) && Object.hasOwn(value, 'activeSetId')) return value;
  const state = structuredClone(value);
  const sets = state.savedSets;
  const remember = (workspace, replace) => {
    const matches = sets.filter(
      (set) => set.workspace.id === workspace.id && set.workspace.name === workspace.name,
    );
    const match = matches.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0];
    if (match) {
      if (replace) match.workspace = structuredClone(workspace);
      return match.id;
    }
    const id = freshId();
    sets.push({ id, savedAt: timestamp(), workspace: structuredClone(workspace) });
    return id;
  };
  if (state.previousWorkspace) remember(state.previousWorkspace, true);
  const activeSetId = remember(state.workspace, true);
  const paneIds = new Set();
  // Keep active pane IDs stable so an existing workspace keeps its UI identity.
  for (const set of [...sets].sort(
    (a, b) => Number(b.id === activeSetId) - Number(a.id === activeSetId),
  )) {
    set.workspace.id = set.id;
    for (const pane of set.workspace.panes) {
      if (paneIds.has(pane.id)) pane.id = freshId();
      paneIds.add(pane.id);
    }
  }
  delete state.previousWorkspace;
  return {
    ...state,
    activeSetId,
    openSetIds: [activeSetId],
    workspace: sets.find((s) => s.id === activeSetId).workspace,
  };
}

export function syncActiveSet(state) {
  if (!state.activeSetId) return state;
  const index = state.savedSets.findIndex((set) => set.id === state.activeSetId);
  if (index < 0 || state.savedSets[index].workspace === state.workspace) return state;
  const savedSets = [...state.savedSets];
  savedSets[index] = { ...savedSets[index], savedAt: timestamp(), workspace: state.workspace };
  return { ...state, savedSets };
}

export function openWorkspaces(state) {
  return (state.openSetIds || [])
    .map((id) =>
      id === state.activeSetId
        ? state.workspace
        : state.savedSets.find((set) => set.id === id)?.workspace,
    )
    .filter(Boolean);
}

export function livePanes(state) {
  return openWorkspaces(state).flatMap((workspace) => workspace.panes);
}

export function switchSet(value, id) {
  const state = syncActiveSet(value);
  const set = state.savedSets.find((set) => set.id === id);
  if (!set) throw new Error(t("세트를 찾을 수 없어요."));
  const alreadyOpen = state.openSetIds.includes(id);
  if (!alreadyOpen && livePanes(state).length + set.workspace.panes.length > MAX_LIVE_PANES)
    throw new Error(
      t("열린 세트 전체에서 최대 128개 화면을 사용할 수 있어요. 다른 세트를 닫은 뒤 열어 주세요."),
    );
  return {
    ...state,
    activeSetId: id,
    openSetIds: alreadyOpen ? state.openSetIds : [...state.openSetIds, id],
    workspace: set.workspace,
  };
}

export function createSet(value, workspace) {
  const state = syncActiveSet(value);
  if (state.savedSets.length >= 200) throw new Error(t("최대 200개 세트를 저장할 수 있어요."));
  if (livePanes(state).length + workspace.panes.length > MAX_LIVE_PANES)
    throw new Error(t("열린 세트 전체에서 최대 128개 화면을 사용할 수 있어요."));
  let id = workspace.id;
  if (state.savedSets.some((set) => set.id === id)) id = freshId();
  const usedIds = new Set(
    state.savedSets.flatMap((set) => set.workspace.panes.map((pane) => pane.id)),
  );
  const copy = {
    ...workspace,
    id,
    panes: workspace.panes.map((pane) => {
      let paneId = pane.id;
      if (usedIds.has(paneId)) paneId = freshId();
      usedIds.add(paneId);
      return { ...pane, id: paneId };
    }),
  };
  return {
    ...state,
    activeSetId: id,
    openSetIds: [...state.openSetIds, id],
    workspace: copy,
    savedSets: [...state.savedSets, { id, savedAt: timestamp(), workspace: copy }],
  };
}

export function closeSet(value, id) {
  const state = syncActiveSet(value);
  const index = state.openSetIds.indexOf(id);
  if (index < 0) return state;
  const openSetIds = state.openSetIds.filter((openId) => openId !== id);
  if (id !== state.activeSetId) return { ...state, openSetIds };
  const activeSetId = openSetIds[Math.min(index, openSetIds.length - 1)] || null;
  return {
    ...state,
    openSetIds,
    activeSetId,
    workspace: activeSetId
      ? state.savedSets.find((set) => set.id === activeSetId).workspace
      : emptyWorkspace(),
  };
}

export function patchSetPane(value, id, profileId, patch) {
  const state = syncActiveSet(value);
  let changed = false;
  const savedSets = state.savedSets.map((set) => {
    if (!state.openSetIds.includes(set.id)) return set;
    const pane = set.workspace.panes.find((pane) => pane.id === id && pane.profileId === profileId);
    if (!pane || Object.entries(patch).every(([key, value]) => pane[key] === value)) return set;
    changed = true;
    return {
      ...set,
      savedAt: timestamp(),
      workspace: {
        ...set.workspace,
        panes: set.workspace.panes.map((p) => (p === pane ? { ...p, ...patch } : p)),
      },
    };
  });
  if (!changed) return state;
  return {
    ...state,
    savedSets,
    workspace: savedSets.find((set) => set.id === state.activeSetId)?.workspace || state.workspace,
  };
}

export function mergeNativeLocations(state, panes) {
  if (!state) return state;
  let next = state;
  for (const pane of panes) {
    let url;
    try {
      url = normalizeUrl(pane.url);
    } catch {
      continue;
    }
    next = patchSetPane(next, pane.paneId, pane.profileId, {
      url,
      ...(pane.title ? { title: pane.title.slice(0, 120) } : {}),
      ...(['mosaic', 'chrome'].includes(pane.browser) ? { browser: pane.browser } : {}),
    });
  }
  return next;
}
