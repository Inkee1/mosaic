import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const preferences = JSON.parse(localStorage.getItem('test.app.preferences') || '{"onboardingDismissed":false,"metricsEnabled":false,"telemetryEnabled":false}');
    const totals = { app_open: 2, ai_started: 3, ai_completed: 1, ai_failed: 1, ai_cancelled: 1 };
    const info = () => ({ version: '0.7.0', channel: 'beta', repository: 'example/mosaic', supportAvailable: false, updatesConfigured: true, preferences: { ...preferences }, telemetry: { configured: !w.telemetryUnavailable, enabled: preferences.telemetryEnabled, region: 'US', lastSentDay: null, sendError: false, storageError: false }, metrics: { totals: { ...totals }, activeDays: 2, days: [] }, recovered: false, storageError: false });
    w.appCalls = [];
    w.mosaicNative = {
      bootstrap: { state: null, version: '0.7.0', dataPath: 'private/path', recovered: false, app: info() },
      saveState: async () => {}, syncPanes: async () => [], layout: async (data: any) => { w.nativeLayout = data; },
      aiState: async () => ({ version: 1, chats: [], maxConcurrent: 2 }),
      aiProviders: async () => [{ id: 'codex', name: 'Codex', status: 'missing', models: [] }, { id: 'claude', name: 'Claude Code', status: 'login-required', models: [] }],
      aiLogin: async () => ({ message: 'claude auth login' }),
      appInfo: async () => info(),
      setAppPreferences: async (patch: any) => {
        Object.assign(preferences, patch); localStorage.setItem('test.app.preferences', JSON.stringify(preferences));
        w.appCalls.push(['preferences', patch]); return info();
      },
      checkUpdates: async () => w.updateError ? { status: 'error', currentVersion: '0.7.0', message: '업데이트를 확인하지 못했어요.' } : { status: 'available', currentVersion: '0.7.0', latestVersion: '0.8.0', url: 'https://github.com/example/mosaic/releases/tag/v0.8.0', message: '새 버전이 있어요.' },
      openAppLink: async (topic: string) => { w.appCalls.push(['link', topic]); },
      exportDiagnostics: async () => { w.appCalls.push(['export']); return { saved: !w.cancelExport }; },
      clearMetrics: async () => { for (const key of Object.keys(totals)) (totals as any)[key] = 0; w.appCalls.push(['clear']); return info(); },
      onEvent: () => () => {},
    };
  });
  await page.goto('/');
});

test('first-use guide is nonblocking and stays dismissed after restart', async ({ page }) => {
  await expect(page.getByRole('button', { name: '시작 안내 열기' })).toBeVisible({ timeout: 2000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '시작 안내 닫기' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '시작 안내 열기' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mosaic 설정' }).click();
  await expect(page.getByRole('dialog', { name: 'Mosaic 설정' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Codex 설치 안내' })).toBeVisible();
  await page.getByRole('button', { name: 'Codex 설치 안내' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).appCalls)).toContainEqual(['link', 'codex']);
});

test('local metrics consent, clear and diagnostic cancellation remain explicit', async ({ page }) => {
  await page.getByRole('button', { name: 'Mosaic 설정' }).click();
  const consent = page.getByRole('checkbox', { name: '이 기기에 사용 횟수 기록' });
  await expect(consent).not.toBeChecked();
  await consent.check();
  await expect(page.getByText('제작자에게 자동 전송하지 않습니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '사용 횟수 지우기' }).click();
  await page.evaluate(() => { (window as any).cancelExport = true; });
  await page.getByRole('button', { name: '진단 요약 저장' }).click();
  await expect(page.getByRole('status').filter({ hasText: '저장을 취소했어요.' })).toBeVisible();
  await expect(page.getByText('private/path', { exact: false })).toHaveCount(0);
});

test('remote usage has separate opt-in, disclosure, persistence and an unconfigured state', async ({ page }) => {
  await page.getByRole('button', { name: 'Mosaic 설정' }).click();
  const remote = page.getByRole('checkbox', { name: '사용자 수 집계에 참여' });
  await expect(remote).not.toBeChecked();
  await page.getByRole('checkbox', { name: '이 기기에 사용 횟수 기록' }).check();
  await expect(remote).not.toBeChecked();
  await expect(page.getByText('PostHog 미국 서버', { exact: false })).toBeVisible();
  await remote.check();
  await expect.poll(() => page.evaluate(() => (window as any).appCalls)).toContainEqual(['preferences', { telemetryEnabled: true }]);
  await page.reload();
  await page.getByRole('button', { name: 'Mosaic 설정' }).click();
  await expect(remote).toBeChecked();
  await remote.uncheck();
  await page.getByRole('button', { name: '대화상자 닫기' }).click();
  await page.evaluate(() => { (window as any).telemetryUnavailable = true; });
  await page.getByRole('button', { name: 'Mosaic 설정' }).click();
  await expect(remote).toBeDisabled();
});

test('manual update result opens only a topic and failures leave modal and native layout usable', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 650 });
  await page.getByRole('button', { name: 'Mosaic 설정' }).click();
  await page.getByRole('button', { name: '업데이트 확인' }).click();
  await expect(page.getByText('새 버전 0.8.0')).toBeVisible();
  await page.getByRole('button', { name: '새 버전 안내 열기' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).appCalls)).toContainEqual(['link', 'update']);
  await page.evaluate(() => { (window as any).updateError = true; });
  await page.getByRole('button', { name: '업데이트 확인' }).click();
  await expect(page.getByText('업데이트를 확인하지 못했어요.')).toBeVisible();
  await page.getByRole('button', { name: '대화상자 닫기' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).nativeLayout?.blocked)).toBe(false);
  await expect(page.getByRole('button', { name: 'Mosaic 설정' })).toBeFocused();
});

test('consent reflects a pending click immediately, ignores stale reads and recovers a rejected save', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any, bridge = w.mosaicNative;
    const getInfo = bridge.appInfo, setPreferences = bridge.setAppPreferences;
    bridge.appInfo = () => new Promise(resolve => { w.resolveInitial = () => { getInfo().then(resolve); }; });
    bridge.setAppPreferences = (patch: any) => new Promise((resolve, reject) => {
      w.finishPreference = () => { setPreferences(patch).then(resolve); };
      w.failPreference = () => { bridge.appInfo = getInfo; reject(new Error('save failed')); };
    });
  });
  await page.getByRole('button', { name: 'Mosaic 설정' }).click();
  const consent = page.getByRole('checkbox', { name: '이 기기에 사용 횟수 기록' });
  await consent.check();
  await expect(consent).toBeDisabled();
  await page.evaluate(() => (window as any).resolveInitial());
  await expect(consent).toBeChecked();
  await page.evaluate(() => (window as any).finishPreference());
  await expect(consent).toBeEnabled();
  await consent.uncheck();
  await page.evaluate(() => (window as any).failPreference());
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(consent).toBeChecked();
  await expect(consent).toBeEnabled();
});
