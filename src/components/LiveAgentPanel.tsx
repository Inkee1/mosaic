import { useEffect, useState } from 'react';
import { Check, Copy, Link2, Play, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import { native } from '../native';
import { getLocale, t } from '../i18n';
import type { AgentInfo, AgentEvent } from '../native';
import type { Pane, Profile } from '../model';

export default function LiveAgentPanel({
  panes,
  profiles,
  onClose,
}: {
  panes: Pane[];
  profiles: Profile[];
  onClose: () => void;
}) {
  const external = panes.filter((p) => p.kind === 'external');
  const [selected, setSelected] = useState<string[]>([]);
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | { type: 'copy-config' }>('');
  const [copied, setCopied] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const refresh = (restoreSelection = false) =>
    native!
      .agentInfo()
      .then((next) => {
        setInfo(next);
        if (restoreSelection || next.enabled) setSelected(next.allowedPaneIds);
        if (next.error) setError(next.error);
      })
      .catch((e) => setError(e.message));
  useEffect(
    () =>
      native!.onEvent((event) => {
        if (event.type === 'agent') {
          if (event.phase !== 'state') setEvents((prev) => [event, ...prev].slice(0, 60));
          refresh(event.phase === 'access');
        }
      }),
    [],
  );
  const targetIdentity = external.map((p) => p.id + ':' + p.profileId).join('|');
  useEffect(() => {
    refresh(true);
  }, [targetIdentity]);
  useEffect(() => {
    const synced = () => refresh();
    window.addEventListener('mosaic-native-ready', synced);
    return () => window.removeEventListener('mosaic-native-ready', synced);
  }, []);
  const apply = async (enabled: boolean, ids = selected) => {
    try {
      setInfo(await native!.setAgentAccess({ enabled, paneIds: ids }));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggle = (id: string) => {
    const ids = selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id];
    setSelected(ids);
    if (info?.enabled) apply(ids.length > 0, ids);
  };
  const phaseLabel: Record<string, string> = {
    access: t('접근 설정 변경'),
    queued: t('작업 대기'),
    started: t('실행 중'),
    completed: t('완료'),
    failed: t('작업 오류'),
    stopped: t('사용자 제어 · 중지'),
    resumed: t('에이전트 제어 재개'),
  };
  return (
    <aside className="agent-panel live-agent-panel">
      <div className="agent-panel-heading">
        <span>
          <Sparkles size={16} />
          {t('에이전트 연결')}
        </span>
        <button className="icon-button" aria-label={t('에이전트 패널 접기')} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="live-agent-scroll">
        <div className={'live-connection ' + (info?.enabled ? 'enabled' : '')}>
          <Link2 size={19} />
          <div>
            <b>{info?.enabled ? t('선택한 화면에 연결 허용 중') : t('로컬 연결 대기')}</b>
            <span>
              {info?.activeCount
                ? t('{count}개 작업 실행 중', { count: info.activeCount })
                : t('외부 에이전트가 MCP로 연결합니다')}
            </span>
          </div>
        </div>
        <p className="live-agent-explanation">{t('사용 중인 AI 에이전트가 이 브라우저 화면을 읽고 조작할 수 있어요. 연결할 화면을 선택하세요.')}</p>
        <div className="live-target-list">
          {external.map((p) => (
            <div className="live-target" key={p.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={() => toggle(p.id)}
                />
                <span>
                  <b>{p.title}</b>
                  <small>{profiles.find((profile) => profile.id === p.profileId)?.name}</small>
                </span>
              </label>
              {info?.pausedPaneIds.includes(p.id) && (
                <button
                  className="button compact"
                  onClick={() =>
                    native!
                      .resumeAgent(p.id)
                      .then(setInfo)
                      .catch((e) => setError(e.message))
                  }
                >
                  <Play size={11} />
                  {t('재개')}
                </button>
              )}
            </div>
          ))}
        </div>
        {!external.length && <p className="muted small">{t('웹 주소로 화면을 먼저 추가하세요.')}</p>}
        <div className="live-access-note">
          <ShieldCheck size={15} />
          <span>{t('선택한 화면의 읽기·입력·클릭을 허용합니다. 직접 화면을 조작하면 해당 화면의 에이전트는 멈춥니다.')}</span>
        </div>
        <button
          className={'button ' + (info?.enabled ? '' : 'primary')}
          disabled={!selected.length && !info?.enabled}
          onClick={() => apply(!info?.enabled)}
        >
          {info?.enabled ? (
            <>
              <Square size={13} />
              {t('연결 허용 끄기')}
            </>
          ) : (
            <>
              <Link2 size={14} />
              {t('선택한 화면 연결 허용')}
            </>
          )}
        </button>
        <div className="live-config">
          <button className="live-config-toggle" onClick={() => setConfigOpen(!configOpen)}>
            {t('MCP 연결 설정')} <span>{configOpen ? '−' : '+'}</span>
          </button>
          {configOpen && (
            <>
              <p>{t('AI 앱의 MCP 서버 설정에 아래 내용을 추가하세요. Mosaic 데스크톱 앱이 실행 중이어야 합니다.')}</p>
              <pre>{info?.config || t('설정을 불러오는 중…')}</pre>
              <button
                className="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(info?.config || '');
                    setCopied(true);
                  } catch {
                    setError({ type: 'copy-config' });
                  }
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {t('설정 복사')}
              </button>
            </>
          )}
        </div>
        {error && (
          <div className="form-error" role="alert">
            {typeof error === 'string' ? error : t('설정을 선택해 직접 복사해 주세요.')}
          </div>
        )}
        <div className="agent-section-label">
          <b>{t('실시간 작업 기록')}</b>
          <span>{t('{count}개', { count: events.length })}</span>
        </div>
        <div className="live-events" aria-live="polite">
          {events.map((event, index) => (
            <div key={event.actionId ? event.actionId + event.phase + index : index}>
              <i className={event.phase} />
              <span>
                <b>{phaseLabel[event.phase] || event.phase}</b>
                <small>
                  {panes.find((p) => p.id === event.paneId)?.title || t('작업 공간')}
                  {event.method ? ' · ' + event.method : ''}
                </small>
                {event.message && <small>{event.message}</small>}
              </span>
              <time>
                {event.timestamp
                  ? new Date(event.timestamp).toLocaleTimeString(getLocale(), {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : ''}
              </time>
            </div>
          ))}
          {!events.length && (
            <p className="muted small">{t('연결된 에이전트의 작업이 여기에 표시됩니다.')}</p>
          )}
        </div>
      </div>
      <div className="live-agent-footer">
        <button
          className="button"
          onClick={() =>
            native!
              .stopAgent()
              .then(setInfo)
              .catch((e) => setError(e.message))
          }
        >
          <Square size={13} />
          {t('모든 에이전트 즉시 중지')}
        </button>
      </div>
    </aside>
  );
}
