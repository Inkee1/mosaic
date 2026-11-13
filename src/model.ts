import { t } from './i18n';
import { normalizeUrl, validState } from '../shared/validation.mjs';
import { migrateSets } from '../shared/workspaces.mjs';
export { normalizeUrl, validState } from '../shared/validation.mjs';
export { resolveAddressInput } from '../shared/address.mjs';
export type PageKind = 'research' | 'document' | 'analytics' | 'chat' | 'external';
export type Profile = {
  id: string;
  name: string;
  note: string;
  color: string;
  googleEmail?: string;
};
export type Pane = {
  id: string;
  title: string;
  url: string;
  profileId: string;
  kind: PageKind;
  addressOpen: boolean;
  browser?: 'mosaic' | 'chrome';
};
export type Workspace = { id: string; name: string; columns: number; rows: number; panes: Pane[] };
export type SavedSet = { id: string; savedAt: string; workspace: Workspace };
export type AppState = {
  version: 1;
  profiles: Profile[];
  workspace: Workspace;
  previousWorkspace?: Workspace;
  activeSetId?: string | null;
  openSetIds?: string[];
  savedSets: SavedSet[];
  theme: 'light' | 'dark';
};
export type RunStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed';
export const STORAGE_KEY = 'mosaic.ui.v1';
export const uid = () => crypto.randomUUID();
export const samples: { kind: PageKind; title: string; url: string; label: string }[] = [
  {
    kind: 'research',
    title: '트렌드 리서치',
    url: 'https://research.mosaic.demo/trends',
    label: '리서치',
  },
  {
    kind: 'document',
    title: '브랜드 캠페인 노트',
    url: 'https://docs.mosaic.demo/campaign',
    label: '문서',
  },
  {
    kind: 'analytics',
    title: '캠페인 대시보드',
    url: 'https://analytics.mosaic.demo/overview',
    label: '대시보드',
  },
  {
    kind: 'chat',
    title: '아이디어 스튜디오',
    url: 'https://chat.mosaic.demo/studio',
    label: 'AI 채팅',
  },
];

export function createInitialState(): AppState {
  const profiles: Profile[] = [
    { id: 'work', name: t("업무용"), note: t("브랜드 · 마케팅"), color: '#447b64' },
    { id: 'personal', name: t("개인용"), note: t("리서치 · 아이디어"), color: '#9a7ab7' },
    { id: 'client', name: t("클라이언트"), note: t("프로젝트 전용"), color: '#c78d4b' },
  ];
  const nativeSamples = [
    {
      kind: 'external' as PageKind,
      title: 'Google',
      url: 'https://www.google.com/',
      label: 'Google',
    },
    {
      kind: 'external' as PageKind,
      title: t("네이버"),
      url: 'https://www.naver.com/',
      label: t("네이버"),
    },
    {
      kind: 'external' as PageKind,
      title: 'ChatGPT',
      url: 'https://chatgpt.com/',
      label: 'ChatGPT',
    },
    { kind: 'external' as PageKind, title: 'Claude', url: 'https://claude.ai/', label: 'Claude' },
  ];
  const panes = (window.mosaicNative ? nativeSamples : samples).map((sample, index) => ({
    ...sample,
    title: t(sample.title), label: t(sample.label),
    id: 'pane-' + index,
    profileId: index === 0 || index === 3 ? 'personal' : 'work',
    addressOpen: false,
  }));
  const workspace: Workspace = {
    id: 'daily',
    name: t("브랜드 워크스페이스"),
    columns: 2,
    rows: 2,
    panes,
  };
  return migrateSets({
    version: 1,
    profiles,
    workspace,
    theme: 'light',
    savedSets: [
      { id: 'brand', savedAt: '2026-11-09T00:00:00Z', workspace: structuredClone(workspace) },
      {
        id: 'research',
        savedAt: '2026-11-09T00:00:00Z',
        workspace: {
          id: 'research-work',
          name: t("리서치 & 아이디어"),
          columns: 2,
          rows: 1,
          panes: structuredClone([panes[0], panes[3]]),
        },
      },
    ],
  });
}

export function sampleForUrl(url: string) {
  return samples.find((sample) => new URL(sample.url).hostname === new URL(url).hostname);
}
export function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function readState(): { state: AppState; warning?: string } {
  try {
    if (window.mosaicNative) {
      const stored = window.mosaicNative.bootstrap.state;
      return {
        state: stored && validState(stored) ? migrateSets(stored) : createInitialState(),
        warning: window.mosaicNative.bootstrap.recovered
          ? t("백업에서 작업 공간을 복구했어요.")
          : undefined,
      };
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { state: createInitialState() };
    const parsed: unknown = JSON.parse(raw);
    if (!validState(parsed)) throw new Error('invalid');
    return { state: migrateSets(parsed) };
  } catch {
    return {
      state: createInitialState(),
      warning: t("저장 데이터를 읽지 못해 기본 화면으로 열었어요."),
    };
  }
}
