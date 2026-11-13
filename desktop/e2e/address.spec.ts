import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('address input reaches Google search in the native view and still navigates direct URLs', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<title>Address fixture</title><p>Local navigation fixture</p>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const baseUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-address-e2e-'));
  const workspace = { id: 'set', name: 'Address test', columns: 1, rows: 1, panes: [
    { id: 'address', title: 'Address fixture', url: baseUrl + '/', profileId: 'test', kind: 'external', addressOpen: true },
  ] };
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, theme: 'light', profiles: [{ id: 'test', name: 'Test', color: '#447b64', note: '' }], workspace, savedSets: [{ id: 'set', savedAt: new Date().toISOString(), workspace }], activeSetId: 'set', openSetIds: ['set'] }));
  const launch = () => electron.launch({ executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined, args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'], env: { ...process.env, MOSAIC_USER_DATA: directory } });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await expect(page.locator('[data-native="true"]')).toHaveCount(1);
    await expect.poll(() => app!.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().some(wc => wc.getURL() === url && !wc.isLoading()), baseUrl + '/')).toBe(true);
    // Intercept only the test pane's Google requests. The real renderer, IPC,
    // navigation and history still run, without sending test queries online.
    await app.evaluate(({ webContents }, prefix) => {
      const pane = webContents.getAllWebContents().find(wc => wc.getURL() === prefix + '/')!;
      (globalThis as any).addressTestPaneId = pane.id;
      (globalThis as any).addressSearchRequests = [];
      pane.session.webRequest.onBeforeRequest({ urls: ['https://www.google.com/search*'] }, (details, callback) => {
        (globalThis as any).addressSearchRequests.push(details.url);
        callback({ redirectURL: prefix + '/search-result' });
      });
    }, baseUrl);
    const address = page.locator('[data-pane-id="address"] .pane-address input');
    for (const query of ['서울 날씨 & 미세먼지', '운동화', 'user@example.com']) {
      await address.fill(query);
      await address.press('Enter');
      await expect.poll(async () => {
        const requests = await app!.evaluate(() => (globalThis as any).addressSearchRequests as string[]);
        return requests.some(request => new URL(request).searchParams.get('q') === query);
      }).toBe(true);
      await expect(address).toHaveValue(baseUrl + '/search-result');
    }
    await address.fill(baseUrl.replace('http://', '') + '/direct');
    await address.press('Enter');
    await expect.poll(() => app!.evaluate(({ webContents }) => {
      const pane = webContents.fromId((globalThis as any).addressTestPaneId)!;
      return pane.isLoading() ? '' : pane.getURL();
    })).toBe(baseUrl + '/direct');
    await expect(address).toHaveValue(baseUrl + '/direct');
  } finally {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
      const child = app.process();
      const timer = setTimeout(() => child.kill(), 3000);
      try { await app.close(); } finally { clearTimeout(timer); }
    }
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
