import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation } from '../automation.mjs';
import { EventEmitter } from 'node:events';
import { NativeTargets } from '../native-targets.mjs';

function fixture() {
  const sent = [];
  const wc = {
    documentVersion: 0, isDestroyed: () => false, getURL: () => 'https://example.test/',
    executeJavaScript: async script => script.includes('elements:Array') ? { title: 'Current', text: 'Ready', elements: [] } : { x: 10, y: 20 },
    debugger: { isAttached: () => true, sendCommand: async (...args) => { sent.push(args); } },
  };
  const entry = { id: 'one', browser: 'mosaic', interactionVersion: 0, view: { webContents: wc } };
  const manager = { get: () => entry, target: () => wc, targetId: () => 'main', listTargets: async () => [] };
  const execute = createAutomation(manager);
  return { sent, wc, entry, execute };
}

test('manual interaction requires a fresh observation and then continues on the same executor', async () => {
  const f = fixture();
  await f.execute('snapshot', { paneId: 'one' }, () => {});
  f.entry.interactionVersion++;
  const result = await f.execute('click', { paneId: 'one', selector: '#button' }, () => {});
  assert.equal(result.status, 'needs_observation');
  assert.equal(result.actionApplied, false);
  assert.equal(f.sent.length, 0);
  await f.execute('snapshot', { paneId: 'one' }, () => {});
  assert.equal((await f.execute('click', { paneId: 'one', selector: '#button' }, () => {})).ok, true);
  assert.equal(f.sent.length, 2);
});

test('input while coordinates are being read discards the stale gesture without cancelling the run', async () => {
  const f = fixture();
  let finish, started;
  const reading = new Promise(resolve => { started = resolve; });
  f.wc.executeJavaScript = async () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.execute('click', { paneId: 'one', selector: '#button' }, () => {});
  await reading;
  f.entry.interactionVersion++;
  finish({ x: 10, y: 20 });
  assert.equal((await pending).status, 'needs_observation');
  assert.equal(f.sent.length, 0);
});

test('a snapshot changed by the user cannot authorize another write, and explicit stop still rejects', async () => {
  const f = fixture();
  f.wc.executeJavaScript = async () => { f.entry.interactionVersion++; return { text: 'stale' }; };
  assert.equal((await f.execute('snapshot', { paneId: 'one' }, () => {})).status, 'needs_observation');
  assert.equal((await f.execute('press_key', { paneId: 'one', key: 'Enter' }, () => {})).status, 'needs_observation');
  assert.equal(f.sent.length, 0);
  await assert.rejects(f.execute('click', { paneId: 'one', x: 1, y: 2 }, () => { throw new Error('explicit stop'); }), /explicit stop/);
});

test('screenshots also refresh input permission and a changed capture must be retried', async () => {
  const f = fixture();
  f.entry.interactionVersion++;
  f.wc.capturePage = async () => {
    f.entry.interactionVersion++;
    return { toPNG: () => Buffer.from('image') };
  };
  assert.equal((await f.execute('screenshot', { paneId: 'one' }, () => {})).status, 'needs_observation');
  assert.equal((await f.execute('press_key', { paneId: 'one', key: 'Enter' }, () => {})).status, 'needs_observation');
  f.wc.capturePage = async () => ({ toPNG: () => Buffer.from('image') });
  assert.equal((await f.execute('screenshot', { paneId: 'one' }, () => {})).mimeType, 'image/png');
  assert.equal((await f.execute('press_key', { paneId: 'one', key: 'Enter' }, () => {})).ok, true);
});

test('observing one popup never authorizes a different target after user input', async () => {
  const f = fixture();
  const other = { ...f.wc };
  const execute = createAutomation({ get: () => f.entry, target: (_entry, id) => id === 'popup' ? other : f.wc, targetId: (_entry, wc) => wc === other ? 'popup' : 'main', listTargets: async () => [] });
  f.entry.interactionVersion++;
  await execute('snapshot', { paneId: 'one', targetId: 'popup' }, () => {});
  assert.equal((await execute('click', { paneId: 'one', targetId: 'main', x: 10, y: 20 }, () => {})).status, 'needs_observation');
  assert.equal(f.sent.length, 0);
  assert.equal((await execute('click', { paneId: 'one', targetId: 'popup', x: 10, y: 20 }, () => {})).ok, true);
});

test('native navigation commit invalidates an observation taken before the destination arrives', async () => {
  const f = fixture();
  const contents = Object.assign(new EventEmitter(), f.wc);
  const targets = new NativeTargets(contents);
  const execute = createAutomation({ get: () => f.entry, target: () => contents, targetId: () => 'main', documentVersion: () => targets.documentVersion(contents), listTargets: () => targets.list() });
  contents.emit('did-start-navigation');
  await execute('snapshot', { paneId: 'one' }, () => {});
  contents.emit('did-frame-navigate');
  assert.equal((await execute('press_key', { paneId: 'one', key: 'Enter' }, () => {})).status, 'needs_observation');
  assert.equal(f.sent.length, 0);
  await execute('snapshot', { paneId: 'one' }, () => {});
  assert.equal((await execute('press_key', { paneId: 'one', key: 'Enter' }, () => {})).ok, true);
  contents.emit('did-navigate-in-page');
  assert.equal((await execute('press_key', { paneId: 'one', key: 'Enter' }, () => {})).status, 'needs_observation');
  targets.dispose();
});

test('native input waits for a painted surface once per document and rechecks user input afterwards', async () => {
  const f = fixture();
  let paints = 0;
  f.wc.capturePage = async () => { paints++; f.sent.push(['paint']); };
  await f.execute('click', { paneId: 'one', x: 10, y: 20 }, () => {});
  assert.equal(f.sent[0][0], 'paint');
  await f.execute('click', { paneId: 'one', x: 10, y: 20 }, () => {});
  assert.equal(paints, 1);
  f.wc.documentVersion++;
  f.wc.capturePage = async () => { paints++; f.entry.interactionVersion++; };
  const count = f.sent.length;
  assert.equal((await f.execute('click', { paneId: 'one', x: 10, y: 20 }, () => {})).status, 'needs_observation');
  assert.equal(f.sent.length, count);
  assert.equal(paints, 2);
});

test('a transient compositor readback is retried before typing and never replays input', async () => {
  const f = fixture();
  let captures = 0;
  f.wc.capturePage = async () => { if (++captures === 1) throw new Error('UnknownVizError'); return { isEmpty: () => false }; };
  assert.equal((await f.execute('type', { paneId: 'one', selector: '#draft', text: 'once' }, () => {})).ok, true);
  assert.equal(captures, 2);
  assert.equal(f.sent.filter(([name]) => name === 'Input.insertText').length, 1);
  f.wc.debugger.sendCommand = async (...args) => { f.sent.push(args); throw new Error('UnknownVizError'); };
  await assert.rejects(f.execute('type', { paneId: 'one', selector: '#draft', text: 'never replay' }, () => {}), /UnknownVizError/);
  assert.equal(f.sent.filter(([name]) => name === 'Input.insertText').length, 2);
});

test('unavailable capture is recoverable, and stop or user input during readback prevents dispatch', async () => {
  const f = fixture();
  let captures = 0;
  f.wc.capturePage = async () => { captures++; throw new Error('UnknownVizError'); };
  const result = await f.execute('click', { paneId: 'one', x: 10, y: 20 }, () => {});
  assert.equal(result.status, 'needs_observation');
  assert.equal(result.actionApplied, false);
  assert.equal(captures, 2);
  assert.equal(f.sent.length, 0);
  f.wc.capturePage = async () => { f.entry.interactionVersion++; throw new Error('UnknownVizError'); };
  assert.equal((await f.execute('click', { paneId: 'one', x: 10, y: 20 }, () => {})).status, 'needs_observation');
  const stopped = fixture(); let cancelled = false;
  stopped.wc.capturePage = async () => { cancelled = true; throw new Error('UnknownVizError'); };
  await assert.rejects(stopped.execute('click', { paneId: 'one', x: 10, y: 20 }, () => { if (cancelled) throw new Error('stopped'); }), /stopped/);
  assert.equal(stopped.sent.length, 0);
});

test('a stalled compositor readback is bounded and does not keep an automation call pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.wc.capturePage = () => new Promise(() => {});
  const pending = f.execute('click', { paneId: 'one', x: 10, y: 20 }, () => {});
  t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(result.status, 'needs_observation');
  assert.equal(result.actionApplied, false);
  assert.equal(f.sent.length, 0);
});
