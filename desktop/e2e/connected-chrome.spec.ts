import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CdpConnection, chromeEndpoint } from '../chrome/cdp.mjs';
import { chromeProfileDirectory } from '../chrome/runtime.mjs';

test('sidebar AI continues through native and connected Chrome popups and restores Chrome after restart', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const path = new URL(request.url!, 'http://fixture').pathname;
    response.end(path === '/auth' ? `<title>Auth</title><input id="answer"><button id="finish" onclick="opener.opener.postMessage(document.querySelector('#answer').value,location.origin);window.close()">Finish</button>` :
      path === '/popup' ? `<title>Popup</title><button id="next" onclick="window.open('/auth','auth','width=600,height=500')">Login</button>` :
      `<title>Root</title><input id="draft"><button id="open" onclick="window.open('/popup','site','width=700,height=600')">Open</button><output id="result"></output><script>addEventListener('message',e=>{if(e.origin===location.origin)document.querySelector('#result').textContent=e.data})</script>`);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/';
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-connected-ai-'));
  const workspace = { id: 'a', name: 'Connected test', columns: 2, rows: 2, panes: ['one', 'two'].map(id => ({ id, title: id, url, profileId: 'test', kind: 'external', addressOpen: false })) };
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, theme: 'light', profiles: [{ id: 'test', name: 'Test', color: '#447b64', note: '' }], workspace, savedSets: [{ id: 'a', savedAt: new Date().toISOString(), workspace }], activeSetId: 'a', openSetIds: ['a'] }));
  const launch = () => electron.launch({ executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined, args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'], env: { ...process.env, MOSAIC_USER_DATA: directory } });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  const shutdowns: Promise<void>[] = [];
  const inspectChrome = async (paneId: string) => {
    const profile = chromeProfileDirectory(directory, paneId, 'test');
    const connection = await CdpConnection.connect(chromeEndpoint(await readFile(join(profile, 'DevToolsActivePort'), 'utf8')));
    const metadata = JSON.parse(await readFile(join(profile, 'mosaic-connection.json'), 'utf8'));
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId: metadata.rootId, flatten: true });
    return { connection, sessionId };
  };
  try {
    app = await launch();
    // Only the paid provider is a fixture. Sidebar IPC, grants, HTTP bridge,
    // Electron popups and installed Chrome input/capture are production paths.
    await app.evaluate(async ({ app, dialog }) => {
      dialog.showMessageBoxSync = () => 1;
      const { join } = process.getBuiltinModule('node:path');
      const { readFile } = process.getBuiltinModule('node:fs/promises');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { ProviderRegistry } = require('./desktop/ai/providers.mjs');
      const state = globalThis as any;
      state.chromeFixtureRuns = [];
      ProviderRegistry.prototype.discover = async () => ['claude', 'codex'].map(id => ({ id, name: id, status: 'ready', models: [] }));
      ProviderRegistry.prototype.run = async (options: any) => {
        const connection = JSON.parse(await readFile(options.connectionFile, 'utf8'));
        const trace: any[] = [];
        const raw = async (method: string, args: any) => {
          const response = await fetch(connection.url + '/call', { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
          const body = await response.json();
          const event = { method, target: args.targetId, status: body.result?.status, title: body.result?.title, targets: Array.isArray(body.result) ? body.result.map((item: any) => item.targetId || item.paneId) : undefined };
          if (JSON.stringify(trace.at(-1)) !== JSON.stringify(event)) trace.push(event);
          if (trace.length > 16) trace.shift();
          return { ok: response.ok, body };
        };
        const call = async (method: string, args: any) => {
          const response = await raw(method, args);
          if (!response.ok) throw new Error(method + ': ' + JSON.stringify(response.body));
          return response.body.result;
        };
        const poll = async (read: () => Promise<any>, accept: (value: any) => boolean) => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const value = await read(); if (accept(value)) return value;
            await new Promise(done => setTimeout(done, 100));
          }
          throw new Error('Fixture timed out waiting for browser: ' + JSON.stringify(trace));
        };
        const panes = await call('list_panes', {});
        if (panes.length !== 1) throw new Error('Grant leaked panes');
        const paneId = panes[0].paneId;
        const nativeMode = options.prompt.includes('NATIVE_MODE');
        if (!nativeMode) await call('open_chrome', { paneId });
        await poll(() => call('snapshot', { paneId, targetId: 'main' }), value => value.title === 'Root' && !value.loading);
        const marker = (nativeMode ? 'native-' : 'chrome-') + options.provider;
        await call('type', { paneId, targetId: 'main', selector: '#draft', text: marker });
        await call('click', { paneId, targetId: 'main', selector: '#open' });
        const pages = await poll(() => call('list_targets', { paneId }), value => value.some((item: any) => item.url.endsWith('/popup')));
        const popup = pages.find((item: any) => item.url.endsWith('/popup'));
        if (popup.parentTargetId !== 'main') throw new Error('Popup owner lost');
        await poll(() => call('snapshot', { paneId, targetId: popup.targetId }), value => value.title === 'Popup' && !value.loading);
        await call('click', { paneId, targetId: popup.targetId, selector: '#next' });
        const children = await poll(() => call('list_targets', { paneId }), value => value.some((item: any) => item.url.endsWith('/auth')));
        const auth = children.find((item: any) => item.url.endsWith('/auth'));
        if (auth.parentTargetId !== popup.targetId) throw new Error('Nested opener lost');
        const foreign = await raw('snapshot', { paneId: paneId === 'one' ? 'two' : 'one', targetId: auth.targetId });
        if (foreign.ok) throw new Error('Foreign target accepted');
        await poll(() => call('snapshot', { paneId, targetId: auth.targetId }), value => value.title === 'Auth' && !value.loading);
        await call('type', { paneId, targetId: auth.targetId, selector: '#answer', text: marker });
        const picture = await call('screenshot', { paneId, targetId: auth.targetId });
        if (picture.mimeType !== 'image/png' || !picture.image) throw new Error('Screenshot missing');
        await call('click', { paneId, targetId: auth.targetId, selector: '#finish' });
        await poll(() => call('snapshot', { paneId, targetId: 'main' }), value => value.text.includes(marker));
        await poll(() => call('list_targets', { paneId }), value => !value.some((item: any) => item.targetId === auth.targetId));
        if ((await raw('snapshot', { paneId, targetId: auth.targetId })).ok) throw new Error('Closed target accepted');
        const run = { paneId, marker, raw, resume: null as null | (() => void) };
        state.chromeFixtureRuns.push(run);
        options.onEvent({ type: 'session', sessionId: 'connected-fixture-' + state.chromeFixtureRuns.length });
        const resume = options.prompt.includes('CONTINUE_MODE') ? new Promise<void>((done, reject) => {
          run.resume = done;
          options.signal.addEventListener('abort', () => reject(new Error('unexpected interruption')), { once: true });
        }) : null;
        options.onEvent({ type: 'text', text: marker });
        if (resume) {
          await resume;
          const stale = await call('type', { paneId, targetId: 'main', selector: '#draft', text: 'stale-overwrite' });
          if (stale.status !== 'needs_observation' || stale.actionApplied !== false) throw new Error('Stale action was allowed');
          const latest = await call('snapshot', { paneId, targetId: 'main' });
          if (!latest.text.includes('user changed this')) throw new Error('Changed page was not reobserved');
          await call('click', { paneId, targetId: 'main', selector: '#continue' });
          const confirmed = await call('snapshot', { paneId, targetId: 'main' });
          if (!confirmed.text.includes('continued without overwrite')) throw new Error('Run did not continue');
          options.onEvent({ type: 'text', text: ' continued' });
        }
        if (options.prompt.includes('HOLD_MODE')) await new Promise((_done, reject) => {
          if (options.signal.aborted) reject(new Error('interrupted'));
          else options.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
        });
        return { model: 'fixture-model', effort: 'low' };
      };
    });
    let page = await app.firstWindow();
    await expect(page.locator('[data-native="true"]')).toHaveCount(2);
    await page.evaluate(() => (window as any).mosaicNative.aiProviders());
    const run = async (provider: string, paneId: string, text: string) => page.evaluate(async ({ provider, paneId, text }) => {
      const bridge = (window as any).mosaicNative;
      const state = await bridge.aiCreateChat({ setId: 'a', provider });
      const id = state.chats.at(-1).id;
      await bridge.aiUpdateChat(id, { paneIds: [paneId] });
      await bridge.aiSend(id, text);
      return id;
    }, { provider, paneId, text });
    const chat = (id: string) => page.evaluate(async id => (await (window as any).mosaicNative.aiState()).chats.find((item: any) => item.id === id), id);
    for (const [provider, paneId, text] of [['claude', 'one', 'NATIVE_MODE'], ['claude', 'one', 'Chrome work'], ['codex', 'two', 'Chrome work']]) {
      const id = await run(provider, paneId, text);
      await expect.poll(async () => { const current = await chat(id); if (current.status === 'error') throw new Error(current.error); return current.status; }).toBe('completed');
    }
    await expect(page.getByRole('heading', { name: 'Chrome 연결됨', exact: true })).toHaveCount(2);
    await page.screenshot({ path: 'test-results-desktop/connected-chrome.png' });
    const continuing = await run('codex', 'two', 'CONTINUE_MODE');
    await expect.poll(async () => (await chat(continuing)).messages.at(-1).content).toBe('chrome-codex');
    // Physical input outside Mosaic's automation lane changes the page but
    // keeps the exact provider run, grants and chat alive.
    const driver = await inspectChrome('two');
    await driver.connection.send('Runtime.evaluate', { expression: `document.querySelector('#draft').value='user draft'; document.querySelector('#result').textContent='user changed this'; const b=document.createElement('button'); b.id='continue'; b.textContent='Continue'; b.onclick=()=>document.querySelector('#result').textContent=document.querySelector('#draft').value==='user draft'?'continued without overwrite':'overwritten'; document.body.append(b)` }, driver.sessionId);
    await driver.connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 15, y: 15, button: 'left', clickCount: 1 }, driver.sessionId);
    await driver.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 15, y: 15, button: 'left', clickCount: 1 }, driver.sessionId);
    driver.connection.close();
    await expect.poll(async () => (await chat(continuing)).events.some((event: any) => event.message.includes('화면 변경 감지'))).toBe(true);
    expect((await chat(continuing)).status).toBe('running');
    await app.evaluate(() => (globalThis as any).chromeFixtureRuns.at(-1).resume());
    await expect.poll(async () => { const current = await chat(continuing); if (current.status === 'error') throw new Error(current.error); return current.status; }).toBe('completed');
    expect((await chat(continuing)).messages.at(-1).content).toBe('chrome-codex continued');
    expect(await app.evaluate(() => (globalThis as any).chromeFixtureRuns.length)).toBe(4);
    const hold = await run('codex', 'two', 'HOLD_MODE');
    await expect.poll(async () => (await chat(hold)).messages.at(-1).content).toBe('chrome-codex');
    await page.evaluate(id => (window as any).mosaicNative.aiStop(id), hold);
    await expect.poll(async () => (await chat(hold)).status).toBe('interrupted');
    // Windows may keep Playwright's inherited process handles alive until the
    // detached Chrome exits. Verify Electron's actual exit independently.
    const processHandle = app.process();
    const exited = processHandle.exitCode !== null ? Promise.resolve() : new Promise<void>(done => processHandle.once('exit', () => done()));
    shutdowns.push(app.close());
    await exited; app = undefined;
    const saved = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'));
    expect(saved.workspace.panes.map((pane: any) => pane.browser)).toEqual(['chrome', 'chrome']);
    for (const paneId of ['one', 'two']) {
      const driver = await inspectChrome(paneId);
      const result = await driver.connection.send('Runtime.evaluate', { expression: 'document.querySelector("#draft").value', returnByValue: true }, driver.sessionId);
      expect(result.result.value).toBe(paneId === 'one' ? 'chrome-claude' : 'chrome-codex');
      driver.connection.close();
    }
    app = await launch();
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Chrome 연결됨', exact: true })).toHaveCount(2);
    await page.locator('[data-pane-id="one"]').getByRole('button', { name: 'Mosaic에서 보기', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chrome 연결됨', exact: true })).toHaveCount(1);
    await page.locator('[data-pane-id="one"]').getByRole('button', { name: /Chrome 연결$/ }).click();
    await expect(page.getByRole('heading', { name: 'Chrome 연결됨', exact: true })).toHaveCount(2);
    const driverAfter = await inspectChrome('one');
    expect((await driverAfter.connection.send('Runtime.evaluate', { expression: 'document.querySelector("#draft").value', returnByValue: true }, driverAfter.sessionId)).result.value).toBe('chrome-claude');
    driverAfter.connection.close();
  } finally {
    for (const paneId of ['one', 'two']) {
      try { const driver = await inspectChrome(paneId); await driver.connection.send('Browser.close').catch(() => {}); driver.connection.close(); } catch {}
    }
    if (app) await app.close();
    await Promise.all(shutdowns);
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await new Promise(done => setTimeout(done, 250));
  }
});
