import { test, expect } from '@playwright/test';
import { automationDriver } from './helpers/automation-driver.mjs';

test('an inserted button cannot redirect an observed selector; refreshing allows the intended action', async ({ page }) => {
  await page.setContent('<main id="actions"><button>Preview</button><button>Save</button></main><output></output>');
  await page.evaluate(() => document.addEventListener('click', e => { document.querySelector('output')!.textContent = (e.target as HTMLElement).textContent; }));
  const { call } = await automationDriver(page);
  const before = await call('snapshot');
  const selector = before.elements.find((e: any) => e.label === 'Save').selector;
  await page.evaluate(() => { const b = document.createElement('button'); b.textContent = 'Inserted'; document.querySelector('main')!.prepend(b); });
  expect(await call('click', { selector })).toMatchObject({ ok: false, status: 'needs_observation', actionApplied: false });
  await expect(page.locator('output')).toHaveText('');
  const after = await call('snapshot');
  expect(await call('click', { selector: after.elements.find((e: any) => e.label === 'Save').selector })).toMatchObject({ ok: true, outcomeVerified: false });
  await expect(page.locator('output')).toHaveText('Save');
});

test('replacing a node with the same id and label requires another observation', async ({ page }) => {
  await page.setContent('<button id="save">Save</button><output></output>');
  const { call } = await automationDriver(page);
  await call('snapshot');
  await page.evaluate(() => { const old = document.querySelector('#save')!; const next = old.cloneNode(true); next.addEventListener('click', () => { document.querySelector('output')!.textContent = 'clicked'; }); old.replaceWith(next); });
  expect(await call('click', { selector: '#save' })).toMatchObject({ ok: false, actionApplied: false });
  await expect(page.locator('output')).toHaveText('');
});

test('an observed control changing meaning cannot be clicked without re-reading', async ({ page }) => {
  await page.setContent('<button id="action">Save</button><output></output>');
  const { call } = await automationDriver(page);
  await call('snapshot');
  await page.locator('#action').evaluate(e => { e.textContent = 'Delete'; e.addEventListener('click', () => { document.querySelector('output')!.textContent = 'deleted'; }); });
  expect(await call('click', { selector: '#action' })).toMatchObject({ ok: false, actionApplied: false });
  await expect(page.locator('output')).toHaveText('');
});

test('a covered target cannot click its overlay and can be retried after observation', async ({ page }) => {
  await page.setContent('<button id="save">Save</button><output></output><div id="overlay" style="position:fixed;inset:0;z-index:10;background:#ddd">Loading</div>');
  await page.evaluate(() => document.addEventListener('click', e => { document.querySelector('output')!.textContent = (e.target as HTMLElement).id; }));
  const { call } = await automationDriver(page);
  await call('snapshot');
  expect(await call('click', { selector: '#save' })).toMatchObject({ ok: false, actionApplied: false, reason: 'covered' });
  await expect(page.locator('output')).toHaveText('');
  await page.locator('#overlay').evaluate(e => e.remove());
  await call('snapshot');
  expect(await call('click', { selector: '#save' })).toMatchObject({ ok: true, outcomeVerified: false });
  await expect(page.locator('output')).toHaveText('save');
});

test('disabled, hidden and ambiguous targets return a recoverable result without input', async ({ page }) => {
  await page.setContent('<button disabled id="disabled">Disabled</button><button hidden id="hidden">Hidden</button><button class="many">One</button><button class="many">Two</button><output></output>');
  await page.evaluate(() => document.addEventListener('click', () => { document.querySelector('output')!.textContent = 'clicked'; }));
  const { call } = await automationDriver(page);
  for (const [selector, reason] of [['#disabled', 'disabled'], ['#hidden', 'hidden'], ['.many', 'ambiguous']]) {
    expect(await call('click', { selector })).toMatchObject({ ok: false, actionApplied: false, reason });
  }
  await expect(page.locator('output')).toHaveText('');
});

test('text entry rejects replacement and covered input, but accepts a fresh target', async ({ page }) => {
  await page.setContent('<label for="note">Note</label><input id="note" value="original">');
  const { call } = await automationDriver(page);
  await call('snapshot');
  await page.locator('#note').evaluate(e => e.replaceWith(e.cloneNode(true)));
  expect(await call('type', { selector: '#note', text: 'wrong' })).toMatchObject({ ok: false, actionApplied: false });
  await expect(page.locator('#note')).toHaveValue('original');
  await call('snapshot');
  await page.evaluate(() => { const cover = document.createElement('div'); cover.id = 'cover'; cover.style.cssText = 'position:fixed;inset:0;z-index:10'; document.body.append(cover); });
  expect(await call('type', { selector: '#note', text: 'wrong' })).toMatchObject({ ok: false, reason: 'covered' });
  await page.locator('#cover').evaluate(e => e.remove());
  await call('snapshot');
  expect(await call('type', { selector: '#note', text: 'updated' })).toMatchObject({ ok: true, outcomeVerified: false });
  await expect(page.locator('#note')).toHaveValue('updated');
});

test('snapshots expose native and ARIA names and states without field values', async ({ page }) => {
  await page.setContent('<label for="email">Work email</label><input id="email" value="private@example.test"><label for="news">Newsletter</label><input id="news" type="checkbox" checked><span id="title">Advanced options</span><button id="expand" aria-labelledby="title" aria-expanded="true">+</button><div id="custom" role="checkbox" aria-label="Custom" aria-checked="mixed" tabindex="0">Custom</div><input type="password" value="secret-password">');
  const { call } = await automationDriver(page);
  const snap = await call('snapshot');
  const byId = (id: string) => snap.elements.find((e: any) => e.selector === '#' + id);
  expect(byId('email')).toMatchObject({ label: 'Work email' });
  expect(byId('news')).toMatchObject({ label: 'Newsletter', checked: true });
  expect(byId('expand')).toMatchObject({ label: 'Advanced options', expanded: true });
  expect(byId('custom')).toMatchObject({ role: 'checkbox', checked: 'mixed' });
  expect(JSON.stringify(snap)).not.toMatch(/private@example|secret-password/);
});

test('viewport targets are prioritized and omitted elements can be read with bounded paging', async ({ page }) => {
  await page.setContent(Array.from({ length: 180 }, (_, i) => `<a href="#">Navigation ${i}</a><br>`).join('') + '<button id="important" style="position:fixed;top:20px;right:20px">Save work</button>');
  const { call } = await automationDriver(page);
  const first = await call('snapshot');
  expect(first.elements).toHaveLength(160);
  expect(first.elements.some((e: any) => e.selector === '#important')).toBe(true);
  expect(first).toMatchObject({ truncated: true, totalElements: 181, nextOffset: 160 });
  const second = await call('snapshot', { offset: first.nextOffset });
  expect(second.elements).toHaveLength(21);
  expect(second.nextOffset).toBeNull();
  expect(new Set([...first.elements, ...second.elements].map(e => e.selector)).size).toBe(181);
});

test('scoped text can be paged without discarding old target identity', async ({ page }) => {
  await page.setContent('<button id="save">Save</button><main id="details">' + 'x'.repeat(25000) + '<button id="last">Last</button></main>');
  const { call } = await automationDriver(page);
  await call('snapshot');
  const first = await call('snapshot', { scope: '#details' });
  expect(first.elements).toHaveLength(1);
  expect(first.text).toHaveLength(24000);
  expect(first.nextTextOffset).toBe(24000);
  expect((await call('snapshot', { scope: '#details', textOffset: 24000 })).text).toContain('Last');
  await page.locator('#save').evaluate(e => e.replaceWith(e.cloneNode(true)));
  expect(await call('click', { selector: '#save' })).toMatchObject({ ok: false, actionApplied: false });
});

test('nested content receives a normal click and dispatch does not claim business success', async ({ page }) => {
  await page.setContent('<button id="save"><span>Save</span></button><output></output>');
  await page.locator('#save').evaluate(e => e.addEventListener('click', () => { document.querySelector('output')!.textContent = 'saved'; }));
  const { call } = await automationDriver(page);
  await call('snapshot');
  expect(await call('click', { selector: '#save' })).toMatchObject({ ok: true, inputDispatched: true, outcomeVerified: false });
  await expect(page.locator('output')).toHaveText('saved');
});

test('revocation while preparing input prevents dispatch', async ({ page }) => {
  await page.setContent('<input id="note" value="original">');
  const { execute, contents } = await automationDriver(page);
  const original = contents.executeJavaScriptInIsolatedWorld;
  let revoked = false;
  contents.executeJavaScriptInIsolatedWorld = async (...args: any[]) => { const result = await original(...args); revoked = true; return result; };
  await expect(execute('type', { paneId: 'probe', selector: '#note', text: 'wrong' }, () => { if (revoked) throw new Error('revoked'); })).rejects.toThrow('revoked');
  await expect(page.locator('#note')).toHaveValue('original');
});

test('native select state exposes selected labels without option values', async ({ page }) => {
  await page.setContent('<label for="plan">Plan</label><select id="plan"><option value="internal-basic">Basic</option><option value="internal-pro" selected>Pro</option></select><select id="multiple" multiple><option value="internal-a" selected>Alpha</option><option value="internal-b">Beta</option><option value="internal-c" selected>Gamma</option></select>');
  const { call } = await automationDriver(page);
  const snapshot = await call('snapshot');
  expect(snapshot.elements.find((e: any) => e.selector === '#plan')).toMatchObject({ selectedOptions: ['Pro'] });
  expect(snapshot.elements.find((e: any) => e.selector === '#multiple')).toMatchObject({ selectedOptions: ['Alpha', 'Gamma'], selectedOptionCount: 2 });
  expect(JSON.stringify(snapshot)).not.toContain('internal-');
  await page.selectOption('#plan', 'internal-basic');
  expect((await call('snapshot')).elements.find((e: any) => e.selector === '#plan').selectedOptions).toEqual(['Basic']);
});

test('display truncation still detects a change in the full link destination', async ({ page }) => {
  await page.setContent('<a id="destination">Open</a>');
  await page.evaluate(() => document.querySelector('a')!.setAttribute('href', 'https://example.test/' + 'x'.repeat(3000) + '/original'));
  const { call } = await automationDriver(page);
  await call('snapshot');
  await page.evaluate(() => document.querySelector('a')!.setAttribute('href', 'https://example.test/' + 'x'.repeat(3000) + '/different'));
  expect(await call('click', { selector: '#destination' })).toMatchObject({ ok: false, reason: 'target_changed', actionApplied: false });
});

test('metadata budget pages large descriptors and unusable selectors are explicit', async ({ page }) => {
  await page.setContent('<main></main>');
  await page.evaluate(() => {
    const main = document.querySelector('main')!;
    for (let i = 0; i < 160; i++) {
      const a = document.createElement('a'); a.id = 'link-' + i; a.textContent = 'Link ' + i;
      a.href = 'https://example.test/' + 'x'.repeat(4000); main.append(a);
    }
    const button = document.createElement('button'); button.id = 'long-' + 'x'.repeat(5000); button.textContent = 'Long ID'; main.append(button);
  });
  const { call } = await automationDriver(page);
  let snapshot = await call('snapshot');
  expect(snapshot.metadataTruncated).toBe(true);
  expect(snapshot.nextOffset).toBeGreaterThan(0);
  const elements = [];
  do {
    expect(JSON.stringify(snapshot).length).toBeLessThan(100000);
    elements.push(...snapshot.elements);
    if (snapshot.nextOffset === null) break;
    snapshot = await call('snapshot', { offset: snapshot.nextOffset });
  } while (elements.length <= 161);
  expect(elements).toHaveLength(161);
  expect(elements.find(e => e.label === 'Long ID')).toMatchObject({ selector: null, selectorUnavailable: true });
});

test('oversized metadata is bounded and reports truncation', async ({ page }) => {
  await page.setContent('<title>Title</title><a id="large">Long link</a>');
  await page.evaluate(() => { document.title = 't'.repeat(100000); document.querySelector('#large')!.setAttribute('href', 'https://example.test/' + 'x'.repeat(1000000)); });
  const { call } = await automationDriver(page);
  const snapshot = await call('snapshot');
  expect(JSON.stringify(snapshot).length).toBeLessThan(100000);
  expect(snapshot.metadataTruncated).toBe(true);
  expect(snapshot.elements[0].hrefTruncated).toBe(true);
});

test('expired selector history after paging cannot authorize a different previously seen node', async ({ page }) => {
  await page.setContent('<main>' + Array.from({ length: 4200 }, (_, i) => `<button>${i}</button>`).join('') + '</main><output></output>');
  await page.evaluate(() => document.addEventListener('click', e => { document.querySelector('output')!.textContent = (e.target as HTMLElement).textContent; }));
  const { call } = await automationDriver(page);
  let snapshot = await call('snapshot');
  const selector = snapshot.elements.find((e: any) => e.label === '1').selector;
  while (snapshot.nextOffset !== null) snapshot = await call('snapshot', { offset: snapshot.nextOffset });
  await page.evaluate(() => { const b = document.createElement('button'); b.textContent = 'Inserted'; document.querySelector('main')!.prepend(b); });
  expect(await call('click', { selector })).toMatchObject({ ok: false, actionApplied: false });
  await expect(page.locator('output')).toHaveText('');
});
