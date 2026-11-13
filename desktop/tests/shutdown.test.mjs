import { t } from '../../shared/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validState } from '../../shared/validation.mjs';
import { migrateSets, mergeNativeLocations } from '../../shared/workspaces.mjs';
import { livePanes } from '../../shared/workspaces.mjs';

test('closing after quit approval does not report an interrupted initial page load as startup failure', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('await window.loadFile(');
  const load = source.slice(start, source.indexOf('\n    })', start));
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('window', 'join', 'root', 'allowExit', load);
  const error = new Error('ERR_FAILED (-2) loading index.html');
  const window = { loadFile: async () => { throw error; } };
  await assert.doesNotReject(run(window, (...parts) => parts.join('/'), 'app', true));
  await assert.rejects(run(window, (...parts) => parts.join('/'), 'app', false), failure => failure === error);
});

test('late shutdown failure reconstructs native pages and makes layout refresh possible', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const quitHandler = source.slice(
    source.indexOf("app.on('before-quit'"),
    source.indexOf('await window.loadFile'),
  );
  let beforeQuit,
    reported,
    flushes = 0,
    refreshed = false;
  const failure = new Promise((resolve) => {
    reported = resolve;
  });
  const pane = {
    id: 'one',
    profileId: 'brand',
    kind: 'external',
    url: 'https://example.com/latest',
  };
  const state = {
    activeSetId: 'set',
    openSetIds: ['set'],
    savedSets: [],
    workspace: { id: 'set', panes: [pane] },
    profiles: [{ id: 'brand' }],
  };
  const manager = {
    panes: new Map([['one', pane]]),
    generation: 0,
    list: () => [],
    requestClose: async () => {
      manager.panes.clear();
      return true;
    },
    closeAll() {},
    flush: async () => {
      if (++flushes === 2) throw new Error('late save failure');
    },
    reconcile(panes) {
      manager.panes = new Map(panes.map((p) => [p.id, p]));
    },
  };
  const install = new Function(
    't',
    'app',
    'manager',
    'emit',
    'initial',
    'livePanes',
    `
    let currentState = initial, quitting = false, allowExit = false;
    const mergeNativeLocations = state => state;
    const store = { save: async () => {}, flush: async () => {} };
    const vault = { flush: async () => {} }, accounts = { closeAll() {} };
    const chats = { stop: async () => {}, flush: async () => {}, close: async () => {} };
    const appServices = { telemetry: { stop() {} }, flush: async () => {} };
    const bridge = { stop() {}, close: async () => { manager.bridgeClosed = true; } };
    ${quitHandler}
  `,
  );
  install(
    t,
    {
      on: (_name, fn) => {
        beforeQuit = fn;
      },
      quit() {
        throw new Error('Must remain open');
      },
    },
    manager,
    (event) => {
      if (event.type === 'refresh') refreshed = true;
      if (event.type === 'error') reported(event);
    },
    state,
    livePanes,
  );
  beforeQuit({ preventDefault() {} });
  await failure;
  assert.equal(manager.panes.get('one')?.url, 'https://example.com/latest');
  assert.equal(refreshed, true);
  assert.notEqual(
    manager.bridgeClosed,
    true,
    'a failed quit must leave the agent server available for reconnection',
  );
});

test('failed session persistence keeps the native pages open so quit can be retried', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const quitHandler = source.slice(
    source.indexOf("app.on('before-quit'"),
    source.indexOf('await window.loadFile'),
  );
  let beforeQuit,
    reported,
    closed = 0;
  const failure = new Promise((resolve) => {
    reported = resolve;
  });
  const install = new Function(
    't',
    'app',
    'manager',
    'emit',
    `
    let currentState = null, quitting = false, allowExit = false;
    const mergeNativeLocations = state => state;
    const store = { save: async () => {}, flush: async () => {} };
    const vault = { flush: async () => {} }, accounts = { closeAll() {} };
    const chats = { stop: async () => {}, flush: async () => {}, close: async () => {} };
    const appServices = { telemetry: { stop() {} }, flush: async () => {} };
    const bridge = { stop() {}, close: async () => {} };
    ${quitHandler}
  `,
  );
  install(
    t,
    {
      on: (_name, fn) => {
        beforeQuit = fn;
      },
      quit() {
        throw new Error('Must stay open');
      },
    },
    {
      panes: new Map([['one', {}]]),
      list: () => [],
      requestClose: async () => {
        closed++;
        return true;
      },
      closeAll() {},
      flush: async () => {
        throw new Error('storage unavailable');
      },
    },
    reported,
  );
  beforeQuit({ preventDefault() {} });
  const event = await failure;
  assert.match(event.message, /storage unavailable/);
  assert.equal(closed, 0, 'save sessions before destroying the only live copies');
});

test(
  'a delayed renderer save cannot replace native URLs captured during shutdown',
  { timeout: 2000 },
  async () => {
    const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
    const saveHandler = source.slice(
      source.indexOf("handle('mosaic:save'"),
      source.indexOf("handle('mosaic:sync'"),
    );
    const quitHandler = source.slice(
      source.indexOf("app.on('before-quit'"),
      source.indexOf('await window.loadFile'),
    );
    const initial = migrateSets({
      version: 1,
      theme: 'light',
      profiles: [{ id: 'work', name: 'Work', note: '', color: '#123456' }],
      savedSets: [],
      workspace: {
        id: 'set',
        name: 'Set',
        columns: 1,
        rows: 1,
        panes: [
          {
            id: 'pane',
            title: 'Page',
            url: 'https://example.com/old',
            profileId: 'work',
            kind: 'external',
            addressOpen: false,
          },
        ],
      },
    });
    let beforeQuit, finishClose, finished;
    const complete = new Promise((resolve) => {
      finished = resolve;
    });
    const approval = new Promise((resolve) => {
      finishClose = resolve;
    });
    const writes = [];
    const app = {
      on: (_name, handler) => {
        beforeQuit = handler;
      },
      quit: () => finished(),
    };
    const store = {
      save: async (state) => {
        writes.push(structuredClone(state));
      },
      flush: async () => {},
    };
    const manager = {
      panes: new Map([['pane', {}]]),
      list: () => [
        { paneId: 'pane', profileId: 'work', title: 'Latest', url: 'https://example.com/latest' },
      ],
      requestClose: () => approval,
      flush: async () => {},
      closeAll() {},
    };
    const install = new Function(
      't',
      'app',
      'store',
      'manager',
      'bridge',
      'validState',
      'mergeNativeLocations',
      'initial',
      `
    let currentState = initial, quitting = false, allowExit = false, save;
    const accounts = { closeAll() {} }, vault = { flush: async () => {} };
    const chats = { stop: async () => {}, flush: async () => {}, close: async () => {}, reconcile() {} };
    const appServices = { telemetry: { stop() {} }, flush: async () => { throw new Error('Optional usage save failed'); } };
    const handle = (name, handler) => { save = handler; };
    const emit = () => {};
    ${saveHandler}
    ${quitHandler}
    return { save, state: () => currentState };
  `,
    );
    const runtime = install(
      t,
      app,
      store,
      manager,
      { stop() {}, close: async () => {} },
      validState,
      mergeNativeLocations,
      initial,
    );
    beforeQuit({ preventDefault() {} });
    assert.equal(runtime.state().workspace.panes[0].url, 'https://example.com/latest');
    await runtime.save(structuredClone(initial));
    finishClose(true);
    await complete;
    assert.equal(writes.at(-1).workspace.panes[0].url, 'https://example.com/latest');
    assert.equal(writes.at(-1).savedSets[0].workspace.panes[0].url, 'https://example.com/latest');
  },
);
