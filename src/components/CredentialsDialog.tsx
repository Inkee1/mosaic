import { useEffect, useState } from 'react';
import { KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { Profile } from '../model';
import { native } from '../native';
import type { SavedCredential } from '../native';
import { Modal } from './Dialogs';
import { t } from '../i18n';

export function CredentialsDialog({
  profile,
  paneId,
  pageUrl,
  onClose,
}: {
  profile: Profile;
  paneId?: string;
  pageUrl?: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<SavedCredential[]>([]);
  const [url, setUrl] = useState(pageUrl || 'https://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const load = async () => {
    if (!native) return;
    setItems(
      await native.listCredentials({ profileId: profile.id, url: paneId ? pageUrl : undefined }),
    );
    setLoaded(true);
  };
  useEffect(() => {
    let current = true;
    setLoaded(false);
    setItems([]);
    setError('');
    setMessage('');
    if (pageUrl) setUrl(pageUrl);
    native
      ?.listCredentials({ profileId: profile.id, url: paneId ? pageUrl : undefined })
      .then((value) => {
        if (current) {
          setItems(value);
          setLoaded(true);
        }
      })
      .catch((err) => {
        if (current) setError(err.message);
      });
    return () => {
      current = false;
    };
  }, [profile.id, paneId, pageUrl]);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await task();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t('{name} · 저장 비밀번호', { name: profile.name })}
      subtitle={
        paneId
          ? t("이 화면에 사용할 계정을 선택하세요. 다른 화면의 로그인은 바뀌지 않아요.")
          : t("같은 사이트의 여러 계정을 함께 보관할 수 있어요.")
      }
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="credential-context">
        <KeyRound size={17} />
        <span>
          {paneId
            ? (() => {
                try {
                  return new URL(pageUrl!).origin;
                } catch {
                  return pageUrl;
                }
              })()
            : t("프로필에 저장한 사이트 계정")}
        </span>
      </div>
      {!native && (
        <p className="form-note">
          {t("비밀번호 저장과 로그인은 Mosaic 데스크톱 앱에서 사용할 수 있어요.")}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="account-success" role="status">
          {t(message)}
        </p>
      )}
      <div className="credential-list">
        {native && !loaded && !error && <p className="muted small">{t("저장한 계정을 불러오는 중…")}</p>}
        {loaded && !items.length && (
          <p className="muted small">{t("아직 저장한 계정이 없어요. 아래에서 추가하세요.")}</p>
        )}
        {items.map((item) => (
          <div className="credential-row" key={item.id}>
            <span>
              <b>{item.username}</b>
              <small>{item.origin}</small>
            </span>
            {paneId && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await native!.fillCredential({
                      paneId,
                      profileId: profile.id,
                      credentialId: item.id,
                      origin: item.origin,
                    });
                    setMessage('이 화면에 입력했어요. 로그인 버튼은 직접 눌러 주세요.');
                  })
                }
              >
                {t("이 화면에 채우기")}
              </button>
            )}
            <button
              type="button"
              className={deleteId === item.id ? 'button danger' : 'icon-button'}
              disabled={busy}
              aria-label={
                t(deleteId === item.id ? '{username} 삭제 확인' : '{username} 저장 비밀번호 삭제', { username: item.username })
              }
              onClick={() => {
                if (deleteId !== item.id) {
                  setDeleteId(item.id);
                  return;
                }
                run(async () => {
                  await native!.deleteCredential(profile.id, item.id);
                  setDeleteId(null);
                  await load();
                });
              }}
            >
              {deleteId === item.id ? t("삭제 확인") : <Trash2 size={15} />}
            </button>
          </div>
        ))}
      </div>
      <form
        className="new-profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await native!.saveCredential({ profileId: profile.id, url, username, password });
            setPassword('');
            setUsername('');
            await load();
            setMessage('암호화해서 저장했어요.');
          });
        }}
      >
        <h3>
          <Plus size={15} />
          {t("계정 추가 · 비밀번호 변경")}
        </h3>
        <fieldset disabled={!native || busy}>
          <label className="credential-site">
            <span className="field-label">{t("사이트 주소")}</span>
            <input
              className="form-input"
              type="url"
              required
              maxLength={2048}
              value={url}
              readOnly={!!paneId}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </label>
          <div className="form-two-columns">
            <label>
              <span className="field-label">{t("아이디 또는 이메일")}</span>
              <input
                className="form-input"
                required
                autoComplete="off"
                maxLength={320}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t("비밀번호")}</span>
              <input
                className="form-input"
                type="password"
                required
                autoComplete="new-password"
                maxLength={8192}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </div>
          <p className="muted small">{t("같은 사이트·아이디로 저장하면 기존 비밀번호를 바꿉니다.")}</p>
        </fieldset>
        <div className="form-note">
          <ShieldCheck size={16} />
          <span>
            {t("이 PC의 Windows 계정으로 암호화해 보관합니다.")}
            <br />
            {t("채우기는 직접 선택할 때만 실행하며 로그인 버튼을 누르지 않습니다.")}
          </span>
        </div>
        <div className="modal-footer">
          <button className="button" type="button" disabled={busy} onClick={onClose}>
            {t("닫기")}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={!native || busy || !username.trim() || !password}
          >
            <KeyRound size={15} />
            {busy ? t("처리 중…") : t("비밀번호 저장")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
