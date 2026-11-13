import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('live sets retain native pages and drafts, save background URLs, close individually and restore on restart', async () => {
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<title>Set fixture</title><style>body{height:4000px;background:#dce8da}</style><input id="draft">',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-sets-e2e-'));
  const workspace = (id: string, name: string) => ({
    id,
    name,
    columns: 2,
    rows: 2,
    panes: [
      {
        id: 'shared-legacy-id',
        title: 'Set fixture',
        url: url + '/' + id,
        profileId: 'work',
        kind: 'external',
        addressOpen: false,
      },
    ],
  });
  await writeFile(
    join(directory, 'workspace.json'),
    JSON.stringify({
      version: 1,
      theme: 'light',
      profiles: [{ id: 'work', name: 'Work', note: '', color: '#447b64' }],
      workspace: workspace('a', 'Set A'),
      savedSets: ['a', 'b'].map((id) => ({
        id,
        savedAt: new Date().toISOString(),
        workspace: workspace(id, 'Set ' + id.toUpperCase()),
      })),
    }),
  );
  const launch = () =>
    electron.launch({
      executablePath: process.env.MOSAIC_TEST_EXECUTABLE || undefined,
      args: process.env.MOSAIC_TEST_EXECUTABLE ? ['--lang=ko'] : [resolve('.'), '--lang=ko'],
      env: { ...process.env, MOSAIC_USER_DATA: directory },
    });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  let stage = 'launch';
  try {
    app = await launch();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1;
    });
    let page = await app.firstWindow();
    const views = () =>
      app!.evaluate(
        ({ webContents }, prefix) =>
          webContents
            .getAllWebContents()
            .filter((wc) => wc.getURL().startsWith(prefix))
            .map((wc) => ({ id: wc.id, url: wc.getURL() })),
        url,
      );
    await expect.poll(views).toHaveLength(1);
    const original = (await views())[0].id;
    stage = 'fill original';
    await app.evaluate(async ({ webContents }, id) => {
      await webContents
        .fromId(id)!
        .executeJavaScript('document.querySelector("#draft").value="KEEP A";scrollTo(0,240)');
    }, original);
    await page.getByRole('button', { name: 'Set B · 1개 화면', exact: true }).click();
    stage = 'rename background set without replacing its native page';
    await page.getByRole('button', { name: 'Set A 이름 변경', exact: true }).click();
    await page.getByRole('textbox', { name: '세트 이름', exact: true }).fill('Set A renamed');
    await page.getByRole('button', { name: '이름 변경', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set B', exact: true })).toBeVisible();
    stage = 'background navigation';
    await expect.poll(views).toHaveLength(2);
    await app.evaluate(async ({ webContents }, id) => {
      await webContents
        .fromId(id)!
        .executeJavaScript('history.pushState({},"","/a-last");document.title="Background A"');
    }, original);
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')).savedSets.find(
            (set: any) => set.id === 'a',
          ).workspace.panes[0].url,
      )
      .toBe(url + '/a-last');
    await page.getByRole('button', { name: 'Set A renamed · 1개 화면', exact: true }).click();
    stage = 'verify original';
    expect((await views()).find((view) => view.url.endsWith('/a-last'))!.id).toBe(original);
    await expect
      .poll(() =>
        app!.evaluate(
          ({ webContents }, id) =>
            webContents
              .fromId(id)!
              .executeJavaScript('({text:document.querySelector("#draft").value,y:scrollY})'),
          original,
        ),
      )
      .toEqual({ text: 'KEEP A', y: 240 });
    await page.getByRole('button', { name: 'Set B 세트 닫기', exact: true }).click();
    stage = 'close B';
    await expect.poll(views).toHaveLength(1);
    expect((await views())[0].id).toBe(original);
    await page.getByRole('button', { name: 'Set B · 1개 화면', exact: true }).click();
    stage = 'reopen B';
    await expect.poll(views).toHaveLength(2);
    await app.evaluate(async ({ webContents }, prefix) => {
      await webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === prefix + '/b')!
        .executeJavaScript('history.pushState({},"","/b-last")');
    }, url);
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')).workspace.panes[0]
            .url,
      )
      .toBe(url + '/b-last');
    // Model a renderer whose final save cannot reach the disk. Shutdown must
    // still take the live native URLs, including an inactive set's navigation.
    await app.evaluate(async ({ webContents, ipcMain }, prefix) => {
      ipcMain.removeHandler('mosaic:save');
      ipcMain.handle('mosaic:save', () => {});
      await webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === prefix + '/a-last')!
        .executeJavaScript('history.pushState({},"","/a-on-quit")');
    }, url);
    await app.close();
    stage = 'restart';
    app = await launch();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1;
    });
    page = await app.firstWindow();
    await expect
      .poll(async () => (await views()).map((view) => view.url).sort())
      .toEqual([url + '/a-on-quit', url + '/b-last']);
    await expect(page.getByRole('heading', { name: 'Set B', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set A renamed · 1개 화면', exact: true })).toBeVisible();
    stage = 'close all';
    await page.getByRole('button', { name: 'Set B 세트 닫기', exact: true }).click();
    await page.getByRole('button', { name: 'Set A renamed 세트 닫기', exact: true }).click();
    await expect.poll(views).toHaveLength(0);
    await expect(page.getByRole('heading', { name: '열린 세트가 없어요' })).toBeVisible();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '열린 세트가 없어요' })).toBeVisible();
    expect(await views()).toEqual([]);
  } catch (error) {
    console.error('Set test failed at: ' + stage, error);
    throw error;
  } finally {
    const process = app?.process();
    const timeout = setTimeout(() => process?.kill(), 3000);
    try {
      await app?.close();
    } finally {
      clearTimeout(timeout);
    }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
