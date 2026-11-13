import { t } from '../../shared/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeUrl } from '../../shared/validation.mjs';
import { clipPane } from '../geometry.mjs';
import { readScrollScript, restoreScrollScript } from '../page-scripts.mjs';

// Exercise the production lifecycle methods without starting Electron. Native
// rendering, clipping and event delivery still require the desktop integration run.
const source = readFileSync(new URL('../pane-manager.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace('export class PaneManager', 'class PaneManager');
const PaneManager = new Function(
  't',
  'normalizeUrl',
  'clipPane',
  'readScrollScript',
  'restoreScrollScript',
  source + '\nreturn PaneManager;',
)(t, normalizeUrl, clipPane, readScrollScript, restoreScrollScript);

function entry(id, executeJavaScript = async () => ({ x: 0, y: 0 })) {
  const pane = {
    id,
    closed: false,
    error: '',
    gridScroll: null,
    focusScroll: null,
    visible: true,
    position: { x: 0, y: 100 },
    container: {
      setVisible(value) {
        pane.visible = value;
      },
      setBounds() {},
      setBorderRadius() {},
    },
    view: {
      setBounds() {},
      webContents: {
        executeJavaScript,
        isDestroyed: () => false,
        isLoading: () => false,
        close() {
          pane.closedCalls = (pane.closedCalls ?? 0) + 1;
        },
      },
    },
  };
  return pane;
}

const item = (paneId) => ({
  paneId,
  rect: { x: 20, y: 20, width: 400, height: 300 },
  viewport: { x: 0, y: 0, width: 800, height: 600 },
});

test('a fresh focus session starts from the current grid scroll and restores it on return', async () => {
  const manager = new PaneManager({}, () => {});
  const pane = entry('one');
  manager.panes.set(pane.id, pane);
  manager.readScroll = async (target) => ({ ...target.position });
  manager.writeScroll = async (target, position) => {
    if (position) target.position = { ...position };
  };
  const layout = (focusId) => manager.layout({ items: [item(pane.id)], blocked: false, focusId });

  await layout(pane.id);
  pane.position.y = 900;
  await layout(null);
  assert.equal(pane.position.y, 100, 'leaving focus restores the original grid position');

  pane.position.y = 200;
  await layout(pane.id);
  assert.equal(
    pane.position.y,
    200,
    'entering focus again must not reuse the previous session position',
  );
  pane.position.y = 700;
  await layout(null);
  assert.equal(pane.position.y, 200);
});

test('an unrelated stalled renderer cannot prevent focus layout or leave old views over the shell', async () => {
  const manager = new PaneManager({}, () => {});
  const target = entry('target');
  const stalled = entry('stalled', () => new Promise(() => {}));
  manager.panes.set(target.id, target);
  manager.panes.set(stalled.id, stalled);

  const operation = manager.layout({
    items: [item(target.id)],
    blocked: false,
    focusId: target.id,
  });
  assert.equal(stalled.visible, false, 'hide the old native view before awaiting a renderer');
  let timeout;
  try {
    await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error('Focus layout waited more than 1.5 seconds for a stalled renderer')),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(manager.focusedId, target.id);
  assert.equal(target.visible, true);
  assert.equal(stalled.visible, false);
});

test('close destroys a pane safely after the containing window has already been destroyed', () => {
  const destroyedWindow = {
    isDestroyed: () => true,
    get contentView() {
      throw new Error('Destroyed window contentView must not be accessed');
    },
  };
  const manager = new PaneManager(destroyedWindow, () => {});
  const pane = entry('one');
  manager.panes.set(pane.id, pane);
  const stopped = [];
  manager.onManual = (id) => stopped.push(id);

  assert.doesNotThrow(() => manager.close(pane.id));
  assert.equal(pane.closed, true);
  assert.equal(pane.closedCalls, 1);
  assert.equal(manager.panes.has(pane.id), false);
  assert.deepEqual(stopped, [pane.id]);
});
