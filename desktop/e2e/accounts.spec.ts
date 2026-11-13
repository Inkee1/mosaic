import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('same-brand P/Q sessions, prepared login, encrypted credentials and logout survive restart', async () => {
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<title>Account fixture</title><form onsubmit="event.preventDefault();document.body.dataset.submitted=\'yes\'"><input autocomplete="username" id="user"><input autocomplete="current-password" type="password" id="pass"><button>Login</button></form>',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as any).port;
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-accounts-'));
  await writeFile(
    join(directory, 'workspace.json'),
    JSON.stringify({
      version: 1,
      theme: 'light',
      profiles: ['work', 'other'].map((id) => ({ id, name: id, note: '', color: '#447b64' })),
      savedSets: [],
      workspace: { id: 'accounts', name: 'Accounts', columns: 2, rows: 2, panes: [] },
    }),
  );
  const launch = () =>
    electron.launch({
      executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined,
      args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'],
      env: { ...process.env, MOSAIC_USER_DATA: directory },
    });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1;
    });
    let page = await app.firstWindow();
    await app.evaluate(async ({ session }, url) => {
      await session
        .fromPartition('persist:mosaic-work')
        .cookies.set({ url, name: 'seed', value: 'prepared-login', httpOnly: true });
    }, url);
    for (const name of ['P', 'Q']) {
      await page.getByRole('button', { name: '화면 추가', exact: true }).click();
      await page.getByLabel('주소 또는 검색어', { exact: true }).fill(url + '/' + name);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '화면 추가', exact: true })
        .click();
    }
    const accountState = () =>
      app!.evaluate(
        async ({ webContents }, url) =>
          Promise.all(
            webContents
              .getAllWebContents()
              .filter((wc) => wc.getURL().startsWith(url))
              .sort((a, b) => a.getURL().localeCompare(b.getURL()))
              .map(async (wc) => ({
                cookies: (await wc.session.cookies.get({})).map((c) => [c.name, c.value]),
                local: await wc.executeJavaScript('localStorage.getItem("account")'),
              })),
          ),
        url,
      );
    await expect.poll(accountState).toEqual([
      { cookies: [['seed', 'prepared-login']], local: null },
      { cookies: [['seed', 'prepared-login']], local: null },
    ]);
    const ids = await page
      .locator('[data-native="true"]')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.paneId!));
    await app.evaluate(async ({ webContents }, url) => {
      const pages = webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith(url));
      for (const wc of pages) {
        const name = new URL(wc.getURL()).pathname.slice(1);
        await wc.session.cookies.set({ url, name: 'account', value: name });
        await wc.executeJavaScript('localStorage.setItem("account", ' + JSON.stringify(name) + ')');
      }
    }, url);
    expect((await accountState()).map((s) => s.local)).toEqual(['P', 'Q']);
    expect(
      (await accountState()).map((s) => s.cookies.find((c) => c[0] === 'account')?.[1]),
    ).toEqual(['P', 'Q']);
    expect(await page.evaluate(() => typeof window.mosaicNative?.saveCredential)).toBe('function');
    await page
      .locator(`[data-pane-id="${ids[0]}"]`)
      .getByRole('button', { name: 'Account fixture 저장 비밀번호', exact: true })
      .click();
    await page.getByLabel('아이디 또는 이메일', { exact: true }).fill('person-P');
    await page.getByLabel('비밀번호', { exact: true }).fill('fixture-secret-467');
    await page.getByRole('button', { name: '비밀번호 저장', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('암호화해서 저장');
    await expect(page.getByLabel('비밀번호', { exact: true })).toHaveValue('');
    const [credential] = await page.evaluate(
      async (url) => window.mosaicNative!.listCredentials({ profileId: 'work', url }),
      url,
    );
    expect(JSON.stringify(credential)).not.toContain('fixture-secret');
    await page.getByRole('button', { name: '이 화면에 채우기', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText(
      '이 화면에 입력했어요',
    );
    await page.screenshot({ path: 'docs/previews/mosaic-passwords.png' });
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    const fields = await app.evaluate(
      async ({ webContents }, url) =>
        Promise.all(
          webContents
            .getAllWebContents()
            .filter((wc) => wc.getURL().startsWith(url))
            .sort((a, b) => a.getURL().localeCompare(b.getURL()))
            .map((wc) =>
              wc.executeJavaScript(
                '({ user:document.querySelector("#user").value, pass:document.querySelector("#pass").value, submitted:document.body.dataset.submitted || null })',
              ),
            ),
        ),
      url,
    );
    expect(fields).toEqual([
      { user: 'person-P', pass: 'fixture-secret-467', submitted: null },
      { user: '', pass: '', submitted: null },
    ]);
    for (const invalid of [
      { profileId: 'other', origin: url },
      { profileId: 'work', origin: 'https://example.com' },
    ]) {
      const result = await page.evaluate(
        async ({ id, credentialId, invalid }) => {
          try {
            await window.mosaicNative!.fillCredential({ paneId: id, credentialId, ...invalid });
            return 'allowed';
          } catch {
            return 'rejected';
          }
        },
        { id: ids[0], credentialId: credential.id, invalid },
      );
      expect(result).toBe('rejected');
    }
    expect(
      await page.evaluate(() => window.mosaicNative!.listCredentials({ profileId: 'other' })),
    ).toEqual([]);
    await page.getByRole('button', { name: 'Accounts 세트 닫기', exact: true }).click();
    await expect(page.locator('[data-native="true"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Accounts · 2개 화면', exact: true }).click();
    await expect
      .poll(async () =>
        (await accountState()).map((s) => s.cookies.find((c) => c[0] === 'account')?.[1]),
      )
      .toEqual(['P', 'Q']);
    // Logging out of P must not affect Q or be undone by the prepared profile.
    await app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url + '/P')!;
      await wc.session.cookies.remove(url, 'seed');
      await wc.session.cookies.remove(url, 'account');
    }, url);
    await app.close();
    app = await launch();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1;
    });
    page = await app.firstWindow();
    await expect.poll(accountState).toEqual([
      { cookies: [], local: 'P' },
      {
        cookies: [
          ['seed', 'prepared-login'],
          ['account', 'Q'],
        ],
        local: 'Q',
      },
    ]);
    expect(
      (await page.evaluate(() => window.mosaicNative!.listCredentials({ profileId: 'work' })))[0]
        .username,
    ).toBe('person-P');
    const vaultBytes = await readFile(join(directory, 'credentials.bin'));
    expect(vaultBytes.includes(Buffer.from('fixture-secret-467'))).toBe(false);
    expect(
      (await readFile(join(directory, 'workspace.json'), 'utf8')).includes('fixture-secret'),
    ).toBe(false);
    await page.getByRole('button', { name: /브라우저 프로필/ }).click();
    await page.screenshot({ path: 'docs/previews/mosaic-accounts.png', animations: 'disabled' });
    await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
    // Preparation windows use the template session, separate from both panes.
    await page.evaluate(() => window.mosaicNative!.openProfileLogin('work', 'google'));
    await expect
      .poll(() => app!.windows().filter((p) => p.url().endsWith('/account-window.html')).length)
      .toBe(1);
    const login = app.windows().find((p) => p.url().endsWith('/account-window.html'))!;
    await expect(login.getByText('work · 로그인 준비', { exact: true })).toBeVisible();
    await login.getByLabel('로그인 사이트 주소', { exact: true }).fill(url + '/prepare');
    await login.getByRole('button', { name: '이동', exact: true }).click();
    await expect
      .poll(() =>
        app!.evaluate(
          ({ webContents }, url) =>
            webContents.getAllWebContents().some((wc) => wc.getURL() === url + '/prepare'),
          url,
        ),
      )
      .toBe(true);
    await app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url + '/prepare')!;
      await wc.executeJavaScript('window.open(' + JSON.stringify(url + '/popup') + '); void 0');
    }, url);
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BrowserWindow }, url) =>
            BrowserWindow.getAllWindows().some((w) => w.webContents.getURL() === url + '/popup'),
          url,
        ),
      )
      .toBe(true);
    const popupTitle = await app.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL() === url + '/popup')!
          .getTitle(),
      url,
    );
    expect(popupTitle).toContain(url);
    const panePopupOpened = await app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url + '/P')!;
      return wc.executeJavaScript(
        '(() => { const popup = window.open("about:blank"); if (popup) popup.location.href = ' +
          JSON.stringify(url + '/pane-popup') +
          '; return !!popup; })()',
      );
    }, url);
    expect(panePopupOpened, 'site sign-in can open a blank popup and then navigate it').toBe(true);
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BrowserWindow }, url) =>
            BrowserWindow.getAllWindows()
              .find((w) => w.webContents.getURL() === url + '/pane-popup')
              ?.getTitle(),
          url,
        ),
      )
      .toContain(url);
    await login.getByRole('button', { name: '완료' }).click();
    await expect
      .poll(() => app!.windows().filter((p) => p.url().endsWith('/account-window.html')).length)
      .toBe(0);
  } finally {
    if (app) {
      const child = app.process();
      const fallback = setTimeout(() => child.kill(), 4000);
      await app.close().catch(() => {});
      clearTimeout(fallback);
    }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
