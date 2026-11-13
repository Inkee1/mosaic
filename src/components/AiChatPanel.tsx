import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Archive, ArrowUp, Check, ChevronDown, Columns2, GitBranch, LoaderCircle,
  MessageSquare, Monitor, Pencil, Plus, RefreshCw, RotateCcw, Sparkles, Square, X,
} from 'lucide-react';
import { native } from '../native';
import { getLocale, t, useLocale } from '../i18n';
import type { Pane, Profile } from '../model';
import {
  chatStatusLabel, isChatActive, providerName, providerStatusLabel,
} from '../ai';
import type { AiChat, AiChatPatch, AiProviderId, AiState, ProviderInfo } from '../ai';

const DISPLAY_KEY = 'mosaic.ai.display.v1';
const COLLAPSED_KEY = 'mosaic.ai.collapsed.v1';
type CollapsedChoice = { connection: boolean; chats: Record<string, boolean> };
function readCollapsed(): CollapsedChoice {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}');
    return {
      connection: value?.connection === true,
      chats: value?.chats && typeof value.chats === 'object' && !Array.isArray(value.chats)
        ? Object.fromEntries(Object.entries(value.chats).filter(([, folded]) => folded === true)) as Record<string, boolean>
        : {},
    };
  } catch { return { connection: false, chats: {} }; }
}
type DisplayChoice = { activeId?: string; secondId?: string; split?: boolean; archive?: boolean };
type DisplayChoices = Record<string, DisplayChoice>;
type PanelProps = {
  setId: string | null;
  setName: string;
  panes: Pane[];
  profiles: Profile[];
  onClose: () => void;
};
const bridge = native && typeof native.aiState === 'function' ? native : undefined;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const effortLabels: Record<string, string> = {
  minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대',
};
const clockLabel = (date: string) => {
  const time = new Date(date);
  return Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
};

function readDisplay(): DisplayChoices {
  try {
    const value = JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([id, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const choice = raw as Record<string, unknown>;
      return [[id, {
        activeId: typeof choice.activeId === 'string' ? choice.activeId : undefined,
        secondId: typeof choice.secondId === 'string' ? choice.secondId : undefined,
        split: choice.split === true,
        archive: choice.archive === true,
      }]];
    }));
  } catch {
    return {};
  }
}

export default function AiChatPanel({ setId, setName, panes, profiles, onClose }: PanelProps) {
  const locale = useLocale();
  const [state, setState] = useState<AiState | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(!!bridge);
  const [refreshing, setRefreshing] = useState(false);
  const [display, setDisplay] = useState<DisplayChoices>(readDisplay);
  const [collapsed, setCollapsed] = useState<CollapsedChoice>(readCollapsed);
  const connectionId = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const latestState = useRef<AiState | null>(null);
  const eventRevision = useRef(0);
  const providerRequest = useRef(0);
  const currentSet = useRef(setId);
  currentSet.current = setId;

  const choose = useCallback((id: string, patch: DisplayChoice) => {
    setDisplay((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }));
  }, []);

  const acceptState = useCallback((next: AiState) => {
    const current = latestState.current;
    if (current?.revision !== undefined && next.revision !== undefined && next.revision < current.revision) return;
    latestState.current = next;
    setState(next);
  }, []);

  // Events are authoritative. A slower IPC response must not replace newer streamed output.
  const command = useCallback(async (operation: () => Promise<AiState>) => {
    const revision = eventRevision.current;
    const next = await operation();
    if (alive.current && (next.revision !== undefined || revision === eventRevision.current)) acceptState(next);
    return next;
  }, [acceptState]);

  const refreshProviders = useCallback(async () => {
    if (!bridge) return;
    const request = ++providerRequest.current;
    setRefreshing(true);
    try {
      const next = await bridge.aiProviders();
      if (alive.current && request === providerRequest.current) setProviders(next);
    } catch (reason) {
      if (alive.current && request === providerRequest.current) setError(errorText(reason));
    } finally {
      if (alive.current && request === providerRequest.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!bridge) return;
    let current = true;
    const revision = eventRevision.current;
    const unsubscribe = bridge.onEvent((event) => {
      if (event.type !== 'ai') return;
      eventRevision.current += 1;
      acceptState(event.state);
      setLoading(false);
    });
    bridge.aiState().then((next) => {
      if (current && (next.revision !== undefined || revision === eventRevision.current)) acceptState(next);
    }).catch((reason) => {
      if (current) setError(errorText(reason));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      alive.current = false;
      current = false;
      providerRequest.current += 1;
      unsubscribe();
    };
  }, [acceptState]);

  useEffect(() => {
    void refreshProviders();
  }, [locale, refreshProviders]);

  useEffect(() => {
    try {
      localStorage.setItem(DISPLAY_KEY, JSON.stringify(display));
    } catch {
      // Display preferences can remain in memory when browser storage is unavailable.
    }
  }, [display]);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); } catch { /* Keep preferences in memory. */ }
  }, [collapsed]);
  useEffect(() => {
    setNewChatOpen(false);
    setError('');
    setNotice('');
  }, [setId]);

  const chats = state?.chats.filter((chat) => chat.setId === setId && !chat.archived) || [];
  const archived = state?.chats.filter((chat) => chat.setId === setId && chat.archived) || [];
  const choice = setId ? display[setId] || {} : {};
  const selected = chats.find((chat) => chat.id === choice.activeId) || chats[0];
  const second = chats.find((chat) => chat.id === choice.secondId && chat.id !== selected?.id)
    || chats.find((chat) => chat.id !== selected?.id);
  const split = !!choice.split && !!second;
  const active = state?.chats.filter(isChatActive) || [];
  const elsewhere = active.filter((chat) => chat.setId !== setId);

  const panelAction = async (key: string, operation: () => Promise<void>) => {
    setPending(key);
    setError('');
    const originSet = setId;
    try {
      await operation();
    } catch (reason) {
      if (alive.current && currentSet.current === originSet) setError(errorText(reason));
    } finally {
      if (alive.current) setPending('');
    }
  };
  const selectCreated = (next: AiState, previousIds: Set<string>, originSet: string) => {
    const created = next.createdChatId
      ? next.chats.find((chat) => chat.id === next.createdChatId && chat.setId === originSet)
      : next.chats.find((chat) => chat.setId === originSet && !previousIds.has(chat.id));
    if (created && alive.current) choose(originSet, { activeId: created.id, split: false });
  };
  const createChat = (provider: AiProviderId) => {
    if (!bridge || !setId) return;
    const originSet = setId;
    const ids = new Set(state?.chats.map((chat) => chat.id));
    void panelAction('create', async () => {
      const next = await command(() => bridge.aiCreateChat({ setId: originSet, provider }));
      selectCreated(next, ids, originSet);
      if (alive.current && currentSet.current === originSet) setNewChatOpen(false);
    });
  };
  const forkChat = async (chat: AiChat, provider: AiProviderId, carry: boolean) => {
    const ids = new Set(state?.chats.map((item) => item.id));
    const next = await command(() => bridge!.aiForkChat(chat.id, provider, carry));
    selectCreated(next, ids, chat.setId);
  };

  return (
    <aside className={'ai-chat-panel' + (split ? ' ai-split' : '')} aria-label={t('AI 채팅 패널')}>
      <header className="ai-panel-heading">
        <span className="ai-heading-mark"><Sparkles size={16} /></span>
        <div><h2>{t('AI 채팅')}</h2><p title={setName}>{setName || t('작업 공간')}</p></div>
        <button className="icon-button ai-fold" aria-label={collapsed.connection ? t('연결·새 채팅 펼치기') : t('연결·새 채팅 접기')} title={collapsed.connection ? t('연결·새 채팅 펼치기') : t('연결·새 채팅 접기')} aria-expanded={!collapsed.connection} aria-controls={connectionId} onClick={() => setCollapsed(previous => ({ ...previous, connection: !previous.connection }))}><ChevronDown size={16} /></button>
        <button className="icon-button" aria-label={t('AI 채팅 패널 접기')} onClick={onClose}><X size={16} /></button>
      </header>

      <div id={connectionId} className="ai-connection-controls" hidden={collapsed.connection}>
      <div className="ai-provider-strip">
        {(['claude', 'codex'] as AiProviderId[]).map((id) => {
          const provider = providers.find((item) => item.id === id);
          return (
            <div className="ai-provider-card" key={id}>
              <details>
                <summary>
                  <i className={'ai-provider-dot ' + (provider?.status || '')} />
                  <b>{provider?.name || providerName(id)}</b>
                  <span>{bridge ? provider ? providerStatusLabel[provider.status] : refreshing ? t('확인 중') : t('미확인') : t('데스크톱 전용')}</span>
                  <ChevronDown size={11} />
                </summary>
                <p>{provider?.detail || (bridge ? t('새로고침으로 연결 상태를 확인하세요.') : t('설치된 공식 CLI 계정을 사용합니다.'))}</p>
                {provider?.version && <small>{t('버전 {version}', { version: provider.version })}</small>}
                {provider?.status === 'ready' && <small>{t('모델 이용 가능 여부는 계정에 따라 달라요.')}</small>}
              </details>
              {provider?.status === 'login-required' && (
                <button className="ai-text-button" disabled={!!pending} aria-label={t('{provider} 로그인', { provider: providerName(id) })} onClick={() => {
                  void panelAction('login', async () => {
                    const result = await bridge!.aiLogin(id);
                    if (alive.current) setNotice(result.message);
                    await refreshProviders();
                  });
                }}>{t('로그인')}</button>
              )}
            </div>
          );
        })}
        <button className="icon-button ai-refresh" aria-label={t('연결 상태 새로고침')} disabled={!bridge || refreshing} onClick={() => void refreshProviders()}>
          <RefreshCw size={13} className={refreshing ? 'ai-spinning' : ''} />
        </button>
      </div>

      <div className="ai-toolbar">
        <button className="button compact" aria-label={t('새 채팅')} disabled={!bridge || !setId || loading || !!pending} aria-expanded={newChatOpen} onClick={() => setNewChatOpen(!newChatOpen)}>
          <Plus size={13} />{t('새 채팅')}</button>
        <span className="ai-toolbar-spacer" />
        <button className={'icon-button' + (split ? ' selected' : '')} aria-label={split ? t('채팅 탭으로 보기') : t('두 채팅 나란히 보기')} title={split ? t('탭으로 보기') : t('두 채팅 나란히 보기')} disabled={chats.length < 2} aria-pressed={split} onClick={() => setId && choose(setId, { split: !split })}>
          <Columns2 size={15} />
        </button>
        <button className={'ai-archive-toggle' + (choice.archive ? ' selected' : '')} disabled={!bridge} aria-expanded={!!choice.archive} onClick={() => setId && choose(setId, { archive: !choice.archive })}>
          <Archive size={13} />{t('보관함')}{archived.length > 0 && <span>{archived.length}</span>}
        </button>
      </div>

      {newChatOpen && (
        <div className="ai-new-picker">
          <p>{t('함께 작업할 AI를 선택하세요')}</p>
          <div>{(['claude', 'codex'] as AiProviderId[]).map((id) => (
            <button key={id} className="button" disabled={!!pending} aria-label={t('{provider} 새 채팅', { provider: providerName(id) })} onClick={() => createChat(id)}>
              <MessageSquare size={14} />{providerName(id)}<Plus size={12} />
            </button>
          ))}</div>
        </div>
      )}
      </div>

      {(error || notice || state?.recoveryNotice) && (
        <div className="ai-notices">
          {error && <p className="ai-error" role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {state?.recoveryNotice && <p>{state.recoveryNotice}</p>}
        </div>
      )}

      {choice.archive && !collapsed.connection && (
        <section className="ai-archive-list" aria-label={t('보관된 채팅')}>
          {archived.length ? archived.map((chat) => (
            <div key={chat.id}>
              <span><b>{chat.title}</b><small>{providerName(chat.provider)}</small></span>
              <button className="icon-button" aria-label={t('{title} 복원', { title: chat.title })} disabled={!!pending} onClick={() => {
                void panelAction('restore', async () => {
                  await command(() => bridge!.aiUpdateChat(chat.id, { archived: false }));
                  if (alive.current) choose(chat.setId, { activeId: chat.id });
                });
              }}><RotateCcw size={14} /></button>
            </div>
          )) : <p>{t('보관된 채팅이 없어요.')}</p>}
        </section>
      )}

      {!bridge ? (
        <div className="ai-empty ai-preview">
          <span className="ai-empty-symbol"><Monitor size={27} /></span>
          <span className="ai-eyebrow">MOSAIC DESKTOP</span>
          <h3>{t('데스크톱에서 AI와 대화하세요')}</h3>
          <p>{t('설치된 Claude Code와 Codex 계정으로')}<br />{t('여러 채팅을 독립적으로 이어갈 수 있어요.')}</p>
          <div className="ai-preview-features"><span><Check size={13} />{t('채팅마다 모델과 화면 선택')}</span><span><Check size={13} />{t('실시간 응답과 작업 기록')}</span><span><Check size={13} />{t('두 채팅을 나란히 비교')}</span></div>
          <small>{t('웹 미리보기에서는 AI가 실행되지 않습니다.')}</small>
        </div>
      ) : loading ? (
        <div className="ai-empty" role="status"><LoaderCircle className="ai-spinning" size={22} /><p>{t('채팅을 불러오고 있어요…')}</p></div>
      ) : !setId || !selected ? (
        <div className="ai-empty">
          <span className="ai-empty-symbol"><MessageSquare size={25} /></span>
          <h3>{setId ? t('이 세트의 첫 대화를 시작하세요') : t('먼저 작업 세트를 열어 주세요')}</h3>
          <p>{setId ? t('새 채팅에서 AI를 선택하고, 함께 볼 화면을 정하세요.') : t('채팅과 화면 선택은 각 세트에 따로 보관됩니다.')}</p>
          {setId && <button className="button primary" onClick={() => { setCollapsed(previous => ({ ...previous, connection: false })); setNewChatOpen(true); }}><Plus size={14} />{t('첫 채팅 만들기')}</button>}
        </div>
      ) : (
        <>
          <div className="ai-tabs" role="tablist" aria-label={t('이 세트의 채팅')}>
            {chats.map((chat) => (
              <button key={chat.id} role="tab" aria-selected={chat.id === selected.id} title={chat.title + ' · ' + providerName(chat.provider)} className={split && chat.id === second?.id ? 'ai-secondary-tab' : ''} onClick={() => {
                if (setId) choose(setId, { activeId: chat.id, secondId: chat.id === second?.id ? selected.id : second?.id });
              }}>
                <i className={'ai-chat-dot ' + chat.status} /><span>{chat.title}</span><small>{providerName(chat.provider)}</small>
              </button>
            ))}
          </div>
          {split && <label className="ai-second-picker">{t('오른쪽 채팅')}<select aria-label={t('함께 볼 채팅')} value={second!.id} onChange={(event) => setId && choose(setId, { secondId: event.target.value })}>{chats.filter((chat) => chat.id !== selected.id).map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>}
          <div className="ai-chat-columns">
            {[selected, ...(split && second ? [second] : [])].map((chat) => (
              <ChatColumn key={chat.id} chat={chat} collapsed={!!collapsed.chats[chat.id]} onToggle={() => setCollapsed(previous => ({ ...previous, chats: { ...previous.chats, [chat.id]: !previous.chats[chat.id] } }))} provider={providers.find((item) => item.id === chat.provider)} panes={panes} profiles={profiles} draft={drafts[chat.id] || ''} onDraft={(value) => setDrafts((previous) => ({ ...previous, [chat.id]: value }))} command={command} onFork={(provider, carry) => forkChat(chat, provider, carry)} />
            ))}
          </div>
        </>
      )}

      {bridge && (
        <footer className="ai-panel-footer">
          <div><span><i className={active.length ? 'active' : ''} />{active.length ? t('{count}개 진행 중', { count: active.length }) : t('모든 채팅 대기 중')}</span><small>{elsewhere.length ? t('다른 세트 {count}개 진행 중', { count: elsewhere.length }) : t('최대 {count}개 동시 실행', { count: state?.maxConcurrent || 2 })}</small></div>
          <button className="button compact" aria-label={t('모든 채팅 중지')} disabled={!active.length || !!pending} onClick={() => void panelAction('stop', async () => { await command(() => bridge!.aiStop()); })}><Square size={11} />{t('전체 중지')}</button>
        </footer>
      )}
    </aside>
  );
}

function ChatColumn({ chat, collapsed, onToggle, provider, panes, profiles, draft, onDraft, command, onFork }: {
  chat: AiChat;
  collapsed: boolean;
  onToggle: () => void;
  provider?: ProviderInfo;
  panes: Pane[];
  profiles: Profile[];
  draft: string;
  onDraft: (value: string) => void;
  command: (operation: () => Promise<AiState>) => Promise<AiState>;
  onFork: (provider: AiProviderId, carry: boolean) => Promise<void>;
}) {
  const inputId = useId();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [forking, setForking] = useState(false);
  const [carry, setCarry] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const active = isChatActive(chat);
  const external = panes.filter((pane) => pane.kind === 'external');
  const missingTargets = chat.paneIds.filter((id) => !external.some((pane) => pane.id === id));
  const models = provider?.models || [];
  const model = models.find((item) => item.id === chat.model);
  const efforts = [...new Set(model?.efforts || [])].filter((effort) => effort !== 'default');
  const otherProvider = chat.provider === 'claude' ? 'codex' : 'claude';
  const canSend = !active && !busy && !!draft.trim() && provider?.status === 'ready' && !missingTargets.length;

  useEffect(() => {
    const element = messagesRef.current;
    if (element && followOutput.current) element.scrollTop = element.scrollHeight;
  }, [chat.messages]);

  const act = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await operation();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy('');
    }
  };
  const patch = (value: AiChatPatch) => act('update', () => command(() => bridge!.aiUpdateChat(chat.id, value)));
  const send = () => {
    if (!canSend) return;
    const original = draft;
    followOutput.current = true;
    void act('send', async () => {
      await command(() => bridge!.aiSend(chat.id, original.trim()));
      if (latestDraft.current === original) onDraft('');
    });
  };

  return (
    <section className="ai-chat-column" role="region" aria-label={t('{title} 채팅', { title: chat.title })} data-chat-id={chat.id}>
      <div className={'ai-chat-controls' + (collapsed ? ' collapsed' : '')}>
      <header className="ai-chat-heading">
        <div><small>{providerName(chat.provider)}</small><h3 title={chat.title}>{chat.title}</h3></div>
        {!collapsed && <>
        <button className="icon-button" aria-label={t('채팅 이름 변경')} title={t('이름 변경')} disabled={!!busy} onClick={() => { setTitle(chat.title); setRenaming(!renaming); }}><Pencil size={13} /></button>
        <button className="icon-button" aria-label={t('다른 AI로 새 채팅')} title={t('다른 AI로 새 채팅')} disabled={!!busy} aria-expanded={forking} onClick={() => setForking(!forking)}><GitBranch size={14} /></button>
        <button className="icon-button" aria-label={t('채팅 보관')} title={active ? t('채팅을 중지한 후 보관할 수 있어요') : t('채팅 보관')} disabled={active || !!busy} onClick={() => void patch({ archived: true })}><Archive size={13} /></button>
        </>}
        <button className="icon-button ai-fold" aria-label={collapsed ? t('채팅 설정 펼치기') : t('채팅 설정 접기')} title={collapsed ? t('채팅 설정 펼치기') : t('채팅 설정 접기')} aria-expanded={!collapsed} aria-controls={inputId + '-settings'} onClick={onToggle}><ChevronDown size={15} /></button>
      </header>
      <div id={inputId + '-settings'} hidden={collapsed}>
      {renaming && <form className="ai-rename" onSubmit={(event) => { event.preventDefault(); if (title.trim()) void act('rename', async () => { await command(() => bridge!.aiUpdateChat(chat.id, { title: title.trim() })); setRenaming(false); }); }}>
        <input aria-label={t('채팅 이름')} autoFocus maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(false); }} />
        <button className="icon-button" aria-label={t('이름 저장')} disabled={!title.trim() || !!busy}><Check size={14} /></button>
        <button className="icon-button" type="button" aria-label={t('이름 변경 취소')} onClick={() => setRenaming(false)}><X size={13} /></button>
      </form>}
      {forking && <div className="ai-fork">
        <b>{t('{provider}에서 새 대화 시작', { provider: providerName(otherProvider) })}</b>
        <label><input type="checkbox" checked={carry} onChange={(event) => setCarry(event.target.checked)} />{t('최근 보이는 대화 가져오기')}</label>
        <p>{t('선택하면 최근 메시지 내용을 새 채팅에 전달합니다. 기존 AI의 세션 기억은 옮겨지지 않아요.')}</p>
        <button className="button compact" disabled={!!busy} aria-label={t('{provider}로 새 채팅 만들기', { provider: providerName(otherProvider) })} onClick={() => void act('fork', () => onFork(otherProvider, carry))}><GitBranch size={12} />{t('새 채팅 만들기')}</button>
      </div>}

      <div className="ai-chat-settings">
        <div className="ai-model-row">
          <label htmlFor={inputId + '-model'}>{t('모델')}<select id={inputId + '-model'} value={chat.model} disabled={!!busy || !provider} onChange={(event) => {
            const nextModel = event.target.value;
            const supports = models.find((item) => item.id === nextModel)?.efforts || [];
            void patch({ model: nextModel, effort: supports.includes(chat.effort) ? chat.effort : 'default' });
          }}>
            <option value="">{models.find((item) => item.id === '')?.label || t('런타임 기본값')}</option>
            {chat.model && !model && <option value={chat.model}>{t('{selection} · 이전 선택', { selection: chat.model })}</option>}
            {models.filter((item) => item.id).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>
          <label htmlFor={inputId + '-effort'}>{t('추론 강도')}<select id={inputId + '-effort'} value={chat.effort} disabled={!!busy || !efforts.length} onChange={(event) => void patch({ effort: event.target.value })}>
            <option value="default">{t('기본값')}</option>
            {chat.effort !== 'default' && !efforts.includes(chat.effort) && <option value={chat.effort}>{t('{selection} · 이전 선택', { selection: chat.effort })}</option>}
            {efforts.map((effort) => <option key={effort} value={effort}>{effortLabels[effort] ? t(effortLabels[effort]) + ' (' + effort + ')' : effort}</option>)}
          </select></label>
        </div>
        {active && <p className="ai-settings-note">{t('모델·추론 강도 변경은 다음 메시지부터 적용돼요.')}</p>}
        <details className="ai-targets" open>
          <summary><Monitor size={12} /><span>{t('함께 볼 화면')}</span><b>{t('{count}개', { count: chat.paneIds.length })}</b><ChevronDown size={12} /></summary>
          <div className="ai-target-options">
            {external.map((pane) => <label key={pane.id} title={pane.url}>
              <input type="checkbox" aria-label={t('대상 {title}', { title: pane.title })} checked={chat.paneIds.includes(pane.id)} disabled={active || !!busy} onChange={(event) => void patch({ paneIds: event.target.checked ? [...chat.paneIds, pane.id] : chat.paneIds.filter((id) => id !== pane.id) })} />
              <span>{pane.title}</span><small>{pane.browser === 'chrome' ? 'Chrome · ' : ''}{profiles.find((profile) => profile.id === pane.profileId)?.name || t('프로필')}</small>
            </label>)}
            {!external.length && <p>{t('이 세트에 웹 화면이 없어요.')}</p>}
          </div>
          {missingTargets.length > 0 && <p className="ai-target-warning">{t('닫힌 대상 {count}개가 있어요.', { count: missingTargets.length })} <button disabled={active || !!busy} onClick={() => void patch({ paneIds: chat.paneIds.filter((id) => !missingTargets.includes(id)) })}>{t('닫힌 대상 제거')}</button></p>}
          <p className="ai-target-note">{active ? t('실행이 끝날 때까지 선택한 화면이 고정됩니다.') : chat.paneIds.length ? t('선택한 화면만 읽고 조작할 수 있어요.') : t('선택한 화면이 없어요 · 대화만 진행합니다.')}</p>
        </details>
      </div>
      </div>
      </div>

      <div className="ai-chat-status" role="status">
        <span className={'ai-status-badge ' + chat.status}>{active && chat.status !== 'queued' ? <LoaderCircle size={11} className="ai-spinning" /> : <i />}{chatStatusLabel[chat.status]}</span>
        <small>{chat.status === 'queued' ? t('실행 자리 또는 대상 화면을 기다려요') : chat.appliedModel ? chat.appliedModel + (chat.appliedEffort ? ' · ' + chat.appliedEffort : '') : t('독립된 대화 기록')}</small>
      </div>
      {(error || chat.error) && <div className="ai-chat-errors">{error && <p className="ai-error" role="alert">{error}</p>}{chat.error && chat.error !== error && <p className="ai-error" role="alert">{chat.error}</p>}</div>}

      <div ref={messagesRef} className="ai-messages" role="log" aria-label={t('대화 메시지')} aria-live="polite" aria-relevant="additions text" onScroll={(event) => {
        const element = event.currentTarget;
        followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
      }}>
        {chat.messages.length ? chat.messages.map((message) => <article className={'ai-message ' + message.role} data-message-role={message.role} key={message.id}>
          <div className="ai-message-meta"><b>{message.role === 'user' ? t('나') : message.role === 'assistant' ? providerName(chat.provider) : t('대화 안내')}</b><time dateTime={message.createdAt}>{clockLabel(message.createdAt)}</time></div>
          <div className="ai-message-content">{message.content}</div>
        </article>) : <div className="ai-conversation-empty"><MessageSquare size={22} /><b>{t('{provider}와 무엇을 해볼까요?', { provider: providerName(chat.provider) })}</b><p>{t('요청을 보내면 응답과 작업 과정이')}<br />{t('여기에 실시간으로 표시됩니다.')}</p></div>}
        {chat.status === 'running' && <div className="ai-responding"><i /><i /><i /><span>{t('응답을 받고 있어요')}</span></div>}
      </div>

      <details className="ai-actions">
        <summary><span>{t('작업 기록')}</span><small>{chat.events.length ? t('최근 {count}개', { count: Math.min(chat.events.length, 60) }) : t('아직 없음')}</small><ChevronDown size={12} /></summary>
        <div>{chat.events.slice(-60).map((event) => <p key={event.id}><time dateTime={event.createdAt}>{clockLabel(event.createdAt)}</time><span>{event.message}</span></p>)}{!chat.events.length && <p>{t('화면 읽기·클릭 등 실행 과정이 표시됩니다.')}</p>}</div>
        {chat.usage && <small className="ai-usage">{t('입력 {input} · 출력 {output} 토큰', { input: chat.usage.inputTokens?.toLocaleString() ?? '—', output: chat.usage.outputTokens?.toLocaleString() ?? '—' })}</small>}
      </details>

      <div className="ai-composer">
        {provider && provider.status !== 'ready' && <p className="ai-provider-warning">{t('{provider} 연결을 먼저 확인해 주세요.', { provider: providerName(chat.provider) })} {provider.detail}</p>}
        <textarea aria-label={t('메시지')} value={draft} maxLength={32768} rows={3} placeholder={active ? t('다음 메시지를 미리 작성하세요…') : t('AI에게 요청할 내용을 적어 주세요…')} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
        }} />
        <div><small>{t('Ctrl + Enter로 보내기')}</small>{active ? <button className="button compact ai-stop" aria-label={t('이 채팅 중지')} disabled={chat.status === 'stopping' || busy === 'stop'} onClick={() => void act('stop', () => command(() => bridge!.aiStop(chat.id)))}><Square size={11} />{chat.status === 'stopping' ? t('중지 중') : t('중지')}</button> : null}<button className="ai-send" aria-label={t('메시지 보내기')} disabled={!canSend} onClick={send}>{busy === 'send' ? <LoaderCircle className="ai-spinning" size={16} /> : <ArrowUp size={17} />}</button></div>
      </div>
    </section>
  );
}
