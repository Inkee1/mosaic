import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Globe2,
  Grid2X2,
  Keyboard,
  KeyRound,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import { host, resolveAddressInput, sampleForUrl, samples } from '../model';
import type { Pane, Profile, Workspace } from '../model';
import { SiteIcon } from './BrowserPane';
import { native } from '../native';
import { CredentialsDialog } from './CredentialsDialog';
import { t } from '../i18n';

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const titleId = useRef('dialog-' + crypto.randomUUID());
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={'modal' + (wide ? ' modal-wide' : '')}
      aria-labelledby={titleId.current}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-heading">
        <div>
          <h2 id={titleId.current}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button type="button" className="icon-button" aria-label={t("대화상자 닫기")} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function AddPaneDialog({
  profiles,
  onAdd,
  onClose,
}: {
  profiles: Profile[];
  onAdd: (pane: Omit<Pane, 'id' | 'addressOpen'>) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const [profileId, setProfileId] = useState(profiles[0].id);
  const [error, setError] = useState('');
  return (
    <Modal title={t("새로운 화면 추가")} subtitle={t("어떤 화면을, 어떤 프로필로 열까요?")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const normalized = resolveAddressInput(url);
            const sample = sampleForUrl(normalized);
            onAdd({
              title: sample ? t(sample.title) : host(normalized).slice(0, 120),
              url: normalized,
              kind: sample?.kind ?? 'external',
              profileId,
            });
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label className="field-label" htmlFor="new-url">
          {t("주소 또는 검색어")}
        </label>
        <div className="form-input with-icon">
          <Globe2 size={17} />
          <input
            id="new-url"
            autoFocus
            placeholder={t("Google 검색 또는 웹주소 입력")}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError('');
            }}
            maxLength={2048}
          />
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="sample-shortcuts">
          {(native
            ? [
                {
                  kind: 'external' as const,
                  title: 'Google',
                  label: 'Google',
                  url: 'https://www.google.com/',
                },
                {
                  kind: 'external' as const,
                  title: t("네이버"),
                  label: '네이버',
                  url: 'https://www.naver.com/',
                },
                {
                  kind: 'external' as const,
                  title: 'ChatGPT',
                  label: 'ChatGPT',
                  url: 'https://chatgpt.com/',
                },
                {
                  kind: 'external' as const,
                  title: 'Claude',
                  label: 'Claude',
                  url: 'https://claude.ai/',
                },
              ]
            : samples
          ).map((sample) => (
            <button
              type="button"
              key={sample.url}
              onClick={() => {
                setUrl(sample.url);
                setError('');
              }}
            >
              <SiteIcon kind={sample.kind} />
              {t(sample.label)}
            </button>
          ))}
        </div>
        <label className="field-label profile-field-label">
          {t("이 화면에 사용할 프로필")} <span>{native ? t("독립 로그인 세션") : t("데모 프로필")}</span>
        </label>
        <div className="profile-options">
          {profiles.map((profile) => (
            <button
              type="button"
              className={'profile-option' + (profileId === profile.id ? ' selected' : '')}
              key={profile.id}
              onClick={() => setProfileId(profile.id)}
              aria-pressed={profileId === profile.id}
            >
              <span
                className="profile-avatar"
                style={{ '--profile-color': profile.color } as React.CSSProperties}
              >
                <UserRound size={17} />
              </span>
              <span>
                <b>{profile.name}</b>
                <small>{profile.note || t("사용자 프로필")}</small>
                {profile.googleEmail && <small>{profile.googleEmail}</small>}
              </span>
              {profileId === profile.id && <Check size={17} />}
            </button>
          ))}
        </div>
        <div className="form-note">
          <ShieldCheck size={16} />
          <span>
            {t("같은 프로필이어도 화면마다 로그인 상태가 따로 유지됩니다.")}
            <br />
            {native ? (
              <>{t("미리 준비한 로그인은 새 화면에 처음 한 번 이어받아요.")}</>
            ) : (
              <>
                {t("프로필 선택과 저장을 체험하는 UI입니다.")}
                <br />
                {t("실제 로그인은 Chromium 엔진 연결 후 사용할 수 있어요.")}
              </>
            )}
          </span>
        </div>
        <div className="modal-footer">
          <button className="button" type="button" onClick={onClose}>
            {t("취소")}
          </button>
          <button className="button primary" type="submit">
            <Plus size={16} />
            {t("화면 추가")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SaveDialog({
  workspace,
  renaming = false,
  onSave,
  onClose,
}: {
  workspace: Workspace;
  renaming?: boolean;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(workspace.name);
  return (
    <Modal
      title={renaming ? t("세트 이름 변경") : t("이 세트에 이름을 붙여 주세요")}
      subtitle={t("주소, 프로필, 배치는 세트마다 자동으로 저장되고 있어요.")}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim());
        }}
      >
        <label className="field-label" htmlFor="set-name">
          {t("세트 이름")}
        </label>
        <input
          className="form-input"
          id="set-name"
          autoFocus
          maxLength={60}
          value={name}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("예: 월요일 리서치")}
        />
        <div className="save-preview">
          <div className="save-grid">
            <Grid2X2 size={26} />
          </div>
          <div>
            <b>{workspace.panes.length === 1 ? t('1개의 화면') : t('{count}개의 화면', { count: workspace.panes.length })}</b>
            <span>
              {t('{columns}열 × {rows}행 · 프로필 설정 포함', { columns: workspace.columns, rows: workspace.rows })}
            </span>
          </div>
          <Save size={18} />
        </div>
        <p className="muted small">
          {renaming ? t("이름은 자동으로 저장됩니다. 화면과 대화는 그대로 유지돼요.") : t("현재 세트의 이름을 변경합니다. 앱 종료 후 작성 중인 입력 복구는 각 사이트의 저장 기능에 따라 달라요.")}
        </p>
        <div className="modal-footer">
          <button className="button" type="button" onClick={onClose}>
            {t("취소")}
          </button>
          <button className="button primary" disabled={!name.trim()}>
            <Save size={15} />
            {renaming ? t("이름 변경") : t("세트 저장하기")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ProfilesDialog({
  profiles,
  onCreate,
  onUpdate,
  onClose,
}: {
  profiles: Profile[];
  onCreate: (name: string, note: string, color: string, googleEmail: string) => void;
  onUpdate: (profile: Profile) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [color, setColor] = useState('#447b64');
  const [googleEmail, setGoogleEmail] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [credentialProfile, setCredentialProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const login = async (profile: Profile, provider: 'google' | 'instagram' | 'naver') => {
    setError('');
    setOpening(profile.id);
    try {
      await native!.openProfileLogin(profile.id, provider);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOpening(null);
    }
  };
  if (credentialProfile)
    return (
      <CredentialsDialog profile={credentialProfile} onClose={() => setCredentialProfile(null)} />
    );
  return (
    <Modal
      title={t("나의 브라우저 프로필")}
      subtitle={t("계정을 미리 준비하고 화면을 추가할 때 선택하세요. 각 화면의 로그인은 따로 유지됩니다.")}
      onClose={onClose}
      wide
    >
      <div className="managed-profiles">
        {profiles.map((p) => (
          <div key={p.id} className="managed-profile">
            <span
              className="profile-avatar"
              style={{ '--profile-color': p.color } as React.CSSProperties}
            >
              <UserRound size={17} />
            </span>
            <span>
              <b>{p.name}</b>
              <small>{p.note || t("사용자 프로필")}</small>
              {p.googleEmail && <small>{p.googleEmail}</small>}
            </span>
            <div className="profile-account-actions">
              <button
                type="button"
                className="button"
                disabled={!native || opening !== null}
                onClick={() => login(p, 'google')}
                aria-label={t('{name} Google 로그인', { name: p.name })}
              >
                {t("Google 로그인")}
              </button>
              <button
                type="button"
                className="button"
                disabled={!native || opening !== null}
                onClick={() => login(p, 'instagram')}
                aria-label={t('{name} 인스타 로그인', { name: p.name })}
              >
                {t("인스타")}
              </button>
              <button
                type="button"
                className="button"
                disabled={!native || opening !== null}
                onClick={() => login(p, 'naver')}
                aria-label={t('{name} 네이버 로그인', { name: p.name })}
              >
                {t("네이버")}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t('{name} 저장 비밀번호', { name: p.name })}
                title={t("저장 비밀번호")}
                onClick={() => setCredentialProfile(p)}
              >
                <KeyRound size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t('{name} 프로필 수정', { name: p.name })}
                title={t("프로필 수정")}
                onClick={() => {
                  setEditingId(p.id);
                  setName(p.name);
                  setNote(p.note);
                  setColor(p.color);
                  setGoogleEmail(p.googleEmail || '');
                }}
              >
                <Pencil size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted small account-hint">
        {t("Google 이메일은 계정을 구분하는 표시입니다. 로그인 버튼으로 사이트에서 직접 인증하세요. Google에서 이 브라우저의 로그인을 제한할 수 있습니다.")}
      </p>
      <form
        className="new-profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            if (editingId)
              onUpdate({
                id: editingId,
                name: name.trim(),
                note: note.trim(),
                color,
                googleEmail: googleEmail.trim(),
              });
            else onCreate(name.trim(), note.trim(), color, googleEmail.trim());
            setName('');
            setNote('');
            setGoogleEmail('');
            setEditingId(null);
          }
        }}
      >
        <h3>
          <Plus size={16} />
          {editingId ? t("프로필 수정") : t("새 프로필")}
        </h3>
        <div className="form-two-columns">
          <label>
            <span className="field-label">{t("프로필 이름")}</span>
            <input
              className="form-input"
              aria-label={t("프로필 이름")}
              maxLength={40}
              placeholder={t("예: 사이드 프로젝트")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t("설명 (선택)")}</span>
            <input
              className="form-input"
              aria-label={t("프로필 설명")}
              maxLength={80}
              placeholder={t("어떤 일에 사용할까요?")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
        <label className="profile-email-field">
          <span className="field-label">{t("Google 이메일 (선택)")}</span>
          <input
            className="form-input"
            type="email"
            maxLength={254}
            value={googleEmail}
            placeholder={t("예: brand@gmail.com")}
            onChange={(e) => setGoogleEmail(e.target.value)}
          />
        </label>
        <div className="color-options">
          {['#447b64', '#9a7ab7', '#c78d4b', '#5f87ba', '#b96f7a'].map((c) => (
            <button
              key={c}
              type="button"
              aria-label={t('프로필 색상 {color}', { color: c })}
              aria-pressed={c === color}
              onClick={() => setColor(c)}
              style={{ background: c }}
            >
              {c === color && <Check size={14} />}
            </button>
          ))}
        </div>
        <div className="form-note">
          <ShieldCheck size={16} />
          <span>
            {native ? (
              <>
                {t("프로필에서 준비한 로그인은 새 화면에 처음 한 번 이어집니다.")}
                <br />
                {t("같은 브랜드라도 화면별로 인스타 P·Q를 따로 사용할 수 있어요.")}
              </>
            ) : (
              <>
                {t("여기서는 이름과 색상만 저장합니다.")}
                <br />
                {t("실제 계정 로그인이나 Chrome 프로필 가져오기는 아직 연결되지 않았어요.")}
              </>
            )}
          </span>
        </div>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            {t("닫기")}
          </button>
          {editingId && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setEditingId(null);
                setName('');
                setNote('');
                setGoogleEmail('');
              }}
            >
              {t("수정 취소")}
            </button>
          )}
          <button
            className="button primary"
            disabled={!name.trim() || (!editingId && profiles.length >= 100)}
          >
            <Plus size={15} />
            {editingId ? t("프로필 저장") : t("프로필 만들기")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SwitcherDialog({
  panes,
  profiles,
  currentId,
  onSelect,
  onClose,
}: {
  panes: Pane[];
  profiles: Profile[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = panes.filter((p) =>
    (p.title + p.url + profiles.find((profile) => profile.id === p.profileId)?.name)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Modal
      title={t("어떤 화면으로 이동할까요?")}
      subtitle={t("제목, 주소, 프로필로 빠르게 찾아보세요.")}
      onClose={onClose}
    >
      <input
        className="form-input"
        aria-label={t("화면 찾기")}
        autoFocus
        placeholder={t("화면 찾기…")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="switcher-list">
        {filtered.map((pane) => (
          <button
            key={pane.id}
            className={pane.id === currentId ? 'selected' : ''}
            onClick={() => onSelect(pane.id)}
          >
            <SiteIcon kind={pane.kind} />
            <span>
              <b>{pane.title}</b>
              <small>
                {profiles.find((p) => p.id === pane.profileId)?.name} · {host(pane.url)}
              </small>
            </span>
            {pane.id === currentId ? <Check size={17} /> : <ChevronRight size={17} />}
          </button>
        ))}
        {!filtered.length && <div className="empty-search">{t("일치하는 화면이 없어요.")}</div>}
      </div>
      <div className="switcher-footer">
        <Keyboard size={14} />
        <span>{t("Alt + Shift + ← / → 로 바로 이동")}</span>
      </div>
    </Modal>
  );
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title={t("흐름을 끊지 않는 단축키")}
      subtitle={t("마우스를 내려놓고, 화면 사이를 가볍게 이동하세요.")}
      onClose={onClose}
    >
      <div className="shortcut-list">
        {[
          ['다음 / 이전 화면', 'Alt + Shift + → / ←'],
          ['화면 선택기', 'Alt + Shift + K'],
          ['집중 모드 / 모든 화면', 'Alt + Shift + F'],
          ['닫기 / 집중 모드에서 나가기', 'Esc'],
        ].map(([label, key]) => (
          <div key={label}>
            <span>{t(label)}</span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
      <div className="form-note">
        <Grid2X2 size={18} />
        <span>
          {t("작은 화면 위에서는 그 화면만 스크롤돼요.")}
          <br />
          {t("제목줄이나 화면 사이 여백 위에서는 전체 작업 공간이 움직입니다.")}
        </span>
      </div>
      <div className="modal-footer">
        <button className="button primary" onClick={onClose}>
          {t("알겠어요")}
          <ArrowRight size={15} />
        </button>
      </div>
    </Modal>
  );
}
