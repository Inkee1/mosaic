import { randomUUID } from 'node:crypto';

const pending = new WeakMap();

// Read browser-registered handlers without invoking page code or consuming
// once-listeners. Synthetic beforeunload events can miss isTrusted guards.
// Unknown/unreachable frames keep the existing protection instead of silently
// discarding a page. A registered handler is a possible warning, not proof that
// the website currently has unsaved content.
export function hasCloseProtection(wc) {
  if (!wc || wc.isDestroyed()) return Promise.resolve(false);
  if (pending.has(wc)) return pending.get(wc);
  const result = inspect(wc).finally(() => pending.delete(wc));
  pending.set(wc, result);
  return result;
}

async function inspect(wc) {
  const contexts = new Map();
  const group = 'mosaic-close-' + randomUUID();
  const debuggerApi = wc.debugger;
  let expired = false, changed = false, timer;
  const message = (_event, method, params) => {
    if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault)
      contexts.set(params.context.auxData.frameId, params.context.id);
    if (method === 'Runtime.executionContextDestroyed' || method === 'Runtime.executionContextsCleared') changed = true;
  };
  const command = (method, params = {}) => {
    if (expired) throw new Error('Close inspection expired');
    return debuggerApi.sendCommand(method, params);
  };
  try {
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    debuggerApi.on('message', message);
    const scan = (async () => {
      await command('Runtime.enable');
      changed = false;
      const { frameTree } = await command('Page.getFrameTree');
      const frames = [];
      const visit = node => { frames.push(node.frame); for (const child of node.childFrames || []) visit(child); };
      visit(frameTree);
      // Cross-process frames may be absent from this debugger session.
      if (frames.length !== wc.mainFrame.framesInSubtree.length || frames.length > 64) return true;
      for (const frame of frames) {
        const contextId = contexts.get(frame.id);
        if (!contextId) return true;
        const { result } = await command('Runtime.evaluate', { expression: 'window', contextId, objectGroup: group });
        if (!result?.objectId) return true;
        const { listeners } = await command('DOMDebugger.getEventListeners', { objectId: result.objectId });
        if (listeners.some(listener => listener.type === 'beforeunload')) return true;
      }
      return changed;
    })();
    return await Promise.race([scan, new Promise(resolve => { timer = setTimeout(() => resolve(true), 1200); })]);
  } catch { return true; }
  finally {
    expired = true;
    clearTimeout(timer);
    debuggerApi?.off('message', message);
    // Commands are ordered on this debugger connection. Release temporary
    // objects and our Runtime subscription; leave the shared debugger attached.
    for (const [method, params] of [['Runtime.releaseObjectGroup', { objectGroup: group }], ['Runtime.disable', {}]]) {
      try { void debuggerApi?.sendCommand(method, params).catch(() => {}); } catch {}
    }
  }
}
