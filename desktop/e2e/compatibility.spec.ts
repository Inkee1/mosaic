import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('Gate notice offers connected Chrome, retains a connection error, and clears on navigation', async () => {
  const server = createServer((_request, response) => response.end('<title>Ready</title>Local page'));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const initial = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/';
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-compatibility-e2e-'));
  const workspace = { id: 'compatibility', name: 'Compatibility', columns: 2, rows: 2, panes: [
    { id: 'gate', title: 'Ready', url: initial, profileId: 'test', kind: 'external', addressOpen: true },
  ] };
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, theme: 'light', profiles: [{ id: 'test', name: 'Test', color: '#447b64', note: '' }], workspace, savedSets: [] }));
  const app = await electron.launch({ executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined, args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'], env: { ...process.env, MOSAIC_USER_DATA: directory } });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(wc => wc.getURL() === url && !wc.isLoading()), initial)).toBe(true);
    await app.evaluate(async ({ app, webContents }, url) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      (globalThis as any).compatibilityPaneId = wc.id;
      (globalThis as any).chromeCalls = [];
      // Only this isolated test session sees these fixture responses.
      await wc.session.protocol.handle('https', request => new Response(`<title>Gate fixture</title><h1>Site content</h1>${new URL(request.url).pathname === '/blocked' ? '<script>setTimeout(()=>{const cover=document.createElement("div");cover.className="guard-fixture";cover.style="position:fixed;inset:0;background:white;z-index:999999";document.body.appendChild(cover)},300)</script>' : ''}`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { ChromeRuntime } = require('./desktop/chrome/runtime.mjs');
      ChromeRuntime.prototype.open = async function (options: any) {
        (globalThis as any).chromeCalls.push(options);
        throw new Error('테스트 연결 오류');
      };
    }, initial);
    const pane = page.locator('[data-pane-id="gate"]');
    const address = pane.locator('.pane-address input');
    const target = 'https://www.gate.com/blocked?from=mosaic';
    await address.fill(target);
    await address.press('Enter');
    await expect(pane.getByRole('heading', { name: 'Chrome으로 이어서 열기' })).toBeVisible({ timeout: 7000 });
    expect(await app.evaluate(() => (globalThis as any).chromeCalls)).toEqual([]);
    const originalPage = await app.evaluate(async ({ webContents, BrowserWindow }) => {
      const wc = webContents.fromId((globalThis as any).compatibilityPaneId)!;
      return { document: await wc.executeJavaScript('({guard:!!document.querySelector(".guard-fixture"),ua:navigator.userAgent})'), visible: BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible() };
    });
    expect(originalPage.document.guard).toBe(true);
    expect(originalPage.document.ua).toContain('Electron/');
    expect(originalPage.visible).toBe(false);
    await pane.getByRole('button', { name: 'Chrome 연결', exact: true }).click();
    await expect(pane.getByRole('alert').first()).toContainText('테스트 연결 오류');
    const calls = await app.evaluate(() => (globalThis as any).chromeCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ paneId: 'gate', profileId: 'test', url: target });
    await page.screenshot({ path: 'test-results/compatibility-notice.png' });
    // Same host without the overlay must continue to work inside Mosaic.
    for (const next of ['https://www.gate.com/working', 'https://gate.com.example/blocked', initial]) {
      await address.fill(next);
      await address.press('Enter');
      await expect.poll(() => app.evaluate(({ webContents }) => { const wc = webContents.fromId((globalThis as any).compatibilityPaneId)!; return wc.isLoading() ? '' : wc.getURL(); })).toBe(next);
      await expect(pane.getByRole('heading', { name: 'Chrome으로 이어서 열기' })).toHaveCount(0);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible())).toBe(true);
    }
  } finally {
    const child = app.process(), timer = setTimeout(() => child.kill(), 3000);
    try {
      await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
      await app.close();
    } finally { clearTimeout(timer); }
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
