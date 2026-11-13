import { t } from '../shared/i18n.mjs';
import { normalizeUrl } from '../shared/validation.mjs';
import { randomUUID } from 'node:crypto';
import { scrollPageScript } from './page-scripts.mjs';
import { observationScript, prepareActionScript, evaluateObservation } from './page-observation.mjs';

const keyNames = {
  Enter: ['Enter', 13],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  Space: [' ', 32],
};

export function createAutomation(manager) {
  const observations = new WeakMap();
  const painted = new WeakMap();
  const pageKeys = new WeakMap();
  class ObservationChanged extends Error {
    constructor(paneId, targetId, message = t('화면이 변경됐어요. snapshot 또는 screenshot으로 현재 화면을 다시 확인한 뒤 원래 작업을 이어가세요. 이전 좌표나 제출 동작을 그대로 반복하지 마세요.')) {
      super(message);
      Object.assign(this, { paneId, targetId });
    }
  }
  const perform = async (method, args, guard) => {
    guard();
    if (method === 'list_panes') return manager.list();
    const entry = manager.get(args.paneId);
    if (method === 'open_chrome') {
      await manager.openChrome(entry.id, guard);
      guard();
      return { ...manager.describe(entry), targets: await manager.listTargets(entry) };
    }
    if (method === 'list_targets') {
      const targets = await manager.listTargets(entry); guard(); return targets;
    }
    const wc = manager.target ? manager.target(entry, args.targetId, { navigate: method === 'navigate' }) : entry.view.webContents;
    const browser = entry.browser;
    const targetId = manager.targetId?.(entry, wc) || 'main';
    if (!pageKeys.has(wc)) pageKeys.set(wc, '__mosaic_observation_' + randomUUID().replaceAll('-', ''));
    const pageKey = pageKeys.get(wc);
    const currentDocument = () => manager.documentVersion?.(entry, wc) ?? wc.documentVersion;
    const currentInput = () => entry.interactionVersion || 0;
    let documentVersion = currentDocument(), interactionVersion = currentInput();
    const check = () => {
      guard();
      if (entry.closed || manager.get(args.paneId) !== entry)
        throw new Error(t('화면 또는 프로필이 변경되어 작업을 중지했어요.'));
    };
    const unchanged = () => {
      check();
      if (entry.browser !== browser || documentVersion !== currentDocument() || interactionVersion !== currentInput())
        throw new ObservationChanged(entry.id, entry.browser === browser ? targetId : undefined);
    };
    let seen = observations.get(entry);
    if (!seen) { seen = new WeakMap(); observations.set(entry, seen); }
    const fresh = () => {
      unchanged();
      const previous = seen.get(wc);
      if ((interactionVersion && previous?.interactionVersion !== interactionVersion) ||
          (previous && previous.documentVersion !== documentVersion)) throw new ObservationChanged(entry.id, targetId);
      if (wc.isDestroyed()) throw new Error(t('대상 탭이 닫혔어요. list_targets로 다시 확인해 주세요.'));
    };
    const observe = async () => {
      // Briefly let a user's gesture settle, but never stall indefinitely.
      const deadline = Date.now() + 1500;
      while (Date.now() - (entry.lastInteractionAt || 0) < 350 && Date.now() < deadline) {
        check(); await new Promise(resolve => setTimeout(resolve, 50));
      }
      check();
      if (entry.browser !== browser) throw new ObservationChanged(entry.id);
      documentVersion = currentDocument(); interactionVersion = currentInput();
    };
    const remember = () => {
      unchanged();
      if (!wc.dialog) seen.set(wc, { documentVersion, interactionVersion });
    };
    const command = async (name, params) => {
      fresh();
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      // Suppress only the native acknowledgements of our own injected gesture,
      // not physical input while waiting for DOM queries or navigation.
      entry.automationDepth = (entry.automationDepth || 0) + 1;
      try {
        return await wc.debugger.sendCommand(name, params);
      } finally {
        entry.automationDepth--;
      }
    };
    const capture = async rect => {
      const unavailable = () => new ObservationChanged(entry.id, targetId, t('화면 이미지가 아직 준비되지 않았어요. 잠시 뒤 현재 화면을 다시 확인한 후 이어가세요.'));
      const timeoutMs = rect.width === 1 && rect.height === 1 ? 2000 : 5000;
      for (let attempt = 0; attempt < 2; attempt++) {
        unchanged();
        if (wc.isDestroyed()) throw unavailable();
        let timer;
        const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(unavailable()), timeoutMs); });
        try {
          const picture = await Promise.race([wc.capturePage(rect, { stayHidden: true, stayAwake: true }), timeout]);
          unchanged();
          if (wc.isDestroyed()) throw unavailable();
          if (picture?.isEmpty?.()) throw new Error('VizSentEmptyBitmap');
          return picture;
        } catch (error) {
          unchanged();
          if (!['UnknownVizError', 'VizSentEmptyBitmap'].includes(error?.message)) throw error;
          if (attempt === 1) throw unavailable();
        } finally { clearTimeout(timer); }
        // Retry only a failed readback, before any input is dispatched.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const gesture = async (name, down, up) => {
      if (browser !== 'chrome') return Promise.all([command(name, down), command(name, up)]);
      fresh();
      entry.automationDepth = (entry.automationDepth || 0) + 1;
      try {
        // Chrome acknowledges pressed input before it can consume the release.
        // Always release the gesture, even if stop arrives between its halves.
        try { await wc.debugger.sendCommand(name, down); }
        finally { if (!wc.isDestroyed()) await wc.debugger.sendCommand(name, up); }
      } finally { entry.automationDepth--; }
    };
    if (method === 'snapshot') {
      await observe();
      if (wc.dialog) return { paneId: entry.id, targetId, requiresUser: true, dialog: wc.dialog, url: wc.getURL() };
      const result = await evaluateObservation(wc, observationScript({ key: pageKey, scope: args.scope, offset: args.offset, textOffset: args.textOffset }));
      const targets = await manager.listTargets?.(entry);
      remember();
      return { ...result, paneId: entry.id, targetId, browser: browser || 'mosaic', loading: !!wc.isLoading?.(), compatibility: entry.compatibility || undefined, targets };
    }
    if (method === 'screenshot') {
      await observe();
      const picture = await capture({});
      remember();
      return { image: picture.toPNG().toString('base64'), mimeType: 'image/png', paneId: entry.id, targetId };
    }
    fresh();
    if (method === 'navigate') {
      const url = normalizeUrl(args.url);
      fresh();
      const navigation = targetId === 'main' ? await manager.navigate(entry, url) : await wc.loadURL(url);
      check();
      if (navigation?.cancelled) throw new Error(t('페이지 이동이 취소됐어요.'));
      if (entry.error) throw new Error(entry.error);
      return { paneId: entry.id, targetId, url: wc.getURL(), targets: await manager.listTargets?.(entry) };
    }
    if (method === 'set_zoom') {
      fresh();
      await wc.setZoomFactor(args.factor); check();
      return { paneId: entry.id, targetId, zoom: wc.getZoomFactor() };
    }
    if (browser === 'chrome') { fresh(); await wc.focus(); fresh(); await wc.prepareInput?.(); fresh(); }
    else if (wc.capturePage && (!painted.has(wc) || painted.get(wc) !== documentVersion)) {
      // A new native popup can expose its DOM before Chromium has a surface
      // for pointer events. As with Chrome, wait for a tiny compositor readback.
      const picture = await capture({ x: 0, y: 0, width: 1, height: 1 });
      fresh();
      if (picture?.isEmpty?.()) throw new ObservationChanged(entry.id, targetId);
      painted.set(wc, documentVersion);
    }
    {
      if (method === 'click') {
        let x = args.x,
          y = args.y;
        if (args.selector) {
          const location = await evaluateObservation(wc, prepareActionScript({ key: pageKey, operation: 'click', selector: args.selector }));
          fresh();
          if (location?.ok === false) return { ...location, paneId: entry.id, targetId, message: t('대상을 누를 수 없거나 관찰 이후 바뀌었어요. 현재 화면을 다시 확인해 주세요.') };
          x = location.x;
          y = location.y;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(t('클릭할 위치가 필요해요.'));
        // Complete the release even if cancellation arrives during the gesture.
        fresh();
        await gesture('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x,
            y,
            button: 'left',
            clickCount: 1,
          }, {
            type: 'mouseReleased',
            x,
            y,
            button: 'left',
            clickCount: 1,
          });
      } else if (method === 'type') {
        const prepared = await evaluateObservation(wc, prepareActionScript({ key: pageKey, operation: 'type', selector: args.selector }));
        fresh();
        if (prepared?.ok === false) return { ...prepared, paneId: entry.id, targetId, message: t('입력 대상을 다시 확인해 주세요.') };
        await command('Input.insertText', { text: args.text });
      } else if (method === 'press_key') {
        const segments = args.key.split('+'),
          name = segments.pop();
        let modifiers = 0;
        for (const segment of segments) {
          if (segment === 'Alt') modifiers |= 1;
          else if (segment === 'Control' || segment === 'Ctrl') modifiers |= 2;
          else if (segment === 'Meta') modifiers |= 4;
          else if (segment === 'Shift') modifiers |= 8;
          else throw new Error(t('지원하지 않는 수정 키예요.'));
        }
        const known =
          keyNames[name] || (name?.length === 1 ? [name, name.toUpperCase().charCodeAt(0)] : null);
        if (!known) throw new Error(t('지원하지 않는 키예요.'));
        await gesture('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: known[0],
            windowsVirtualKeyCode: known[1],
            modifiers,
            ...(name === 'Enter' ? { text: '\r' } : {}),
          }, {
            type: 'keyUp',
            key: known[0],
            windowsVirtualKeyCode: known[1],
            modifiers,
          });
      } else if (method === 'scroll') {
        const x = Number(args.x || 0),
          y = Number(args.y || 0);
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          Math.abs(x) > 100000 ||
          Math.abs(y) > 100000
        )
          throw new Error('Invalid scroll');
        fresh();
        try {
          await wc.executeJavaScript(scrollPageScript({ selector: args.selector, x, y }));
        } catch (error) {
          // Translate only the failure generated by our scroll script. Other
          // page exceptions and site text pass through unchanged.
          const firstLine = typeof error?.message === 'string' ? error.message.split(/\r?\n/, 1)[0] : '';
          if (firstLine === '스크롤할 요소를 찾을 수 없어요.' || firstLine === 'Error: 스크롤할 요소를 찾을 수 없어요.')
            throw new Error(t('스크롤할 요소를 찾을 수 없어요.'), { cause: error });
          throw error;
        }
      } else throw new Error(t('지원하지 않는 도구예요.'));
      check();
      return { ok: true, inputDispatched: true, outcomeVerified: false, paneId: entry.id, targetId, url: wc.isDestroyed() ? undefined : wc.getURL(), targets: await manager.listTargets?.(entry), message: t('입력 명령을 전달했어요. snapshot 또는 screenshot으로 실제 결과를 확인한 뒤 작업 완료를 판단하세요.') };
    }
  };
  return async function execute(method, args, guard) {
    try { return await perform(method, args, guard); }
    catch (error) {
      if (!(error instanceof ObservationChanged)) throw error;
      // This is a recoverable tool result; the same provider run and grants stay alive.
      return { ok: false, status: 'needs_observation', actionApplied: false, paneId: error.paneId, targetId: error.targetId, message: error.message };
    }
  };
}
