import { useEffect, useState } from 'react';
import { ExternalLink, Globe2, LoaderCircle, RotateCw } from 'lucide-react';
import { native } from '../native';
import type { NativePaneState } from '../native';
import { t } from '../i18n';

export default function NativePage({
  id,
  url,
  status,
}: {
  id: string;
  url: string;
  status?: NativePaneState;
}) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  useEffect(() => { setOpenError(''); }, [id, status?.browser]);
  const busy = opening || status?.chromeConnecting;
  const chromeTabCount = status?.targetCount || 1;
  const chrome = async () => {
    setOpening(true); setOpenError('');
    try { await native!.openInChrome(id); }
    catch (error) { setOpenError((error as Error).message); }
    finally { setOpening(false); }
  };
  return (
    <div className="native-placeholder">
      {status?.browser === 'chrome' ? (
        <>
          <Globe2 size={28} />
          <h3>{busy ? t("Chrome 연결 중…") : status.chromeConnected ? t("Chrome 연결됨") : t("Chrome 연결 끊김")}</h3>
          <p>{t("웹페이지는 Chrome에서, AI 명령은 오른쪽 채팅에서.")}</p>
          {status.chromeConnected && <p>{t(chromeTabCount === 1 ? '1개 탭 · {title}' : '{count}개 탭 · {title}', { count: chromeTabCount, title: status.activeTargetTitle || status.title })}</p>}
          <button className="button" disabled={busy} onClick={chrome}>
            <ExternalLink size={14} />{busy ? t("연결 중…") : status.chromeConnected ? t("Chrome 보기") : t("다시 연결")}
          </button>
          <button className="button" disabled={busy} onClick={() => native!.useMosaic(id).catch(error => setOpenError(error.message))}>{t("Mosaic에서 보기")}</button>
          <p>{t("화면별 전용 Chrome입니다. 처음에는 로그인이 필요할 수 있어요.")}</p>
          {(openError || status.error) && <p role="alert">{openError || status.error}</p>}
        </>
      ) : status?.compatibility === 'gate-electron' ? (
        <>
          <Globe2 size={28} />
          <h3>{t("Chrome으로 이어서 열기")}</h3>
          <p>{t("Gate가 Mosaic 안에서의 접속을 제한하고 있어요.")}</p>
          <button className="button" disabled={busy} onClick={chrome}>
            <ExternalLink size={14} />{busy ? t("연결 중…") : t("Chrome 연결")}
          </button>
          <p>{t("오른쪽 AI가 Chrome의 탭과 팝업도 이어서 조작합니다.")}</p>
          {(openError || status.error) && <p role="alert">{openError || status.error}</p>}
        </>
      ) : status?.error ? (
        <>
          <Globe2 size={30} />
          <h3>{t("페이지를 열지 못했어요")}</h3>
          <p>{status.error}</p>
          <code>{url}</code>
          <button className="button" onClick={() => native?.command(id, 'reload').catch(() => {})}>
            <RotateCw size={14} />
            {t("다시 시도")}
          </button>
          <button className="button" disabled={busy} onClick={chrome}><ExternalLink size={14} />{t("Chrome 연결")}</button>
          {openError && <p role="alert">{openError}</p>}
        </>
      ) : (
        <>
          <LoaderCircle className="native-loading" size={24} />
          <p>{busy ? t("Chrome 연결 중…") : t("웹페이지를 불러오는 중…")}</p>
        </>
      )}
    </div>
  );
}
