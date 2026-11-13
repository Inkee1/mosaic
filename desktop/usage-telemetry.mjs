import { t } from '../shared/i18n.mjs';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const POLICY = 'mosaic-usage-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const empty = () => ({ schema: 1, enabled: false, installationId: null, policy: POLICY, destination: null, lastSentDay: null });
export function validateTelemetryConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['host', 'projectToken'].includes(key))) return null;
  if (!['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(value.host) || typeof value.projectToken !== 'string' || !/^phc_[A-Za-z0-9_-]{20,255}$/.test(value.projectToken)) return null;
  return { host: value.host, projectToken: value.projectToken };
}
function dayUuid(id, day) {
  const hex = createHash('sha1').update('mosaic-active-day\0' + id + '\0' + day).digest('hex').slice(0, 32).split('');
  hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export class UsageTelemetry {
  constructor({ directory, version, config, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 5000 }) {
    this.config = validateTelemetryConfig(config);
    this.destination = this.config && createHash('sha256').update(JSON.stringify(this.config)).digest('hex');
    this.version = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) && version.length < 80 ? version : 'unknown';
    this.file = join(directory, 'usage-consent.json');
    this.fetchImpl = fetchImpl; this.now = now; this.timeoutMs = Math.max(10, Math.min(5000, timeoutMs));
    this.state = empty(); this.changes = Promise.resolve(); this.sending = null;
    this.generation = 0; this.lastAttempt = null; this.storageError = false; this.sendError = false; this.paused = false;
    try {
      if (statSync(this.file).size > 4096) throw new Error('Invalid usage preferences');
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (this.config && raw.schema === 1 && raw.enabled === true && raw.policy === POLICY && raw.destination === this.destination && UUID.test(raw.installationId || '')) {
        this.state = { ...empty(), enabled: true, installationId: raw.installationId, destination: this.destination,
          lastSentDay: /^\d{4}-\d{2}-\d{2}$/.test(raw.lastSentDay || '') ? raw.lastSentDay : null };
      }
    } catch { /* Missing, changed-policy/destination and corrupt state require fresh consent. */ }
  }
  info() {
    return { configured: !!this.config, enabled: !!this.config && this.state.enabled && !this.paused,
      region: this.config?.host === 'https://us.i.posthog.com' ? 'US' : this.config ? 'EU' : null,
      lastSentDay: this.state.lastSentDay, sendError: this.sendError, storageError: this.storageError };
  }
  async persist(next) {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', JSON.stringify(next) + '\n', { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
      this.storageError = false;
    } catch (error) { this.storageError = true; throw error; }
  }
  change(action) {
    const result = this.changes.then(action);
    this.changes = result.catch(() => {});
    return result;
  }
  pause() { this.paused = true; this.generation++; this.controller?.abort(); }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new TypeError(t('집계 설정이 올바르지 않아요.')));
    if (!enabled) this.pause();
    const generation = this.generation;
    return this.change(async () => {
      if (enabled && !this.config) throw new Error(t('사용량 집계 서버 configuration이 준비되지 않았어요.'));
      const next = enabled ? { ...empty(), enabled: true, installationId: this.state.enabled ? this.state.installationId : randomUUID(), destination: this.destination, lastSentDay: this.state.enabled ? this.state.lastSentDay : null } : empty();
      // Set visible/network consent only after its atomic write has succeeded.
      if (!enabled) this.state = empty();
      await this.persist(next);
      this.state = next;
      if (generation === this.generation) this.paused = false;
      this.sendError = false; this.lastAttempt = null;
    }).then(() => { if (enabled) void this.tick(); });
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 60000);
    this.timer.unref?.();
    void this.tick();
  }
  stop() { clearInterval(this.timer); this.timer = null; this.pause(); }
  tick() {
    if (this.sending) return this.sending;
    this.sending = this.sendDay().catch(() => { this.sendError = true; }).finally(() => { this.sending = null; });
    return this.sending;
  }
  async sendDay() {
    await this.changes;
    if (!this.info().enabled) return;
    const now = this.now(), day = now.toISOString().slice(0, 10);
    if (this.state.lastSentDay === day || (this.lastAttempt !== null && now.getTime() - this.lastAttempt >= 0 && now.getTime() - this.lastAttempt < 3600000)) return;
    this.lastAttempt = now.getTime();
    const generation = this.generation, id = this.state.installationId;
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.config.host + '/i/v0/e/', {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: this.config.projectToken, event: 'mosaic_active_day', distinct_id: id,
          uuid: dayUuid(id, day), timestamp: now.toISOString(),
          properties: { app_version: this.version, platform: ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'other', architecture: ['x64', 'arm64', 'ia32'].includes(process.arch) ? process.arch : 'other', consent_policy: POLICY, $process_person_profile: false, $geoip_disable: true, $ip: null } }),
      });
      const accepted = response.ok && !response.redirected;
      // No response body, error details or remote content are logged or retained.
      void response.body?.cancel().catch(() => {});
      if (!accepted) throw new Error('Usage request failed');
      await this.change(async () => {
        if (generation !== this.generation || !this.info().enabled || id !== this.state.installationId) return;
        const next = { ...this.state, lastSentDay: day };
        await this.persist(next); this.state = next; this.sendError = false; this.lastAttempt = null;
      });
    } catch { if (generation === this.generation && this.info().enabled) this.sendError = true; }
    finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }
  }
  async flush() { await this.changes; await this.sending; await this.changes; }
}
