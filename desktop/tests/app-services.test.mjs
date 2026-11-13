import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServices } from '../app-services.mjs';

const config = { repository: 'example/mosaic', channel: 'beta', supportEmail: null, licenseStatus: 'pending' };
const release = (version, patch = {}) => ({ tag_name: 'v' + version, html_url: 'https://github.com/example/mosaic/releases/tag/v' + version, draft: false, prerelease: version.includes('-'), ...patch });
const telemetryConfig = { host: 'https://us.i.posthog.com', projectToken: 'phc_' + 'x'.repeat(40) };
async function service(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-services-'));
  return new AppServices({ directory, version: '0.7.0', config, ...options });
}

test('language preference follows the system, persists explicitly and leaves consent off', async () => {
  const app = await service({ systemLocale: 'en-US' });
  assert.equal(app.info().preferences.language, 'system');
  assert.equal(app.info().locale, 'en');
  await app.setPreferences({ language: 'ko' });
  assert.equal(app.info().locale, 'ko');
  const restored = new AppServices({ directory: app.directory, version: '0.7.1', systemLocale: 'en-GB' });
  assert.equal(restored.info().preferences.language, 'ko');
  assert.equal(restored.info().locale, 'ko');
  assert.equal(restored.info().preferences.metricsEnabled, false);
  assert.equal(restored.info().preferences.telemetryEnabled, false);
  await restored.setPreferences({ language: 'system' });
  assert.equal(restored.info().locale, 'en');
  for (const language of ['fr', true, null, {}, '__proto__']) await assert.rejects(restored.setPreferences({ language }));
});

test('failed language saves preserve the previous language and invalid stored language falls back', async () => {
  const app = await service({ systemLocale: 'en-US' });
  await writeFile(join(app.directory, 'app-settings.json'), JSON.stringify({ version: 1, preferences: { language: 'invalid' }, days: [] }));
  const restored = new AppServices({ directory: app.directory, version: '0.7.1', systemLocale: 'en-US' });
  assert.equal(restored.info().preferences.language, 'system');
  restored.save = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(restored.setPreferences({ language: 'ko' }));
  assert.equal(restored.info().preferences.language, 'system');
  assert.equal(restored.info().locale, 'en');
});

test('support can open a configured HTTPS form without publishing an email address', async () => {
  const supportUrl = 'https://support.example.test/contact?product=mosaic';
  const app = await service({ config: { ...config, supportUrl } });
  assert.equal(app.info().supportAvailable, true);
  assert.equal(app.link('support'), supportUrl);
  assert.throws(() => app.link(supportUrl), 'renderer callers must still use a fixed topic');
  const both = await service({ config: { ...config, supportUrl, supportEmail: 'support@example.test' } });
  assert.equal(both.link('support'), supportUrl);
  const email = await service({ config: { ...config, supportEmail: 'support@example.test' } });
  assert.equal(email.link('support'), 'mailto:support%40example.test');
});

test('support rejects executable, unencrypted and credential-bearing form links', async () => {
  for (const supportUrl of ['javascript:alert(1)', 'file:///C:/private', 'http://support.example.test', '//support.example.test', 'https://user:secret@support.example.test', 'https://support.example.test/\ncontact', ' https://support.example.test', 'https://support.example.test/' + 'x'.repeat(2048)]) {
    const app = await service({ config: { ...config, supportUrl } });
    assert.equal(app.info().supportAvailable, false, supportUrl);
    assert.throws(() => app.link('support'));
  }
});

test('server usage requires separate durable consent and sends only a daily random install identity', async () => {
  const requests = [];
  const app = await service({ telemetryConfig, fetchImpl: async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return new Response('{}'); } });
  await app.setPreferences({ metricsEnabled: true });
  app.record('app_open'); await app.flush();
  assert.equal(requests.length, 0);
  assert.equal(app.info().preferences.telemetryEnabled, false);
  await app.setPreferences({ telemetryEnabled: true }); await app.flush();
  assert.equal(requests.length, 1);
  const { body, options, url } = requests[0];
  assert.equal(url, 'https://us.i.posthog.com/i/v0/e/');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(body.event, 'mosaic_active_day');
  assert.match(body.distinct_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(body.properties).sort(), ['$geoip_disable', '$ip', '$process_person_profile', 'app_version', 'architecture', 'consent_policy', 'platform'].sort());
  assert.equal(body.properties.$ip, null);
  assert.equal(body.properties.$geoip_disable, true);
  assert.equal(body.properties.$process_person_profile, false);
  assert.ok(!JSON.stringify(app.info()).includes(body.distinct_id));
  assert.ok(!JSON.stringify(app.diagnostics()).includes(body.distinct_id));
  const restored = new AppServices({ directory: app.directory, version: '0.7.0', telemetryConfig, fetchImpl: app.fetchImpl });
  await restored.telemetry.tick(); await restored.flush();
  assert.equal(requests.length, 1, 'restart must not count the same day twice');
  await restored.setPreferences({ telemetryEnabled: false });
  assert.equal(JSON.parse(await readFile(join(app.directory, 'usage-consent.json'), 'utf8')).installationId, null);
  await restored.setPreferences({ telemetryEnabled: true }); await restored.flush();
  assert.notEqual(requests[1].body.distinct_id, body.distinct_id);
});

test('server usage migrates old local consent as off and rejects unsafe destinations or management tokens', async () => {
  const app = await service();
  await app.setPreferences({ metricsEnabled: true });
  const restored = new AppServices({ directory: app.directory, version: '0.7.0', telemetryConfig });
  assert.equal(restored.info().preferences.telemetryEnabled, false);
  for (const config of [{}, { ...telemetryConfig, host: 'http://us.i.posthog.com' }, { ...telemetryConfig, host: 'https://us.i.posthog.com.attacker.test' }, { ...telemetryConfig, projectToken: 'phx_' + 'x'.repeat(40) }]) {
    const invalid = await service({ telemetryConfig: config, fetchImpl: () => { throw new Error('Unexpected network request'); } });
    await assert.rejects(invalid.setPreferences({ telemetryEnabled: true }), /집계|configuration/i);
    assert.equal(invalid.info().preferences.telemetryEnabled, false);
  }
});

test('server usage opt-out aborts in-flight requests and failures have bounded retries', async () => {
  let calls = 0, signal;
  const app = await service({ telemetryConfig, timeoutMs: 25, fetchImpl: (_url, options) => {
    calls++; signal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private network detail')), { once: true }));
  } });
  await app.setPreferences({ telemetryEnabled: true });
  await app.flush();
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  await app.telemetry.tick();
  assert.equal(calls, 1, 'failed requests retry at most once an hour');
  assert.doesNotMatch(JSON.stringify(app.info()), /private network detail/);
  await app.setPreferences({ telemetryEnabled: false });
  assert.equal(app.info().preferences.telemetryEnabled, false);
});

test('server consent save failure sends nothing and midnight keeps the same installation identity', async () => {
  let date = new Date('2026-11-12T23:59:00Z');
  const requests = [];
  const app = await service({ telemetryConfig, now: () => date, fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response('{}'); } });
  const file = app.telemetry?.file;
  assert.ok(file, 'telemetry consent storage is available');
  const blocker = join(app.directory, 'blocker'); await writeFile(blocker, 'file');
  app.telemetry.file = join(blocker, 'usage-consent.json');
  await assert.rejects(app.setPreferences({ telemetryEnabled: true }));
  assert.equal(requests.length, 0);
  assert.equal(app.info().preferences.telemetryEnabled, false);
  app.telemetry.file = file;
  await app.setPreferences({ telemetryEnabled: true }); await app.flush();
  date = new Date('2026-11-13T00:01:00Z');
  await app.telemetry.tick(); await app.flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].distinct_id, requests[1].distinct_id);
  assert.notEqual(requests[0].uuid, requests[1].uuid);
});

test('a newer opt-out supersedes an enable waiting on an unrelated settings save', async () => {
  let sends = 0, releaseSave, enteredSave;
  const entered = new Promise(resolve => { enteredSave = resolve; });
  const app = await service({ telemetryConfig, fetchImpl: async () => { sends++; return new Response('{}'); } });
  app.save = () => { enteredSave(); return new Promise(resolve => { releaseSave = resolve; }); };
  const enable = app.setPreferences({ metricsEnabled: true, telemetryEnabled: true });
  // The old implementation waits in app.save before applying telemetry intent.
  // Give it one turn; the fixed implementation writes telemetry independently.
  await Promise.race([entered, new Promise(resolve => setTimeout(resolve, 10))]);
  const disable = app.setPreferences({ telemetryEnabled: false });
  const sendsAtRevocation = sends;
  app.save = async () => {};
  releaseSave?.();
  await Promise.all([enable, disable]); await app.flush();
  assert.equal(sends, sendsAtRevocation);
  assert.equal(app.info().preferences.telemetryEnabled, false);
  const raw = JSON.parse(await readFile(join(app.directory, 'usage-consent.json'), 'utf8'));
  assert.equal(raw.enabled, false); assert.equal(raw.installationId, null);
});

test('unrelated local settings failures cannot prevent durable telemetry revocation', async () => {
  const app = await service({ telemetryConfig, fetchImpl: async () => new Response('{}') });
  await app.setPreferences({ telemetryEnabled: true }); await app.flush();
  app.save = async () => { throw new Error('Local settings unavailable'); };
  await app.setPreferences({ telemetryEnabled: false }).catch(() => {});
  await app.telemetry.flush();
  const raw = JSON.parse(await readFile(join(app.directory, 'usage-consent.json'), 'utf8'));
  assert.equal(raw.enabled, false); assert.equal(raw.installationId, null);
  const restarted = new AppServices({ directory: app.directory, version: '0.7.0', telemetryConfig });
  assert.equal(restarted.info().preferences.telemetryEnabled, false);
});

test('shutdown waits for durable revocation even if local preferences failed', async () => {
  const app = await service({ telemetryConfig, fetchImpl: async () => new Response('{}') });
  await app.setPreferences({ telemetryEnabled: true }); await app.flush();
  let releaseRevoke, enteredRevoke;
  const entered = new Promise(resolve => { enteredRevoke = resolve; });
  const persist = app.telemetry.persist.bind(app.telemetry);
  app.telemetry.persist = async next => { if (!next.enabled) { enteredRevoke(); await new Promise(resolve => { releaseRevoke = resolve; }); } await persist(next); };
  app.save = () => { app.pending = Promise.reject(new Error('Local settings unavailable')); return app.pending; };
  const change = app.setPreferences({ metricsEnabled: false, telemetryEnabled: false }).catch(() => {});
  await entered; await change; app.telemetry.stop();
  let finished = false;
  const shutdown = app.flush().catch(() => {}).then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished, false);
  releaseRevoke(); await shutdown;
  assert.equal(JSON.parse(await readFile(join(app.directory, 'usage-consent.json'), 'utf8')).enabled, false);
});

test('metrics are off by default; opt-in persists only counts and opt-out erases them', async () => {
  const app = await service();
  assert.equal(app.record('app_open'), false);
  assert.deepEqual(app.info().metrics.days, []);
  await app.setPreferences({ metricsEnabled: true, onboardingDismissed: true });
  app.record('app_open'); app.record('ai_started'); app.record('ai_completed');
  assert.equal(app.record({ event: 'ai_failed', prompt: 'private-content' }), false);
  assert.equal(app.record('https://private.example'), false);
  await app.flush();
  const restored = new AppServices({ directory: app.directory, version: '0.7.0', config });
  assert.equal(restored.info().preferences.onboardingDismissed, true);
  assert.equal(restored.info().metrics.totals.ai_started, 1);
  assert.ok(!JSON.stringify(restored.diagnostics()).includes('private'));
  await restored.setPreferences({ metricsEnabled: false });
  assert.deepEqual(restored.info().metrics.days, []);
  assert.deepEqual(JSON.parse(await readFile(join(app.directory, 'app-settings.json'), 'utf8')).days, []);
});

test('stored data is bounded, unknown fields discarded and corrupt settings recover safely', async () => {
  const app = await service({ now: () => new Date('2026-11-12T00:00:00Z') });
  const days = Array.from({ length: 120 }, (_, i) => ({ date: new Date(Date.UTC(2026, 10, 12 - i)).toISOString().slice(0, 10), app_open: 2, ai_started: -4, url: 'private-url' }));
  await writeFile(join(app.directory, 'app-settings.json'), JSON.stringify({ version: 1, preferences: { metricsEnabled: true, onboardingDismissed: true, password: 'secret-value' }, days, token: 'private-token' }));
  const bounded = new AppServices({ directory: app.directory, version: '0.7.0', config, now: app.now });
  assert.equal(bounded.info().metrics.days.length, 90);
  assert.equal(bounded.info().metrics.totals.app_open, 180);
  assert.equal(bounded.info().metrics.totals.ai_started, 0);
  assert.doesNotMatch(JSON.stringify(bounded.diagnostics()), /private|secret|url|password|token/);
  await writeFile(join(app.directory, 'app-settings.json'), '{broken');
  const recovered = new AppServices({ directory: app.directory, version: '0.7.0', config });
  assert.equal(recovered.info().preferences.metricsEnabled, false);
  assert.equal(recovered.info().recovered, true);
});

test('preference validation rejects unexpected values; clear retains consent and no content is exported', async () => {
  const app = await service();
  await assert.rejects(app.setPreferences({ endpoint: 'https://other.example' }));
  await assert.rejects(app.setPreferences({ metricsEnabled: 'yes' }));
  await app.setPreferences({ metricsEnabled: true });
  app.record('ai_failed'); await app.flush();
  await app.clearMetrics();
  assert.equal(app.info().preferences.metricsEnabled, true);
  assert.equal(app.info().metrics.totals.ai_failed, 0);
  assert.ok(!JSON.stringify(app.diagnostics()).includes(app.directory));
  assert.equal(app.diagnostics().networkTelemetry, false);
});

test('failed consent persistence leaves counting disabled, and a later save can recover', async () => {
  const app = await service();
  const blocker = join(app.directory, 'not-a-directory');
  await writeFile(blocker, 'block');
  const originalFile = app.file;
  app.file = join(blocker, 'app-settings.json');
  await assert.rejects(app.setPreferences({ metricsEnabled: true }));
  assert.equal(app.info().preferences.metricsEnabled, false);
  assert.equal(app.record('ai_started'), false);
  assert.equal(app.info().storageError, true);
  app.file = originalFile;
  await app.setPreferences({ metricsEnabled: true });
  assert.equal(app.info().storageError, false);
  assert.equal(app.record('ai_started'), true);
  await app.flush();
});

test('events and later preference changes cannot persist consent whose save failed', async () => {
  const app = await service();
  const originalSave = app.save.bind(app);
  let rejectConsent, started;
  const entered = new Promise(resolve => { started = resolve; });
  let first = true;
  app.save = () => {
    if (!first) return originalSave();
    first = false;
    started();
    return new Promise((_resolve, reject) => { rejectConsent = reject; });
  };
  const consent = app.setPreferences({ metricsEnabled: true });
  await entered;
  const counted = app.record('ai_started');
  const laterPreference = app.setPreferences({ onboardingDismissed: true });
  rejectConsent(new Error('Temporary storage failure'));
  await assert.rejects(consent);
  await laterPreference;
  await app.flush();
  const restored = new AppServices({ directory: app.directory, version: '0.7.0', config });
  assert.equal(counted, false, 'do not count until consent is durable');
  assert.equal(app.info().preferences.metricsEnabled, false);
  assert.equal(restored.info().preferences.metricsEnabled, false);
  assert.deepEqual(restored.info().metrics.days, []);
  assert.equal(restored.info().preferences.onboardingDismissed, true);
});

test('unconfigured updates and fixed help links do not access arbitrary endpoints', async () => {
  let requests = 0;
  const app = await service({ config: {}, fetchImpl: () => { requests++; throw new Error('unexpected'); } });
  assert.equal((await app.checkUpdates()).status, 'unconfigured');
  assert.equal(requests, 0);
  assert.match(app.link('codex'), /^https:\/\/developers\.openai\.com\//);
  assert.throws(() => app.link('https://attacker.example'));
  assert.throws(() => app.link('update'));
  for (const repository of ['../other', 'owner/repo/extra', 'owner/repo?secret=1', 'https://github.com/owner/repo']) {
    const invalid = await service({ config: { ...config, repository }, fetchImpl: () => { requests++; } });
    assert.equal((await invalid.checkUpdates()).status, 'unconfigured');
  }
  assert.equal(requests, 0);
});

test('manual update check uses bounded GitHub requests and the newest eligible release', async () => {
  let request;
  const app = await service({ fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify([release('0.7.1'), release('0.9.0', { draft: true }), release('0.8.0-beta.2'), release('0.8.0-beta.11'), release('0.6.9')]));
  } });
  const result = await app.checkUpdates();
  assert.equal(result.status, 'available');
  assert.equal(result.latestVersion, '0.8.0-beta.11');
  assert.equal(app.link('update'), 'https://github.com/example/mosaic/releases/tag/v0.8.0-beta.11');
  assert.equal(request.url, 'https://api.github.com/repos/example/mosaic/releases?per_page=10');
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal);
});

test('stable updates exclude prereleases and reject hostile versions or release URLs', async () => {
  const rows = [release('0.8.0-beta.1'), release('0.9.0', { html_url: 'https://attacker.example/download' }), release('01.8.0'), release('0.7.0'), release('0.9.1', { html_url: 'https://github.com/example/mosaic/releases/tag/v0.9.1?token=x' })];
  const app = await service({ config: { ...config, channel: 'stable' }, fetchImpl: async () => new Response(JSON.stringify(rows)) });
  assert.equal((await app.checkUpdates()).status, 'current');
  assert.throws(() => app.link('update'));
});

test('oversized, failed and malformed update responses are recoverable without leaking error contents', async () => {
  for (const fetchImpl of [
    async () => new Response('x'.repeat(300000)),
    async () => new Response('{}'),
    async () => new Response('[]', { status: 429 }),
    async () => { throw new Error('Bearer private-access-token'); },
  ]) {
    const app = await service({ fetchImpl });
    const result = await app.checkUpdates();
    assert.equal(result.status, 'error');
    assert.doesNotMatch(JSON.stringify(result), /Bearer|private-access-token/);
    assert.equal(app.info().preferences.metricsEnabled, false);
  }
});

test('concurrent update checks share a request and timeout leaves settings usable', async () => {
  let requests = 0;
  const app = await service({ timeoutMs: 20, fetchImpl: (_url, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  } });
  const results = await Promise.all([app.checkUpdates(), app.checkUpdates()]);
  assert.equal(requests, 1);
  assert.ok(results.every(result => result.status === 'error'));
  await app.setPreferences({ onboardingDismissed: true });
  assert.equal(app.info().preferences.onboardingDismissed, true);
});
