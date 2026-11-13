import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCall } from '../agent-tools.mjs';
import { fillCredential } from '../credentials.mjs';
import { createAutomation } from '../automation.mjs';
import { ChromeContents } from '../chrome/contents.mjs';

test('browser target tools preserve pane grants while accepting only bounded target identifiers', () => {
  assert.deepEqual(validateCall('list_targets', { paneId: 'one' }), { paneId: 'one' });
  assert.deepEqual(validateCall('open_chrome', { paneId: 'one' }), { paneId: 'one' });
  assert.deepEqual(validateCall('snapshot', { paneId: 'one', targetId: 'chrome-abc' }), { paneId: 'one', targetId: 'chrome-abc' });
  assert.throws(() => validateCall('snapshot', { paneId: 'one', targetId: '../outside' }));
  assert.throws(() => validateCall('open_chrome', { paneId: 'one', endpoint: 'ws://elsewhere' }));
});

test('stored Mosaic credentials cannot be filled into a hidden native page while Chrome is selected', async () => {
  const manager = { get: () => ({ browser: 'chrome', get view() { assert.fail('hidden page must not be inspected'); } }) };
  await assert.rejects(fillCredential(manager, {}, { paneId: 'one' }), /Chrome/);
});

test('a document changing during selector inspection never receives stale input', async () => {
  let release, started;
  const inspected = new Promise(resolve => { started = resolve; });
  const commands = [];
  const group = { connection: { closed: false, send: async method => { commands.push(method); return {}; } }, changed() {}, runtime: { onManual() {} } };
  const contents = new ChromeContents(group, { targetId: 'root', url: 'https://old.test/' }, 'root');
  contents.executeJavaScriptInIsolatedWorld = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const entry = { browser: 'chrome', id: 'one' };
  const execute = createAutomation({ get: () => entry, target: () => contents, targetId: () => 'main', listTargets: async () => [] });
  const action = execute('click', { paneId: 'one', selector: '#old-button' }, () => {});
  await inspected;
  contents.event('Page.frameNavigated', { frame: { id: 'frame', url: 'https://different.test/' } });
  release({ x: 10, y: 20 });
  assert.equal((await action).status, 'needs_observation');
  assert.equal(commands.some(name => name.startsWith('Input.')), false);
});

test('snapshot paging is bounded and scope cannot smuggle extra access', () => {
  const args = { paneId: 'one', targetId: 'main', scope: '#details', offset: 160, textOffset: 24000 };
  assert.deepEqual(validateCall('snapshot', args), args);
  for (const extra of [{ offset: -1 }, { offset: 1.5 }, { offset: 10001 }, { textOffset: 10000001 }, { scope: '\0' }, { scope: '' }, { frameId: 'other' }]) {
    assert.throws(() => validateCall('snapshot', { paneId: 'one', ...extra }));
  }
});
