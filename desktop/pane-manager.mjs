import { t } from '../shared/i18n.mjs';
import { View, WebContentsView, session, dialog } from 'electron';
import { normalizeUrl } from '../shared/validation.mjs';
import { clipPane } from './geometry.mjs';
import { readScrollScript, restoreScrollScript } from './page-scripts.mjs';
import { installPopupHandling } from './popup-origin.mjs';
import { hasCloseProtection } from './close-protection.mjs';
import { watchSiteCompatibility } from './site-compatibility.mjs';
import { NativeTargets } from './native-targets.mjs';
import { installPermissionHandlers } from './site-permissions.mjs';

export class PaneManager {
  constructor(window, emit, sessionStore = null, chromeRuntime = null) {
    this.window = window;
    this.emit = emit;
    this.panes = new Map();
    this.sessions = new Map();
    this.sessionReady = new Map();
    this.sessionStore = sessionStore;
    this.generation = 0;
    this.blocked = false;
    this.focusedId = null;
    this.onManual = () => {};
    this.onInput = () => {};
    this.profiles = [];
    this.descriptors = [];
    this.chromeRuntime = chromeRuntime;
    if (chromeRuntime) {
      chromeRuntime.onChange = (id, group) => {
        const entry = this.panes.get(id);
        if (entry?.chrome === group && !entry.closed) this.updateChrome(entry);
      };
      chromeRuntime.onManual = (id, profileId) => {
        const entry = this.panes.get(id);
        if (entry?.profileId === profileId && entry.browser === 'chrome' && !entry.closed && !entry.automationDepth) this.userInput(id);
      };
      chromeRuntime.onDisconnect = (id, profileId) => {
        const entry = this.panes.get(id);
        if (entry?.profileId === profileId && entry.browser === 'chrome' && !entry.closed) this.onManual(id);
      };
    }
  }
  userInput(id) {
    const entry = this.panes.get(id);
    if (!entry || entry.closed) return;
    entry.interactionVersion = (entry.interactionVersion || 0) + 1;
    entry.lastInteractionAt = Date.now();
    this.onInput(id);
  }
  documentVersion(entry, contents) {
    return entry.browser === 'chrome' ? contents.documentVersion : entry.targets?.documentVersion(contents) ?? entry.documentVersion;
  }
  getSession(profileId, paneId) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(profileId)) throw new Error('Invalid profile');
    if (paneId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(paneId))
      throw new Error('Invalid pane');
    const key = paneId
      ? `mosaic-pane-${paneId.length}-${paneId}-${profileId}`
      : 'mosaic-' + profileId;
    if (this.sessions.has(key)) return this.sessions.get(key);
    const ses = session.fromPartition('persist:' + key);
    installPermissionHandlers(ses, async ({ origin, permission, mediaTypes }) => {
      const permissionLabel = permission === 'media'
        ? mediaTypes.map(type => type === 'audio' ? t('마이크') : t('카메라')).join(', ')
        : permission;
      const { response } = await dialog.showMessageBox(this.window, {
        type: 'question',
        title: t('사이트 권한'),
        message: t('{origin} 사이트가 {permission} 권한을 요청합니다.', { origin, permission: permissionLabel }),
        buttons: [t('거부'), t('이번 실행에서 허용')],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    }, () => !this.window.isDestroyed());
    ses.on('will-download', (_event, item) =>
      item.setSaveDialogOptions({ title: t('다운로드 파일 저장') }),
    );
    this.sessions.set(key, ses);
    const seed = paneId ? this.getSession(profileId) : undefined;
    this.sessionReady.set(
      ses,
      this.sessionStore?.prepare(key, ses, seed, this.sessionReady.get(seed)) || Promise.resolve(),
    );
    return ses;
  }
  reconcile(panes, profiles, generation) {
    this.profiles = profiles;
    this.descriptors = panes;
    if (generation !== this.generation) {
      this.closeAll();
      this.generation = generation;
    }
    const ids = new Set(panes.filter((p) => p.kind === 'external').map((p) => p.id));
    for (const id of this.panes.keys()) if (!ids.has(id)) this.close(id);
    for (const pane of panes.filter((p) => p.kind === 'external')) {
      if (!profiles.some((p) => p.id === pane.profileId)) throw new Error('Unknown profile');
      let entry = this.panes.get(pane.id);
      if (entry?.switching) continue;
      if (entry && entry.profileId !== pane.profileId) {
        // Profile changes are transactions, not renderer reconciliation. An old
        // in-flight metadata sync must never undo a newly committed session.
        continue;
      }
      if (!entry) entry = this.create(pane);
      // Explicit navigation uses command(). Reconcile only handles unobserved set URLs.
      if (pane.url !== entry.modelUrl && !entry.reportedUrls.has(pane.url))
        this.navigate(entry, pane.url);
      entry.modelUrl = pane.url;
    }
    return this.list();
  }
  create(pane, { register = true, load = true } = {}) {
    const container = new View();
    container.setVisible(false);
    const view = new WebContentsView({
      webPreferences: {
        session: this.getSession(pane.profileId, pane.id),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
      },
    });
    container.addChildView(view);
    this.window.contentView.addChildView(container);
    const entry = {
      id: pane.id,
      profileId: pane.profileId,
      browser: pane.browser === 'chrome' ? 'chrome' : 'mosaic',
      container,
      view,
      modelUrl: pane.url,
      url: pane.url,
      title: pane.title,
      loading: true,
      error: '',
      compatibility: '',
      reportedUrls: new Set([pane.url]),
      layout: null,
      gridScroll: null,
      focusScroll: null,
      closed: false,
    };
    if (register) this.panes.set(pane.id, entry);
    const wc = view.webContents;
    entry.targets = new NativeTargets(wc, {
      changed: () => { if (entry.browser !== 'chrome') this.send(entry); },
      manual: () => { entry.inputVersion = (entry.inputVersion || 0) + 1; if (entry.browser !== 'chrome' && !entry.automationDepth) this.userInput(entry.id); },
    });
    entry.disposeCompatibility = watchSiteCompatibility(wc, (compatibility) => {
      entry.nativeCompatibility = compatibility;
      if (entry.closed || entry.browser === 'chrome' || entry.compatibility === compatibility) return;
      entry.compatibility = compatibility;
      this.applyLayout(entry);
      this.send(entry);
    });
    wc.setZoomMode('isolated');
    wc.on('will-prevent-unload', (event) => {
      if (entry.closed) return;
      const leave =
        dialog.showMessageBoxSync(this.window, {
          type: 'question',
          title: t('닫기 확인'),
          message: t('작성 중인 내용이 사라질 수 있어요. 닫을까요?'),
          buttons: [t('취소'), t('닫기')],
          noLink: true,
          defaultId: 0,
          cancelId: 0,
        }) === 1;
      if (leave) event.preventDefault();
      else entry.closeDenied?.();
    });
    const state = () => this.send(entry);
    wc.on('did-start-loading', () => {
      if (entry.browser === 'chrome') return;
      entry.loading = true;
      entry.error = '';
      state();
    });
    wc.on('did-start-navigation', () => { entry.documentVersion = (entry.documentVersion || 0) + 1; });
    wc.on('did-stop-loading', () => {
      if (entry.browser === 'chrome') return;
      entry.loading = false;
      state();
    });
    wc.on('page-title-updated', (_event, title) => {
      if (entry.browser === 'chrome') return;
      entry.title = title.slice(0, 120) || new URL(entry.url).hostname;
      state();
    });
    const navigation = (url) => {
      if (entry.browser === 'chrome') return;
      try {
        const parsed = normalizeUrl(url);
        entry.url = parsed;
        entry.reportedUrls.add(parsed);
        if (entry.reportedUrls.size > 50)
          entry.reportedUrls.delete(entry.reportedUrls.values().next().value);
      } catch {}
      state();
    };
    wc.on('did-navigate', (_event, url) => navigation(url));
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) navigation(url);
    });
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (entry.browser === 'chrome') return;
      if (isMainFrame && code !== -3) {
        entry.loading = false;
        entry.error = description;
        this.applyLayout(entry);
        state();
      }
    });
    wc.on('render-process-gone', (_event, details) => {
      if (entry.browser === 'chrome') return;
      entry.error = t('페이지 프로세스가 종료됐어요: {reason}', { reason: details.reason });
      entry.loading = false;
      this.applyLayout(entry);
      state();
    });
    wc.on('dom-ready', () => {
      // Prevent a web document at its edge from handing wheel scrolling to the shell.
      wc.insertCSS('html,body { overscroll-behavior: contain !important; }').catch(() => {});
      this.applyLayout(entry);
      state();
    });
    const preventUnsafe = (event, url) => {
      try {
        normalizeUrl(url);
      } catch {
        event.preventDefault();
      }
    };
    wc.on('will-navigate', preventUnsafe);
    wc.on('will-redirect', preventUnsafe);
    installPopupHandling(wc, this.window, (...args) => entry.targets.popup(...args));
    wc.on('focus', () => this.emit({ type: 'activate', paneId: entry.id }));
    wc.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown') entry.inputVersion = (entry.inputVersion || 0) + 1;
      if (input.type === 'mouseDown' && !entry.automationDepth) this.userInput(entry.id);
    });
    wc.on('input-event', (_event, input) => {
      if (input.type === 'mouseWheel') entry.inputVersion = (entry.inputVersion || 0) + 1;
      if (input.type === 'mouseWheel' && !entry.automationDepth) this.userInput(entry.id);
    });
    wc.on('before-input-event', (event, input) => {
      entry.inputVersion = (entry.inputVersion || 0) + 1;
      if (input.type !== 'keyDown') return;
      if (
        !entry.automationDepth &&
        input.alt &&
        input.shift &&
        ['ArrowLeft', 'ArrowRight', 'KeyK', 'KeyF'].includes(input.code)
      ) {
        event.preventDefault();
        this.window.webContents.focus();
        this.emit({ type: 'shortcut', paneId: entry.id, code: input.code });
        return;
      }
      if (!entry.automationDepth && input.key === 'Escape' && this.focusedId) {
        event.preventDefault();
        this.window.webContents.focus();
        this.emit({ type: 'shortcut', paneId: entry.id, code: 'Escape' });
        return;
      }
      if (!entry.automationDepth) this.userInput(entry.id);
    });
    if (load) {
      if (entry.browser === 'chrome') void this.connectChrome(entry).catch(() => {});
      else this.navigate(entry, pane.url);
    }
    return entry;
  }
  send(entry) {
    if (
      !entry.closed &&
      this.panes.get(entry.id) === entry &&
      entry.view.webContents && !entry.view.webContents.isDestroyed()
    )
      this.emit({ type: 'pane', ...this.describe(entry), generation: this.generation });
  }
  describe(entry) {
    const wc = entry.browser === 'chrome' ? (entry.chrome?.targets.get(entry.chrome.rootId) || entry.chrome?.targets.get(entry.chrome.activeId)) : entry.view.webContents;
    const connected = entry.browser === 'chrome' && !!entry.chrome && !entry.chrome.connection.closed && entry.chrome.targets.size > 0;
    return {
      paneId: entry.id,
      profileId: entry.profileId,
      url: entry.url,
      title: entry.title,
      loading: entry.loading,
      error: entry.error,
      compatibility: entry.compatibility,
      browser: entry.browser || 'mosaic',
      chromeConnected: connected,
      chromeConnecting: !!entry.chromeConnecting,
      targetCount: entry.browser === 'chrome' ? (connected ? entry.chrome.targets.size : 0) : (entry.targets?.items.size || 1),
      activeTargetTitle: connected ? entry.chrome.targets.get(entry.chrome.activeId)?.getTitle().slice(0, 120) : undefined,
      canGoBack: wc?.navigationHistory.canGoBack() || false,
      canGoForward: wc?.navigationHistory.canGoForward() || false,
      zoom: wc?.getZoomFactor() || 1,
      switching: !!entry.switching,
    };
  }
  list() {
    return [...this.panes.values()].map((e) => this.describe(e));
  }
  get(id) {
    const entry = this.panes.get(id);
    if (!entry || entry.closed || entry.view.webContents.isDestroyed())
      throw new Error(t('화면을 찾을 수 없어요.'));
    if (entry.switching) throw new Error(t('프로필을 변경하는 중이에요.'));
    return entry;
  }
  target(entry, targetId, options) {
    if (entry.browser === 'chrome') {
      if (!entry.chrome || entry.chrome.connection.closed) throw new Error(t('Chrome 연결이 끊겼어요. open_chrome으로 다시 연결해 주세요.'));
      return entry.chrome.target(targetId, options);
    }
    return entry.targets ? entry.targets.target(targetId) : entry.view.webContents;
  }
  targetId(entry, contents) {
    return entry.browser === 'chrome' ? (contents.id === entry.chrome.rootId ? 'main' : 'chrome-' + contents.id) : (entry.targets?.id(contents) || 'main');
  }
  listTargets(entry) {
    return entry.browser === 'chrome' ? (entry.chrome?.list() || []) : (entry.targets?.list() || []);
  }
  updateChrome(entry) {
    const root = entry.chrome?.targets.get(entry.chrome.rootId) || entry.chrome?.targets.get(entry.chrome.activeId);
    if (root && !root.isDestroyed()) {
      // Long OAuth callback addresses remain transient, not workspace addresses.
      try { entry.url = normalizeUrl(root.getURL()); entry.reportedUrls.add(entry.url); } catch {}
      entry.title = root.getTitle().slice(0, 120) || entry.title;
      entry.loading = root.loading;
      entry.error = '';
    } else entry.loading = false;
    this.applyLayout(entry); this.send(entry);
  }
  openChrome(id, guard = () => {}) { return this.connectChrome(this.get(id), guard); }
  async connectChrome(entry, guard = () => {}) {
    if (!this.chromeRuntime) throw new Error(t('Chrome 연결을 사용할 수 없어요.'));
    const check = () => { guard(); if (entry.closed) throw new Error(t('Chrome 연결이 취소됐어요.')); };
    check(); entry.chromeConnecting = true; entry.error = ''; this.send(entry);
    try {
      const group = await this.chromeRuntime.open({ paneId: entry.id, profileId: entry.profileId, url: entry.url }, check);
      check(); entry.chrome = group; entry.browser = 'chrome'; entry.compatibility = '';
      this.updateChrome(entry);
      await group.target(undefined, { navigate: true }).focus(); check();
      return this.describe(entry);
    } catch (error) {
      if (!entry.closed) { entry.error = error.message; this.applyLayout(entry); }
      throw error;
    } finally { entry.chromeConnecting = false; this.send(entry); }
  }
  useMosaic(id) {
    const entry = this.get(id);
    this.chromeRuntime?.disconnect(id, entry.profileId);
    entry.chrome = null; entry.browser = 'mosaic'; entry.error = ''; entry.compatibility = entry.nativeCompatibility || '';
    if (entry.view.webContents.getURL() !== entry.url) this.navigate(entry, entry.url);
    else { entry.loading = entry.view.webContents.isLoading(); this.applyLayout(entry); this.send(entry); }
    return this.describe(entry);
  }
  async switchProfile(id, profileId) {
    if (!this.profiles.some((profile) => profile.id === profileId))
      throw new Error(t('프로필을 찾을 수 없어요.'));
    const original = this.get(id);
    if (original.profileId === profileId) return this.describe(original);
    this.onManual(id);
    original.switching = true;
    this.send(original);
    let candidate, timer;
    const cancelled = new Promise((_, reject) => {
      original.cancelSwitch = () => reject(new Error(t('프로필 변경이 취소됐어요.')));
    });
    const operation = (async () => {
      try {
        candidate = this.create(
          { id, title: original.title, url: original.url, profileId, browser: original.browser },
          { register: false, load: false },
        );
        const navigation = await Promise.race([
          original.browser === 'chrome' ? this.connectChrome(candidate) : this.navigate(candidate, original.url),
          cancelled,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(t('새 프로필의 페이지를 여는 데 시간이 너무 오래 걸려요.'))),
              15000,
            );
          }),
        ]);
        if (navigation?.cancelled) throw new Error(t('새 프로필의 페이지 열기가 취소됐어요.'));
        if (candidate.error) throw new Error(candidate.error);
        if (original.closed || this.panes.get(id) !== original)
          throw new Error(t('화면이 변경되어 프로필 전환을 취소했어요.'));
        if (!(await this.requestEntryClose(original)))
          throw new Error(t('기존 페이지를 유지했어요. 프로필 변경을 취소합니다.'));
        candidate.layout = original.layout;
        this.panes.set(id, candidate);
        this.dispose(original);
        this.applyLayout(candidate);
        this.send(candidate);
        return this.describe(candidate);
      } catch (error) {
        if (candidate) this.dispose(candidate);
        throw error;
      } finally {
        clearTimeout(timer);
        original.switching = false;
        original.cancelSwitch = null;
        original.switchTask = null;
        if (!original.closed) {
          this.applyLayout(original);
          this.send(original);
        }
      }
    })();
    original.switchTask = operation;
    return operation;
  }
  async requestEntryClose(entry) {
    if (entry.targets?.items.size > 1) {
      if (!(await this.confirmNativeClose([entry]))) return false;
      entry.view.webContents.close();
      return true;
    }
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return Promise.resolve(true);
    if (entry.closeTask) return entry.closeTask;
    const operation = new Promise((resolve) => {
      const finish = (allowed) => {
        wc.off('destroyed', closed);
        entry.closeDenied = null;
        resolve(allowed);
      };
      const closed = () => finish(true);
      entry.closeDenied = () => finish(false);
      wc.once('destroyed', closed);
      wc.close({ waitForBeforeUnload: true });
    });
    entry.closeTask = operation;
    return operation.finally(() => {
      entry.closeTask = null;
    });
  }
  async confirmNativeClose(panes) {
      const contentsOf = entry => entry.targets ? [...entry.targets.items.values()].map(item => item.contents) : [entry.view.webContents];
      const framesOf = entry => {
        try { return contentsOf(entry).map(wc => wc?.mainFrame?.framesInSubtree.map(frame => frame.processId + ':' + frame.frameToken).join('|')).join(';'); }
        catch { return null; }
      };
      const entries = panes.map(entry => {
        return { id: entry.id, entry, version: entry.documentVersion || 0, input: entry.inputVersion || 0, targetsVersion: entry.targets?.version, frames: framesOf(entry) };
      });
      const protection = await Promise.all(entries.flatMap(({ entry }) => contentsOf(entry).map(wc => hasCloseProtection(wc))));
      const changed = entries.some(({ id, entry, version, input, targetsVersion, frames }) => this.panes.get(id) !== entry || (entry.documentVersion || 0) !== version || (entry.inputVersion || 0) !== input || entry.targets?.version !== targetsVersion || framesOf(entry) !== frames);
      if ((changed || protection.some(Boolean)) && dialog.showMessageBoxSync(this.window, {
          type: 'question',
          title: t('닫기 확인'),
          message: t('작성 중인 내용이 사라질 수 있어요. 닫을까요?'),
          buttons: [t('취소'), t('닫기')],
          noLink: true,
          defaultId: 0,
          cancelId: 0,
        }) !== 1) return false;
      return true;
  }
  async requestClose(ids) {
    const targets = [...new Set(ids)].filter((id) => this.panes.has(id));
    if (targets.length > 1) {
      for (const id of targets) this.onManual(id);
      if (!(await this.confirmNativeClose(targets.map(id => this.panes.get(id))))) return false;
      // Inspect every page before closing any. Cancel keeps original views and
      // drafts intact; ordinary batches no longer require a count-based prompt.
      for (const id of targets) this.close(id);
      return true;
    }
    for (const id of targets) {
      let entry = this.panes.get(id);
      if (!entry) continue;
      if (entry.switchTask) {
        entry.cancelSwitch?.();
        await entry.switchTask.catch(() => {});
        entry = this.panes.get(id);
      }
      if (!entry) continue;
      this.onManual(id);
      if (!(await this.requestEntryClose(entry))) {
        this.reconcile(this.descriptors, this.profiles, this.generation);
        this.emit({ type: 'refresh' });
        return false;
      }
      this.dispose(entry);
    }
    return true;
  }
  navigate(entry, url, targetContents) {
    const normalized = normalizeUrl(url);
    if (entry.browser === 'chrome') {
      entry.modelUrl = normalized;
      return (targetContents || this.target(entry, 'main', { navigate: true })).loadURL(normalized);
    }
    entry.modelUrl = normalized;
    entry.url = normalized;
    entry.error = '';
    entry.loading = true;
    entry.reportedUrls.add(normalized);
    this.send(entry);
    const sequence = (entry.navigationSequence = (entry.navigationSequence || 0) + 1);
    return Promise.resolve(this.sessionReady.get(entry.view.webContents.session))
      .then(() => {
        if (entry.closed || sequence !== entry.navigationSequence) return { cancelled: true };
        return entry.view.webContents.loadURL(normalized);
      })
      .catch((error) => {
        if (!entry.closed && error.code === 'ERR_ABORTED') {
          try {
            entry.url = normalizeUrl(entry.view.webContents.getURL());
            entry.modelUrl = entry.url;
            entry.reportedUrls.add(entry.url);
          } catch {}
          entry.loading = false;
          this.send(entry);
          return { cancelled: true };
        }
        if (!entry.closed) {
          entry.loading = false;
          entry.error = error.code || error.message;
          this.applyLayout(entry);
          this.send(entry);
        }
      });
  }
  async layout({ items, blocked, focusId }) {
    this.blocked = blocked;
    const sequence = (this.layoutSequence = (this.layoutSequence || 0) + 1);
    if (blocked) for (const entry of this.panes.values()) entry.container.setVisible(false);
    const changed = focusId !== this.focusedId;
    if (changed) {
      for (const entry of this.panes.values()) entry.container.setVisible(false);
      if (!this.focusedId && focusId)
        await Promise.all(
          [...this.panes.values()].map(async (entry) => {
            entry.focusScroll = null;
            entry.gridScroll = await this.readScroll(entry);
          }),
        );
      if (this.focusedId) {
        const previous = this.panes.get(this.focusedId);
        if (previous) previous.focusScroll = await this.readScroll(previous);
      }
    }
    if (sequence !== this.layoutSequence) return;
    this.focusedId = focusId;
    const active = new Set();
    for (const item of items) {
      const entry = this.panes.get(item.paneId);
      if (!entry) continue;
      active.add(entry.id);
      entry.layout = item;
      this.applyLayout(entry);
    }
    for (const entry of this.panes.values())
      if (!active.has(entry.id)) {
        entry.layout = null;
        entry.container.setVisible(false);
      }
    if (changed) {
      if (focusId) {
        const entry = this.panes.get(focusId);
        if (entry) await this.writeScroll(entry, entry.focusScroll || entry.gridScroll);
      } else
        await Promise.all(
          [...this.panes.values()].map((entry) => this.writeScroll(entry, entry.gridScroll)),
        );
    }
  }
  async boundedScript(entry, source) {
    if (entry.browser === 'chrome') return null;
    let timer;
    try {
      return await Promise.race([
        entry.view.webContents.executeJavaScript(source),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 250);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  readScroll(entry) {
    return this.boundedScript(entry, readScrollScript);
  }
  writeScroll(entry, position) {
    if (position && !entry.closed) return this.boundedScript(entry, restoreScrollScript(position));
  }
  applyLayout(entry) {
    if (this.blocked || !entry.layout || entry.browser === 'chrome' || entry.error || entry.compatibility || entry.closed || entry.switching) {
      entry.container.setVisible(false);
      return;
    }
    const bounds = clipPane(entry.layout.rect, entry.layout.viewport);
    if (!bounds.visible || bounds.container.width < 32 || bounds.container.height < 32) {
      entry.container.setVisible(false);
      return;
    }
    entry.container.setBounds(bounds.container);
    entry.container.setBorderRadius(1);
    entry.view.setBounds(bounds.content);
    entry.container.setVisible(true);
  }
  async command(id, action, value) {
    const entry = this.get(id),
      wc = this.target(entry, entry.browser === 'chrome' && !entry.chrome?.targets.has(entry.chrome.rootId) ? undefined : 'main', { navigate: true });
    if (action === 'navigate') await this.navigate(entry, value, wc);
    else if (action === 'back' && wc.navigationHistory.canGoBack()) await wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward())
      await wc.navigationHistory.goForward();
    else if (action === 'reload') {
      entry.error = '';
      await wc.reload();
      this.applyLayout(entry);
    } else if (action === 'stop') await wc.stop();
    else if (action === 'focus') await wc.focus();
    else if (action === 'zoom') {
      const factor = Number(value);
      if (!Number.isFinite(factor) || factor < 0.5 || factor > 2)
        throw new Error('Zoom must be 50–200%');
      await wc.setZoomFactor(factor);
    }
    this.send(entry);
    return this.describe(entry);
  }
  close(id) {
    const entry = this.panes.get(id);
    if (!entry) return;
    this.onManual(id);
    entry.cancelSwitch?.();
    this.dispose(entry);
  }
  dispose(entry) {
    entry.closed = true;
    this.chromeRuntime?.disconnect(entry.id, entry.profileId);
    entry.targets?.dispose();
    entry.disposeCompatibility?.();
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.container);
    const wc = entry.view.webContents;
    if (wc && !wc.isDestroyed()) wc.close();
    if (this.panes.get(entry.id) === entry) this.panes.delete(entry.id);
  }
  closeAll() {
    for (const id of [...this.panes.keys()]) this.close(id);
  }
  async flush() {
    if (this.sessionStore) return this.sessionStore.flush();
    await Promise.all(
      [...this.sessions.values()].map(async (ses) => {
        ses.flushStorageData();
        await ses.cookies.flushStore();
      }),
    );
  }
}
