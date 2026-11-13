import test from 'node:test';
import assert from 'node:assert/strict';
import { installPermissionHandlers } from '../site-permissions.mjs';

function fixture(ask) {
  const handlers = {};
  installPermissionHandlers({ setPermissionCheckHandler: fn => { handlers.check = fn; }, setPermissionRequestHandler: fn => { handlers.request = fn; } }, ask);
  const wc = { isDestroyed: () => false, getURL: () => 'https://example.test/page' };
  const request = (permission = 'notifications', details = {}, contents = wc) => new Promise(resolve => handlers.request(contents, permission, resolve, details));
  return { ...handlers, request, wc };
}

test('a denied notification request is remembered instead of showing another prompt', async () => {
  let prompts = 0;
  const f = fixture(async () => { prompts++; return false; });
  assert.equal(await f.request(), false);
  assert.equal(await f.request(), false);
  assert.equal(prompts, 1);
  assert.equal(f.check(f.wc, 'notifications', 'https://example.test'), false);
});

test('identical pending requests share one prompt and reuse an explicit approval', async () => {
  let prompts = 0, decide;
  const f = fixture(() => { prompts++; return new Promise(resolve => { decide = resolve; }); });
  const first = f.request(), second = f.request();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts, 1);
  decide(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(await f.request(), true);
  assert.equal(f.check(f.wc, 'notifications', 'https://example.test/other'), true);
  assert.equal(prompts, 1);
});

test('choices never grant another origin, permission, session or media capability', async () => {
  let prompts = 0;
  const f = fixture(async () => { prompts++; return true; });
  await f.request('media', { mediaTypes: ['audio'] });
  assert.equal(f.check(f.wc, 'media', 'https://example.test', { mediaType: 'audio' }), true);
  assert.equal(f.check(f.wc, 'media', 'https://example.test', { mediaType: 'video' }), false);
  assert.equal(f.check(f.wc, 'media', 'https://other.test', { mediaType: 'audio' }), false);
  assert.equal(f.check(f.wc, 'notifications', 'https://example.test'), false);
  await f.request('media', { mediaTypes: ['video'] });
  assert.equal(prompts, 2);
  const another = fixture(async () => false);
  assert.equal(another.check(another.wc, 'media', 'https://example.test', { mediaType: 'audio' }), false);
});

test('invalid requests and unavailable windows are denied without prompting; prompt failures resolve safely', async () => {
  let prompts = 0;
  const f = fixture(async () => { prompts++; throw new Error('closed dialog'); });
  for (const [permission, details, wc] of [['unknown', {}, f.wc], ['notifications', { requestingUrl: 'file:///private' }, f.wc], ['notifications', {}, null], ['media', {}, f.wc]]) assert.equal(await f.request(permission, details, wc), false);
  assert.equal(prompts, 0);
  assert.equal(await f.request(), false);
  assert.equal(await f.request(), false);
  assert.equal(prompts, 1);
});

test('a page that navigates or closes during a prompt does not receive permission', async () => {
  let decide;
  const f = fixture(() => new Promise(resolve => { decide = resolve; }));
  const result = f.request();
  await new Promise(resolve => setImmediate(resolve));
  f.wc.getURL = () => 'https://other.test/';
  decide(true);
  assert.equal(await result, false);
  assert.equal(f.check(f.wc, 'notifications', 'https://other.test'), false);
});

test('known inherited and blob origins work while ambiguous or opaque frames stay denied', async () => {
  const f = fixture(async () => true);
  f.wc.mainFrame = { framesInSubtree: [{ url: 'about:srcdoc', origin: 'https://example.test' }] };
  assert.equal(await f.request('notifications', { requestingUrl: 'about:srcdoc', isMainFrame: false }), true);
  assert.equal(f.check(f.wc, 'notifications', 'https://example.test'), true);
  assert.equal(await f.request('geolocation', { requestingUrl: 'blob:https://example.test/fixture' }), true);
  assert.equal(await f.request('media', { requestingUrl: 'about:blank', securityOrigin: 'https://example.test', mediaTypes: ['audio'] }), true);
  assert.equal(await f.request('media', { requestingUrl: 'https://example.test', securityOrigin: 'null', mediaTypes: ['video'] }), false);
  const ambiguous = fixture(() => { throw new Error('must not prompt for an ambiguous origin'); });
  ambiguous.wc.mainFrame = { framesInSubtree: [{ url: 'about:srcdoc', origin: 'https://example.test' }, { url: 'about:srcdoc', origin: 'null' }] };
  assert.equal(await ambiguous.request('notifications', { requestingUrl: 'about:srcdoc' }), false);
});

test('denying a camera upgrade preserves a previously approved microphone', async () => {
  const prompted = [];
  const f = fixture(async request => { prompted.push(request.mediaTypes); return prompted.length === 1; });
  assert.equal(await f.request('media', { mediaTypes: ['audio'] }), true);
  assert.equal(await f.request('media', { mediaTypes: ['audio', 'video'] }), false);
  assert.equal(await f.request('media', { mediaTypes: ['audio'] }), true);
  assert.deepEqual(prompted, [['audio'], ['video']]);
});
