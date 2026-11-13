import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Requires an OS which allows the official Electron executable. Do not skip
// failures here: UI-only and mocked tests cannot establish native correctness.
test('native views isolate profiles, accept parallel agent input, preserve focus state and survive restart', async () => {
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<title>Native fixture</title><style>body{margin:0;background:rgb(240,30,80);height:4000px}</style><input id="draft"><button>Action</button><script>localStorage.setItem("opened", "yes")</script>',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  const url = 'http://127.0.0.1:' + address.port + '/';
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-native-e2e-'));
  const profiles = ['work', 'personal'].map((id) => ({ id, name: id, note: '', color: '#447b64' }));
  await writeFile(
    join(directory, 'workspace.json'),
    JSON.stringify({
      version: 1,
      theme: 'light',
      profiles,
      savedSets: [],
      workspace: {
        id: 'native-test',
        name: 'Native tests',
        columns: 2,
        rows: 2,
        panes: ['work', 'work', 'personal'].map((profileId, i) => ({
          id: 'test-' + i,
          title: 'Page ' + i,
          url: url + '?pane=' + i,
          profileId,
          kind: 'external',
          addressOpen: false,
        })),
      },
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
    const page = await app.firstWindow();
    await expect(page.locator('[data-native="true"]')).toHaveCount(3);
    const views = () =>
      app!.evaluate(
        ({ webContents }, prefix) =>
          webContents
            .getAllWebContents()
            .filter((wc) => wc.getURL().startsWith(prefix))
            .map((wc) => ({ url: wc.getURL(), title: wc.getTitle() })),
        url,
      );
    await expect.poll(views).toHaveLength(3);
    await app.evaluate(async ({ webContents }, prefix) => {
      const panes = webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith(prefix));
      await panes
        .find((wc) => wc.getURL().endsWith('pane=0'))!
        .session.cookies.set({
          url: prefix,
          name: 'profile-test',
          value: 'work-value',
          expirationDate: Date.now() / 1000 + 3600,
        });
    }, url);
    const cookies = () =>
      app!.evaluate(
        async ({ webContents }, prefix) =>
          Promise.all(
            webContents
              .getAllWebContents()
              .filter((wc) => wc.getURL().startsWith(prefix))
              .sort((a, b) => a.getURL().localeCompare(b.getURL()))
              .map(async (wc) => ({
                url: wc.getURL(),
                cookies: await wc.session.cookies.get({ name: 'profile-test' }),
              })),
          ),
        url,
      );
    const stored = await cookies();
    expect(stored[0].cookies[0].value).toBe('work-value');
    expect(stored[1].cookies).toEqual([]);
    expect(stored[2].cookies).toEqual([]);

    // Exercise the real authenticated bridge and CDP input in separate native
    // renderers. No production accounts, services or connection tokens are used.
    await page.evaluate(() => (window as any).mosaicNative.setAgentAccess({
      enabled: true, paneIds: ['test-0', 'test-1'],
    }));
    const connection = JSON.parse(await readFile(join(directory, 'agent-connection.json'), 'utf8'));
    const call = async (method: string, args: Record<string, unknown>) => {
      const response = await fetch(connection.url + '/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args }),
      });
      const body = await response.json();
      expect(response.ok, JSON.stringify(body.error)).toBe(true);
      return body.result;
    };
    await Promise.all(['test-0', 'test-1'].map((paneId, i) => call('type', {
      paneId, selector: '#draft', text: 'Agent draft ' + i,
    })));
    const pageState = () => app!.evaluate(async ({ webContents }, prefix) =>
      Promise.all(webContents.getAllWebContents()
        .filter(wc => wc.getURL().startsWith(prefix))
        .sort((a, b) => a.getURL().localeCompare(b.getURL()))
        .map(wc => wc.executeJavaScript('({text:document.querySelector("#draft").value,y:scrollY})'))), url);
    await expect.poll(async () => (await pageState()).map(p => p.text))
      .toEqual(['Agent draft 0', 'Agent draft 1', '']);
    await call('scroll', { paneId: 'test-0', y: 320 });
    await expect.poll(async () => (await pageState())[0].y).toBe(320);
    await page.locator('[data-pane-id="test-0"]').getByRole('button', { name: 'Native fixture 크게 보기', exact: true }).click();
    await expect(page.locator('[data-pane-id="test-0"]')).toHaveClass(/focused/);
    const focusedPane = page.locator('[data-pane-id="test-0"]');
    const workspaceBox = (await page.getByTestId('workspace-scroll').boundingBox())!;
    const focusedBox = (await focusedPane.boundingBox())!;
    expect(Math.round(workspaceBox.y + workspaceBox.height - focusedBox.y - focusedBox.height)).toBe(10);
    const bodyBox = (await focusedPane.locator('.pane-body').boundingBox())!;
    await expect.poll(() => app!.evaluate(async ({ webContents }, prefix) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === prefix + '?pane=0')!;
      return wc.executeJavaScript('({width:innerWidth,height:innerHeight})');
    }, url)).toEqual({ width: Math.round(bodyBox.width), height: Math.round(bodyBox.height) });
    await mkdir('docs/previews', { recursive: true });
    const focusedImage = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const { width, height } = window.getBounds();
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
      const source = sources.find(source => source.id === window.getMediaSourceId());
      if (!source || source.thumbnail.isEmpty()) throw new Error('Native focus capture unavailable');
      return source.thumbnail.toPNG().toString('base64');
    });
    await writeFile('docs/previews/mosaic-focus-native.png', Buffer.from(focusedImage, 'base64'));
    const originalSize = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const size = window.getContentSize();
      window.setContentSize(1200, 800);
      return size;
    });
    await expect.poll(async () => {
      const area = (await page.getByTestId('workspace-scroll').boundingBox())!;
      const card = (await focusedPane.boundingBox())!;
      return Math.round(area.y + area.height - card.y - card.height);
    }).toBe(10);
    await expect.poll(async () => {
      const rect = (await focusedPane.locator('.pane-body').boundingBox())!;
      const actual = await app!.evaluate(async ({ webContents }, prefix) => {
        const wc = webContents.getAllWebContents().find(wc => wc.getURL() === prefix + '?pane=0')!;
        return wc.executeJavaScript('({width:innerWidth,height:innerHeight})');
      }, url);
      return { width: actual.width - Math.round(rect.width), height: actual.height - Math.round(rect.height) };
    }).toEqual({ width: 0, height: 0 });
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), originalSize);
    await app.evaluate(({ webContents }, prefix) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === prefix + '?pane=0')!;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['alt', 'shift'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right', modifiers: ['alt', 'shift'] });
    }, url);
    await expect(page.locator('[data-pane-id="test-1"]')).toHaveClass(/focused/);
    await page.locator('[data-pane-id="test-1"]').getByRole('button', { name: 'Native fixture 줄이기', exact: true }).click();
    await expect.poll(async () => (await pageState())[0]).toEqual({ text: 'Agent draft 0', y: 320 });
    // Restore the fixture viewport for the composed screenshot below.
    await call('scroll', { paneId: 'test-0', y: -320 });
    await page.getByRole('button', { name: '화면 추가', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.every(
            (child) => !child.getVisible(),
          ),
        ),
      )
      .toBe(true);
    await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.some((child) => child.getVisible()),
        ),
      )
      .toBe(true);
    await mkdir('docs/previews', { recursive: true });
    const nativeImage = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const { width, height } = window.getBounds();
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
      const source = sources.find(source => source.id === window.getMediaSourceId());
      if (!source || source.thumbnail.isEmpty()) throw new Error('Native window capture unavailable');
      return source.thumbnail.toPNG().toString('base64');
    });
    await writeFile('docs/previews/native-integration.png', Buffer.from(nativeImage, 'base64'));
    await app.close();
    app = await launch();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1;
    });
    await expect.poll(views).toHaveLength(3);
    expect((await cookies())[0].cookies[0].value).toBe('work-value');
  } finally {
    await app?.close();
    await new Promise<void>((done) => server.close(() => done()));
    // Keep the isolated test directory for diagnosis. Never touch real profiles.
  }
});
