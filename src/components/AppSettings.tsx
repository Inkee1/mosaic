import { t, changeLanguage, getLanguagePreference } from '../i18n';
import type { LanguagePreference } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { Modal } from './Dialogs';
import { native } from '../native';
import type { AppInfo, AppLink, UpdateInfo } from '../native';
import { providerStatusLabel } from '../ai';
import type { ProviderInfo } from '../ai';
import '../app-settings.css';

export default function AppSettings({ initial, onInfo, onClose }: { initial: AppInfo; onInfo: (info: AppInfo) => void; onClose: () => void }) {
  const [info, setInfo] = useState(initial);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [metricsDraft, setMetricsDraft] = useState<boolean | null>(null);
  const [telemetryDraft, setTelemetryDraft] = useState<boolean | null>(null);
  const preferenceRevision = useRef(0);
  const accept = (next: AppInfo) => { setInfo(next); onInfo(next); };
  useEffect(() => {
    let alive = true;
    const revision = preferenceRevision.current;
    void native!.appInfo().then(next => { if (alive && revision === preferenceRevision.current) { setInfo(next); onInfo(next); } }).catch(() => { if (alive) setError(t("설정을 읽지 못했어요. 다시 열어 주세요.")); });
    void native!.aiProviders().then(next => { if (alive) setProviders(next); }).catch(() => { if (alive) setError(t("AI 연결 상태를 확인하지 못했어요. 새로고침해 주세요.")); });
    return () => { alive = false; };
  }, []);
  const run = async (name: string, action: () => Promise<void>) => {
    if (pending) return;
    setPending(name); setNotice(''); setError('');
    try { await action(); }
    catch { setError(t("요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.")); }
    finally { setPending(''); }
  };
  const link = (topic: AppLink) => void run('link', () => native!.openAppLink(topic));
  const setMetrics = (enabled: boolean) => {
    preferenceRevision.current++;
    setMetricsDraft(enabled);
    void run('consent', async () => {
      try { accept(await native!.setAppPreferences({ metricsEnabled: enabled })); }
      catch (failure) {
        try { accept(await native!.appInfo()); } catch { /* Keep the last confirmed state. */ }
        throw failure;
      } finally { setMetricsDraft(null); }
    });
  };
  const totals = info.metrics.totals;
  const setTelemetry = (enabled: boolean) => {
    preferenceRevision.current++;
    setTelemetryDraft(enabled);
    void run('telemetry', async () => {
      try { accept(await native!.setAppPreferences({ telemetryEnabled: enabled })); }
      catch (failure) {
        try { accept(await native!.appInfo()); } catch { /* Keep the last confirmed state. */ }
        throw failure;
      } finally { setTelemetryDraft(null); }
    });
  };
  return (
    <Modal title={t("Mosaic 설정")} subtitle={t("버전 ") + info.version + (info.channel === 'beta' ? t(" · 미리보기") : '')} onClose={onClose} wide>
      <div className="app-settings-content">
        <section className="app-settings-section">
          <h3>{t('언어')}</h3>
          <label className="settings-language">
            <span>{t('화면 표시 언어를 선택하세요. 웹사이트와 작성한 내용은 그대로 유지됩니다.')}</span>
            <select aria-label={t('언어')} value={getLanguagePreference()} disabled={!!pending} onChange={event => {
              const language = event.target.value as LanguagePreference;
              preferenceRevision.current++;
              void run('language', async () => {
                await changeLanguage(language);
                accept(await native!.appInfo());
                setUpdate(null); setNotice(''); setError('');
              });
            }}>
              <option value="system">{t('시스템 설정 따르기')}</option>
              <option value="ko">한국어</option>
              <option value="en">English</option>
            </select>
          </label>
        </section>
        <section className="app-settings-section">
          <h3>{t("처음 시작하기")}</h3>
          <ol className="setup-steps">
            <li><b>{t("웹 화면을 추가하세요.")}</b><span>{t("사이트에 직접 로그인하세요. 같은 사이트도 화면마다 별도 계정을 유지할 수 있어요.")}</span></li>
            <li><b>{t("사용할 AI를 연결하세요.")}</b><span>{t("공식 Claude Code 또는 Codex를 설치하고 본인 계정으로 로그인하세요. AI 이용 요금과 한도는 제공자 계정에 따릅니다.")}</span></li>
            <li><b>{t("작업할 화면을 선택하세요.")}</b><span>{t("오른쪽 AI 채팅에서 새 채팅을 만들고, 허용할 화면을 고른 뒤 요청하세요. 실행 중에도 중지할 수 있어요.")}</span></li>
          </ol>
          <div className="setup-providers">
            {(['codex', 'claude'] as const).map(id => {
              const provider = providers.find(item => item.id === id), name = id === 'codex' ? 'Codex' : 'Claude Code';
              const command = id === 'codex' ? 'codex login' : 'claude auth login';
              return <div className="setup-provider" key={id}>
                <div><b>{name}</b><span className={provider?.status === 'ready' ? 'provider-ready' : ''}>{provider ? t(providerStatusLabel[provider.status]) : t("연결 확인 중")}</span></div>
                <p>{t("설치 후 터미널에서 ")}<code>{command}</code>{t("을 실행하고 안내에 따라 로그인하세요.")}</p>
                <div className="settings-actions">
                  <button className="button compact" disabled={!!pending} aria-label={t('{name} 설치 안내', { name })} onClick={() => link(id)}>{t("설치 안내 ")}<ExternalLink size={12} /></button>
                  <button className="button compact" disabled={!!pending} aria-label={t('{name} 로그인 명령 복사', { name })} onClick={() => void run('copy', async () => { await navigator.clipboard.writeText(command); setNotice(t("로그인 명령을 복사했어요. 터미널에 붙여 넣어 실행해 주세요.")); })}>{t("명령 복사")}</button>
                </div>
              </div>;
            })}
          </div>
          <button className="button compact" disabled={!!pending} onClick={() => void run('providers', async () => { setProviders(await native!.aiProviders()); setNotice(t("AI 연결 상태를 다시 확인했어요.")); })}><RefreshCw size={13} />{t("AI 연결 다시 확인")}</button>
          <p className="settings-note">{t("처음에는 “선택한 페이지의 핵심 내용을 요약해 줘”처럼 결과를 쉽게 확인할 수 있는 요청으로 시작하세요. 로그인·인증 코드·결제는 직접 확인해 주세요.")}</p>
        </section>
        <section className="app-settings-section">
          <h3>{t("업데이트")}</h3>
          <p>{t("확인 버튼을 누를 때만 새 버전을 조회합니다. 다운로드와 설치는 직접 진행하며, 열려 있는 작업을 저장한 뒤 앱을 닫아 주세요.")}</p>
          {!info.updatesConfigured && <p className="settings-note">{t("이 미리보기에는 업데이트 배포 주소가 아직 등록되지 않았어요.")}</p>}
          <div className="settings-actions">
            <button className="button compact" disabled={!!pending} onClick={() => void run('update', async () => { setUpdate(await native!.checkUpdates()); })}><RefreshCw size={13} />{pending === 'update' ? t("확인 중…") : t("업데이트 확인")}</button>
            {update?.status === 'available' && <button className="button compact primary" disabled={!!pending} onClick={() => link('update')}>{t("새 버전 안내 열기 ")}<ExternalLink size={12} /></button>}
          </div>
          {update && <div className="settings-update" role="status">{update.latestVersion && <b>{t("새 버전 ")}{update.latestVersion}</b>}<p>{update.message}</p></div>}
        </section>
        <section className="app-settings-section">
          <h3><ShieldCheck size={16} />{t("데이터와 진단")}</h3>
          <p>{t("웹사이트의 내용과 스크린샷은 AI가 작업할 때 선택한 AI 제공자에게 전달될 수 있습니다. 비밀번호 저장소는 AI 도구에 제공하지 않습니다.")}</p>
          <label className="settings-consent">
            <input type="checkbox" checked={metricsDraft ?? info.preferences.metricsEnabled} disabled={!!pending} onChange={event => setMetrics(event.target.checked)} />
            <span><b>{t("이 기기에 사용 횟수 기록")}</b><small>{t("최대 90일간 앱 실행·AI 요청 종료·오류 횟수만 저장합니다. 끄면 저장된 횟수도 지웁니다.")}</small></span>
          </label>
          <p className="settings-note">{t("제작자에게 자동 전송하지 않습니다.")}</p>
          {info.preferences.metricsEnabled && <div className="settings-counts">
            <span>{t("앱 실행 ")}<b>{totals.app_open}</b></span><span>{t("AI 요청 ")}<b>{totals.ai_started}</b></span><span>{t("응답 종료 ")}<b>{totals.ai_completed}</b></span><span>{t("오류 ")}<b>{totals.ai_failed}</b></span><span>{t("중단 ")}<b>{totals.ai_cancelled}</b></span>
          </div>}
          <p className="settings-note">{t("응답 종료 횟수는 사이트에서 실제 작업이 성공했다는 뜻이 아닙니다.")}</p>
          <div className="settings-actions">
            <button className="button compact" disabled={!!pending || !info.preferences.metricsEnabled} onClick={() => void run('clear', async () => { accept(await native!.clearMetrics()); setNotice(t("사용 횟수를 지웠어요.")); })}>{t("사용 횟수 지우기")}</button>
            <button className="button compact" disabled={!!pending} onClick={() => void run('export', async () => { const result = await native!.exportDiagnostics(); setNotice(result.saved ? t("진단 요약을 저장했어요. 내용을 확인한 뒤 필요한 경우 직접 전달해 주세요.") : t("저장을 취소했어요.")); })}><Download size={13} />{t("진단 요약 저장")}</button>
          </div>
          <p className="settings-note">{t("진단 요약에는 앱·런타임 버전, 운영체제 종류, 위 숫자만 포함합니다. URL·대화·계정·비밀번호·개인 파일 경로는 포함하지 않습니다.")}</p>
        </section>
        <section className="app-settings-section">
          <h3>{t("선택적 사용자 수 집계")}</h3>
          <label className="settings-consent">
            <input type="checkbox" aria-label={t("사용자 수 집계에 참여")} checked={telemetryDraft ?? info.preferences.telemetryEnabled ?? false} disabled={!!pending || !info.telemetry?.configured} onChange={event => setTelemetry(event.target.checked)} />
            <span><b>{t("사용자 수 집계에 참여")}</b><small>{t("동의하면 하루 한 번 무작위 설치 ID, 앱 버전, OS 종류와 실행 여부를 전송합니다. 꺼도 모든 기능을 이용할 수 있어요.")}</small></span>
          </label>
          {info.telemetry?.configured ? <p className="settings-note">{t("전송받는 곳: PostHog ")}{info.telemetry.region === 'EU' ? t("유럽연합") : t("미국")}{t(" 서버. URL·방문 기록·대화·계정·화면은 전송하지 않으며 위치 분석과 사용자 프로필 생성을 사용하지 않습니다. 서버는 연결 과정에서 IP 주소를 볼 수 있습니다.")}</p> : <p className="settings-note">{t("집계 서버 연결을 준비 중입니다. 이 배포본은 사용자 수를 전송하지 않습니다.")}</p>}
          <p className="settings-note">{t("기존의 기기 내부 기록과 별도의 동의입니다. 끄면 새 전송을 중지하고 기기의 집계 ID를 지웁니다. 이미 서버가 받은 기록은 자동으로 삭제되지 않습니다. 다시 켜거나 재설치하면 새 설치로 집계될 수 있습니다.")}</p>
          {info.telemetry?.sendError && <p className="settings-note">{t("집계 전송이 지연되고 있습니다. 앱 사용에는 영향이 없으며 잠시 후 다시 시도합니다.")}</p>}
          <div className="settings-actions">
            {info.repository && <button className="button compact" disabled={!!pending} onClick={() => link('issues')}>{t("문제 제보 ")}<ExternalLink size={12} /></button>}
            {info.supportAvailable && <button className="button compact" disabled={!!pending} onClick={() => link('support')}>{t("문의하기 ")}<ExternalLink size={12} /></button>}
          </div>
        </section>
        {(info.recovered || info.storageError) && <p className="settings-warning">{info.storageError ? t("설정 저장에 문제가 있어요. 저장 공간과 권한을 확인해 주세요.") : t("설정 파일을 읽지 못해 기본값으로 복구했어요. 사용 횟수 기록은 꺼져 있습니다.")}</p>}
        {error && <p className="settings-warning" role="alert">{error}</p>}
        <p className="settings-feedback" role="status">{notice}</p>
      </div>
    </Modal>
  );
}
