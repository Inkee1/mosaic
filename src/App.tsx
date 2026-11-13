import { t, useLocale, getLanguagePreference, changeLanguage } from './i18n';
import type { LanguagePreference } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Command,
  FolderOpen,
  Grid2X2,
  Keyboard,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  UserRound,
  X,
} from 'lucide-react';
import { readState, STORAGE_KEY, uid } from './model';
import type { AppState, Pane, RunStatus, Workspace } from './model';
import {
  syncActiveSet,
  switchSet,
  createSet,
  closeSet,
  patchSetPane,
  openWorkspaces,
  livePanes,
  MAX_LIVE_PANES,
} from '../shared/workspaces.mjs';
import BrowserPane from './components/BrowserPane';
import AiChatPanel from './components/AiChatPanel';
import AppSettings from './components/AppSettings';
import LiveAgentPanel from './components/LiveAgentPanel';
import { native } from './native';
import type { AppInfo } from './native';
import { useNativeWorkspace } from './useNativeWorkspace';
import {
  AddPaneDialog,
  HelpDialog,
  Modal,
  ProfilesDialog,
  SaveDialog,
  SwitcherDialog,
} from './components/Dialogs';

type Dialog = 'add' | 'save' | 'rename' | 'profiles' | 'switcher' | 'help' | 'connect' | 'settings' | null;
type ScrollPosition = { top: number; left: number };
const SIDEBAR_STORAGE_KEY = 'mosaic.sidebar.collapsed';
const getPaneBody = (id: string) =>
  document.querySelector<HTMLDivElement>('[data-pane-id="' + CSS.escape(id) + '"] .pane-body');

function MosaicLogo({ small = false }: { small?: boolean }) {
  return (
    <span className={'mosaic-logo' + (small ? ' small-logo' : '')}>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export default function App() {
  useLocale();
  const [initial] = useState(readState);
  const [state, setStoredState] = useState(initial.state);
  const setState = (update: (state: AppState) => AppState) =>
    setStoredState((previous) => syncActiveSet(update(previous)));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(native?.bootstrap.app || null);
  const [renamingSetId, setRenamingSetId] = useState<string | null>(null);
  const [toast, setToast] = useState(initial.warning ?? '');
  const [persisted, setPersisted] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(state.workspace.panes[0]?.id ?? null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [agentOpen, setAgentOpen] = useState(true);
  const [externalAgentOpen, setExternalAgentOpen] = useState(false);
  const workspaceGeneration = 0;
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(700);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollBeforeFocus = useRef({ top: 0, left: 0 });
  const paneScrollBeforeFocus = useRef(new Map<string, ScrollPosition>());
  const focusedPaneScroll = useRef(new Map<string, ScrollPosition>());
  const layoutRef = useRef<HTMLDivElement>(null);
  const nativeMutation = useRef(false);
  const setScrollPositions = useRef(new Map<string, ScrollPosition>());
  const { workspace, profiles, savedSets } = state;
  const workspaceDisplayName = state.activeSetId ? workspace.name : t('열린 세트 없음');
  const renamingWorkspace = renamingSetId === state.activeSetId
    ? workspace
    : savedSets.find((set) => set.id === renamingSetId)?.workspace;
  const latestState = useRef(state);
  latestState.current = state;
  const openedWorkspaces = openWorkspaces(state);
  const latestWorkspace = useRef(workspace);
  latestWorkspace.current = workspace;
  const focusedPane = workspace.panes.find((p) => p.id === focusedId);
  const nativeStatuses = useNativeWorkspace(
    state,
    focusedId,
    !!dialog || layoutOpen,
    workspaceGeneration,
    (id, profileId, patch) => setState((previous) => patchSetPane(previous, id, profileId, patch)),
    (id) => {
      if (latestWorkspace.current.panes.some((pane) => pane.id === id)) setActiveId(id);
    },
    setToast,
  );

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    if (native) {
      let current = true;
      native
        .saveState(state)
        .then(() => {
          if (current) setPersisted(true);
        })
        .catch((error) => {
          if (current) {
            setPersisted(false);
            setToast(t("디스크 저장에 실패했어요: ") + error.message);
          }
        });
      return () => {
        current = false;
      };
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setPersisted(true);
    } catch {
      setPersisted(false);
      setToast(t("저장 공간에 쓸 수 없어요. 현재 변경은 이 창에서만 유지됩니다."));
    }
  }, [state]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setViewportHeight(entries[0].contentRect.height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (runStatus !== 'running') return;
    const timer = window.setInterval(
      () => setProgress((previous) => Math.min(4, previous + 1)),
      3000,
    );
    return () => window.clearInterval(timer);
  }, [runStatus]);
  useEffect(() => {
    if (progress === 4 && runStatus === 'running') setRunStatus('completed');
  }, [progress, runStatus]);
  useEffect(() => {
    if (!layoutOpen) return;
    const close = (event: PointerEvent) => {
      if (!layoutRef.current?.contains(event.target as Node)) setLayoutOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [layoutOpen]);

  const updateWorkspace = (patch: Partial<Workspace>) => {
    const setId = state.activeSetId;
    setState((s) =>
      s.activeSetId === setId && setId ? { ...s, workspace: { ...s.workspace, ...patch } } : s,
    );
  };
  const toggleSidebar = () => {
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
    } catch {
      setToast(t("사이드바 설정을 저장할 수 없어요. 현재 선택은 이 창에서만 유지됩니다."));
    }
  };
  const stopDemo = () => {
    setRunStatus('idle');
    setProgress(0);
  };
  const changeFocus = (id: string | null) => {
    if (id === focusedId) return;
    const element = viewportRef.current;
    if (id && !focusedId && element) {
      scrollBeforeFocus.current = { top: element.scrollTop, left: element.scrollLeft };
      paneScrollBeforeFocus.current.clear();
      for (const pane of workspace.panes) {
        const body = getPaneBody(pane.id);
        if (body)
          paneScrollBeforeFocus.current.set(pane.id, {
            top: body.scrollTop,
            left: body.scrollLeft,
          });
      }
      focusedPaneScroll.current = new Map(paneScrollBeforeFocus.current);
    }
    if (focusedId) {
      const body = getPaneBody(focusedId);
      if (body)
        focusedPaneScroll.current.set(focusedId, { top: body.scrollTop, left: body.scrollLeft });
    }
    setFocusedId(id);
    if (id) setActiveId(id);
    requestAnimationFrame(() => {
      if (id) {
        const body = getPaneBody(id);
        const position = focusedPaneScroll.current.get(id);
        if (body && position) {
          body.scrollTop = position.top;
          body.scrollLeft = position.left;
        }
        body?.focus({ preventScroll: true });
        if (native && workspace.panes.some((p) => p.id === id && p.kind === 'external'))
          native.command(id, 'focus').catch(() => {});
      } else {
        for (const [paneId, position] of paneScrollBeforeFocus.current) {
          const body = getPaneBody(paneId);
          if (body) {
            body.scrollTop = position.top;
            body.scrollLeft = position.left;
          }
        }
        if (element) {
          element.scrollTop = scrollBeforeFocus.current.top;
          element.scrollLeft = scrollBeforeFocus.current.left;
        }
        if (activeId) getPaneBody(activeId)?.focus({ preventScroll: true });
      }
    });
  };
  const navigatePane = (direction: number) => {
    if (!workspace.panes.length) return;
    const index = workspace.panes.findIndex((p) => p.id === (focusedId || activeId));
    const next =
      workspace.panes[(index + direction + workspace.panes.length) % workspace.panes.length];
    setActiveId(next.id);
    if (focusedId) changeFocus(next.id);
    else
      requestAnimationFrame(() => {
        const body = getPaneBody(next.id);
        body
          ?.closest('article')
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        body?.focus({ preventScroll: true });
        if (native && next.kind === 'external') native.command(next.id, 'focus').catch(() => {});
      });
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (dialog || document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape') {
        if (layoutOpen) setLayoutOpen(false);
        else if (focusedId) changeFocus(null);
        return;
      }
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault();
        navigatePane(e.code === 'ArrowRight' ? 1 : -1);
      } else if (e.code === 'KeyK') {
        e.preventDefault();
        setDialog('switcher');
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        changeFocus(focusedId ? null : activeId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const approveClose = async (ids: string[]) => {
    if (!native) return true;
    if (nativeMutation.current) return false;
    nativeMutation.current = true;
    try {
      return await native.requestClose(ids);
    } catch (error) {
      setToast((error as Error).message);
      return false;
    } finally {
      nativeMutation.current = false;
    }
  };
  const resetSetView = (next: Workspace) => {
    const viewport = viewportRef.current;
    if (viewport && state.activeSetId)
      setScrollPositions.current.set(state.activeSetId, {
        top: focusedId ? scrollBeforeFocus.current.top : viewport.scrollTop,
        left: focusedId ? scrollBeforeFocus.current.left : viewport.scrollLeft,
      });
    setActiveId(next.panes[0]?.id ?? null);
    setFocusedId(null);
    setLayoutOpen(false);
    stopDemo();
    requestAnimationFrame(() => {
      const position = setScrollPositions.current.get(next.id);
      viewportRef.current?.scrollTo(position?.left || 0, position?.top || 0);
    });
  };
  const activateSet = (id: string) => {
    if (id === state.activeSetId) return;
    try {
      const next = switchSet(latestState.current, id);
      resetSetView(next.workspace);
      setState((s) => switchSet(s, id));
    } catch (error) {
      setToast((error as Error).message);
    }
  };
  const newWorkspace = () => {
    try {
      const next = createSet(latestState.current, {
        id: uid(),
        name: t("새로운 작업 공간"),
        columns: 2,
        rows: 2,
        panes: [],
      });
      resetSetView(next.workspace);
      setState(() => next);
    } catch (error) {
      setToast((error as Error).message);
    }
  };
  const closeWorkspace = async (id: string) => {
    const target = latestState.current.savedSets.find((set) => set.id === id);
    if (!target || !latestState.current.openSetIds?.includes(id)) return;
    if (
      native &&
      !(await approveClose(
        target.workspace.panes.filter((p) => p.kind === 'external').map((p) => p.id),
      ))
    )
      return;
    const next = closeSet(latestState.current, id);
    if (latestState.current.activeSetId === id) resetSetView(next.workspace);
    setState((s) => closeSet(s, id));
    setToast(t("세트를 닫았어요. 보관된 세트에서 마지막 주소로 다시 열 수 있어요."));
  };
  const closePane = async (id: string) => {
    const setId = state.activeSetId;
    if (native && !(await approveClose([id]))) return;
    const next = latestWorkspace.current.panes.filter((p) => p.id !== id);
    setState((current) => {
      const target = current.savedSets.find((set) => set.id === setId);
      if (!target) return current;
      const changed = {
        ...target.workspace,
        panes: target.workspace.panes.filter((pane) => pane.id !== id),
      };
      return {
        ...current,
        savedSets: current.savedSets.map((set) =>
          set.id === setId
            ? { ...set, savedAt: new Date().toISOString(), workspace: changed }
            : set,
        ),
        workspace: current.activeSetId === setId ? changed : current.workspace,
      };
    });
    if (focusedId === id) changeFocus(null);
    setActiveId((current) => (current === id ? (next[0]?.id ?? null) : current));
    if (runStatus === 'running' || runStatus === 'paused') stopDemo();
  };
  const addPane = (pane: Omit<Pane, 'id' | 'addressOpen'>) => {
    if (livePanes(state).length >= MAX_LIVE_PANES) {
      setToast(t("열린 세트 전체에서 최대 128개 화면을 사용할 수 있어요."));
      return;
    }
    if (workspace.panes.length >= 32) {
      setToast(t("UI 미리보기에서는 최대 32개 화면을 추가할 수 있어요."));
      return;
    }
    const newPane = { ...pane, id: uid(), addressOpen: false };
    updateWorkspace({ panes: [...workspace.panes, newPane] });
    setActiveId(newPane.id);
    setDialog(null);
    if (focusedId) setFocusedId(newPane.id);
    else
      requestAnimationFrame(() =>
        document
          .querySelector('[data-pane-id="' + newPane.id + '"]')
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }),
      );
    setToast(t('{name} 화면을 추가했어요.', { name: pane.title }));
  };
  const saveSet = (name: string) => {
    updateWorkspace({ name });
    setDialog(null);
    setToast(t('“{name}” 세트를 저장했어요. 이후 변경도 자동 저장됩니다.', { name }));
  };
  const openSetRename = (id: string) => {
    setRenamingSetId(id);
    setDialog('rename');
  };
  const renameSet = (name: string) => {
    const setId = renamingSetId;
    const trimmed = name.trim();
    if (!setId || !trimmed || trimmed.length > 60) return;
    setState((current) => {
      const target = current.savedSets.find((set) => set.id === setId);
      if (!target) return current;
      const updated = {
        ...(current.activeSetId === setId ? current.workspace : target.workspace),
        name: trimmed,
      };
      return {
        ...current,
        workspace: current.activeSetId === setId ? updated : current.workspace,
        savedSets: current.savedSets.map((set) => set.id === setId
          ? { ...set, workspace: updated, savedAt: new Date().toISOString() }
          : set),
      };
    });
    setDialog(null);
    setRenamingSetId(null);
    setToast(t('세트 이름을 “{name}”(으)로 변경했어요.', { name: trimmed }));
  };
  const rowHeight = Math.max(
    325,
    (viewportHeight - 32 - (workspace.rows - 1) * 16) / workspace.rows,
  );

  return (
    <div className={'app-shell' + (native ? ' desktop-mode' : '')}>
      <aside
        id="workspace-sidebar"
        className={'sidebar' + (sidebarCollapsed ? ' collapsed' : '')}
        aria-label={t("작업 공간 탐색")}
      >
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            changeFocus(null);
          }}
          aria-label={t("Mosaic 전체 화면")}
        >
          <MosaicLogo />
          <span>
            mosaic<span className="brand-period">.</span>
          </span>
        </a>
        <nav className="primary-nav">
          <button
            className="selected"
            onClick={() => changeFocus(null)}
            aria-label={t("작업 공간")}
            title={t("작업 공간")}
          >
            <LayoutDashboard size={17} />
            <span>{t("작업 공간")}</span>
            <span className="nav-count">{workspace.panes.length}</span>
          </button>
          <button
            onClick={() => setDialog('profiles')}
            aria-label={t("브라우저 프로필")}
            title={t("브라우저 프로필")}
          >
            <UserRound size={17} />
            <span>{t("브라우저 프로필")}</span>
            <span className="nav-count">{profiles.length}</span>
          </button>
        </nav>
        <div className="sidebar-label">
          <span>{t("열린 세트")}</span>
          <button
            className="icon-button"
            onClick={newWorkspace}
            aria-label={t("새 세트 만들기")}
            title={t("새 세트 만들기")}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="saved-sets">
          {openedWorkspaces.map((setWorkspace) => (
            <div className="set-row" key={setWorkspace.id}>
              <button
                onClick={() => activateSet(setWorkspace.id)}
                className={state.activeSetId === setWorkspace.id ? 'current' : ''}
                title={t('{name} · {count}개 화면', { name: setWorkspace.name, count: setWorkspace.panes.length })}
                aria-label={t('{name} · {count}개 화면', { name: setWorkspace.name, count: setWorkspace.panes.length })}
                aria-current={state.activeSetId === setWorkspace.id ? 'page' : undefined}
              >
                <span className="set-grid">
                  <Grid2X2 size={15} />
                </span>
                <span>{setWorkspace.name}</span>
                <small>{setWorkspace.panes.length}</small>
              </button>
              <button
                className="set-rename"
                onClick={() => openSetRename(setWorkspace.id)}
                aria-label={t('{name} 이름 변경', { name: setWorkspace.name })}
                title={t("세트 이름 변경")}
              >
                <Pencil size={12} />
              </button>
              <button
                className="set-close"
                onClick={() => closeWorkspace(setWorkspace.id)}
                aria-label={t('{name} 세트 닫기', { name: setWorkspace.name })}
                title={t("세트 닫기 · 구성은 보관됩니다")}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        {savedSets.some((set) => !state.openSetIds?.includes(set.id)) && (
          <>
            <div className="sidebar-label">
              <span>{t("보관된 세트")}</span>
            </div>
            <div className="saved-sets archived-sets">
              {savedSets
                .filter((set) => !state.openSetIds?.includes(set.id))
                .map((set) => (
                  <div className="archived-set-row" key={set.id}>
                  <button
                    onClick={() => activateSet(set.id)}
                    title={t('{name} · 마지막 주소로 열기', { name: set.workspace.name })}
                    aria-label={t('{name} · {count}개 화면', { name: set.workspace.name, count: set.workspace.panes.length })}
                  >
                    <span className="set-grid">
                      <FolderOpen size={15} />
                    </span>
                    <span>{set.workspace.name}</span>
                    <small>{set.workspace.panes.length}</small>
                  </button>
                  <button
                    className="set-rename"
                    onClick={() => openSetRename(set.id)}
                    aria-label={t('{name} 이름 변경', { name: set.workspace.name })}
                    title={t("세트 이름 변경")}
                  >
                    <Pencil size={12} />
                  </button>
                  </div>
                ))}
            </div>
          </>
        )}
        <button
          className="new-workspace"
          onClick={newWorkspace}
          aria-label={t("새 작업 공간")}
          title={t("새 작업 공간")}
        >
          <Plus size={15} />
          <span>{t("새 작업 공간")}</span>
        </button>
        <div className="sidebar-bottom">
          {!native && <label className="sidebar-language">
            <span>{t('언어')}</span>
            <select aria-label={t('언어')} value={getLanguagePreference()} onChange={event => {
              void changeLanguage(event.target.value as LanguagePreference).catch(() => setToast(t('언어 설정을 저장하지 못했어요.')));
            }}>
              <option value="system">{t('시스템 설정 따르기')}</option><option value="ko">한국어</option><option value="en">English</option>
            </select>
          </label>}
          {appInfo && <button className="sidebar-help" aria-label={t("Mosaic 설정")} title={t("Mosaic 설정")} onClick={() => setDialog('settings')}><Settings2 size={16} /><span>{t("Mosaic 설정")}</span></button>}
          <button
            className="sidebar-help"
            onClick={() => setDialog('help')}
            aria-label={t("키보드 단축키")}
            title={t("키보드 단축키")}
          >
            <Keyboard size={16} />
            <span>{t("키보드 단축키")}</span>
            <kbd>?</kbd>
          </button>
          <div className="sidebar-account">
            <span className="account-avatar">{t("나")}</span>
            <span>
              <b>{t("나만의 워크스페이스")}</b>
              <small>{t("로컬에 저장되는 작업 공간")}</small>
            </span>
            <button
              className="icon-button"
              onClick={() =>
                setState((s) => ({ ...s, theme: s.theme === 'light' ? 'dark' : 'light' }))
              }
              aria-label={state.theme === 'light' ? t("다크 모드로 전환") : t("라이트 모드로 전환")}
              title={state.theme === 'light' ? t("다크 모드로 전환") : t("라이트 모드로 전환")}
            >
              {state.theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
            </button>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-workspace">
            <button
              className="icon-button"
              onClick={toggleSidebar}
              aria-label={sidebarCollapsed ? t("사이드바 펼치기") : t("사이드바 접기")}
              title={sidebarCollapsed ? t("사이드바 펼치기") : t("사이드바 접기")}
              aria-expanded={!sidebarCollapsed}
              aria-controls="workspace-sidebar"
            >
              {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
            <h1 title={workspaceDisplayName}>{workspaceDisplayName}</h1>
            {state.activeSetId && <button
              className="icon-button"
              onClick={() => openSetRename(state.activeSetId!)}
              aria-label={t("현재 세트 이름 변경")}
              title={t("세트 이름 변경")}
            ><Pencil size={13} /></button>}
          </div>
          <div className="topbar-actions">
            <button
              className="button"
              disabled={!state.activeSetId}
              onClick={() => setDialog('save')}
            >
              <Bookmark size={15} />{t("세트 저장")}</button>
            <button
              className="button primary"
              disabled={!state.activeSetId}
              onClick={() => setDialog('add')}
            >
              <Plus size={17} />{t("화면 추가")}</button>
          </div>
        </header>
        {appInfo && !appInfo.preferences.onboardingDismissed && <div className="first-use-guide">
          <span><b>{t("Mosaic에 오신 것을 환영해요")}</b>{t("AI 연결과 첫 작업, 선택적 사용자 수 집계를 안내해 드릴게요.")}</span>
          <button className="button compact" aria-label={t("시작 안내 열기")} onClick={() => setDialog('settings')}>{t("시작 안내")}</button>
          <button className="icon-button" aria-label={t("시작 안내 닫기")} onClick={() => void native!.setAppPreferences({ onboardingDismissed: true }).then(setAppInfo).catch(() => setToast(t("안내 설정을 저장하지 못했어요.")))}><X size={14} /></button>
        </div>}
        <div className="workspace-content">
          <section className="workspace-main">
            <div className="workspace-toolbar">
              {focusedPane ? (
                <>
                  <button className="back-to-grid" onClick={() => changeFocus(null)}>
                    <Grid2X2 size={15} />{t("모든 화면으로")}</button>
                  <span className="toolbar-divider" />
                  <span className="focus-position">
                    {workspace.panes.findIndex((p) => p.id === focusedId) + 1}
                    <span> / {workspace.panes.length}</span>
                  </span>
                  <div className="focus-navigation">
                    <button
                      className="icon-button"
                      onClick={() => navigatePane(-1)}
                      aria-label={t("이전 화면")}
                    >
                      <ChevronLeft size={17} />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => navigatePane(1)}
                      aria-label={t("다음 화면")}
                    >
                      <ChevronRight size={17} />
                    </button>
                    <button className="button compact" onClick={() => setDialog('switcher')}>{t("화면 선택")}<ChevronDown size={12} />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="views-label">
                    <LayoutGrid size={15} />{t("모든 화면")}<span>{workspace.panes.length}</span>
                  </span>
                  <span className="toolbar-divider" />
                  <div className="layout-presets" aria-label={t("격자 배치")}>
                    {[
                      [1, 2],
                      [2, 2],
                      [3, 2],
                    ].map(([columns, rows]) => (
                      <button
                        key={columns}
                        className={
                          workspace.columns === columns && workspace.rows === rows ? 'selected' : ''
                        }
                        onClick={() => updateWorkspace({ columns, rows })}
                        aria-label={t('{columns}열 {rows}행', { columns, rows })}
                        aria-pressed={workspace.columns === columns && workspace.rows === rows}
                      >
                        <span
                          className="layout-icon"
                          style={{ gridTemplateColumns: 'repeat(' + columns + ', 1fr)' }}
                        >
                          {Array.from({ length: columns * rows }, (_, i) => (
                            <i key={i} />
                          ))}
                        </span>
                        <span>
                          {columns} × {rows}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="layout-custom" ref={layoutRef}>
                    <button
                      className={'icon-button' + (layoutOpen ? ' selected' : '')}
                      onClick={() => setLayoutOpen(!layoutOpen)}
                      aria-label={t("배치 직접 설정")}
                      aria-expanded={layoutOpen}
                    >
                      <Settings2 size={15} />
                    </button>
                    {layoutOpen && (
                      <div className="layout-popover">
                        <b>{t("나에게 맞는 배치")}</b>
                        <p>{t("열 × 한 화면에 보이는 행")}</p>
                        <div>
                          {(['columns', 'rows'] as const).map((key, i) => (
                            <label key={key}>
                              {i === 0 ? t("열") : t("행")}
                              <select
                                aria-label={i === 0 ? t("열 수") : t("행 수")}
                                value={workspace[key]}
                                onChange={(e) => updateWorkspace({ [key]: Number(e.target.value) })}
                              >
                                {[1, 2, 3, 4].map((n) => (
                                  <option key={n} value={n}>
                                    {n}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ))}
                        </div>
                        <small>{t("초과 화면은 스크롤해서 볼 수 있어요.")}</small>
                      </div>
                    )}
                  </div>
                </>
              )}
              <div className="toolbar-end">
                <button
                  className="icon-button quick-switch"
                  onClick={() => setDialog('switcher')}
                  aria-label={t("화면 선택기")}
                  title={t("화면 찾기 (Alt+Shift+K)")}
                >
                  <Search size={16} />
                </button>
                <button
                  className={'agent-toggle' + (agentOpen ? ' selected' : '')}
                  onClick={() => { setAgentOpen(!agentOpen); setExternalAgentOpen(false); }}
                  aria-label={t("에이전트 패널")}
                  aria-pressed={agentOpen}
                >
                  <Sparkles size={14} />
                  <span>{t("AI 채팅")}</span>
                  {agentOpen && <i />}
                </button>
                {native && <button className="icon-button" aria-label={t("외부 MCP 연결")} title={t("외부 AI 앱 연결 설정")} onClick={() => { setExternalAgentOpen(!externalAgentOpen); setAgentOpen(false); }}><Link2 size={15} /></button>}
              </div>
            </div>
            <div
              ref={viewportRef}
              className={'workspace-viewport' + (focusedId ? ' focus-viewport' : '')}
              data-testid="workspace-scroll"
            >
              {openedWorkspaces.map((renderWorkspace) => (
                <div
                  className="workspace-set"
                  key={renderWorkspace.id}
                  hidden={renderWorkspace.id !== state.activeSetId}
                >
                  <div
                    className={'browser-grid' + (focusedId ? ' focus-grid' : '')}
                    style={
                      {
                        '--columns': renderWorkspace.columns,
                        '--pane-height': rowHeight + 'px',
                      } as CSSProperties
                    }
                  >
                    {renderWorkspace.panes.map((pane, index) => (
                      <BrowserPane
                        key={pane.id}
                        pane={pane}
                        profile={profiles.find((p) => p.id === pane.profileId)!}
                        profiles={profiles}
                        nativeStatus={nativeStatuses[pane.id]}
                        index={index}
                        focused={focusedId === pane.id}
                        hidden={!!focusedId && focusedId !== pane.id}
                        active={activeId === pane.id}
                        runStatus={runStatus}
                        progress={progress}
                        onActivate={() => {
                          if (renderWorkspace.id === state.activeSetId) setActiveId(pane.id);
                        }}
                        onUpdate={(patch) =>
                          setState((s) => patchSetPane(s, pane.id, pane.profileId, patch))
                        }
                        onFocus={() => changeFocus(focusedId === pane.id ? null : pane.id)}
                        onClose={() => closePane(pane.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {!state.activeSetId && (
                <div className="empty-workspace">
                  <div className="empty-mosaic">
                    <MosaicLogo />
                  </div>
                  <h2>{t("열린 세트가 없어요")}</h2>
                  <p>{t("보관된 세트를 다시 열거나 새로운 세트를 만들어 보세요.")}</p>
                  <button className="button primary" onClick={newWorkspace}>
                    <Plus size={16} />{t("새 세트 만들기")}</button>
                </div>
              )}
              {state.activeSetId && !workspace.panes.length && (
                <div className="empty-workspace">
                  <div className="empty-mosaic">
                    <MosaicLogo />
                  </div>
                  <span className="eyebrow">A FRESH PERSPECTIVE</span>
                  <h2>{t("무엇부터 펼쳐볼까요?")}</h2>
                  <p>{t("첫 번째 화면을 추가하고,")}<br />{t("나만의 작업 흐름을 만들어 보세요.")}</p>
                  <button className="button primary" onClick={() => setDialog('add')}>
                    <Plus size={16} />{t("첫 화면 추가")}</button>
                </div>
              )}
            </div>
            <footer className="workspace-status">
              <span>
                <i className={persisted ? '' : 'save-error'} />
                {persisted ? t("현재 구성 자동 저장됨") : t("저장 실패 · 이 창에서만 유지")}
                <span className="status-divider">·</span>
                {t('{count}개 화면', { count: workspace.panes.length })}</span>
              <button onClick={() => setDialog('help')}>
                <Keyboard size={12} />
                <span>Alt + Shift + ← →</span>
                <small>{t("화면 전환")}</small>
              </button>
            </footer>
          </section>
          {agentOpen && <AiChatPanel setId={state.activeSetId || null} setName={workspaceDisplayName} panes={workspace.panes} profiles={profiles} onClose={() => setAgentOpen(false)} />}
          {externalAgentOpen && native && <LiveAgentPanel panes={workspace.panes} profiles={profiles} onClose={() => setExternalAgentOpen(false)} />}
        </div>
      </div>
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={15} />
          </span>
          {toast}
          <button className="icon-button" onClick={() => setToast('')} aria-label={t("알림 닫기")}>
            <X size={14} />
          </button>
        </div>
      )}
      {dialog === 'add' && (
        <AddPaneDialog profiles={profiles} onAdd={addPane} onClose={() => setDialog(null)} />
      )}
      {dialog === 'save' && (
        <SaveDialog workspace={workspace} onSave={saveSet} onClose={() => setDialog(null)} />
      )}
      {dialog === 'rename' && renamingWorkspace && (
        <SaveDialog key={renamingSetId} workspace={renamingWorkspace} renaming onSave={renameSet} onClose={() => setDialog(null)} />
      )}
      {dialog === 'profiles' && (
        <ProfilesDialog
          profiles={profiles}
          onCreate={(name, note, color, googleEmail) => {
            setState((s) => ({
              ...s,
              profiles: [...s.profiles, { id: uid(), name, note, color, googleEmail }],
            }));
            setToast(
              native
                ? t("프로필을 만들었어요. Google·인스타 로그인 버튼으로 미리 준비하세요.")
                : t("새 데모 프로필을 만들었어요. 화면 추가에서 선택할 수 있습니다."),
            );
          }}
          onUpdate={(profile) =>
            setState((s) => ({
              ...s,
              profiles: s.profiles.map((p) => (p.id === profile.id ? profile : p)),
            }))
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'switcher' && (
        <SwitcherDialog
          panes={workspace.panes}
          profiles={profiles}
          currentId={focusedId || activeId}
          onSelect={(id) => {
            changeFocus(id);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
      {dialog === 'settings' && appInfo && <AppSettings initial={appInfo} onInfo={setAppInfo} onClose={() => setDialog(null)} />}
      {dialog === 'connect' && (
        <Modal
          title={t("어떤 AI와도, 같은 작업 공간에서")}
          subtitle={native ? t("Claude Code와 Codex를 채팅별로 선택해 작업하세요.") : t("실제 AI 채팅은 Mosaic 데스크톱 앱에서 사용할 수 있어요.")}
          onClose={() => setDialog(null)}
        >
          <div className="connect-illustration">
            <MosaicLogo />
            <span>↔</span>
            <span className="connect-agent">
              <Sparkles size={25} />
            </span>
          </div>
          <div className="connection-features">
            <div>
              <Check size={16} />
              <span>{t("화면을 지정해 탐색하고, 읽고, 입력하기")}</span>
            </div>
            <div>
              <Check size={16} />
              <span>{t("여러 화면의 작업 과정을 동시에 확인하기")}</span>
            </div>
            <div>
              <Check size={16} />
              <span>{t("사용자가 직접 이어받고 언제든 멈추기")}</span>
            </div>
          </div>
          <p className="connection-note">{t("데스크톱 앱의 오른쪽 AI 채팅에서 새 대화를 만들고, 모델·추론 강도와 함께 볼 화면을 선택하세요. 이 PC에 설치된 Claude Code 또는 Codex의 로그인을 사용합니다.")}</p>
          <div className="modal-footer">
            <button
              className="button primary"
              onClick={() => {
                setDialog(null);
                setAgentOpen(true);
              }}
            >{t("AI 채팅 열기")}<ArrowRight size={15} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
