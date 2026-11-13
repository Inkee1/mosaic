// Gate currently covers its page when it identifies Electron. Observe that
// state without removing the site's guard or changing the browser identity.
export function isGateUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      (url.hostname === 'gate.com' || url.hostname.endsWith('.gate.com'));
  } catch { return false; }
}

const overlayScript = `(() => {
  if (!innerWidth || !innerHeight) return false;
  return Array.from(document.querySelectorAll('[class^="guard-"]')).some(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.position === 'fixed' && style.display !== 'none' &&
      style.visibility === 'visible' && Number(style.opacity) > 0.95 &&
      style.backgroundColor === 'rgb(255, 255, 255)' &&
      rect.left <= 0 && rect.top <= 0 && rect.right >= innerWidth && rect.bottom >= innerHeight &&
      element.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2));
  });
})()`;

export function watchSiteCompatibility(contents, onChange) {
  let generation = 0, disposed = false;
  const timers = new Set();
  const cancel = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
  const check = async (version) => {
    if (disposed || contents.isDestroyed() || version !== generation) return;
    const url = contents.getURL();
    if (!isGateUrl(url)) return;
    let timeout;
    try {
      const blocked = await Promise.race([
        contents.executeJavaScript(overlayScript),
        new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1000); timeout.unref(); }),
      ]);
      if (typeof blocked === 'boolean' && !disposed && !contents.isDestroyed() &&
          version === generation && url === contents.getURL())
        onChange(blocked ? 'gate-electron' : '');
    } catch { /* Navigation can replace the document during the read. */ }
    finally { clearTimeout(timeout); }
  };
  const navigation = (_event, _url, inPlace, main) => {
    if (!main || inPlace) return;
    generation++; cancel(); onChange('');
  };
  const loaded = () => {
    cancel();
    if (disposed || contents.isDestroyed() || !isGateUrl(contents.getURL())) return;
    const version = generation;
    for (const delay of [0, 750, 2500, 6000]) {
      const timer = setTimeout(() => { timers.delete(timer); void check(version); }, delay);
      timer.unref(); timers.add(timer);
    }
  };
  const dispose = () => {
    disposed = true; generation++; cancel();
    contents.off('did-start-navigation', navigation);
    contents.off('did-stop-loading', loaded);
    contents.off('destroyed', dispose);
  };
  contents.on('did-start-navigation', navigation);
  contents.on('did-stop-loading', loaded);
  contents.on('destroyed', dispose);
  return dispose;
}
