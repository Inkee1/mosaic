import { subscribeLocale, t } from '../shared/i18n.mjs';

// Popup URLs are transient: OAuth state can exceed the workspace address limit.
// Keep protocol/credential checks without imposing the editable field's 2 KiB cap.
export function isAllowedPopupUrl(value) {
  if (value === 'about:blank') return true;
  if (typeof value !== 'string' || value.length > 65536) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname &&
      !url.username && !url.password && url.href.length <= 65536;
  } catch {
    return false;
  }
}

// Use the same policy at every level. A site opened from search results must
// still be able to open its own login window, with the original opener/session.
export function installPopupHandling(contents, parent, onCreated) {
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedPopupUrl(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent, width: 1000, height: 760, minWidth: 360, minHeight: 300,
        show: true, frame: true, autoHideMenuBar: true,
        backgroundColor: '#f4f5f2',
        webPreferences: {
          session: contents.session, sandbox: true, contextIsolation: true,
          nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
        },
      },
    };
  });
  contents.on('did-create-window', (popup, details) => {
    popup.setMenu(null);
    const status = showPopupOrigin(popup, details.url);
    const safeNavigation = (event, url) => {
      if (!isAllowedPopupUrl(url)) {
        event.preventDefault();
        status.fail('address');
      }
    };
    popup.webContents.on('will-navigate', safeNavigation);
    popup.webContents.on('will-redirect', safeNavigation);
    popup.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F5' ||
        ((input.control || input.meta) && input.key.toLowerCase() === 'r'))) {
        event.preventDefault();
        popup.webContents.reload();
      }
    });
    onCreated?.(popup, details, contents);
    installPopupHandling(popup.webContents, popup, onCreated);
  });
}

// Web content cannot replace the native title with a claimed service name.
// Query strings (including OAuth tokens) never appear in the window title.
export function showPopupOrigin(popup, initialUrl = '') {
  const contents = popup.webContents;
  let target = initialUrl, phase = 'loading', message = '', slowTimer;
  const update = () => {
    if (popup.isDestroyed() || contents.isDestroyed()) return;
    let origin = t('새 창');
    try {
      const url = new URL(contents.getURL() || target);
      if (['http:', 'https:'].includes(url.protocol)) origin = url.origin;
    } catch {}
    const errors = {
      address: t('열 수 없는 주소'),
      connection: t('연결 실패'),
      unresponsive: t('페이지 응답 중단'),
    };
    const label = phase === 'error' ? t('{message} · F5 새로고침', { message: errors[message] || message }) :
      phase === 'slow' ? t('연결 지연 · 기다리는 중…') :
      phase === 'loading' ? t('불러오는 중…') : t('새 창');
    popup.setTitle(origin + ' · ' + label);
  };
  const start = () => {
    clearTimeout(slowTimer);
    phase = 'loading'; message = '';
    slowTimer = setTimeout(() => { phase = 'slow'; update(); }, 8000);
    slowTimer.unref();
    update();
  };
  const fail = (text) => {
    clearTimeout(slowTimer);
    phase = 'error'; message = text;
    update();
  };
  popup.on('page-title-updated', (event) => { event.preventDefault(); update(); });
  contents.on('did-start-navigation', (_event, url, _inPlace, main) => {
    if (main) { target = url; update(); }
  });
  contents.on('did-start-loading', start);
  contents.on('did-stop-loading', () => {
    clearTimeout(slowTimer);
    if (phase !== 'error') phase = 'ready';
    update();
  });
  contents.on('did-fail-load', (_event, code, _description, url, main) => {
    if (main && code !== -3) { target = url; fail('connection'); }
  });
  contents.on('render-process-gone', () => fail('unresponsive'));
  contents.on('did-navigate', update);
  contents.on('did-navigate-in-page', (_event, _url, main) => { if (main) update(); });
  const unsubscribeLocale = subscribeLocale(update);
  popup.on('closed', () => { clearTimeout(slowTimer); unsubscribeLocale(); });
  start();
  return { fail };
}
