import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('ordinary batches close silently; protected iframe prompts once and cancel preserves every page', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/frame'
      ? '<title>Editor frame</title><textarea id="draft"></textarea>'
      : '<title>Close fixture</title><input id="draft">' + (request.url === '/two' ? '<iframe src="/frame"></iframe>' : ''));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-close-e2e-'));
  const workspace = { id: 'set', name: 'Close test', columns: 2, rows: 2, panes: ['one', 'two'].map(id => ({ id, title: id, url: url + '/' + id, profileId: 'test', kind: 'external', addressOpen: false })) };
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, theme: 'light', profiles: [{ id: 'test', name: 'Test', color: '#447b64', note: '' }], workspace, savedSets: [{ id: 'set', savedAt: new Date().toISOString(), workspace }], activeSetId: 'set', openSetIds: ['set'] }));
  const launch = () => electron.launch({ executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined, args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'], env: { ...process.env, MOSAIC_USER_DATA: directory } });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  let stage = 'launch';
  try {
    app = await launch();
    let page = await app.firstWindow();
    await expect(page.locator('[data-native="true"]')).toHaveCount(2);
    await expect.poll(() => app!.evaluate(({ webContents }, prefix) => {
      const views = webContents.getAllWebContents().filter(wc => wc.getURL().startsWith(prefix));
      return views.length === 2 && views.every(wc => !wc.isLoading());
    }, url)).toBe(true);
    await app.evaluate(({ dialog }) => {
      const state = globalThis as any;
      state.closeQuestions = [];
      state.closeAnswer = 0;
      dialog.showMessageBoxSync = (_window: any, options: any) => { state.closeQuestions.push(options); return state.closeAnswer; };
    });
    stage = 'install iframe guard';
    const ids = await app.evaluate(async ({ webContents }, prefix) => {
      const views = webContents.getAllWebContents().filter(wc => wc.getURL().startsWith(prefix));
      const first = views.find(wc => wc.getURL().endsWith('/one'))!;
      const second = views.find(wc => wc.getURL().endsWith('/two'))!;
      await first.executeJavaScript('document.querySelector("#draft").value="KEEP DRAFT"');
      await second.executeJavaScript(`window.frames[0].beforeUnloadCalls=0; window.frames[0].addEventListener('beforeunload',event=>{window.frames[0].beforeUnloadCalls++;if(event.isTrusted){event.preventDefault();event.returnValue='';}}, {once:true});`);
      return views.map(wc => wc.id).sort();
    }, url);
    stage = 'cancel protected batch';
    expect(await page.evaluate(() => (window as any).mosaicNative.requestClose(['one', 'two']))).toBe(false);
    const retained = await app.evaluate(async ({ webContents }, prefix) => {
      const views = webContents.getAllWebContents().filter(wc => wc.getURL().startsWith(prefix));
      return {
        ids: views.map(wc => wc.id).sort(),
        draft: await views.find(wc => wc.getURL().endsWith('/one'))!.executeJavaScript('document.querySelector("#draft").value'),
        calls: await views.find(wc => wc.getURL().endsWith('/two'))!.executeJavaScript('window.frames[0].beforeUnloadCalls'),
        questions: (globalThis as any).closeQuestions,
      };
    }, url);
    expect(retained.ids).toEqual(ids);
    expect(retained.draft).toBe('KEEP DRAFT');
    expect(retained.calls).toBe(0); // The once/trusted handler was inspected, never executed.
    expect(retained.questions).toHaveLength(1);
    expect(retained.questions[0].buttons).toEqual(['취소', '닫기']);
    expect(retained.questions[0].noLink).toBe(true);
    stage = 'approve protected batch';
    await app.evaluate(() => { (globalThis as any).closeAnswer = 1; });
    expect(await page.evaluate(() => (window as any).mosaicNative.requestClose(['one', 'two']))).toBe(true);
    expect(await app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().filter(wc => wc.getURL().startsWith(prefix)).length, url)).toBe(0);
    stage = 'first close';
    await app.close();
    stage = 'relaunch';
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('[data-native="true"]')).toHaveCount(2);
    await expect.poll(() => app!.evaluate(({ webContents }, prefix) => {
      const views = webContents.getAllWebContents().filter(wc => wc.getURL().startsWith(prefix));
      return views.length === 2 && views.every(wc => !wc.isLoading());
    }, url)).toBe(true);
    await app.evaluate(({ dialog }) => {
      (globalThis as any).closeQuestions = [];
      dialog.showMessageBoxSync = (_window: any, options: any) => { (globalThis as any).closeQuestions.push(options); return 0; };
    });
    // A clean page with a clean iframe also closes without a generic warning.
    stage = 'silent clean batch';
    expect(await page.evaluate(() => (window as any).mosaicNative.requestClose(['one', 'two']))).toBe(true);
    expect(await app.evaluate(() => (globalThis as any).closeQuestions.length)).toBe(0);
  } catch (error) {
    console.error('Close test stage: ' + stage);
    throw error;
  } finally {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
      const process = app.process();
      const timer = setTimeout(() => process.kill(), 3000);
      try { await app.close(); } finally { clearTimeout(timer); }
    }
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
