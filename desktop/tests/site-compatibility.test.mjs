import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromeWebUrl, openInChrome } from '../external-browser.mjs';
import { isGateUrl, watchSiteCompatibility } from '../site-compatibility.mjs';

test('Chrome handoff accepts only web URLs, including a bounded encoded length', () => {
  assert.equal(chromeWebUrl('https://www.gate.com/login?next=%2Faccount&ref=a'), 'https://www.gate.com/login?next=%2Faccount&ref=a');
  for (const value of ['file:///C:/secret', 'javascript:alert(1)', '--user-data-dir=C:/private', 'https://user:pass@gate.com/', 'https://gate.com/\n--flag', null, 'https://gate.com/' + '가'.repeat(3000)])
    assert.throws(() => chromeWebUrl(value), /열 수 없는 주소/);
});

test('Chrome receives one URL argument without a shell or Mosaic profile data', async () => {
  const calls = [];
  let unreferenced = false;
  const target = 'https://www.gate.com/login?next=%2Faccount&text=%22%26';
  await openInChrome(target, {
    env: { ProgramFiles: 'C:/Program Files', LOCALAPPDATA: 'C:/Users/test/AppData/Local' },
    exists: file => file.includes('Program Files'),
    launch: (file, args, options) => {
      calls.push({ file, args, options });
      const child = new EventEmitter();
      child.unref = () => { unreferenced = true; };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /chrome\.exe$/);
  assert.deepEqual(calls[0].args, [target]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, false, 'the Chrome window must be visible to the user');
  assert.equal(unreferenced, true);
});

test('missing Chrome and failed process launch report an error without success', async () => {
  await assert.rejects(openInChrome('https://gate.com/', { env: {}, launch: () => assert.fail('must not launch') }), /Chrome을 찾지 못했어요/);
  await assert.rejects(openInChrome('https://gate.com/', {
    env: { ProgramFiles: 'C:/Program Files' }, exists: () => true,
    launch: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; },
  }), /Chrome을 열지 못했어요/);
});

test('the Gate detector never treats a lookalike or unrelated protocol as Gate', () => {
  for (const value of ['https://gate.com/', 'https://www.gate.com/login', 'https://www.gate.com/en']) assert.equal(isGateUrl(value), true);
  for (const value of ['https://gate.com.example/', 'https://fakegate.com/', 'file://gate.com/', 'garbage']) assert.equal(isGateUrl(value), false);
});

test('compatibility detection discards a late result after navigation, including same-URL reloads', async () => {
  for (const next of ['https://example.com/', 'https://www.gate.com/']) {
    const wc = new EventEmitter(), changes = [];
    let url = 'https://www.gate.com/', finish;
    wc.getURL = () => url;
    wc.isDestroyed = () => false;
    wc.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
    const dispose = watchSiteCompatibility(wc, value => changes.push(value));
    try {
      wc.emit('did-stop-loading');
      await delay(15);
      assert.equal(typeof finish, 'function');
      url = next;
      wc.emit('did-start-navigation', {}, url, false, true);
      finish(true);
      await delay(5);
      assert.deepEqual(changes, ['']);
    } finally { dispose(); }
  }
});

test('disposed detectors ignore pending renderer results and release event listeners', async () => {
  const wc = new EventEmitter(), changes = [];
  let finish;
  wc.getURL = () => 'https://www.gate.com/';
  wc.isDestroyed = () => false;
  wc.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
  const dispose = watchSiteCompatibility(wc, value => changes.push(value));
  wc.emit('did-stop-loading');
  await delay(15);
  dispose();
  finish(true);
  await delay(5);
  assert.deepEqual(changes, []);
  assert.equal(wc.eventNames().length, 0);
});
