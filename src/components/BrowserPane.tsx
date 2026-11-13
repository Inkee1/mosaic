import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowLeft,
  ExternalLink,
  RotateCw,
  ChevronDown,
  ChevronUp,
  FileText,
  Globe2,
  KeyRound,
  Maximize2,
  Minimize2,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { host, resolveAddressInput, sampleForUrl } from '../model';
import type { Pane, Profile, RunStatus } from '../model';
import DemoPage from './DemoPages';
import NativePage from './NativePage';
import { native } from '../native';
import type { NativePaneState } from '../native';
import { Modal } from './Dialogs';
import { CredentialsDialog } from './CredentialsDialog';
import { t } from '../i18n';

export function SiteIcon({ kind }: { kind: Pane['kind'] }) {
  const Icon =
    kind === 'research'
      ? Search
      : kind === 'document'
        ? FileText
        : kind === 'analytics'
          ? TrendingUp
          : kind === 'chat'
            ? Sparkles
            : Globe2;
  return (
    <span className={'site-icon ' + kind}>
      <Icon size={14} />
    </span>
  );
}

export default function BrowserPane({
  pane,
  profile,
  index,
  focused,
  hidden,
  active,
  runStatus,
  progress,
  profiles,
  nativeStatus,
  onActivate,
  onUpdate,
  onFocus,
  onClose,
}: {
  pane: Pane;
  profile: Profile;
  index: number;
  focused: boolean;
  hidden: boolean;
  active: boolean;
  runStatus: RunStatus;
  progress: number;
  profiles?: Profile[];
  nativeStatus?: NativePaneState;
  onActivate: () => void;
  onUpdate: (patch: Partial<Pane>) => void;
  onFocus: () => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(pane.url);
  const [error, setError] = useState('');
  const [pendingProfile, setPendingProfile] = useState<string | null>(null);
  const [changingProfile, setChangingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const isNative = !!native && pane.kind === 'external';
  const isChrome = (nativeStatus?.browser || pane.browser) === 'chrome';
  const chromeTabCount = nativeStatus?.targetCount || 1;
  const command = (action: 'back' | 'forward' | 'reload' | 'zoom', value?: number) =>
    native?.command(pane.id, action, value).catch((err) => setError(err.message));
  useEffect(() => {
    setAddress(pane.url);
    setError('');
  }, [pane.url]);
  const agentActive =
    nativeStatus?.agentPhase === 'started' ||
    (runStatus === 'running' && pane.kind !== 'analytics' && pane.kind !== 'external');
  return (
    <article
      className={
        'browser-pane' +
        (focused ? ' focused' : '') +
        (hidden ? ' pane-hidden' : '') +
        (active ? ' active' : '') +
        (agentActive ? ' agent-active' : '')
      }
      data-pane-id={pane.id}
      data-native={isNative ? 'true' : undefined}
      onPointerDown={onActivate}
      onFocusCapture={onActivate}
      aria-label={t('{title} 브라우저', { title: pane.title })}
    >
      <div className="pane-titlebar">
        <button
          className="icon-button address-toggle"
          onClick={() => onUpdate({ addressOpen: !pane.addressOpen })}
          aria-expanded={pane.addressOpen}
          aria-label={t(pane.addressOpen ? '{title} 주소창 접기' : '{title} 주소창 펼치기', { title: pane.title })}
          title={t("주소창 펼치기 / 접기")}
        >
          {pane.addressOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        <SiteIcon kind={pane.kind} />
        <div className="pane-title">
          <b>{pane.title}</b>
          <span>{host(pane.url)}</span>
        </div>
        {agentActive && (
          <span
            className="pane-agent-dot"
            title={native ? t("에이전트 실행 중") : t("에이전트 데모 실행 중")}
          />
        )}
        <span
          className="profile-badge"
          title={
            t(native ? '{name} · 프로필을 바꾸면 페이지를 다시 엽니다' : '{name} · 데모 프로필', { name: profile.name })
          }
        >
          <i style={{ background: profile.color }} />
          {native && profiles ? (
            <select
              aria-label={t('{title} 프로필', { title: pane.title })}
              value={profile.id}
              onChange={(e) => {
                setProfileError('');
                setPendingProfile(e.target.value);
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            profile.name
          )}
        </span>
        {isNative && !isChrome && (
          <button
            type="button"
            className="icon-button"
            title={t("이 화면의 저장 비밀번호 · 독립 로그인")}
            aria-label={t('{title} 저장 비밀번호', { title: pane.title })}
            onClick={() => setCredentialsOpen(true)}
          >
            <KeyRound size={14} />
          </button>
        )}
        {isNative && (
          <button type="button" className="icon-button"
            title={isChrome ? t("연결된 Chrome 보기") : t("Chrome 연결 · AI로 계속 조작")}
            aria-label={t(isChrome ? '{title} Chrome 보기' : '{title} Chrome 연결', { title: pane.title })}
            disabled={nativeStatus?.chromeConnecting}
            onClick={() => native!.openInChrome(pane.id).catch(err => setError(err.message))}>
            <ExternalLink size={14} />
          </button>
        )}
        <button
          className="icon-button"
          onClick={onFocus}
          aria-label={t(focused ? '{title} 줄이기' : '{title} 크게 보기', { title: pane.title })}
          title={focused ? t("모든 화면으로") : t("크게 보기")}
        >
          {focused ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          className="icon-button pane-close"
          onClick={onClose}
          aria-label={t('{title} 닫기', { title: pane.title })}
          title={t("화면 닫기")}
        >
          <X size={13} />
        </button>
      </div>
      {credentialsOpen && (
        <CredentialsDialog
          profile={profile}
          paneId={pane.id}
          pageUrl={pane.url}
          onClose={() => setCredentialsOpen(false)}
        />
      )}
      {pendingProfile && (
        <Modal
          title={t("브라우저 프로필 변경")}
          subtitle={isChrome ? t("선택한 프로필의 전용 Chrome으로 연결합니다. 기존 Chrome 창은 유지됩니다.") : t("다른 프로필로 페이지를 새로 엽니다. 현재 페이지에 저장하지 않은 입력은 사라집니다.")}
          onClose={() => {
            if (!changingProfile) setPendingProfile(null);
          }}
        >
          <p>
            {profile.name} → {profiles?.find((p) => p.id === pendingProfile)?.name}
          </p>
          {profileError && (
            <p className="form-error" role="alert">
              {profileError}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button"
              disabled={changingProfile}
              onClick={() => setPendingProfile(null)}
            >
              {t("취소")}
            </button>
            <button
              className="button primary"
              disabled={changingProfile}
              onClick={async () => {
                setChangingProfile(true);
                setProfileError('');
                try {
                  const result = await native!.switchProfile(pane.id, pendingProfile);
                  onUpdate({ profileId: result.profileId, url: result.url, title: result.title, browser: result.browser });
                  setPendingProfile(null);
                } catch (error) {
                  setProfileError((error as Error).message);
                } finally {
                  setChangingProfile(false);
                }
              }}
            >
              {changingProfile ? t("새 프로필로 여는 중…") : t("프로필 변경하기")}
            </button>
          </div>
        </Modal>
      )}
      {pane.addressOpen && (
        <form
          className="pane-address"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const url = resolveAddressInput(address);
              const sample = sampleForUrl(url);
              if (isNative)
                native!.command(pane.id, 'navigate', url).catch((err) => setError(err.message));
              onUpdate({
                url,
                kind: sample?.kind ?? 'external',
                title: sample ? t(sample.title) : host(url).slice(0, 120),
              });
              setAddress(url);
              setError('');
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          {isNative && (
            <span className="native-nav">
              <button
                type="button"
                className="icon-button"
                aria-label={t("뒤로")}
                disabled={!nativeStatus?.canGoBack}
                onClick={() => command('back')}
              >
                <ArrowLeft size={13} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t("앞으로")}
                disabled={!nativeStatus?.canGoForward}
                onClick={() => command('forward')}
              >
                <ArrowRight size={13} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t("새로고침")}
                onClick={() => command('reload')}
              >
                <RotateCw size={13} />
              </button>
            </span>
          )}
          <ShieldCheck size={13} />
          <input
            aria-label={t('{title} 주소', { title: pane.title })}
            placeholder={t("Google 검색 또는 웹주소 입력")}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoFocus
          />
          <button className="icon-button" aria-label={t("검색 또는 이동")}>
            <ArrowRight size={14} />
          </button>
          {error && (
            <span className="address-error" role="alert">
              {error}
            </span>
          )}
        </form>
      )}
      <div className="pane-body" tabIndex={0} aria-label={t('{title} 콘텐츠', { title: pane.title })}>
        {isNative ? (
          <NativePage id={pane.id} url={pane.url} status={nativeStatus} />
        ) : (
          <DemoPage kind={pane.kind} url={pane.url} progress={progress} />
        )}
      </div>
      <div className="pane-bottom">
        <span>
          <span className="tiny-dot" />
          {isNative
            ? isChrome
              ? (nativeStatus?.chromeConnected ? (chromeTabCount === 1 ? t('Chrome 연결 · 1개 탭') : t('Chrome 연결 · {count}개 탭', { count: chromeTabCount })) : nativeStatus?.chromeConnecting ? t("Chrome 연결 중…") : t("Chrome 연결 끊김"))
              : nativeStatus?.compatibility
              ? t("Chrome에서 열기 필요")
              : nativeStatus?.error
              ? t("연결 오류")
              : agentActive
                ? t("에이전트 작업 중")
                : nativeStatus?.agentPhase === 'stopped'
                  ? t("사용자 제어")
                  : nativeStatus?.loading
                    ? t("불러오는 중")
                    : 'Chromium · ' + profile.name
            : agentActive
              ? t("데모 작업 중")
              : runStatus === 'paused' && pane.kind !== 'analytics' && pane.kind !== 'external'
                ? t("데모 일시정지")
                : t("로컬 미리보기")}
        </span>
        <span>
          {String(index + 1).padStart(2, '0')}
          {isNative && (
            <button
              className="native-zoom"
              title={t("클릭하면 화면 배율을 바꿉니다")}
              onClick={() =>
                command(
                  'zoom',
                  (nativeStatus?.zoom || 1) <= 0.75 ? 1 : (nativeStatus?.zoom || 1) - 0.1,
                )
              }
            >
              {Math.round((nativeStatus?.zoom || 1) * 100)}%
            </button>
          )}
          <span className="pane-corner">⌟</span>
        </span>
      </div>
    </article>
  );
}
