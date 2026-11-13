import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatStore } from '../ai/chat-store.mjs';
import { ChatService } from '../ai/chat-service.mjs';

const until = async (check) => {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('Expected state did not arrive');
};
const pane = (id, profileId = 'p') => ({ id, profileId, kind: 'external', title: id, url: 'https://example.com/' });

async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-ai-test-'));
  let workspace = { openSetIds: ['a', 'b'], savedSets: [
    { id: 'a', workspace: { name: 'A', panes: [pane('one'), pane('two')] } },
    { id: 'b', workspace: { name: 'B', panes: [pane('three')] } },
  ] };
  const runs = [], bridges = [], events = [];
  const registry = {
    discover: async () => ['claude', 'codex'].map((id) => ({ id, name: id, status: 'ready', models: [
      { id: 'small', label: 'Small', efforts: ['low', 'high'] },
      { id: 'other', label: 'Other', efforts: ['medium'] },
    ] })),
    run: (input) => new Promise((resolve, reject) => {
      runs.push({ input, resolve, reject });
      input.onEvent({ type: 'session', sessionId: 'session-' + runs.length });
      if (!options.slowStop) input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    close: async () => {},
  };
  const createBridge = (config) => {
    const bridge = {
      config, stopped: false, closed: false,
      start: async (file) => { bridge.file = file; },
      setAccess: (access) => { bridge.access = access; },
      stop: () => { bridge.stopped = true; },
      close: async () => { bridge.closed = true; },
    };
    bridges.push(bridge);
    return bridge;
  };
  const service = new ChatService({
    directory, root: directory, registry, createBridge,
    getWorkspace: () => workspace,
    getPane: (id) => workspace.savedSets.flatMap((s) => s.workspace.panes).find((p) => p.id === id),
    execute: options.execute || (async (method, args, guard) => { guard(); return { method, ...args }; }),
    emit: (event) => events.push(event),
    onMetric: options.onMetric,
  });
  t.after(async () => {
    for (const run of runs) run.resolve({});
    await service.close();
  });
  const chat = async (setId = 'a', provider = 'claude', paneIds = []) => {
    const next = await service.createChat({ setId, provider });
    const id = next.chats.at(-1).id;
    await service.updateChat(id, { paneIds });
    return id;
  };
  return { service, registry, directory, runs, bridges, events, chat, setWorkspace: (next) => { workspace = next; }, getWorkspace: () => workspace };
}

test('usage hooks report only lifecycle names and never conversation or failure content', async t => {
  const metrics = [];
  const h = await harness(t, { onMetric: event => metrics.push(event) });
  const id = await h.chat('a', 'claude', ['one']);
  await h.service.send(id, 'private user content');
  await until(() => h.runs.length === 1);
  h.runs[0].resolve({ text: 'private response' });
  await until(() => h.service.find(id).status === 'completed');
  await h.service.send(id, 'another private prompt');
  await until(() => h.runs.length === 2);
  h.runs[1].reject(new Error('private provider error'));
  await until(() => h.service.find(id).status === 'error');
  assert.deepEqual(metrics, ['ai_started', 'ai_completed', 'ai_started', 'ai_failed']);
});

test('pane replacement during discovery cancels admission and snapshots remain ordered', async (t) => {
  const h = await harness(t);
  const id = await h.chat('a', 'claude', ['one']);
  let release;
  const original = h.registry.discover;
  h.registry.discover = () => new Promise(resolve => { release = resolve; });
  const first = h.service.state();
  const sending = h.service.send(id, 'do not execute after pane replacement');
  const rejection = assert.rejects(sending, /중지/);
  h.service.stopForPane('one');
  await assert.rejects(h.service.send(id, 'too soon'), /기다려/);
  release(await original());
  await rejection;
  assert.equal(h.runs.length, 0);
  assert.equal(h.service.find(id).status, 'interrupted');
  assert.ok(h.service.state().revision > first.revision);
  assert.ok(h.events.every((event, i) => !i || event.state.revision > h.events[i - 1].state.revision));
});

test('runtime default model accepts its supported effort and concurrent forks retain exact identity', async (t) => {
  const h = await harness(t);
  const source = await h.chat('a', 'claude', ['one']);
  h.service.find(source).messages.push({ id: 'old-message', role: 'user', content: 'visible context', createdAt: new Date().toISOString() });
  const [fork, other] = await Promise.all([
    h.service.forkChat(source, 'codex', true),
    h.service.createChat({ setId: 'b', provider: 'claude' }),
  ]);
  assert.notEqual(fork.createdChatId, other.createdChatId);
  assert.deepEqual(h.service.find(fork.createdChatId).paneIds, ['one']);
  assert.match(h.service.find(fork.createdChatId).messages[0].content, /visible context/);
  assert.deepEqual(h.service.find(other.createdChatId).paneIds, []);
  assert.deepEqual(h.service.find(other.createdChatId).messages, []);
  h.service.catalog = [{ id: 'claude', status: 'ready', models: [{ id: '', label: 'CLI default', efforts: ['high'] }] }];
  await h.service.updateChat(source, { effort: 'high' });
  await h.service.send(source, 'use default model with high effort');
  await until(() => h.runs.length === 1);
  assert.equal(h.runs[0].input.model, '');
  assert.equal(h.runs[0].input.effort, 'high');
});

test('failed shutdown persistence leaves the chat service usable and quit can be retried', async (t) => {
  const h = await harness(t);
  const original = h.service.store.save.bind(h.service.store);
  h.service.store.save = async () => { throw new Error('disk full during shutdown'); };
  await assert.rejects(h.service.close(), /disk full/);
  h.service.store.save = original;
  assert.equal((await h.service.providers()).length, 2);
  await h.chat();
  await h.service.close();
});

test('chat history survives restart and interrupted runs never replay; backup recovers corruption', async (t) => {
  const h = await harness(t);
  const id = await h.chat();
  await h.service.send(id, 'hello');
  await until(() => h.runs.length === 1);
  h.runs[0].input.onEvent({ type: 'text', text: 'partial answer' });
  await h.service.flush();
  const store = new ChatStore(h.directory);
  const recovered = store.load();
  assert.equal(recovered.chats[0].status, 'interrupted');
  assert.equal(recovered.chats[0].messages.at(-1).content, 'partial answer');
  assert.equal(recovered.chats[0].sessionId, 'session-1');
  await h.service.updateChat(id, { title: 'saved title' });
  await writeFile(join(h.directory, 'ai-chats.json'), '{bad-json');
  const backup = new ChatStore(h.directory).load();
  assert.ok(backup.recoveryNotice);
  assert.equal(backup.chats.length, 1);
  assert.equal(h.runs.length, 1);
});

test('maximum two independent runs and whole-turn pane locks prevent interleaved chats', async (t) => {
  const h = await harness(t);
  const first = await h.chat('a', 'claude', ['one']);
  const conflict = await h.chat('a', 'codex', ['one']);
  const independent = await h.chat('b', 'codex', ['three']);
  const fourth = await h.chat();
  await h.service.send(first, 'first');
  await h.service.send(conflict, 'same pane');
  await h.service.send(independent, 'other set');
  await h.service.send(fourth, 'no target');
  await until(() => h.runs.length === 2);
  assert.match(h.runs[0].input.prompt, /first/);
  assert.match(h.runs[1].input.prompt, /other set/);
  assert.equal(h.service.state().chats.find((c) => c.id === conflict).status, 'queued');
  assert.throws(() => h.service.guardExternal('one'), /AI|채팅|사용/);
  h.runs[0].resolve({ text: 'done', model: 'small', effort: 'high' });
  await until(() => h.runs.length === 3);
  assert.match(h.runs[2].input.prompt, /same pane/);
  assert.equal(h.service.state().chats.find((c) => c.id === fourth).status, 'queued');
});

test('target grants are per run and set membership is enforced', async (t) => {
  const h = await harness(t);
  const id = await h.chat();
  await assert.rejects(h.service.updateChat(id, { paneIds: ['three'] }), /화면|세트/);
  await assert.rejects(h.service.createChat({ setId: 'missing' }), /세트/);
  await assert.rejects(h.service.updateChat(id, { sessionId: 'injected' }), /설정|허용|지원/);
  await h.service.updateChat(id, { paneIds: ['one'] });
  await h.service.send(id, 'read');
  await until(() => h.runs.length === 1);
  assert.deepEqual(h.bridges[0].access, { enabled: true, panes: [{ id: 'one', profileId: 'p' }] });
  assert.equal(h.runs[0].input.connectionFile, h.bridges[0].file);
  assert.doesNotMatch(JSON.stringify(h.service.state()), /connectionFile|token/);
});

test('stopping revokes browser access immediately but retains the lock until runtime exits', async (t) => {
  const h = await harness(t, { slowStop: true });
  const id = await h.chat('a', 'claude', ['one']);
  const waiting = await h.chat('a', 'codex', ['one']);
  await h.service.send(id, 'run');
  await h.service.send(waiting, 'wait');
  await until(() => h.runs.length === 1);
  await h.service.stop(id);
  assert.ok(h.runs[0].input.signal.aborted);
  assert.ok(h.bridges[0].stopped);
  assert.equal(h.service.state().chats[0].status, 'stopping');
  await assert.rejects(h.bridges[0].config.execute('click', { paneId: 'one' }, () => {}));
  assert.equal(h.runs.length, 1);
  h.runs[0].resolve({});
  await until(() => h.runs.length === 2);
  assert.equal(h.service.state().chats[0].status, 'interrupted');
});

test('profile change and set closure cancel queued and running work; switching active set does not', async (t) => {
  const h = await harness(t);
  const first = await h.chat('a', 'claude', ['one']);
  const waiting = await h.chat('a', 'codex', ['one']);
  await h.service.send(first, 'run');
  await h.service.send(waiting, 'wait');
  await until(() => h.runs.length === 1);
  h.getWorkspace().activeSetId = 'b';
  h.service.reconcile();
  assert.equal(h.runs[0].input.signal.aborted, false);
  h.getWorkspace().savedSets[0].workspace.panes[0].profileId = 'replacement';
  h.service.reconcile();
  await until(() => h.service.state().chats[0].status === 'interrupted');
  assert.equal(h.service.state().chats[1].status, 'interrupted');
  assert.equal(h.runs.length, 1);
  const third = await h.chat('b', 'claude');
  await h.service.send(third, 'normal chat');
  await until(() => h.runs.length === 2);
  h.getWorkspace().openSetIds = ['a'];
  h.service.reconcile();
  await until(() => h.service.state().chats[2].status === 'interrupted');
});

test('model settings freeze per run, unsupported effort is rejected, and resume belongs only to its chat', async (t) => {
  const h = await harness(t);
  const id = await h.chat();
  await h.service.updateChat(id, { model: 'small', effort: 'high' });
  await h.service.send(id, 'first');
  await until(() => h.runs.length === 1);
  await h.service.updateChat(id, { model: 'other', effort: 'medium' });
  assert.equal(h.runs[0].input.model, 'small');
  assert.equal(h.runs[0].input.effort, 'high');
  h.runs[0].input.onEvent({ type: 'text', text: 'answer' });
  h.runs[0].resolve({ text: 'answer', model: 'small', effort: 'high' });
  await until(() => h.service.state().chats[0].status === 'completed');
  assert.equal(h.service.state().chats[0].messages.at(-1).content, 'answer');
  await h.service.send(id, 'second');
  await until(() => h.runs.length === 2);
  assert.equal(h.runs[1].input.sessionId, 'session-1');
  assert.equal(h.runs[1].input.model, 'other');
  h.runs[1].resolve({});
  await until(() => h.service.state().chats[0].status === 'completed');
  await h.service.updateChat(id, { effort: 'not-supported' });
  await assert.rejects(h.service.send(id, 'invalid'), /effort|지원/);
  const fork = await h.service.forkChat(id, 'codex', true);
  assert.equal(fork.chats.at(-1).provider, 'codex');
  assert.equal(fork.chats.at(-1).sessionId, undefined);
  assert.match(fork.chats.at(-1).messages[0].content, /first|answer/);
});

test('late provider events after cancel are ignored and a failed durable enqueue never invokes a provider', async (t) => {
  const h = await harness(t);
  const id = await h.chat();
  await h.service.send(id, 'run');
  await until(() => h.runs.length === 1);
  await h.service.stop(id);
  await until(() => h.service.state().chats[0].status === 'interrupted');
  h.runs[0].input.onEvent({ type: 'text', text: 'late response' });
  assert.ok(!h.service.state().chats[0].messages.some((m) => m.content.includes('late response')));
  const originalSave = h.service.store.save.bind(h.service.store);
  h.service.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(h.service.send(id, 'cannot save'), /disk full/);
  assert.equal(h.runs.length, 1);
  // Restore storage for teardown.
  h.service.store.save = originalSave;
});

test('pane closure cancels only the chat owning that pane; archived chats cannot run', async (t) => {
  const h = await harness(t);
  const first = await h.chat('a', 'claude', ['one']);
  const second = await h.chat('a', 'codex', ['two']);
  await h.service.send(first, 'one');
  await h.service.send(second, 'two');
  await until(() => h.runs.length === 2);
  h.service.stopForPane('one');
  await until(() => h.service.state().chats[0].status === 'interrupted');
  assert.equal(h.runs[1].input.signal.aborted, false);
  await h.service.updateChat(first, { archived: true });
  await assert.rejects(h.service.send(first, 'archived'), /보관/);
  await h.service.updateChat(first, { archived: false });
  assert.equal(h.service.state().chats[0].archived, false);
});

test('manual input keeps the same provider run alive and retains its pane lock', async (t) => {
  const h = await harness(t);
  const first = await h.chat('a', 'claude', ['one']);
  const second = await h.chat('a', 'codex', ['one']);
  await h.service.send(first, 'continue around user input');
  await until(() => h.runs.length === 1);
  await h.service.send(second, 'wait for the same pane');
  h.service.userInteracted('one');
  h.service.userInteracted('one');
  assert.equal(h.runs[0].input.signal.aborted, false);
  assert.equal(h.service.find(first).status, 'running');
  assert.equal(h.service.find(second).status, 'queued');
  assert.equal(h.runs.length, 1);
  assert.equal(h.bridges[0].stopped, false);
  assert.equal(h.service.find(first).events.filter(event => event.type === 'notice').length, 1);
  assert.match(h.runs[0].input.prompt, /needs_observation/);
  await h.bridges[0].config.execute('snapshot', { paneId: 'one' }, () => {});
  h.runs[0].resolve({});
  await until(() => h.runs.length === 2);
  assert.equal(h.service.find(first).status, 'completed');
});

test('an in-flight external browser operation owns its pane until it settles', async (t) => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const h = await harness(t, { execute: async (_method, _args, guard) => { guard(); await gate; guard(); } });
  const operation = h.service.executeExternal('click', { paneId: 'one' }, () => {});
  const id = await h.chat('a', 'claude', ['one']);
  await h.service.send(id, 'wait for external input');
  assert.equal(h.runs.length, 0);
  finish();
  await operation;
  await until(() => h.runs.length === 1);
});

test('a stopped provider cannot release a pane while its old browser command is still running', async (t) => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const h = await harness(t, { execute: async (_method, _args, guard) => { guard(); await gate; guard(); } });
  const id = await h.chat('a', 'claude', ['one']);
  const other = await h.chat('a', 'codex', ['one']);
  await h.service.send(id, 'first');
  await h.service.send(other, 'second');
  await until(() => h.runs.length === 1);
  const command = h.bridges[0].config.execute('click', { paneId: 'one' }, () => {}).catch(() => {});
  await h.service.stop(id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.runs.length, 1);
  finish();
  await command;
  await until(() => h.runs.length === 2);
});
