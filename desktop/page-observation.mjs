import { selectorFunction } from './page-scripts.mjs';

export const OBSERVATION_WORLD = 1005;

// This function is serialized into an isolated Chromium world. References never
// become page attributes, tool arguments, or authorization to access another tab.
function pageOperation(request, selectorFor) {
  const MAX_ELEMENTS = 160, MAX_SCAN = 10000, MAX_REFERENCES = 4096, TEXT_LIMIT = 24000;
  const OUTPUT_LIMIT = 96000, SELECTED_OPTIONS_LIMIT = 8;
  let state = globalThis[request.key];
  if (!state) {
    state = { selectors: new Map(), observed: false };
    Object.defineProperty(globalThis, request.key, { value: state });
  }
  const labelText = value => String(value || '').replace(/\s+/g, ' ').trim();
  const flag = value => value === null ? undefined : value === 'mixed' ? 'mixed' : value === 'true';
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
  };
  const disabled = element => element.matches(':disabled') || !!element.closest('[inert],[aria-disabled="true"]');
  const describe = element => {
    const tag = element.tagName.toLowerCase();
    const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    const labels = Array.from(element.labels || []).map(label => label.textContent).join(' ');
    const input = ['input', 'textarea', 'select'].includes(tag);
    return {
      tag, type: element.getAttribute('type') || undefined,
      role: element.getAttribute('role') || undefined,
      label: labelText(labelled || element.getAttribute('aria-label') || labels || element.getAttribute('placeholder') || element.getAttribute('title') ||
        (!input ? element.innerText : '') || element.getAttribute('name')),
      href: tag === 'a' ? element.href : undefined,
      disabled: disabled(element), readOnly: !!element.readOnly,
      checked: tag === 'input' && ['checkbox', 'radio'].includes(element.type) ? (element.indeterminate ? 'mixed' : element.checked) : flag(element.getAttribute('aria-checked')),
      selected: tag === 'option' ? element.selected : flag(element.getAttribute('aria-selected')),
      selectedOptions: tag === 'select' ? Array.from(element.selectedOptions, option => labelText(option.label)) : undefined,
      expanded: flag(element.getAttribute('aria-expanded')),
      pressed: flag(element.getAttribute('aria-pressed')),
    };
  };
  const boundFields = (details, limits) => {
    for (const [name, limit] of Object.entries(limits)) {
      if (details[name]?.length > limit) {
        details[name] = details[name].slice(0, limit);
        details[name + 'Truncated'] = true;
        details.metadataTruncated = true;
      }
    }
    return details;
  };
  const boundedDetails = raw => {
    const details = boundFields({ ...raw }, { tag: 64, type: 64, role: 64, label: 180, href: 2048 });
    if (raw.selectedOptions) {
      details.selectedOptionCount = raw.selectedOptions.length;
      details.selectedOptions = raw.selectedOptions.slice(0, SELECTED_OPTIONS_LIMIT).map(label => label.slice(0, 180));
      if (raw.selectedOptions.length > SELECTED_OPTIONS_LIMIT || raw.selectedOptions.some(label => label.length > 180)) {
        details.selectedOptionsTruncated = true;
        details.metadataTruncated = true;
      }
    }
    return details;
  };
  const signature = element => JSON.stringify(describe(element));
  const blocked = reason => ({ ok: false, reason, status: 'needs_observation', actionApplied: false });

  if (request.operation === 'snapshot') {
    let root = document.body || document.documentElement;
    if (request.scope) {
      const matches = document.querySelectorAll(request.scope);
      if (matches.length !== 1) throw new Error('Snapshot scope must match exactly one element.');
      root = matches[0];
    }
    const query = 'a,button,input,textarea,select,[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="option"],[role="menuitem"],[role="combobox"],[role="textbox"],[contenteditable="true"]';
    const found = [...(root.matches(query) ? [root] : []), ...root.querySelectorAll(query)];
    const candidates = found.slice(0, MAX_SCAN).filter(visible).map((element, order) => {
      const rect = element.getBoundingClientRect();
      const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      return { element, order, inViewport };
    });
    candidates.sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.order - b.order);
    const offset = request.offset || 0, textOffset = request.textOffset || 0;
    const allText = root.innerText || '';
    let text = allText.slice(textOffset, textOffset + TEXT_LIMIT);
    // Account for JSON escaping as well as raw characters in the output budget.
    if (JSON.stringify(text).length > 30000) {
      let low = 0, high = text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (JSON.stringify(text.slice(0, middle)).length <= 30000) low = middle;
        else high = middle - 1;
      }
      text = text.slice(0, low);
    }
    const header = boundFields({ url: location.href, title: document.title, scope: request.scope || null }, { url: 2048, title: 512 });
    let remaining = OUTPUT_LIMIT - JSON.stringify({ ...header, text }).length - 1024;
    let metadataTruncated = !!header.metadataTruncated;
    const elements = [];
    for (const { element, inViewport } of candidates.slice(offset, offset + MAX_ELEMENTS)) {
      const selector = selectorFor(element), raw = describe(element);
      // Never shorten a selector into a different, potentially valid target.
      const selectorAvailable = selector.length <= 4096 && JSON.stringify(selector).length <= 4098;
      const details = { selector: selectorAvailable ? selector : null, ...boundedDetails(raw), inViewport };
      if (!selectorAvailable) { details.selectorUnavailable = true; details.metadataTruncated = true; }
      const size = JSON.stringify(details).length + 1;
      if (size > remaining) { metadataTruncated = true; break; }
      remaining -= size;
      elements.push(details);
      metadataTruncated ||= !!details.metadataTruncated;
      if (selectorAvailable) {
        // The full meaning is retained internally: display truncation must never
        // hide a changed destination or changed control label from this check.
        const record = { node: new WeakRef(element), signature: JSON.stringify(raw) };
        state.selectors.delete(selector);
        state.selectors.set(selector, record);
        while (state.selectors.size > MAX_REFERENCES) state.selectors.delete(state.selectors.keys().next().value);
      }
    }
    state.observed = true;
    const nextOffset = offset + elements.length < candidates.length ? offset + elements.length : null;
    const nextTextOffset = textOffset + text.length < allText.length ? textOffset + text.length : null;
    return {
      ...header, text, elements, metadataTruncated,
      offset, totalElements: candidates.length, nextOffset,
      truncated: nextOffset !== null || found.length > MAX_SCAN, scanTruncated: found.length > MAX_SCAN,
      textOffset, textTruncated: nextTextOffset !== null, nextTextOffset,
    };
  }

  const matches = document.querySelectorAll(request.selector);
  if (!matches.length) return blocked('missing');
  if (matches.length !== 1) return blocked('ambiguous');
  const element = matches[0];
  // Expired selector records fail closed. Looking up the newly resolved node
  // would accidentally authorize a different, previously observed control.
  const known = state.selectors.get(request.selector);
  if (known && (known.node.deref() !== element || known.signature !== signature(element))) return blocked('target_changed');
  if (state.observed && !known) return blocked('unobserved_target');
  if (!element.isConnected) return blocked('target_changed');
  if (!visible(element)) return blocked('hidden');
  if (disabled(element)) return blocked('disabled');
  if (request.operation === 'type' && (element.readOnly || !(element.matches('input,textarea') || element.isContentEditable))) return blocked('not_editable');

  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return blocked('outside_viewport');
  const insetX = Math.min(2, (right - left) / 4), insetY = Math.min(2, (bottom - top) / 4);
  const points = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + insetX, top + insetY], [right - insetX, top + insetY],
    [left + insetX, bottom - insetY], [right - insetX, bottom - insetY],
  ];
  const point = points.find(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return hit === element || (hit && element.contains(hit));
  });
  if (!point) return blocked('covered');
  if (request.operation === 'type') {
    element.focus();
    if (document.activeElement !== element) return blocked('focus_failed');
    if (element.select) element.select();
    else {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
  }
  return { ok: true, x: point[0], y: point[1] };
}

const script = options => `(${pageOperation.toString()})(${JSON.stringify(options)},(${selectorFunction}))`;
export const observationScript = options => script({ ...options, operation: 'snapshot' });
export const prepareActionScript = options => script(options);

export function evaluateObservation(contents, source) {
  // Native Electron and connected Chrome both provide an isolated world.
  // Older compatible adapters may only provide executeJavaScript.
  return contents.executeJavaScriptInIsolatedWorld
    ? contents.executeJavaScriptInIsolatedWorld(OBSERVATION_WORLD, [{ code: source }])
    : contents.executeJavaScript(source);
}
