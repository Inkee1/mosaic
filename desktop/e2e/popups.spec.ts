import { test, expect, _electron as electron } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function popupFixture(account = false) {
  let failConnection = true;
  const pendingLoads = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === '/failed' && failConnection) { request.socket.destroy(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Set-Cookie', 'popup-session=fixture; Path=/; SameSite=Lax');
    if (path === '/delayed') { pendingLoads.add(response); return; }
    if (path === '/login') {
      response.end('<title>Login fixture</title><h1>Login ready</h1><script>opener.postMessage("login-ready",location.origin)</script>');
      return;
    }
    response.end(`<title>Popup fixture</title><button id="site" onclick="window.open('/site','site')">Open site</button>
      <button id="login" onclick="window.open('/login','login')">Log in</button>
      <button id="long" onclick="const child=window.open('about:blank','long-login');setTimeout(()=>child.location='/login?state='+ 'x'.repeat(3000),100)">Long login</button>
      <button id="failed" onclick="window.open('/failed','failed')">Failed connection</button>
      <button id="delayed" onclick="window.open('/delayed','delayed')">Delayed connection</button>
      <script>addEventListener('message', e => {if(e.origin===location.origin)document.body.dataset.message=e.data;});</script>`);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-popup-e2e-'));
  const workspace = { id: 'popups', name: 'Popups', columns: 1, rows: 1, panes: [
    { id: 'one', title: 'Popup fixture', url: base + '/pane', profileId: 'test', kind: 'external', addressOpen: false },
  ] };
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ version: 1, theme: 'light', profiles: [{ id: 'test', name: 'Test', color: '#447b64', note: '' }], workspace, savedSets: [] }));
  const app = await electron.launch({ executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined, args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'], env: { ...process.env, MOSAIC_USER_DATA: directory } });
  const owner = base + (account ? '/account' : '/pane');
  const page = await app.firstWindow();
  if (account) {
    await app.evaluate(({ session }, url) => {
      session.fromPartition('persist:mosaic-test').webRequest.onBeforeRequest(
        { urls: ['https://accounts.google.com/*'] }, (_details, callback) => callback({ redirectURL: url }),
      );
    }, owner);
    await page.evaluate(() => (window as any).mosaicNative.openProfileLogin('test', 'google'));
  }
  await expect.poll(() => app.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().some(wc => wc.getURL() === url && !wc.isLoading()), owner)).toBe(true);
  const click = (url: string, button: string) => app.evaluate(async ({ webContents }, { url, button }) => {
    const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
    await wc.executeJavaScript('document.getElementById(' + JSON.stringify(button) + ').click()', true);
  }, { url, button });
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    id: window.webContents.id, url: window.webContents.getURL(), title: window.getTitle(), visible: window.isVisible(),
  })));
  const close = async () => {
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    const child = app.process();
    const timer = setTimeout(() => child.kill(), 3000);
    try { await app.close(); } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  };
  return { app, base, owner, click, windows, close, pendingLoads,
    restoreConnection: () => { failConnection = false; },
    releaseLoads: () => { for (const response of pendingLoads) response.end('<title>Loaded fixture</title><h1>Loaded</h1>'); pendingLoads.clear(); },
  };
}

for (const account of [false, true]) {
  test(`${account ? 'account' : 'pane'} popup can open a login popup and retain opener, long callback URLs and session`, async () => {
    const fixture = await popupFixture(account);
    const { app, base, owner, click, windows } = fixture;
    try {
      await click(owner, 'site');
      await expect.poll(async () => (await windows()).some(window => window.url === base + '/site')).toBe(true);
      await click(base + '/site', 'login');
      await expect.poll(async () => (await windows()).some(window => window.url === base + '/login' && window.visible)).toBe(true);
      await expect.poll(() => app.evaluate(async ({ webContents }, url) =>
        webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript('document.body.dataset.message'), base + '/site')).toBe('login-ready');
      await click(base + '/site', 'long');
      await expect.poll(async () => (await windows()).some(window => window.url.startsWith(base + '/login?state=') && window.url.length > 3000)).toBe(true);
      const properties = await app.evaluate(async ({ webContents }, { owner, base }) => {
        const original = webContents.getAllWebContents().find(wc => wc.getURL() === owner)!;
        const login = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(base + '/login?'))!;
        const preferences = login.getLastWebPreferences();
        return { sameSession: original.session === login.session, sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, cookies: (await login.session.cookies.get({ url: base })).map(cookie => cookie.name) };
      }, { owner, base });
      expect(properties).toEqual({ sameSession: true, sandbox: true, nodeIntegration: false, contextIsolation: true, cookies: ['popup-session'] });
    } finally { await fixture.close(); }
  });
}

test('popup loading, slow connections and failures are visible; F5 retries successfully', async () => {
  const fixture = await popupFixture();
  try {
    await fixture.click(fixture.owner, 'delayed');
    await expect.poll(async () => (await fixture.windows()).some(window => window.title.includes('불러오는 중'))).toBe(true);
    await expect.poll(async () => (await fixture.windows()).some(window => window.title.includes('연결 지연'))).toBe(true);
    await expect.poll(() => fixture.pendingLoads.size).toBe(1);
    fixture.releaseLoads();
    await expect.poll(async () => (await fixture.windows()).some(window => window.url === fixture.base + '/delayed' && window.title === fixture.base + ' · 새 창')).toBe(true);
    await fixture.click(fixture.owner, 'failed');
    await expect.poll(async () => (await fixture.windows()).some(window => window.title.includes('연결 실패'))).toBe(true);
    fixture.restoreConnection();
    await fixture.app.evaluate(({ BrowserWindow }) => {
      const popup = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('연결 실패'))!;
      popup.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' });
      popup.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F5' });
    });
    await expect.poll(async () => (await fixture.windows()).some(window => window.url === fixture.base + '/failed' && window.title === fixture.base + ' · 새 창')).toBe(true);
  } finally { await fixture.close(); }
});
