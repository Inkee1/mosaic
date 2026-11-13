import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('native bridge protects observed targets, rejects overlays and reads bounded labelled snapshots', async () => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Reliability fixture</title><main></main>'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/';
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-reliability-'));
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, theme: 'light', profiles: [{ id: 'test', name: 'Test', note: '', color: '#447b64' }], savedSets: [], workspace: { id: 'test', name: 'Test', columns: 1, rows: 1, panes: [{ id: 'probe', profileId: 'test', title: 'Test', url, kind: 'external', addressOpen: false }] } }));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined, args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'], env: { ...process.env, MOSAIC_USER_DATA: directory } });
    const page = await app.firstWindow();
    await expect(page.locator('[data-native="true"]')).toHaveCount(1);
    const evaluate = (source: string) => app!.evaluate(async ({ webContents }, { url, source }) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url);
      if (!wc) throw new Error('Fixture not loaded');
      return wc.executeJavaScript(source);
    }, { url, source });
    await expect.poll(() => evaluate('document.readyState').catch(() => '')).toBe('complete');
    await page.evaluate(() => (window as any).mosaicNative.setAgentAccess({ enabled: true, paneIds: ['probe'] }));
    const connection = JSON.parse(await readFile(join(directory, 'agent-connection.json'), 'utf8'));
    const call = async (method: string, args = {}) => {
      const response = await fetch(connection.url + '/call', { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args: { paneId: 'probe', ...args } }) });
      const body = await response.json(); expect(response.ok, JSON.stringify(body.error)).toBe(true); return body.result;
    };
    await evaluate(`document.body.innerHTML='<main id="actions"><button>Preview</button><button>Save</button></main><output></output>';document.addEventListener('click',e=>document.querySelector('output').textContent=e.target.textContent)`);
    const snapshot = await call('snapshot');
    const selector = snapshot.elements.find((e: any) => e.label === 'Save').selector;
    await evaluate(`{const b=document.createElement('button');b.textContent='Inserted';document.querySelector('main').prepend(b)}`);
    expect(await call('click', { selector })).toMatchObject({ ok: false, actionApplied: false });
    expect(await evaluate(`document.querySelector('output').textContent`)).toBe('');
    const fresh = await call('snapshot');
    const current = fresh.elements.find((e: any) => e.label === 'Save').selector;
    await evaluate(`{const cover=document.createElement('div');cover.id='cover';cover.style.cssText='position:fixed;inset:0;z-index:10;background:#ddd';document.body.append(cover)}`);
    expect(await call('click', { selector: current })).toMatchObject({ ok: false, reason: 'covered' });
    expect(await evaluate(`document.querySelector('output').textContent`)).toBe('');
    await evaluate(`document.querySelector('#cover').remove()`);
    await call('snapshot');
    expect(await call('click', { selector: current })).toMatchObject({ ok: true, outcomeVerified: false });
    await expect.poll(() => evaluate(`document.querySelector('output').textContent`)).toBe('Save');
    await evaluate(`document.body.innerHTML=Array.from({length:180},(_,i)=>'<a href="#">Nav '+i+'</a><br>').join('')+'<button id="important" style="position:fixed;top:20px;right:20px">Important</button>'`);
    const first = await call('snapshot');
    expect(first.elements.some((e: any) => e.selector === '#important')).toBe(true);
    expect(first.nextOffset).toBe(160);
    expect((await call('snapshot', { offset: 160 })).elements).toHaveLength(21);
    await evaluate(`document.body.innerHTML='<label for="email">Work email</label><input id="email" value="private-value"><input id="checked" type="checkbox" checked>'`);
    const fields = await call('snapshot');
    expect(fields.elements.find((e: any) => e.selector === '#email').label).toBe('Work email');
    expect(fields.elements.find((e: any) => e.selector === '#checked').checked).toBe(true);
    expect(JSON.stringify(fields)).not.toContain('private-value');
    expect(await evaluate(`Object.keys(globalThis).some(key=>key.startsWith('__mosaic_observation_'))`)).toBe(false);
  } finally {
    await app?.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});
