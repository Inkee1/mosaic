import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

test('desktop setup, local consent, safe diagnostics and restart preserve existing browser state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-release-e2e-'));
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Private fixture</title><input value="private-field"><p>private-page-content</p>'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/?private-query';
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, theme: 'light', profiles: [{ id: 'p', name: 'Private profile', note: '', color: '#447b64' }], savedSets: [], workspace: { id: 'w', name: 'Private work', columns: 1, rows: 1, panes: [{ id: 'probe', profileId: 'p', title: 'Private title', url, kind: 'external', addressOpen: false }] } }));
  const launch = () => electron.launch({ executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined, args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'], env: { ...process.env, MOSAIC_USER_DATA: directory } });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    await expect(page.locator('[data-native="true"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '시작 안내 열기' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const initial = await page.evaluate(() => (window as any).mosaicNative.appInfo());
    expect(initial.preferences.metricsEnabled).toBe(false);
    expect(initial.metrics.days).toEqual([]);
    await page.getByRole('button', { name: '시작 안내 닫기' }).click();
    await page.getByRole('button', { name: 'Mosaic 설정' }).click();
    await page.getByRole('checkbox', { name: '이 기기에 사용 횟수 기록' }).check();
    await expect.poll(() => page.evaluate(async () => (await (window as any).mosaicNative.appInfo()).preferences.metricsEnabled)).toBe(true);
    await expect(page.getByText('제작자에게 자동 전송하지 않습니다.', { exact: true })).toBeVisible();
    const exportPath = join(directory, 'diagnostics-export.json');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
    await page.getByRole('button', { name: '진단 요약 저장' }).click();
    await expect(page.getByRole('status').filter({ hasText: '진단 요약을 저장했어요.' })).toBeVisible();
    const exported = await readFile(exportPath, 'utf8');
    expect(exported).not.toMatch(/private-|Private profile|private-query|connectionFile|Bearer/);
    expect(exported).not.toContain(directory);
    expect(JSON.parse(exported).networkTelemetry).toBe(false);
    const rejected = await page.evaluate(async () => {
      try { await (window as any).mosaicNative.openAppLink('https://untrusted.example'); return false; } catch { return true; }
    });
    expect(rejected).toBe(true);
    await page.getByRole('combobox', { name: '언어', exact: true }).selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('checkbox', { name: 'Record usage counts on this device' })).toBeChecked();
    const selected = await page.evaluate(() => (window as any).mosaicNative.appInfo());
    expect(selected.preferences.language).toBe('en');
    expect(selected.preferences.telemetryEnabled).toBe(false);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await app.close(); app = undefined;
    app = await launch(); page = await app.firstWindow();
    await expect(page.locator('[data-native="true"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Open getting started' })).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const restored = await page.evaluate(() => (window as any).mosaicNative.appInfo());
    expect(restored.preferences.metricsEnabled).toBe(true);
    expect(restored.preferences.language).toBe('en');
    expect(restored.locale).toBe('en');
    expect(restored.metrics.totals.app_open).toBe(1);
    expect(await page.evaluate(() => (window as any).mosaicNative.bootstrap.state.workspace.panes[0].url)).toBe(url);
    await page.getByRole('button', { name: 'Mosaic settings' }).click();
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ko');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await page.getByRole('checkbox', { name: '이 기기에 사용 횟수 기록' }).uncheck();
    await expect.poll(() => page.evaluate(async () => (await (window as any).mosaicNative.appInfo()).metrics.days)).toEqual([]);
    await page.getByRole('button', { name: '대화상자 닫기' }).click();
    expect(await app.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(item => item.getURL() === url);
      return wc?.executeJavaScript('typeof window.mosaicNative');
    }, url)).toBe('undefined');
  } finally {
    await app?.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});
