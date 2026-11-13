import { t } from '../../shared/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { normalizeUrl } from '../../shared/validation.mjs';
import { clipPane } from '../geometry.mjs';
import { readScrollScript, restoreScrollScript } from '../page-scripts.mjs';
import { installPopupHandling } from '../popup-origin.mjs';
import { watchSiteCompatibility } from '../site-compatibility.mjs';
import { NativeTargets } from '../native-targets.mjs';
import { installPermissionHandlers } from '../site-permissions.mjs';

const source = readFileSync(new URL('../pane-manager.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace('export class PaneManager', 'class PaneManager');

function setup() {
  const sessions = new Map();
  const controls = { load: async () => {}, leave: false, confirmations: [] };
  class View {
    children = [];
    visible = false;
    addChildView(v) {
      this.children.push(v);
    }
    removeChildView(v) {
      this.children = this.children.filter((x) => x !== v);
    }
    setVisible(v) {
      this.visible = v;
    }
    setBounds(v) {
      this.bounds = v;
    }
    setBorderRadius() {}
  }
  class Contents extends EventEmitter {
    constructor(session) {
      super();
      this.session = session;
      this.destroyed = false;
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    }
    async loadURL(url) {
      this.url = url;
      await controls.load(this);
      this.emit('did-navigate', {}, url);
      this.emit('dom-ready');
      this.emit('did-stop-loading');
    }
    setZoomMode() {}
    getZoomFactor() {
      return 1;
    }
    setWindowOpenHandler() {}
    getURL() {
      return this.url;
    }
    isDestroyed() {
      return this.destroyed;
    }
    insertCSS() {
      return Promise.resolve();
    }
    stop() {}
    close(options) {
      if (options?.waitForBeforeUnload && this.protected) {
        const event = {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
        };
        this.emit('will-prevent-unload', event);
        if (!event.defaultPrevented) return;
      }
      this.destroyed = true;
      this.emit('destroyed');
    }
  }
  class WebContentsView extends View {
    constructor(options) {
      super();
      this.webContents = new Contents(options.webPreferences.session);
    }
  }
  const session = {
    fromPartition(partition) {
      if (!sessions.has(partition)) {
        const value = new EventEmitter();
        value.partition = partition;
        value.setPermissionCheckHandler = () => {};
        value.setPermissionRequestHandler = () => {};
        sessions.set(partition, value);
      }
      return sessions.get(partition);
    },
  };
  const dialog = { showMessageBoxSync: (_window, options) => { controls.confirmations.push(options); return controls.leave ? 1 : 0; } };
  const PaneManager = new Function(
    't',
    'View',
    'WebContentsView',
    'session',
    'dialog',
    'normalizeUrl',
    'clipPane',
    'readScrollScript',
    'restoreScrollScript',
    'hasCloseProtection',
    'installPopupHandling',
    'watchSiteCompatibility',
    'NativeTargets',
    'installPermissionHandlers',
    source + '\nreturn PaneManager;',
  )(
    t,
    View,
    WebContentsView,
    session,
    dialog,
    normalizeUrl,
    clipPane,
    readScrollScript,
    restoreScrollScript,
    async wc => { await controls.inspect?.(wc); return !!wc.protected; },
    installPopupHandling,
    watchSiteCompatibility,
    NativeTargets,
    installPermissionHandlers,
  );
  const window = { contentView: new View(), isDestroyed: () => false };
  const manager = new PaneManager(window, () => {});
  const profiles = [{ id: 'personal' }, { id: 'work' }];
  const pane = {
    id: 'one',
    profileId: 'personal',
    title: 'Original',
    url: 'https://example.com/',
    kind: 'external',
  };
  manager.reconcile([pane], profiles, 0);
  return { manager, controls, window, profiles, pane };
}

test('two panes with the same brand retain independent sessions when closed and reopened', async () => {
  const { manager, profiles, pane } = setup();
  const second = { ...pane, id: 'two' };
  manager.reconcile([pane, second], profiles, 0);
  await new Promise((resolve) => setImmediate(resolve));
  const firstSession = manager.get('one').view.webContents.session;
  const secondSession = manager.get('two').view.webContents.session;
  assert.notEqual(firstSession, secondSession, 'same brand must not merge P and Q logins');
  manager.close('two');
  manager.reconcile([pane, second], profiles, 0);
  assert.equal(manager.get('two').view.webContents.session, secondSession);
});

test('closing a real-style view succeeds when Electron clears its webContents property', async () => {
  const { manager, window } = setup();
  await new Promise((resolve) => setImmediate(resolve));
  const original = manager.get('one');
  const wc = original.view.webContents;
  Object.defineProperty(original.view, 'webContents', {
    get: () => (wc.destroyed ? undefined : wc),
  });
  assert.equal(await manager.requestClose(['one']), true);
  assert.equal(manager.panes.size, 0);
  assert.equal(window.contentView.children.length, 0);
});

test('failed profile loading leaves the original page and draft intact', async () => {
  const { manager, controls, window } = setup();
  await new Promise((resolve) => setImmediate(resolve));
  const original = manager.get('one');
  original.view.webContents.draft = 'unfinished';
  controls.load = async (wc) => {
    if (wc.session.partition.endsWith('work')) throw new Error('ERR_CONNECTION_REFUSED');
  };
  await assert.rejects(manager.switchProfile('one', 'work'), /ERR_CONNECTION_REFUSED/);
  assert.equal(manager.get('one'), original);
  assert.equal(original.view.webContents.draft, 'unfinished');
  assert.equal(original.view.webContents.destroyed, false);
  assert.equal(window.contentView.children.length, 1);
});

test('stale renderer sync cannot revert a completed profile transaction', async () => {
  const { manager } = setup();
  await new Promise((resolve) => setImmediate(resolve));
  const oldDescriptors = manager.descriptors;
  await manager.switchProfile('one', 'work');
  const replacement = manager.get('one');
  manager.reconcile(oldDescriptors, manager.profiles, manager.generation);
  assert.equal(manager.get('one'), replacement);
  assert.equal(manager.get('one').profileId, 'work');
});

test('closing a pane cancels its pending profile load without leaving another view', async () => {
  const { manager, controls, window } = setup();
  await new Promise((resolve) => setImmediate(resolve));
  controls.load = () => new Promise(() => {});
  const changing = manager.switchProfile('one', 'work');
  const rejected = assert.rejects(changing, /취소/);
  assert.equal(await manager.requestClose(['one']), true);
  await rejected;
  assert.equal(manager.list().length, 0);
  assert.equal(window.contentView.children.length, 0);
});

test('profile replacement only commits after the new page has loaded', async () => {
  const { manager, controls, window } = setup();
  await new Promise((resolve) => setImmediate(resolve));
  const original = manager.get('one');
  let complete;
  controls.load = (wc) =>
    wc.session.partition.endsWith('work')
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : Promise.resolve();
  const switching = manager.switchProfile('one', 'work');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(original.view.webContents.destroyed, false);
  assert.equal(manager.list()[0].profileId, 'personal');
  complete();
  const replacement = await switching;
  assert.equal(replacement.profileId, 'work');
  assert.equal(original.view.webContents.destroyed, true);
  assert.equal(window.contentView.children.length, 1);
});

test('beforeunload cancellation keeps a pane; confirmed close destroys it', async () => {
  const { manager, controls } = setup();
  const original = manager.get('one');
  original.view.webContents.protected = true;
  assert.equal(await manager.requestClose(['one']), false);
  assert.equal(manager.get('one'), original);
  assert.equal(original.view.webContents.destroyed, false);
  controls.leave = true;
  assert.equal(await manager.requestClose(['one']), true);
  assert.equal(manager.list().length, 0);
});

test('cancelled navigation reports the original URL without hiding the existing page', async () => {
  const { manager, controls } = setup();
  await new Promise((resolve) => setImmediate(resolve));
  const original = manager.get('one');
  controls.load = async (wc) => {
    wc.url = 'https://example.com/';
    throw Object.assign(new Error('cancelled'), { code: 'ERR_ABORTED' });
  };
  const result = await manager.navigate(original, 'https://example.org/');
  assert.equal(result.cancelled, true);
  assert.equal(original.url, 'https://example.com/');
  assert.equal(original.error, '');
});

test('cancelling a batch close preserves every original page and draft', async () => {
  const { manager, controls, profiles, pane } = setup();
  manager.reconcile([pane, { ...pane, id: 'two' }], profiles, 0);
  await new Promise((resolve) => setImmediate(resolve));
  const first = manager.get('one'),
    second = manager.get('two');
  first.view.webContents.draft = 'first draft';
  second.view.webContents.protected = true;
  assert.equal(await manager.requestClose(['one', 'two']), false);
  assert.equal(manager.get('one'), first);
  assert.equal(first.view.webContents.destroyed, false);
  assert.equal(first.view.webContents.draft, 'first draft');
  controls.leave = true;
  assert.equal(await manager.requestClose(['one', 'two']), true);
  assert.equal(manager.list().length, 0);
});

test('closing multiple ordinary pages does not ask for confirmation', async () => {
  const { manager, controls, profiles, pane } = setup();
  manager.reconcile([pane, { ...pane, id: 'two' }], profiles, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await manager.requestClose(['one', 'two']), true);
  assert.equal(controls.confirmations.length, 0);
  assert.equal(manager.list().length, 0);
});

test('a page changing during batch inspection requires confirmation before any page closes', async () => {
  const { manager, controls, profiles, pane } = setup();
  manager.reconcile([pane, { ...pane, id: 'two' }], profiles, 0);
  await new Promise(resolve => setImmediate(resolve));
  const first = manager.get('one');
  controls.inspect = async wc => { if (wc === first.view.webContents) wc.emit('did-start-navigation'); };
  assert.equal(await manager.requestClose(['one', 'two']), false);
  assert.equal(controls.confirmations.length, 1);
  assert.equal(manager.get('one'), first);
  assert.equal(first.closed, false);
  assert.equal(manager.panes.size, 2);
});

test('input after a clean inspection still protects its draft while another pane is being inspected', async () => {
  const { manager, controls, profiles, pane } = setup();
  manager.reconcile([pane, { ...pane, id: 'two' }], profiles, 0);
  await new Promise(resolve => setImmediate(resolve));
  const first = manager.get('one');
  controls.inspect = async wc => {
    if (wc === first.view.webContents) return;
    await new Promise(resolve => setImmediate(resolve));
    first.view.webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'a', code: 'KeyA' });
    first.view.webContents.protected = true;
    first.view.webContents.draft = 'new draft during inspection';
  };
  assert.equal(await manager.requestClose(['one', 'two']), false);
  assert.equal(controls.confirmations.length, 1);
  assert.equal(manager.get('one'), first);
  assert.equal(first.view.webContents.draft, 'new draft during inspection');
  assert.equal(first.closed, false);
});

test('a protected child popup keeps its parent and draft until the whole pane close is approved', async () => {
  const { manager, controls } = setup();
  await new Promise(resolve => setImmediate(resolve));
  const entry = manager.get('one');
  const child = new entry.view.webContents.constructor(entry.view.webContents.session);
  child.id = 15; child.url = 'https://example.com/login'; child.protected = true;
  const popup = { webContents: child, isDestroyed: () => child.destroyed, destroy: () => child.close() };
  entry.targets.popup(popup, {}, entry.view.webContents);
  entry.view.webContents.draft = 'preserved';
  assert.equal(await manager.requestClose(['one']), false);
  assert.equal(child.destroyed, false);
  assert.equal(manager.get('one').view.webContents.draft, 'preserved');
  controls.leave = true;
  assert.equal(await manager.requestClose(['one']), true);
  assert.equal(child.destroyed, true);
  assert.equal(controls.confirmations.length, 2);
});

test('returning from Chrome preserves the embedded page compatibility notice', async () => {
  const { manager } = setup();
  await new Promise(resolve => setImmediate(resolve));
  const entry = manager.get('one');
  entry.view.webContents.isLoading = () => false;
  entry.browser = 'chrome'; entry.nativeCompatibility = 'gate-electron';
  const result = manager.useMosaic('one');
  assert.equal(result.browser, 'mosaic');
  assert.equal(result.compatibility, 'gate-electron');
});
