import { test, expect } from '@playwright/test';
import { createAutomation } from '../desktop/automation.mjs';
import { readScrollScript, restoreScrollScript } from '../desktop/page-scripts.mjs';

// Exercise the production DOM/CDP executor in real Chrome. This is not an
// Electron WebContentsView integration test; that has a separate configuration.
async function driver(page: any) {
  const cdp = await page.context().newCDPSession(page);
  const contents = {
    executeJavaScript: (source: string) => page.evaluate(source),
    getURL: () => page.url(),
    isDestroyed: () => page.isClosed(),
    debugger: {
      isAttached: () => true,
      attach() {},
      sendCommand: (name: string, args: any) => cdp.send(name, args),
    },
    capturePage: async () => {
      const png = await page.screenshot();
      return { toPNG: () => png };
    },
  };
  const entry = {
    id: 'test-pane',
    profileId: 'personal',
    view: { webContents: contents },
    closed: false,
    error: '',
  };
  const manager = {
    get: () => entry,
    list: () => [{ paneId: entry.id, profileId: entry.profileId, url: page.url() }],
    describe: () => ({ paneId: entry.id, url: page.url() }),
    navigate: async (_entry: unknown, url: string) => {
      await page.goto(url);
    },
    command: () => ({ ok: true }),
  };
  return { execute: createAutomation(manager), contents, entry, cdp };
}

test('DOM snapshots produce usable deep selectors without input values', async ({ page }) => {
  await page.setContent(
    '<title>Fixture</title><input id="secret" type="password" value="private-password">' +
      '<div>'.repeat(12) +
      '<button>Deep action</button>' +
      '</div>'.repeat(12),
  );
  const { execute } = await driver(page);
  const snapshot = await execute('snapshot', { paneId: 'test-pane' }, () => {});
  expect(JSON.stringify(snapshot)).not.toContain('private-password');
  const button = snapshot.elements.find((item: any) => item.label === 'Deep action');
  await expect(page.locator(button.selector)).toHaveText('Deep action');
});

test('agent types Korean, clicks, scrolls and captures a real page', async ({ page }) => {
  await page.setContent(
    '<style>body{min-height:3000px}</style><input id="note" value="old"><button id="save" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>',
  );
  const { execute } = await driver(page);
  const call = (method: string, args: object = {}) =>
    execute(method, { paneId: 'test-pane', ...args }, () => {});
  await call('type', { selector: '#note', text: '여러 화면에서 작업' });
  await expect(page.locator('#note')).toHaveValue('여러 화면에서 작업');
  await call('click', { selector: '#save' });
  await expect(page.locator('output')).toHaveText('여러 화면에서 작업');
  await call('scroll', { y: 600 });
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(500);
  const picture = await call('screenshot');
  expect(Buffer.from(picture.image, 'base64').subarray(1, 4).toString()).toBe('PNG');
});

test('revocation during element lookup prevents subsequent input', async ({ page }) => {
  await page.setContent('<input id="note" value="unchanged">');
  const { execute, contents } = await driver(page);
  const original = contents.executeJavaScript;
  let revoked = false;
  contents.executeJavaScript = async (source) => {
    const result = await original(source);
    revoked = true;
    return result;
  };
  await expect(
    execute(
      'type',
      { paneId: 'test-pane', selector: '#note', text: 'must not be inserted' },
      () => {
        if (revoked) throw new Error('revoked');
      },
    ),
  ).rejects.toThrow('revoked');
  await expect(page.locator('#note')).toHaveValue('unchanged');
});

test('agent scroll and focus memory work with nested chat containers', async ({ page }) => {
  await page.setContent(
    '<style>html,body{margin:0;height:100%;overflow:hidden}#messages{height:100vh;overflow:auto}section{height:4000px}</style><main id="messages"><section>Chat messages</section></main>',
  );
  const { execute } = await driver(page);
  await execute('scroll', { paneId: 'test-pane', y: 600 }, () => {});
  expect(await page.locator('#messages').evaluate((e: HTMLElement) => e.scrollTop)).toBe(600);
  const saved = await page.evaluate(readScrollScript);
  await execute('scroll', { paneId: 'test-pane', selector: '#messages', y: 400 }, () => {});
  expect(await page.locator('#messages').evaluate((e: HTMLElement) => e.scrollTop)).toBe(1000);
  await page.evaluate(restoreScrollScript(saved));
  expect(await page.locator('#messages').evaluate((e: HTMLElement) => e.scrollTop)).toBe(600);
});

test('navigation, shortcuts and pane replacement use the current target', async ({ page, baseURL }) => {
  const { execute, entry } = await driver(page);
  await execute('navigate', { paneId: 'test-pane', url: baseURL! + '/' }, () => {});
  await expect(page).toHaveTitle(/Mosaic/);
  await page.setContent('<input id="note" value="shortcut">');
  await page.locator('input').focus();
  await execute('press_key', { paneId: 'test-pane', key: 'Control+A' }, () => {});
  await execute('press_key', { paneId: 'test-pane', key: 'Backspace' }, () => {});
  await expect(page.locator('input')).toHaveValue('');
  entry.closed = true;
  await expect(execute('click', { paneId: 'test-pane', x: 20, y: 20 }, () => {})).rejects.toThrow(
    /변경/,
  );
});

test('a separately scrolling body is targeted and restored', async ({ page }) => {
  await page.setContent('<!DOCTYPE html><style>html{height:100%;overflow:hidden}body{margin:0;height:100%;overflow:auto}main{height:4000px}</style><main>Scrollable body</main>');
  const { execute } = await driver(page);
  await execute('scroll', { paneId: 'test-pane', y: 600 }, () => {});
  expect(await page.evaluate(() => document.body.scrollTop)).toBe(600);
  const saved = await page.evaluate(readScrollScript);
  await page.evaluate(() => { document.body.scrollTop = 100; });
  await page.evaluate(restoreScrollScript(saved));
  expect(await page.evaluate(() => document.body.scrollTop)).toBe(600);
});
