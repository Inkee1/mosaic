import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { automationDriver } from '../tests/helpers/automation-driver.mjs';

// Usage: node scripts/compare-automation.mjs <original automation.mjs> <report.json>
const beforePath = process.argv[2];
if (!beforePath) throw new Error('Provide the saved original automation.mjs path.');
const original = await import(pathToFileURL(resolve(beforePath)).href);
const current = await import('../desktop/automation.mjs');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
await context.route('**/*', route => route.abort());

async function run(factory) {
  const results = [];
  const measure = async (name, category, html, verify) => {
    const page = await context.newPage();
    try {
      await page.setContent(html);
      const driver = await automationDriver(page, factory);
      const result = await verify(page, driver.call);
      results.push({ name, category, ...result });
    } catch (error) { results.push({ name, category, passed: false, error: error.message }); }
    finally { await page.close(); }
  };
  await measure('stale-selector', 'defect', '<main id="actions"><button>Preview</button><button>Save</button></main><output></output>', async (page, call) => {
    await page.evaluate(() => document.addEventListener('click', e => { document.querySelector('output').textContent = e.target.textContent; }));
    const snap = await call('snapshot');
    const selector = snap.elements.find(e => e.label === 'Save').selector;
    await page.evaluate(() => { const b = document.createElement('button'); b.textContent = 'Inserted'; document.querySelector('main').prepend(b); });
    const result = await call('click', { selector });
    const actual = await page.locator('output').textContent();
    return { passed: result.actionApplied === false && actual === '', actualClick: actual, reportedOk: result.ok };
  });
  await measure('covered-button', 'defect', '<button id="save">Save</button><output></output><div id="cover" style="position:fixed;inset:0;z-index:10">Loading</div>', async (page, call) => {
    await page.evaluate(() => document.addEventListener('click', e => { document.querySelector('output').textContent = e.target.id; }));
    await call('snapshot');
    const result = await call('click', { selector: '#save' });
    const actual = await page.locator('output').textContent();
    return { passed: result.actionApplied === false && actual === '', actualClick: actual, reportedOk: result.ok };
  });
  await measure('visible-target-after-limit', 'defect', Array.from({ length: 180 }, (_, i) => `<a href="#">Navigation ${i}</a><br>`).join('') + '<button id="save" style="position:fixed;top:20px;right:20px">Save work</button>', async (_page, call) => {
    const snap = await call('snapshot');
    const found = snap.elements.some(e => e.selector === '#save');
    return { passed: found && snap.truncated === true, targetListed: found, elementCount: snap.elements.length, reportsTruncation: snap.truncated === true };
  });
  await measure('label-and-checkbox-state', 'defect', '<label for="email">Work email</label><input id="email"><label for="news">Newsletter</label><input id="news" type="checkbox" checked>', async (_page, call) => {
    const snap = await call('snapshot');
    const email = snap.elements.find(e => e.selector === '#email'), checkbox = snap.elements.find(e => e.selector === '#news');
    return { passed: email.label === 'Work email' && checkbox.checked === true, emailLabel: email.label, checked: checkbox.checked ?? null };
  });
  await measure('ordinary-click', 'control', '<button id="save"><span>Save</span></button><output></output>', async (page, call) => {
    await page.locator('#save').evaluate(e => e.addEventListener('click', () => { document.querySelector('output').textContent = 'saved'; }));
    await call('snapshot');
    await call('click', { selector: '#save' });
    return { passed: await page.locator('output').textContent() === 'saved' };
  });
  await measure('korean-input', 'control', '<input id="note" value="old">', async (page, call) => {
    await call('snapshot');
    await call('type', { selector: '#note', text: '비교 테스트' });
    return { passed: await page.locator('#note').inputValue() === '비교 테스트' };
  });
  return results;
}

try {
  const before = await run(original.createAutomation);
  const after = await run(current.createAutomation);
  const report = { measuredAt: new Date().toISOString(), environment: 'Production executors, isolated headless Chrome, local fixtures; no AI provider calls', before, after };
  if (process.argv[3]) await writeFile(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (after.some(result => !result.passed)) process.exitCode = 1;
} finally { await browser.close(); }
