import {
  ArrowUpRight,
  Check,
  Circle,
  Ellipsis,
  Link2,
  Pause,
  Play,
  Plus,
  Radio,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import type { Pane, RunStatus } from '../model';
import { SiteIcon } from './BrowserPane';
import { t } from '../i18n';

const events = [
  { title: '작업 공간을 살펴봤어요', body: '선택한 샘플 화면을 연결했습니다.', time: '00:00' },
  { title: '브랜드 트렌드 정리', body: '리서치 화면에서 핵심 키워드 3개 수집', time: '00:04' },
  {
    title: '캠페인 노트에 인사이트 추가',
    body: '리서치와 문서를 하나의 흐름으로 연결',
    time: '00:08',
  },
  { title: '새로운 메시지 제안', body: '아이디어 스튜디오에 캠페인 초안 작성', time: '00:12' },
];
export default function AgentPanel({
  status,
  progress,
  panes,
  onStart,
  onPause,
  onStop,
  onClose,
  onConnect,
}: {
  status: RunStatus;
  progress: number;
  panes: Pane[];
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onClose: () => void;
  onConnect: () => void;
}) {
  const targets = panes.filter((p) => ['research', 'document', 'chat'].includes(p.kind));
  const running = status === 'running' || status === 'paused';
  return (
    <aside className="agent-panel">
      <div className="agent-panel-heading">
        <span>
          <Sparkles size={16} />
          {t('에이전트 스튜디오')}
        </span>
        <button className="icon-button" onClick={onClose} aria-label={t('에이전트 패널 접기')}>
          <X size={16} />
        </button>
      </div>
      <div className="agent-scroll">
        <div className="agent-intro">
          <span className="agent-orb">
            <Sparkles size={23} />
          </span>
          <div className="eyebrow">A LITTLE HELP. A BIGGER PICTURE.</div>
          <h2>
            {t('화면은 여러 개.')}
            <br />
            {t('작업은 하나의 흐름.')}
          </h2>
          <p>
            {t('리서치부터 정리까지,')}
            <br />
            {t('에이전트와 함께하는 작업을 그려보세요.')}
          </p>
        </div>
        <div className="connection-card">
          <span className="connection-symbol">
            <Link2 size={17} />
          </span>
          <div>
            <b>{t('나의 AI 연결')}</b>
            <small>{t('아직 연결된 에이전트가 없어요')}</small>
          </div>
          <button className="icon-button" onClick={onConnect} aria-label={t('AI 연결 안내')}>
            <ArrowUpRight size={16} />
          </button>
        </div>
        <div className="agent-section-label">
          <b>{t('이 작업 공간에서')}</b>
          <span>{t('{count}개 화면', { count: targets.length })}</span>
        </div>
        <div className="agent-targets">
          {targets.map((p) => (
            <div key={p.id}>
              <SiteIcon kind={p.kind} />
              <span>{p.title}</span>
              {status === 'completed' ? (
                <Check size={13} className="green-text" />
              ) : (
                <i className={running ? 'target-running' : ''} />
              )}
            </div>
          ))}
          {!targets.length && (
            <p className="muted small">{t('데모를 체험하려면 리서치, 문서 또는 AI 채팅 샘플을 추가하세요.')}</p>
          )}
        </div>
        <div className="agent-section-label activity-label">
          <b>{t('작업 타임라인')}</b>
          <span className="demo-label">DEMO</span>
        </div>
        {status === 'idle' ? (
          <div className="activity-empty">
            <div className="activity-line" />
            <span>
              <Circle size={10} />
              {t('모든 준비가 됐어요')}
            </span>
            <p>
              {t('아래 데모를 실행하면 여러 화면에서')}
              <br />
              {t('작업이 이어지는 모습을 볼 수 있어요.')}
            </p>
          </div>
        ) : (
          <div className="activity-timeline" aria-live="polite">
            {events.slice(0, Math.max(1, progress)).map((event, index) => (
              <div className="timeline-item" key={event.title}>
                <span
                  className={
                    'timeline-dot' +
                    (index === progress - 1 && status === 'running' ? ' processing' : '')
                  }
                >
                  {index < progress - 1 || status === 'completed' ? (
                    <Check size={10} />
                  ) : (
                    <Circle size={8} />
                  )}
                </span>
                <div>
                  <div>
                    <b>{t(event.title)}</b>
                    <small>{event.time}</small>
                  </div>
                  <p>{t(event.body)}</p>
                </div>
              </div>
            ))}
            <div className="run-state">
              <i className={status === 'running' ? 'pulsing' : ''} />
              {status === 'running'
                ? t('예시 작업을 재생하고 있어요')
                : status === 'paused'
                  ? t('데모가 일시정지됐어요')
                  : status === 'stopped'
                    ? t('데모를 중지했어요')
                    : t('예시 작업이 완료됐어요')}
            </div>
          </div>
        )}
        <div className="agent-tip">
          <span>✧</span>
          <p>
            <b>{t('지금 보고 있는 화면에서, 실시간으로.')}</b>
            <br />
            {t('AI가 작업하는 과정을 확인하고')}
            <br />
            {t('언제든 직접 이어받는 경험을 준비합니다.')}
          </p>
        </div>
      </div>
      <div className="agent-composer">
        <div className="demo-task">
          <span>
            <Sparkles size={14} />
            {t('체험할 예시 작업')}
          </span>
          <p>
            {t('트렌드를 조사하고, 캠페인 노트와')}
            <br />
            {t('새로운 메시지 초안으로 연결해 줘.')}
          </p>
          <div>
            <span className="demo-label">{t('미리 준비된 데모')}</span>
            <span>{t('{count}개 대상', { count: targets.length })}</span>
          </div>
        </div>
        <div className="agent-run-controls">
          {running ? (
            <>
              <button className="button primary" onClick={onPause}>
                {status === 'paused' ? <Play size={14} /> : <Pause size={14} />}
                {status === 'paused' ? t('계속하기') : t('일시정지')}
              </button>
              <button className="button stop-button" onClick={onStop} aria-label={t('데모 중지')}>
                <Square size={13} />
              </button>
            </>
          ) : (
            <button className="button primary" onClick={onStart} disabled={!targets.length}>
              <Play size={14} />
              {status === 'idle' ? t('함께 작업하는 모습 보기') : t('데모 다시 보기')}
            </button>
          )}
        </div>
        <p className="agent-disclaimer">{t('실제 AI 연결 없이 로컬 샘플만 변경합니다.')}</p>
      </div>
    </aside>
  );
}
