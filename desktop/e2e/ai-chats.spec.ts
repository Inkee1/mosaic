import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('AI chats use native scoped browser tools, queue pane conflicts, cancel and restore history', async () => {
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<title>AI fixture</title><input id="draft"><button id="confirm" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#draft\').value">Confirm</button><output id="result"></output>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-ai-native-'));
  const workspace = { id: 'a', name: 'AI test set', columns: 2, rows: 2, panes: ['one', 'two'].map(id => ({ id, title: id, url: url + '/' + id, profileId: 'test', kind: 'external', addressOpen: false })) };
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, theme: 'light', profiles: [{ id: 'test', name: 'Test', color: '#447b64', note: '' }], workspace, savedSets: [{ id: 'a', savedAt: new Date().toISOString(), workspace }], activeSetId: 'a', openSetIds: ['a'] }));
  const launch = () => electron.launch({ executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined, args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'], env: { ...process.env, MOSAIC_USER_DATA: directory } });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    // Replace only the external provider boundary inside this isolated test
    // process. IPC, persistence, HTTP authentication and Chromium input are real.
    await app.evaluate(async ({ app, dialog }) => {
      dialog.showMessageBoxSync = () => 1;
      const { join } = process.getBuiltinModule('node:path');
      const { readFile } = process.getBuiltinModule('node:fs/promises');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { ProviderRegistry } = require('./desktop/ai/providers.mjs');
      const global = globalThis as any;
      global.fixtureRuns = [];
      ProviderRegistry.prototype.discover = async () => ['claude', 'codex'].map(id => ({ id, name: id, status: 'ready', models: [] }));
      ProviderRegistry.prototype.run = async (options: any) => {
        const connection = JSON.parse(await readFile(options.connectionFile, 'utf8'));
        const call = async (method: string, args: any) => {
          const response = await fetch(connection.url + '/call', { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
          return { ok: response.ok, body: await response.json() };
        };
        const listed = await call('list_panes', {});
        const panes = listed.body.result;
        if (!listed.ok || panes.length !== 1) throw new Error('Unexpected scoped pane listing');
        const paneId = panes[0].paneId || panes[0].id;
        const denied = await call('snapshot', { paneId: paneId === 'one' ? 'two' : 'one' });
        if (denied.ok) throw new Error('Cross-chat access was allowed');
        const marker = options.prompt.includes('HOLD') ? 'holding' : 'completed-' + options.provider;
        const run = { paneId, marker, call, resume: null as null | (() => void) };
        global.fixtureRuns.push(run);
        options.onEvent({ type: 'session', sessionId: 'fixture-' + global.fixtureRuns.length });
        for (const [method, args] of [['snapshot', { paneId }], ['type', { paneId, selector: '#draft', text: marker }], ['click', { paneId, selector: '#confirm' }]]) {
          const result = await call(method as string, args);
          if (!result.ok) throw new Error('Native tool failed: ' + method);
        }
        const resume = options.prompt.includes('CONTINUE') ? new Promise<void>((done, reject) => {
          run.resume = done;
          options.signal.addEventListener('abort', () => reject(new Error('unexpected interruption')), { once: true });
        }) : null;
        options.onEvent({ type: 'text', text: marker });
        if (resume) {
          await resume;
          const stale = await call('type', { paneId, selector: '#draft', text: 'stale-overwrite' });
          if (stale.body.result.status !== 'needs_observation' || stale.body.result.actionApplied !== false) throw new Error('Stale native action applied');
          await call('snapshot', { paneId });
          const clicked = await call('click', { paneId, selector: '#confirm' });
          if (!clicked.body.result.ok) throw new Error('Fresh native action did not continue');
          options.onEvent({ type: 'text', text: ' continued' });
        }
        if (marker === 'holding') await new Promise((_resolve, reject) => {
          if (options.signal.aborted) reject(new Error('interrupted'));
          else options.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
        });
        return { model: 'fixture-model', effort: 'low' };
      };
    });
    let page = await app.firstWindow();
    await expect(page.locator('[data-native="true"]')).toHaveCount(2);
    await page.evaluate(() => (window as any).mosaicNative.aiProviders());
    const create = (provider: string, paneId: string) => page.evaluate(async ({ provider, paneId }) => {
      const bridge = (window as any).mosaicNative;
      const state = await bridge.aiCreateChat({ setId: 'a', provider });
      const id = state.chats.at(-1).id;
      await bridge.aiUpdateChat(id, { paneIds: [paneId] });
      return id;
    }, { provider, paneId });
    const first = await create('claude', 'one');
    const conflict = await create('codex', 'one');
    const independent = await create('codex', 'two');
    const send = (id: string, text: string) => page.evaluate(({ id, text }) => (window as any).mosaicNative.aiSend(id, text), { id, text });
    const chats = () => page.evaluate(async () => (await (window as any).mosaicNative.aiState()).chats);
    await send(first, 'HOLD');
    await expect.poll(async () => (await chats()).find((c: any) => c.id === first).messages.at(-1).content).toBe('holding');
    await send(conflict, 'same pane');
    await send(independent, 'different pane');
    await expect.poll(async () => (await chats()).find((c: any) => c.id === independent).status).toBe('completed');
    expect((await chats()).find((c: any) => c.id === conflict).status).toBe('queued');
    await page.evaluate(id => (window as any).mosaicNative.aiStop(id), first);
    await expect.poll(async () => (await chats()).find((c: any) => c.id === conflict).status).toBe('completed');
    expect((await chats()).find((c: any) => c.id === first).status).toBe('interrupted');
    expect(await app.evaluate(async () => {
      try { return (await (globalThis as any).fixtureRuns[0].call('type', { paneId: 'one', selector: '#draft', text: 'late' })).ok; }
      catch { return false; }
    })).toBe(false);
    const outputs = await app.evaluate(async ({ webContents }, prefix) => Promise.all(webContents.getAllWebContents().filter(wc => wc.getURL().startsWith(prefix)).map(wc => wc.executeJavaScript('document.querySelector("#result").textContent'))), url);
    expect(outputs).toEqual(['completed-codex', 'completed-codex']);
    await send(independent, 'CONTINUE');
    await expect.poll(async () => (await chats()).find((c: any) => c.id === independent).messages.at(-1).content).toBe('completed-codex');
    await app.evaluate(async ({ webContents }, prefix) => {
      const wc = webContents.getAllWebContents().find(item => item.getURL() === prefix + '/two')!;
      await wc.executeJavaScript('document.querySelector("#draft").value="user native draft"');
      wc.sendInputEvent({ type: 'mouseDown', x: 12, y: 12, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: 12, y: 12, button: 'left', clickCount: 1 });
    }, url);
    await expect.poll(async () => (await chats()).find((c: any) => c.id === independent).events.some((event: any) => event.message.includes('화면 변경 감지'))).toBe(true);
    expect((await chats()).find((c: any) => c.id === independent).status).toBe('running');
    await app.evaluate(() => (globalThis as any).fixtureRuns.at(-1).resume());
    await expect.poll(async () => { const current = (await chats()).find((c: any) => c.id === independent); if (current.status === 'error') throw new Error(current.error); return current.status; }).toBe('completed');
    expect(await app.evaluate(async ({ webContents }, prefix) => webContents.getAllWebContents().find(item => item.getURL() === prefix + '/two')!.executeJavaScript('document.querySelector("#result").textContent'), url)).toBe('user native draft');
    expect(await app.evaluate(() => (globalThis as any).fixtureRuns.length)).toBe(4);
    const before = await chats();
    await app.close();
    app = await launch();
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    page = await app.firstWindow();
    await expect(page.getByRole('tab')).toHaveCount(3);
    const after = await chats();
    expect(after.map((c: any) => [c.id, c.status, c.messages, c.sessionId])).toEqual(before.map((c: any) => [c.id, c.status, c.messages, c.sessionId]));
    await page.screenshot({ path: 'test-results-desktop/ai-chats.png' });
  } finally {
    if (app) await app.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});
