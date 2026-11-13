const supported = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
function webOrigin(value) {
  try { const url = new URL(new URL(value).origin); return ['https:', 'http:'].includes(url.protocol) ? url.origin : null; } catch { return null; }
}
function requestOrigin(wc, permission, details) {
  if (permission === 'media' && details?.securityOrigin !== undefined) return webOrigin(details.securityOrigin);
  const url = details?.requestingUrl || wc.getURL();
  if (!['about:blank', 'about:srcdoc'].includes(url)) return webOrigin(url);
  // These URLs inherit an origin. Only trust Electron's frame origins when every
  // matching candidate agrees; never guess from the enclosing page's address.
  try {
    const frames = wc.mainFrame?.framesInSubtree.filter(frame => frame.url === url) || [];
    const origins = new Set(frames.map(frame => webOrigin(frame.origin)));
    return origins.size === 1 && !origins.has(null) ? [...origins][0] : null;
  } catch { return null; }
}
function capabilities(permission, details, check = false) {
  if (!supported.has(permission)) return [];
  if (permission !== 'media') return [permission];
  const types = check ? [details?.mediaType] : details?.mediaTypes;
  if (!Array.isArray(types) || !types.length || types.some(type => !['audio', 'video'].includes(type))) return [];
  return [...new Set(types)].sort().map(type => 'media:' + type);
}

// Decisions belong to this Electron session and this app run only. They do not
// merge profiles/panes, and approving audio never grants camera access.
export function installPermissionHandlers(session, ask, isAlive = () => true) {
  const decisions = new Map(), pending = new Map();
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const origin = webOrigin(permission === 'media' && details?.securityOrigin !== undefined ? details.securityOrigin : requestingOrigin), types = capabilities(permission, details, true);
    return !!origin && types.length > 0 && types.every(type => decisions.get(origin + '|' + type) === true);
  });
  session.setPermissionRequestHandler(async (wc, permission, callback, details = {}) => {
    if (!wc || wc.isDestroyed() || !isAlive()) return callback(false);
    const topUrl = wc.getURL();
    const origin = requestOrigin(wc, permission, details), types = capabilities(permission, details);
    if (!origin || !types.length) return callback(false);
    const keys = types.map(type => origin + '|' + type);
    if (keys.some(key => decisions.get(key) === false)) return callback(false);
    if (keys.every(key => decisions.get(key) === true)) return callback(true);
    const undecided = keys.filter(key => !decisions.has(key));
    const mediaTypes = permission === 'media' ? types.filter(type => undecided.includes(origin + '|' + type)).map(type => type.slice('media:'.length)) : undefined;
    const requestKey = JSON.stringify(undecided);
    if (!pending.has(requestKey)) {
      const decision = Promise.resolve().then(() => isAlive() ? ask({ origin, permission, mediaTypes }) : false)
        .then(value => value === true, () => false)
        .then(accepted => { for (const key of undecided) decisions.set(key, accepted); return accepted; })
        .finally(() => pending.delete(requestKey));
      pending.set(requestKey, decision);
    }
    const accepted = await pending.get(requestKey);
    callback(accepted && keys.every(key => decisions.get(key) === true) && isAlive() && !wc.isDestroyed() && wc.getURL() === topUrl);
  });
}
