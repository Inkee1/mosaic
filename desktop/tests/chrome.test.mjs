import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CdpConnection, chromeEndpoint } from '../chrome/cdp.mjs';
import { chromeProfileDirectory, ChromeGroup, ChromeRuntime } from '../chrome/runtime.mjs';
import { ChromeContents } from '../chrome/contents.mjs';

class Socket extends EventTarget {
  static instances = [];
  readyState = 0;
  bufferedAmount = 0;
  sent = [];
  closeCalls = 0;
  constructor(url) { super(); this.url = url; Socket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  send(value) { this.sent.push(JSON.parse(value)); }
  reply(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { this.closeCalls++; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('Chrome endpoints are constrained to the owned loopback browser endpoint', () => {
  assert.equal(chromeEndpoint('43123\n/devtools/browser/abc-123\n'), 'ws://127.0.0.1:43123/devtools/browser/abc-123');
  for (const value of ['0\n/devtools/browser/a', '65536\n/devtools/browser/a', '123\nhttp://evil.test', '123\n/devtools/browser/a?x=1', 'hello']) assert.throws(() => chromeEndpoint(value));
});

test('CDP correlates parallel replies and sessions and bounds an unanswered command', async () => {
  const connection = await CdpConnection.connect('ws://127.0.0.1:43123/devtools/browser/abc-123', { WebSocketImpl: Socket, timeoutMs: 60 });
  const socket = Socket.instances.at(-1), events = [];
  connection.on('event', event => events.push(event));
  const first = connection.send('Runtime.evaluate', { expression: '1' }, 'one');
  const second = connection.send('Page.getFrameTree', {}, 'two');
  socket.reply({ id: socket.sent[1].id, sessionId: 'two', result: { order: 2 } });
  socket.reply({ method: 'Page.loadEventFired', sessionId: 'one', params: { timestamp: 1 } });
  socket.reply({ id: socket.sent[0].id, sessionId: 'one', result: { order: 1 } });
  assert.deepEqual(await first, { order: 1 });
  assert.deepEqual(await second, { order: 2 });
  assert.equal(events[0].sessionId, 'one');
  await assert.rejects(connection.send('NeverReplies'), /시간|timeout/i);
  assert.equal(connection.pending.size, 0);
  connection.close();
});

test('disconnect rejects in-flight CDP work and never accepts new commands', async () => {
  const connection = await CdpConnection.connect('ws://127.0.0.1:43123/devtools/browser/abc-123', { WebSocketImpl: Socket });
  const pending = connection.send('Runtime.evaluate', {}, 'one');
  Socket.instances.at(-1).close();
  await assert.rejects(pending, /연결|closed/i);
  assert.equal(Socket.instances.at(-1).closeCalls, 1, 'do not close an already closed native WebSocket handle');
  await assert.rejects(connection.send('Runtime.evaluate'), /연결|closed/i);
});

test('external CDP addresses and embedded credentials never create a connection', async () => {
  const count = Socket.instances.length;
  for (const url of ['ws://evil.test:9222/devtools/browser/a', 'ws://127.0.0.1:9222/other', 'ws://user:pass@127.0.0.1:9222/devtools/browser/a', 'http://127.0.0.1:9222/devtools/browser/a'])
    await assert.rejects(CdpConnection.connect(url, { WebSocketImpl: Socket }));
  assert.equal(Socket.instances.length, count);
});

test('Chrome profile directories isolate pane/profile identities without path traversal', () => {
  const base = 'C:/Mosaic Test';
  const one = chromeProfileDirectory(base, 'pane-one', 'work');
  assert.notEqual(one, chromeProfileDirectory(base, 'pane-two', 'work'));
  assert.notEqual(one, chromeProfileDirectory(base, 'pane-one', 'personal'));
  assert.equal(one, chromeProfileDirectory(base, 'pane-one', 'work'));
  assert.throws(() => chromeProfileDirectory(base, '../personal', 'work'));
});

function ownedGroup() {
  const connection = new EventEmitter(); connection.closed = false;
  const group = new ChromeGroup({ changed() {}, onManual() {} }, { paneId: 'one', profileId: 'test' }, connection, 'endpoint', '', { endpoint: 'endpoint', rootId: 'root' });
  group.save = async () => {};
  for (const info of [{ targetId: 'root', url: 'https://example.test/' }, { targetId: 'child', openerId: 'root', url: 'chrome://newtab/' }]) {
    group.targets.set(info.targetId, new ChromeContents(group, info, info.targetId));
  }
  return group;
}

test('Chrome disconnect is terminal and is not reported as ordinary input', () => {
  const group = ownedGroup();
  let input = 0, disconnected = 0;
  group.runtime.onManual = () => input++;
  group.runtime.onDisconnect = () => disconnected++;
  group.connection.emit('closed');
  assert.equal(input, 0);
  assert.equal(disconnected, 1);
});

test('an owned Chrome new tab allows safe navigation without exposing its internal document', () => {
  const group = ownedGroup();
  assert.throws(() => group.target('chrome-child'));
  assert.equal(group.target('chrome-child', { navigate: true }).id, 'child');
  assert.throws(() => group.target('chrome-foreign', { navigate: true }));
});

test('closing the original Chrome page never retargets an explicit main request to its popup', () => {
  const group = ownedGroup(); group.targets.get('child').info.url = 'https://example.test/popup';
  group.event({ method: 'Target.targetDestroyed', params: { targetId: 'root' } });
  assert.throws(() => group.target('main'));
  assert.equal(group.target().id, 'child');
  assert.equal(group.target('chrome-child').id, 'child');
});

test('reopening an owner while its old connection is cancelling starts a fresh attempt', async () => {
  const runtime = new ChromeRuntime({ directory: '.' });
  const waiting = [];
  runtime.connect = async (options, guard) => { await new Promise(resolve => waiting.push(resolve)); guard(); return { profileId: options.profileId }; };
  const options = { paneId: 'one', profileId: 'test', url: 'https://example.test/' };
  const first = runtime.open(options);
  const rejected = assert.rejects(first, /취소/);
  runtime.disconnect('one', 'test');
  const second = runtime.open(options);
  const attempts = waiting.length;
  for (const finish of waiting) finish();
  await rejected;
  const result = await second.catch(error => error);
  assert.equal(attempts, 2);
  assert.deepEqual(result, { profileId: 'test' });
});

test('an agent hash navigation cannot hide the next manual navigation notification', async () => {
  let manual = 0;
  const group = { connection: { closed: false, send: async () => ({}) }, changed() {}, runtime: { onManual() { manual++; } } };
  const page = new ChromeContents(group, { targetId: 'root', url: 'https://example.test/' }, 'root');
  page.mainFrameId = 'frame';
  await page.loadURL('https://example.test/#anchor');
  page.event('Page.navigatedWithinDocument', { frameId: 'frame', url: 'https://example.test/#anchor', navigationType: 'fragment' });
  assert.equal(manual, 0);
  page.event('Page.frameNavigated', { frame: { id: 'frame', url: 'https://different.test/' } });
  assert.equal(manual, 1);
});

test('manual same-document browser navigation reports input while a renderer history update does not', () => {
  let manual = 0;
  const group = { connection: { closed: false }, changed() {}, runtime: { onManual() { manual++; } } };
  const page = new ChromeContents(group, { targetId: 'root', url: 'https://example.test/' }, 'root');
  page.mainFrameId = 'frame';
  page.event('Page.navigatedWithinDocument', { frameId: 'frame', url: 'https://example.test/app', navigationType: 'historyApi' });
  assert.equal(manual, 0);
  page.event('Page.navigatedWithinDocument', { frameId: 'frame', url: 'https://example.test/#manual', navigationType: 'fragment' });
  assert.equal(manual, 1);
});

test('failed navigation and an already loaded popup cannot authorize later manual navigation', async () => {
  let manual = 0;
  const group = { connection: { closed: false, send: async () => ({ errorText: 'ERR_ABORTED' }) }, changed() {}, runtime: { onManual() { manual++; } } };
  const page = new ChromeContents(group, { targetId: 'child', openerId: 'root', url: 'https://example.test/popup' }, 'child');
  page.mainFrameId = 'frame';
  page.event('Page.frameNavigated', { frame: { id: 'frame', url: 'https://different.test/' } });
  assert.equal(manual, 1);
  await assert.rejects(page.loadURL('https://example.test/failed'), /ERR_ABORTED/);
  page.event('Page.frameNavigated', { frame: { id: 'frame', url: 'https://example.test/failed' } });
  assert.equal(manual, 2);
});
