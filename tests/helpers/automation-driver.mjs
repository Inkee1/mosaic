import { createAutomation } from '../../desktop/automation.mjs';

// Real Chromium DOM and input; only the Electron container is adapted.
export async function automationDriver(page, factory = createAutomation) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  const contents = {
    documentVersion: 0,
    isDestroyed: () => page.isClosed(),
    getURL: () => page.url(),
    isLoading: () => false,
    executeJavaScript: source => page.evaluate(source),
    executeJavaScriptInIsolatedWorld: async (worldId, scripts) => {
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'mosaic-' + worldId });
      const result = await cdp.send('Runtime.evaluate', { expression: scripts[0].code, contextId: executionContextId, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    focus: () => cdp.send('Page.bringToFront'),
    prepareInput: async () => { await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } }); },
    debugger: { isAttached: () => true, attach() {}, sendCommand: (name, args) => cdp.send(name, args) },
    capturePage: async () => { const image = await page.screenshot(); return { toPNG: () => image }; },
  };
  cdp.on('Page.frameNavigated', event => { if (!event.frame.parentId) contents.documentVersion++; });
  const entry = { id: 'probe', browser: 'chrome', profileId: 'test', interactionVersion: 0, view: { webContents: contents } };
  const manager = { get: () => entry, target: () => contents, targetId: () => 'main', listTargets: async () => [] };
  const execute = factory(manager);
  return { contents, entry, execute, call: (method, args = {}) => execute(method, { paneId: 'probe', ...args }, () => {}) };
}
