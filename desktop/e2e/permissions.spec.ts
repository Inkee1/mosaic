import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('repeated website notification requests reuse one denial while other panes remain isolated', async () => {
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Permission fixture</title><button>Request notification</button><iframe srcdoc="<button>Inherited frame</button>"></iframe>'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-permissions-e2e-'));
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, theme: 'light', profiles: [{ id: 'test', name: 'Test', note: '', color: '#447b64' }], savedSets: [], workspace: { id: 'permissions', name: 'Permissions', columns: 2, rows: 1, panes: ['one', 'two'].map(id => ({ id, title: id, url: origin + '/' + id, profileId: 'test', kind: 'external', addressOpen: false })) } }));
  const app = await electron.launch({ executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined, args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=en'] : [resolve('.'), '--lang=en'], env: { ...process.env, MOSAIC_USER_DATA: directory } });
  try {
    await app.firstWindow();
    await expect.poll(() => app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().filter(wc => wc.getURL().startsWith(origin) && !wc.isLoading()).length, origin)).toBe(2);
    await app.evaluate(({ dialog }) => {
      (globalThis as any).permissionPrompts = 0;
      dialog.showMessageBox = async () => { (globalThis as any).permissionPrompts++; return { response: 0, checkboxChecked: false }; };
    });
    const request = (id: string) => app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      return wc.executeJavaScript('Notification.requestPermission()', true);
    }, origin + '/' + id);
    expect(await request('one')).toBe('denied');
    expect(await request('one')).toBe('denied');
    expect(await app.evaluate(() => (globalThis as any).permissionPrompts)).toBe(1);
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.reload(), origin + '/one');
    await expect.poll(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)?.isLoading(), origin + '/one')).toBe(false);
    expect(await request('one')).toBe('denied');
    expect(await app.evaluate(() => (globalThis as any).permissionPrompts)).toBe(1);
    expect(await app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      return wc.executeJavaScript('frames[0].Notification.requestPermission()', true);
    }, origin + '/two')).toBe('denied');
    expect(await request('two')).toBe('denied');
    expect(await app.evaluate(() => (globalThis as any).permissionPrompts)).toBe(2);
  } finally {
    await app.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});
