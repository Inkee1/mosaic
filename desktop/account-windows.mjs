import { getLocale, subscribeLocale, t } from '../shared/i18n.mjs';
import { BrowserWindow, WebContentsView, ipcMain } from 'electron';
import { join } from 'node:path';
import { normalizeUrl } from '../shared/validation.mjs';
import { installPopupHandling } from './popup-origin.mjs';

const providers = {
  google: 'https://accounts.google.com/',
  instagram: 'https://www.instagram.com/accounts/login/',
  naver: 'https://nid.naver.com/nidlogin.login',
};

function presentation(name) {
  return {
    locale: getLocale(),
    title: t('{name} · 로그인 준비', { name }),
    labels: {
      hint: t('직접 로그인한 뒤 완료를 누르세요. 이후 새로 추가하는 화면에 처음 한 번 이어집니다. 기존 화면은 바뀌지 않아요.'),
      back: t('뒤로'),
      reload: t('새로고침'),
      address: t('로그인 사이트 주소'),
      go: t('이동'),
      done: t('완료'),
    },
  };
}

export class AccountWindows {
  constructor(parent, manager, root) {
    this.parent = parent;
    this.manager = manager;
    this.root = root;
    this.windows = new Map();
    ipcMain.handle('mosaic:account-command', (event, action, value) => {
      const entry = [...this.windows.values()].find(
        (e) =>
          e.window.webContents === event.sender && event.senderFrame === event.sender.mainFrame,
      );
      if (!entry) throw new Error('IPC sender is not trusted');
      const wc = entry.view.webContents;
      if (action === 'state') return entry.state;
      if (action === 'close') entry.window.close();
      else if (action === 'navigate') return this.navigate(entry, normalizeUrl(value));
      else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (action === 'reload') wc.reload();
    });
  }
  async navigate(entry, url) {
    const wc = entry.view.webContents;
    await this.manager.sessionReady.get(wc.session);
    if (entry.window.isDestroyed() || wc.isDestroyed()) return;
    await wc.loadURL(url).catch((error) => {
      if (error.code !== 'ERR_ABORTED')
        this.send(entry, { error: t('페이지를 열지 못했어요: {code}', { code: error.code }) });
    });
  }
  send(entry, patch) {
    entry.state = { ...entry.state, ...patch, ...presentation(entry.state.name) };
    if (!entry.window.isDestroyed())
      entry.window.webContents.send('mosaic:account-state', entry.state);
  }
  async open(profile, provider) {
    if (!providers[provider]) throw new Error(t('지원하는 로그인 사이트를 선택해 주세요.'));
    const previous = this.windows.get(profile.id);
    if (previous && !previous.window.isDestroyed()) {
      previous.window.show();
      previous.window.focus();
      this.navigate(previous, providers[provider]).catch((error) =>
        this.send(previous, { error: error.message }),
      );
      return;
    }
    const window = new BrowserWindow({
      parent: this.parent,
      width: 1050,
      height: 820,
      minWidth: 720,
      minHeight: 540,
      title: t('{name} · 로그인 준비', { name: profile.name }),
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(this.root, 'desktop/account-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.setMenu(null);
    const view = new WebContentsView({
      webPreferences: {
        session: this.manager.getSession(profile.id),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const entry = {
      window,
      view,
      state: { name: profile.name, url: providers[provider], loading: true, error: '', ...presentation(profile.name) },
    };
    const unsubscribeLocale = subscribeLocale(() => {
      if (window.isDestroyed()) return;
      window.setTitle(t('{name} · 로그인 준비', { name: entry.state.name }));
      this.send(entry, {});
    });
    this.windows.set(profile.id, entry);
    window.contentView.addChildView(view);
    const layout = () => {
      const [width, height] = window.getContentSize();
      view.setBounds({ x: 0, y: 112, width, height: Math.max(0, height - 112) });
    };
    window.on('resize', layout);
    layout();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const wc = view.webContents;
    const safeNavigation = (event, url) => {
      try {
        normalizeUrl(url);
      } catch {
        event.preventDefault();
      }
    };
    wc.on('will-navigate', safeNavigation);
    wc.on('will-redirect', safeNavigation);
    wc.on('did-navigate', (_event, url) => this.send(entry, { url }));
    wc.on('did-navigate-in-page', (_event, url, main) => {
      if (main) this.send(entry, { url });
    });
    wc.on('did-start-loading', () => this.send(entry, { loading: true, error: '' }));
    wc.on('did-stop-loading', () => this.send(entry, { loading: false }));
    installPopupHandling(wc, window);
    window.on('closed', () => {
      unsubscribeLocale();
      if (!wc.isDestroyed()) wc.close();
      this.windows.delete(profile.id);
      this.manager
        .flush()
        .catch((error) => this.manager.emit({ type: 'error', message: error.message }));
    });
    await window.loadFile(join(this.root, 'desktop/account-window.html'));
    this.send(entry, {});
    this.navigate(entry, providers[provider]).catch((error) =>
      this.send(entry, { loading: false, error: error.message }),
    );
  }
  closeAll() {
    for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.close();
  }
}
