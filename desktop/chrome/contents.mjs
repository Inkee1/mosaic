import { t } from '../../shared/i18n.mjs';
import { EventEmitter } from 'node:events';
import { chromeWebUrl } from '../external-browser.mjs';

export class ChromeContents extends EventEmitter {
  constructor(group, info, sessionId) {
    super();
    this.group = group;
    this.id = info.targetId;
    this.sessionId = sessionId;
    this.info = info;
    this.loading = false;
    this.destroyed = false;
    this.zoom = 1;
    this.dialog = null;
    this.documentVersion = 0;
    this.navigationIntent = info.openerId ? { url: info.url, source: 'initial' } : null;
    this.navigation = null;
    this.history = { currentIndex: 0, entries: [] };
    this.debugger = { isAttached: () => true, attach() {}, sendCommand: (method, params) => this.send(method, params) };
    this.navigationHistory = {
      canGoBack: () => this.history.currentIndex > 0,
      canGoForward: () => this.history.currentIndex < this.history.entries.length - 1,
      goBack: () => this.navigateHistory(-1), goForward: () => this.navigateHistory(1),
    };
  }
  send(method, params = {}) {
    if (this.isDestroyed()) return Promise.reject(new Error(t('Chrome 탭이 닫혔어요. 화면 목록을 다시 확인해 주세요.')));
    return this.group.connection.send(method, params, this.sessionId);
  }
  isDestroyed() { return this.destroyed || this.group.connection.closed; }
  getURL() { return this.info.url || 'about:blank'; }
  getTitle() { return this.info.title || ''; }
  isLoading() { return this.loading; }
  getZoomFactor() { return this.zoom; }
  async setZoomFactor(factor) { await this.send('Emulation.setPageScaleFactor', { pageScaleFactor: factor }); this.zoom = factor; this.group.changed(); }
  async executeJavaScript(expression) {
    if (this.dialog) throw new Error(t('Chrome의 확인 창을 직접 처리한 뒤 계속해 주세요.'));
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: false });
    if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description || result.exceptionDetails.text || t('페이지 스크립트 오류')).slice(0, 500));
    return result.result?.value;
  }
  async capturePage() {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return { toPNG: () => Buffer.from(result.data, 'base64') };
  }
  async executeJavaScriptInIsolatedWorld(worldId, scripts) {
    if (this.dialog) throw new Error(t('Chrome의 확인 창을 직접 처리한 뒤 계속해 주세요.'));
    const { frameTree } = await this.send('Page.getFrameTree');
    const { executionContextId } = await this.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'mosaic-' + worldId });
    const result = await this.send('Runtime.evaluate', { expression: scripts[0].code, contextId: executionContextId, returnByValue: true, awaitPromise: true, userGesture: false });
    if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description || result.exceptionDetails.text || t('페이지 스크립트 오류')).slice(0, 500));
    return result.result?.value;
  }
  async loadURL(value) {
    const url = chromeWebUrl(value);
    this.navigationIntent = { url, source: 'agent' };
    this.loading = true; this.group.changed();
    try {
      const result = await this.send('Page.navigate', { url });
      if (result.errorText) throw new Error(result.errorText);
    } catch (error) { this.navigationIntent = null; this.navigation = null; this.loading = false; this.group.changed(); throw error; }
    // Navigation is asynchronous; snapshot exposes ready/loading state so the
    // agent can inspect the destination instead of blocking on long-lived requests.
    this.info.url = url;
    this.group.changed();
  }
  async refreshHistory() {
    try { this.history = await this.send('Page.getNavigationHistory'); } catch {}
  }
  async navigateHistory(offset) {
    await this.refreshHistory();
    const entry = this.history.entries[this.history.currentIndex + offset];
    if (entry) {
      this.navigationIntent = { url: entry.url, source: 'agent' };
      try { await this.send('Page.navigateToHistoryEntry', { entryId: entry.id }); }
      catch (error) { this.navigationIntent = null; this.navigation = null; throw error; }
    }
  }
  async reload() {
    this.navigationIntent = { url: this.getURL(), source: 'agent' };
    try { await this.send('Page.reload'); }
    catch (error) { this.navigationIntent = null; this.navigation = null; throw error; }
  }
  stop() { this.navigationIntent = null; this.navigation = null; return this.send('Page.stopLoading'); }
  focus() { return this.send('Page.bringToFront'); }
  async prepareInput() {
    if (this.paintedVersion === this.documentVersion) return;
    const version = this.documentVersion;
    // A loaded DOM can precede Chrome's first compositor surface. In that
    // interval Chrome acknowledges pointer commands but drops their events.
    // A tiny surface readback waits for painting without storing page imagery.
    await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
    if (version === this.documentVersion) this.paintedVersion = version;
  }
  event(method, params) {
    if (method === 'Page.frameRequestedNavigation' && params.frameId === this.mainFrameId && params.disposition === 'currentTab') this.navigationIntent = { url: params.url, source: 'renderer' };
    if (method === 'Page.frameStartedNavigating' && params.frameId === this.mainFrameId) {
      this.documentVersion++;
      const sameNavigation = this.navigation && params.loaderId && this.navigation.loaderId === params.loaderId;
      this.navigation = { loaderId: params.loaderId, allowed: sameNavigation ? this.navigation.allowed : this.navigationIntent?.url === params.url };
      this.navigationIntent = null;
    }
    if (method === 'Page.frameStartedLoading' && params.frameId === this.mainFrameId) this.loading = true;
    if (method === 'Page.loadEventFired' || (method === 'Page.frameStoppedLoading' && params.frameId === this.mainFrameId)) {
      this.loading = false; this.navigationIntent = null; this.navigation = null; void this.refreshHistory();
    }
    if (method === 'Page.frameNavigated' && !params.frame.parentId) {
      const knownFrame = !!this.mainFrameId;
      this.mainFrameId = params.frame.id; this.info.url = params.frame.url; this.documentVersion++;
      this.navigationCompleted(params.frame.url, knownFrame);
    }
    if (method === 'Page.navigatedWithinDocument' && params.frameId === this.mainFrameId) {
      this.info.url = params.url; this.documentVersion++;
      this.navigationCompleted(params.url, true, params.navigationType === 'historyApi');
      this.loading = false; void this.refreshHistory();
    }
    if (method === 'Page.javascriptDialogOpening') this.dialog = { type: params.type, message: String(params.message).slice(0, 1000) };
    if (method === 'Page.javascriptDialogClosed') this.dialog = null;
    this.group.changed();
  }
  navigationCompleted(url, knownFrame, historyApi = false) {
    const allowed = this.navigation ? this.navigation.allowed : this.navigationIntent?.url === url;
    if (knownFrame && !allowed && !historyApi) this.group.runtime.onManual(this.group.paneId, this.group.profileId);
    this.navigationIntent = null; this.navigation = null;
  }
  dispose() { this.destroyed = true; this.emit('destroyed'); }
}
