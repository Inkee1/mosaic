import { t } from '../shared/i18n.mjs';
import { isAllowedPopupUrl } from './popup-origin.mjs';

// Child windows inherit their owner's grant. A window from another pane is
// never looked up globally, even if its webContents ID is known.
export class NativeTargets {
  constructor(contents, { changed = () => {}, manual = () => {} } = {}) {
    this.items = new Map(); this.activeId = 'main'; this.version = 0;
    this.changed = changed; this.manual = manual; this.disposed = false;
    this.add(contents, 'main');
  }
  add(contents, id, parentTargetId, window) {
    if (this.disposed) return;
    const item = { contents, id, parentTargetId, window, listeners: [], documentVersion: 0 };
    this.items.set(id, item); this.activeId = id; this.version++;
    const on = (name, fn) => { contents.on(name, fn); item.listeners.push([name, fn]); };
    on('focus', () => { this.activeId = id; this.changed(); });
    on('destroyed', () => {
      this.items.delete(id); this.version++;
      if (this.activeId === id) this.activeId = this.items.has(parentTargetId) ? parentTargetId : 'main';
      this.changed();
    });
    // Start and commit are separate epochs: an observation while the old page
    // waits for a response must never authorize input on its replacement.
    for (const event of ['did-start-navigation', 'did-frame-navigate', 'did-navigate-in-page'])
      on(event, () => { item.documentVersion++; this.version++; this.changed(); });
    for (const event of ['did-stop-loading', 'page-title-updated'])
      on(event, () => { this.version++; this.changed(); });
    if (id !== 'main') {
      const input = () => { this.activeId = id; this.version++; this.manual(); };
      on('before-input-event', (_event, value) => { if (value.type === 'keyDown') input(); });
      on('before-mouse-event', (_event, value) => { if (value.type === 'mouseDown') input(); });
      on('input-event', (_event, value) => { if (value.type === 'mouseWheel') input(); });
    }
    this.changed();
  }
  popup(window, _details, opener) {
    const parentId = [...this.items.values()].find(item => item.contents === opener)?.id;
    if (!parentId) return;
    this.add(window.webContents, 'popup-' + window.webContents.id, parentId, window);
  }
  list() {
    return [...this.items.values()].filter(({ contents }) => !contents.isDestroyed()).map(({ contents, id, parentTargetId }) => ({
      targetId: id, parentTargetId, browser: 'mosaic', active: id === this.activeId,
      title: (contents.getTitle?.() || '').slice(0, 120), url: contents.getURL(),
      loading: !!contents.isLoading?.(), accessible: isAllowedPopupUrl(contents.getURL() || 'about:blank'),
    }));
  }
  target(id = this.activeId) {
    const contents = this.items.get(id)?.contents;
    if (!contents || contents.isDestroyed()) throw new Error(t('탭이 닫혔어요. list_targets로 다시 확인해 주세요.'));
    if (!isAllowedPopupUrl(contents.getURL() || 'about:blank')) throw new Error(t('제어할 수 없는 페이지예요.'));
    return contents;
  }
  id(contents) { return [...this.items.values()].find(item => item.contents === contents)?.id; }
  documentVersion(contents) { return [...this.items.values()].find(item => item.contents === contents)?.documentVersion; }
  dispose() {
    this.disposed = true;
    for (const { contents, window, listeners } of this.items.values()) {
      for (const [name, fn] of listeners) contents.off(name, fn);
      if (window && !window.isDestroyed()) window.destroy();
    }
    this.items.clear();
  }
}
