import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const { AgentBridge } = await import('../agent-bridge.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const script = fileURLToPath(new URL('../../scripts/mcp.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function until(check, message = 'condition was not reached') {
  const end = Date.now() + 5_000;
  while (!check()) { assert.ok(Date.now() < end, message); await pause(10); }
}

async function fixture(t, execute) {
  assert.equal(typeof AgentBridge, 'function', 'AgentBridge must implement the local control server');
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-bridge-'));
  const connectionFile = join(directory, 'agent-connection.json');
  const profiles = new Map([['one', 'work'], ['two', 'work'], ['three', 'personal'], ['four', 'personal']]);
  const events = [];
  const bridge = new AgentBridge({
    getProfile: id => profiles.get(id),
    emit: event => events.push(event),
    execute: execute ?? (async (method, args, guard) => {
      guard();
      if (method === 'list_panes') return [...profiles].map(([paneId, profileId]) => ({ paneId, profileId, title: paneId }));
      if (method === 'screenshot') return { image: 'aW1hZ2U=', mimeType: 'image/png' };
      return { method, args };
    }),
  });
  t.after(async () => {
    await bridge.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('mosaic-bridge-'));
    await rm(directory, { recursive: true, force: true });
  });
  await bridge.start(connectionFile);
  const connection = JSON.parse(await readFile(connectionFile, 'utf8'));
  const grant = (ids = ['one', 'two', 'three', 'four']) => bridge.setAccess({ enabled: true, panes: ids.map(id => ({ id, profileId: profiles.get(id) })) });
  return { bridge, connection, connectionFile, profiles, events, grant };
}

function request(connection, { path = '/call', method = 'POST', body, headers = {}, authenticated = true, raw } = {}) {
  const bytes = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(connection.url + path, {
      method,
      headers: {
        ...(authenticated ? { Authorization: 'Bearer ' + connection.token } : {}),
        ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }),
        ...headers,
      },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', data => { text += data; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

const call = (connection, method, args = {}) => request(connection, { body: { method, args } });

test('connection credentials stay out of public info and are removed only by their owner', async t => {
  const f = await fixture(t);
  assert.match(f.connection.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(f.connection.token, /^[a-f0-9]{64}$/);
  assert.equal(f.connection.pid, process.pid);
  if (process.platform !== 'win32') assert.equal((await stat(f.connectionFile)).mode & 0o777, 0o600);
  assert.equal(f.bridge.info().enabled, false);
  const info = await request(f.connection, { path: '/info', method: 'GET' });
  assert.equal(info.status, 200);
  assert.equal(JSON.stringify(info).includes(f.connection.token), false);
  const tools = await request(f.connection, { path: '/tools', method: 'GET' });
  assert.equal(tools.status, 200);
  assert.equal(tools.body.result.some(tool => tool.name === 'evaluate'), false);
  assert.ok(tools.body.result.some(tool => tool.name === 'snapshot'));
  await f.bridge.close();
  await assert.rejects(readFile(f.connectionFile), { code: 'ENOENT' });
  assert.throws(() => f.grant(), /closed/i);
});

test('close preserves a replacement connection file and cannot race an unfinished start', async t => {
  const f = await fixture(t);
  const replacement = { url: 'http://127.0.0.1:12345', token: 'a'.repeat(64), pid: process.pid };
  await writeFile(f.connectionFile, JSON.stringify(replacement));
  await f.bridge.close();
  assert.deepEqual(JSON.parse(await readFile(f.connectionFile, 'utf8')), replacement);
  await rm(f.connectionFile);
  const source = `
    import { AgentBridge } from ${JSON.stringify(new URL('../agent-bridge.mjs', import.meta.url).href)};
    import { existsSync } from 'node:fs';
    const bridge = new AgentBridge({ execute: async () => ({}), getProfile: () => 'work' });
    const starting = bridge.start(process.argv[1]);
    const closing = bridge.close();
    const started = await starting.then(() => true, () => false);
    await closing;
    process.stdout.write(JSON.stringify({ started, port: bridge.info().port, exists: existsSync(process.argv[1]) }));
    process.exit(0);
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, f.connectionFile], { windowsHide: true, timeout: 6000 });
  assert.deepEqual(JSON.parse(stdout), { started: false, port: null, exists: false });
});

test('client metadata cannot echo the bearer token into UI info or events', async t => {
  const f = await fixture(t); f.grant(['one']);
  assert.equal((await request(f.connection, { body: { method: 'snapshot', args: { paneId: 'one' } }, headers: { 'X-Mosaic-Client': f.connection.token } })).status, 200);
  assert.equal(JSON.stringify(f.bridge.info()).includes(f.connection.token), false);
  assert.equal(JSON.stringify(f.events).includes(f.connection.token), false);
});

test('every route rejects missing credentials, browser origins and non-loopback Host headers', async t => {
  const f = await fixture(t);
  for (const path of ['/info', '/tools', '/call']) {
    const method = path === '/call' ? 'POST' : 'GET';
    const body = path === '/call' ? { method: 'list_panes', args: {} } : undefined;
    assert.equal((await request(f.connection, { path, method, body, authenticated: false })).status, 401);
    assert.equal((await request(f.connection, { path, method, body, headers: { Authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await request(f.connection, { path, method, body, headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await request(f.connection, { path, method, body, headers: { Origin: '' } })).status, 403);
    assert.equal((await request(f.connection, { path, method, body, headers: { Host: 'localhost:80' } })).status, 403);
    assert.equal((await request(f.connection, { path, method, body, headers: { Host: 'evil.example' } })).status, 403);
  }
  assert.equal((await call(f.connection, 'list_panes')).body.error.code, 'ACCESS_DISABLED');
});

test('grants bind the exact current profile and list_panes never reveals other panes', async t => {
  const f = await fixture(t);
  f.grant(['one']);
  assert.throws(() => f.bridge.setAccess({ enabled: true, panes: [{ id: 'two', profileId: 'personal' }] }), /profile/i);
  assert.deepEqual(f.bridge.info().allowedPaneIds, ['one']);
  assert.equal((await call(f.connection, 'snapshot', { paneId: 'two' })).status, 403);
  assert.deepEqual((await call(f.connection, 'list_panes')).body.result, [{ paneId: 'one', profileId: 'work', title: 'one' }]);
  f.profiles.set('one', 'personal');
  assert.equal((await call(f.connection, 'snapshot', { paneId: 'one' })).body.error.code, 'GRANT_CHANGED');
  assert.deepEqual((await call(f.connection, 'list_panes')).body.result, []);
  f.grant(['one']);
  assert.equal((await call(f.connection, 'snapshot', { paneId: 'one' })).status, 200);
});

test('invalid commands and oversized bodies never reach the executor', async t => {
  let executed = 0;
  const f = await fixture(t, async () => { executed++; return {}; });
  f.grant();
  const invalid = [
    ['evaluate', { paneId: 'one', code: 'alert(1)' }],
    ['snapshot', {}], ['snapshot', { paneId: 'one', extra: true }], ['snapshot', []],
    ['navigate', { paneId: 'one', url: 'javascript:alert(1)' }],
    ['navigate', { paneId: 'one', url: 'file:///etc/passwd' }],
    ['navigate', { paneId: 'one', url: 'https://example.com/' + 'x'.repeat(2048) }],
    ['click', { paneId: 'one' }], ['click', { paneId: 'one', x: 1 }],
    ['click', { paneId: 'one', selector: 'button', x: 1, y: 2 }],
    ['click', { paneId: 'one', x: -1, y: 1 }],
    ['type', { paneId: 'one', selector: '', text: 'hello' }],
    ['type', { paneId: 'one', selector: 'x'.repeat(4097), text: 'hello' }],
    ['type', { paneId: 'one', selector: 'input', text: 'x'.repeat(32769) }],
    ['press_key', { paneId: 'one', key: '\u0000' }],
    ['scroll', { paneId: 'one', y: null }], ['scroll', { paneId: 'one', y: 100001 }],
    ['set_zoom', { paneId: 'one', factor: 3 }],
  ];
  for (const [method, args] of invalid) assert.equal((await call(f.connection, method, args)).status, 400, method + ': ' + JSON.stringify(args).slice(0, 100));
  assert.equal((await request(f.connection, { raw: '{broken' })).status, 400);
  assert.equal((await request(f.connection, { body: { method: 'list_panes', args: null } })).status, 400);
  assert.equal((await request(f.connection, { raw: JSON.stringify({ method: 'list_panes', args: {}, padding: 'x'.repeat(131072) }) })).status, 413);
  assert.equal((await request(f.connection, { body: { method: 'list_panes', args: {} }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(executed, 0);
});

test('supported commands preserve validated arguments for the executor', async t => {
  const f = await fixture(t);
  f.grant(['one']);
  const valid = [
    ['navigate', { paneId: 'one', url: 'https://example.com/page' }],
    ['click', { paneId: 'one', selector: '#send' }], ['click', { paneId: 'one', x: 10, y: 20 }],
    ['type', { paneId: 'one', selector: 'input', text: 'Hello\nworld' }],
    ['press_key', { paneId: 'one', key: 'Control+A' }], ['scroll', { paneId: 'one', x: -50, y: 600 }],
    ['set_zoom', { paneId: 'one', factor: 1.25 }],
  ];
  for (const [method, args] of valid) assert.deepEqual((await call(f.connection, method, args)).body.result, { method, args });
  assert.equal(JSON.stringify(f.events).includes(f.connection.token), false);
  assert.equal(JSON.stringify(f.events).includes('Hello'), false);
  assert.equal(f.events.at(-1).info.activeCount, 0, 'the UI must receive the final idle state');
});

test('same-pane commands remain FIFO while at most three panes execute concurrently', async t => {
  const started = [], releases = new Map(), active = new Set();
  let maximum = 0;
  const f = await fixture(t, async (_method, args, guard) => {
    guard();
    assert.equal(active.has(args.paneId), false, 'a pane must have only one active command');
    active.add(args.paneId); maximum = Math.max(maximum, active.size);
    const gate = deferred(); releases.set(args.url, gate); started.push(args.url);
    await gate.promise; guard(); active.delete(args.paneId);
    return args.url;
  });
  t.after(() => { for (const release of releases.values()) release.resolve(); });
  f.grant();
  const first = call(f.connection, 'navigate', { paneId: 'one', url: 'https://example.com/1a' });
  await until(() => started.length === 1);
  const second = call(f.connection, 'navigate', { paneId: 'one', url: 'https://example.com/1b' });
  await until(() => f.events.filter(e => e.phase === 'queued').length === 2);
  const third = call(f.connection, 'navigate', { paneId: 'two', url: 'https://example.com/2' });
  const fourth = call(f.connection, 'navigate', { paneId: 'three', url: 'https://example.com/3' });
  await until(() => started.length === 3);
  const fifth = call(f.connection, 'navigate', { paneId: 'four', url: 'https://example.com/4' });
  await until(() => f.events.filter(e => e.phase === 'queued').length === 5);
  assert.equal(started.includes('https://example.com/1b'), false);
  assert.equal(started.includes('https://example.com/4'), false);
  releases.get('https://example.com/1a').resolve();
  await until(() => started.includes('https://example.com/1b'));
  assert.equal(started.includes('https://example.com/4'), false);
  releases.get('https://example.com/2').resolve();
  await until(() => started.includes('https://example.com/4'));
  for (const release of releases.values()) release.resolve();
  assert.deepEqual((await Promise.all([first, second, third, fourth, fifth])).map(r => r.status), [200, 200, 200, 200, 200]);
  assert.equal(maximum, 3);
  assert.equal(f.bridge.info().activeCount, 0);
});

test('pane stop cancels queued commands and guards old work even after resume', async t => {
  const gate = deferred(), effects = [];
  const f = await fixture(t, async (method, args, guard) => {
    guard();
    if (method === 'navigate') await gate.promise;
    guard(); effects.push(method); return { paneId: args.paneId };
  });
  t.after(() => gate.resolve());
  f.grant(['one']);
  const running = call(f.connection, 'navigate', { paneId: 'one', url: 'https://example.com/' });
  await until(() => f.bridge.info().activeCount === 1);
  const queued = call(f.connection, 'click', { paneId: 'one', selector: 'button' });
  await until(() => f.events.filter(e => e.phase === 'queued').length === 2);
  f.bridge.stop('one');
  assert.deepEqual((await Promise.all([running, queued])).map(r => r.body.error.code), ['STOPPED', 'STOPPED']);
  assert.deepEqual(f.bridge.info().pausedPaneIds, ['one']);
  assert.equal((await call(f.connection, 'snapshot', { paneId: 'one' })).body.error.code, 'PANE_PAUSED');
  f.bridge.resume('one');
  const resumed = call(f.connection, 'click', { paneId: 'one', selector: 'button' });
  await until(() => f.events.filter(e => e.phase === 'queued').length === 3);
  assert.deepEqual(effects, []);
  gate.resolve();
  assert.equal((await resumed).status, 200);
  assert.deepEqual(effects, ['click']);
});

test('global stop revokes work and profile changes invalidate already running guards', async t => {
  const gates = [deferred(), deferred()], effects = [];
  let started = 0;
  const f = await fixture(t, async (_method, args, guard) => {
    guard(); const index = started++; await gates[index].promise;
    guard(); effects.push(args.paneId); return {};
  });
  t.after(() => gates.forEach(gate => gate.resolve()));
  f.grant(['one', 'two']);
  const first = call(f.connection, 'snapshot', { paneId: 'one' });
  const second = call(f.connection, 'snapshot', { paneId: 'two' });
  await until(() => started === 2);
  f.profiles.set('two', 'personal'); gates[1].resolve();
  assert.equal((await second).body.error.code, 'GRANT_CHANGED');
  f.bridge.stop();
  assert.equal((await first).body.error.code, 'STOPPED');
  assert.equal(f.bridge.info().enabled, false);
  assert.equal((await call(f.connection, 'list_panes')).body.error.code, 'ACCESS_DISABLED');
  gates[0].resolve(); await until(() => f.bridge.info().activeCount === 0);
  assert.deepEqual(effects, []);
});

test('removing a grant cancels pending work and each pane queue has a finite bound', async t => {
  const gate = deferred();
  const f = await fixture(t, async (_method, _args, guard) => { guard(); await gate.promise; guard(); return {}; });
  t.after(() => gate.resolve());
  f.grant(['one']);
  const running = call(f.connection, 'snapshot', { paneId: 'one' });
  await until(() => f.bridge.info().activeCount === 1);
  const queued = Array.from({ length: 16 }, () => call(f.connection, 'snapshot', { paneId: 'one' }));
  await until(() => f.events.filter(e => e.phase === 'queued').length === 17);
  const overflow = await call(f.connection, 'snapshot', { paneId: 'one' });
  assert.equal(overflow.status, 429);
  assert.equal(overflow.body.error.code, 'QUEUE_FULL');
  f.bridge.setAccess({ enabled: true, panes: [] });
  const responses = await Promise.all([running, ...queued]);
  assert.ok(responses.every(r => r.status === 403));
  gate.resolve();
});

test('the 30-second deadline cancels queued and active work without releasing a live pane lane', { timeout: 40_000 }, async t => {
  const gate = deferred(), effects = [];
  const f = await fixture(t, async (_method, _args, guard) => { guard(); await gate.promise; guard(); effects.push('effect'); return {}; });
  t.after(() => gate.resolve());
  f.grant(['one']);
  const first = call(f.connection, 'snapshot', { paneId: 'one' });
  await until(() => f.bridge.info().activeCount === 1);
  const second = call(f.connection, 'snapshot', { paneId: 'one' });
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(r => r.body.error.code), ['DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED']);
  assert.equal(f.bridge.info().activeCount, 1);
  gate.resolve(); await until(() => f.bridge.info().activeCount === 0);
  assert.deepEqual(effects, []);
});

function mcpProcess(t, args, env = {}) {
  const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const messages = [], waits = new Map();
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line); messages.push(message);
    const key = JSON.stringify(message.id), wait = waits.get(key);
    if (wait) { waits.delete(key); wait.resolve(message); }
  });
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) { child.kill(); await new Promise(done => child.once('exit', done)); } });
  const notify = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const rpc = (id, method, params) => {
    const wait = deferred(); waits.set(JSON.stringify(id), wait); notify({ id, method, ...(params === undefined ? {} : { params }) });
    return Promise.race([wait.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('MCP response timeout; stderr: ' + stderr)), 6_000); timer.unref(); wait.promise.finally(() => clearTimeout(timer)); })]);
  };
  return { child, messages, rpc, notify, stderr: () => stderr };
}

test('stdio MCP negotiates, lists tools, invokes the bridge and maps PNG screenshots', async t => {
  const f = await fixture(t); f.grant(['one']);
  const mcp = mcpProcess(t, ['--connection-file', f.connectionFile]);
  assert.deepEqual((await mcp.rpc(1, 'ping')).result, {});
  const initialized = await mcp.rpc(2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Bridge test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.ok(initialized.result.capabilities.tools);
  mcp.notify({ method: 'notifications/initialized' });
  const tools = (await mcp.rpc(3, 'tools/list')).result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['click', 'list_panes', 'list_targets', 'navigate', 'open_chrome', 'press_key', 'screenshot', 'scroll', 'set_zoom', 'snapshot', 'type']);
  assert.equal(tools.find(tool => tool.name === 'navigate').inputSchema.additionalProperties, false);
  const snapshot = await mcp.rpc(4, 'tools/call', { name: 'snapshot', arguments: { paneId: 'one' } });
  assert.deepEqual(JSON.parse(snapshot.result.content[0].text), { method: 'snapshot', args: { paneId: 'one' } });
  const screenshot = await mcp.rpc(5, 'tools/call', { name: 'screenshot', arguments: { paneId: 'one' } });
  assert.deepEqual(screenshot.result.content, [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]);
  const forbidden = await mcp.rpc(6, 'tools/call', { name: 'snapshot', arguments: { paneId: 'two' } });
  assert.equal(forbidden.result.isError, true);
  assert.equal((await mcp.rpc(7, 'unknown/method')).error.code, -32601);
  assert.equal(JSON.stringify(mcp.messages).includes(f.connection.token), false);
  assert.equal(mcp.stderr().includes(f.connection.token), false);
  assert.match(f.bridge.info().lastClient, /Bridge test/);
});

test('MCP preserves a recoverable screenshot result so the same client can observe again', async t => {
  let calls = 0;
  const f = await fixture(t, async (_method, _args, guard) => {
    guard();
    return calls++ ? { image: 'aW1hZ2U=', mimeType: 'image/png' }
      : { status: 'needs_observation', actionApplied: false, paneId: 'one', targetId: 'main', message: 'Read the current screen again.' };
  });
  f.grant(['one']);
  const mcp = mcpProcess(t, ['--connection-file', f.connectionFile]);
  await mcp.rpc(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'continuation-test', version: '1' } });
  const first = await mcp.rpc(1, 'tools/call', { name: 'screenshot', arguments: { paneId: 'one' } });
  assert.notEqual(first.result.isError, true);
  assert.equal(JSON.parse(first.result.content[0].text).status, 'needs_observation');
  const second = await mcp.rpc(2, 'tools/call', { name: 'screenshot', arguments: { paneId: 'one' } });
  assert.equal(second.result.content[0].type, 'image');
});

test('MCP supports older protocol versions and the environment connection path', async t => {
  const f = await fixture(t); f.grant(['one']);
  for (const version of ['2024-11-05', '2025-03-26', 'unsupported']) {
    const mcp = mcpProcess(t, [], { MOSAIC_CONNECTION_FILE: f.connectionFile });
    const result = await mcp.rpc(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'compatibility-test', version: '1' } });
    assert.equal(result.result.protocolVersion, version === 'unsupported' ? '2025-06-18' : version);
    assert.equal((await mcp.rpc(2, 'tools/call', { name: 'snapshot', arguments: { paneId: 'one' } })).result.isError, undefined);
  }
});

test('MCP cancellation disconnects pending HTTP calls and blocks their later side effects', async t => {
  const gate = deferred(), effects = [];
  const f = await fixture(t, async (_method, args, guard) => { guard(); await gate.promise; guard(); effects.push(args.paneId); return {}; });
  t.after(() => gate.resolve());
  f.grant(['one']);
  const mcp = mcpProcess(t, ['--connection-file', f.connectionFile]);
  await mcp.rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cancel-test', version: '1' } });
  const running = mcp.rpc(2, 'tools/call', { name: 'snapshot', arguments: { paneId: 'one' } });
  await until(() => f.bridge.info().activeCount === 1);
  const queued = mcp.rpc(3, 'tools/call', { name: 'snapshot', arguments: { paneId: 'one' } });
  await until(() => f.events.filter(e => e.phase === 'queued').length === 2);
  mcp.notify({ method: 'notifications/cancelled', params: { requestId: 3 } });
  assert.equal((await queued).result.isError, true);
  mcp.notify({ method: 'notifications/cancelled', params: { requestId: 2 } });
  assert.equal((await running).result.isError, true);
  await until(() => f.events.filter(e => e.code === 'CLIENT_DISCONNECTED').length === 2);
  gate.resolve(); await until(() => f.bridge.info().activeCount === 0);
  assert.deepEqual(effects, []);
});
