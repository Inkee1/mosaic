import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageTelemetry } from './usage-telemetry.mjs';
import { normalizeSupportUrl } from './support-contact.mjs';
import { normalizeLanguagePreference, resolveLocale, translate } from '../shared/i18n.mjs';

const EVENTS = ['app_open', 'ai_started', 'ai_completed', 'ai_failed', 'ai_cancelled'];
const MAX_RESPONSE = 256 * 1024;
const MAX_DAYS = 90;
const HELP = Object.freeze({
  codex: 'https://developers.openai.com/codex/quickstart',
  claude: 'https://code.claude.com/docs/en/quickstart',
});
const repositoryName = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i.test(value) && !['.', '..'].includes(value.split('/')[1]) ? value : null;
const emailAddress = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? value : null;
const freshState = () => ({ version: 1, preferences: { onboardingDismissed: false, metricsEnabled: false, language: 'system' }, days: [] });
const totalsOf = days => Object.fromEntries(EVENTS.map(name => [name, days.reduce((sum, day) => sum + (day[name] || 0), 0)]));

function versionParts(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  const main = match.slice(1, 4).map(Number), pre = match[4]?.split('.') || [];
  if (main.some(number => !Number.isSafeInteger(number)) || pre.some(part => !/^[0-9A-Za-z-]+$/.test(part) || /^0\d+$/.test(part))) return null;
  return { main, pre };
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.main[i] !== b.main[i]) return a.main[i] > b.main[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i], right = b.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    if (ln && rn) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}
function releaseUrl(repository, tag, value) {
  try {
    const url = new URL(value), expected = new URL('https://github.com/' + repository + '/releases/tag/' + encodeURIComponent(tag));
    const parts = url.pathname.split('/');
    if (url.origin !== expected.origin || url.username || url.password || url.search || url.hash || parts.length !== 6) return null;
    if ((parts[1] + '/' + parts[2]).toLowerCase() !== repository.toLowerCase() || parts[3] !== 'releases' || parts[4] !== 'tag' || decodeURIComponent(parts[5]) !== tag) return null;
    return expected.href;
  } catch { return null; }
}
async function boundedJson(response) {
  if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > MAX_RESPONSE || !response.body) throw new Error('Update response rejected');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw new Error('Update response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export class AppServices {
  constructor({ directory, version, config = {}, telemetryConfig = {}, systemLocale = 'ko', fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 8000 }) {
    Object.assign(this, { directory, version, fetchImpl, now });
    this.systemLocale = typeof systemLocale === 'string' ? systemLocale : 'en';
    this.timeoutMs = Math.min(8000, Math.max(10, timeoutMs));
    this.config = { repository: repositoryName(config.repository), supportEmail: emailAddress(config.supportEmail), supportUrl: normalizeSupportUrl(config.supportUrl), channel: config.channel === 'stable' ? 'stable' : 'beta' };
    this.file = join(directory, 'app-settings.json');
    this.value = freshState();
    this.recovered = false;
    this.storageError = false;
    this.pending = Promise.resolve();
    this.changes = Promise.resolve();
    this.metricsReady = false;
    this.update = null;
    this.checking = null;
    try {
      if (statSync(this.file).size > 65536) throw new Error('Settings too large');
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw?.version !== 1 || !raw.preferences || !Array.isArray(raw.days)) throw new Error('Invalid settings');
      for (const name of ['onboardingDismissed', 'metricsEnabled']) this.value.preferences[name] = raw.preferences[name] === true;
      this.value.preferences.language = normalizeLanguagePreference(raw.preferences.language);
      if (this.value.preferences.metricsEnabled) this.value.days = this.cleanDays(raw.days);
    } catch (error) { this.recovered = error.code !== 'ENOENT'; }
    this.metricsReady = this.value.preferences.metricsEnabled;
    this.telemetry = new UsageTelemetry({ directory, version, config: telemetryConfig, fetchImpl, now, timeoutMs });
  }
  cleanDays(days) {
    const today = this.now().toISOString().slice(0, 10), cutoff = Date.parse(today) - (MAX_DAYS - 1) * 86400000;
    const clean = new Map();
    for (const row of days.slice(-365)) {
      if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date > today || !(Date.parse(row.date) >= cutoff) || new Date(row.date).toISOString().slice(0, 10) !== row.date) continue;
      clean.set(row.date, { date: row.date, ...Object.fromEntries(EVENTS.map(event => [event, Number.isInteger(row[event]) && row[event] >= 0 ? Math.min(row[event], 1000000) : 0])) });
    }
    return [...clean.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_DAYS);
  }
  info() {
    this.value.days = this.value.preferences.metricsEnabled ? this.cleanDays(this.value.days) : [];
    return {
      locale: resolveLocale(this.value.preferences.language, this.systemLocale), systemLocale: this.systemLocale,
      version: this.version, channel: this.config.channel, repository: this.config.repository,
      supportAvailable: !!(this.config.supportUrl || this.config.supportEmail), updatesConfigured: !!this.config.repository,
      preferences: { ...this.value.preferences, telemetryEnabled: this.telemetry.info().enabled }, telemetry: this.telemetry.info(), recovered: this.recovered, storageError: this.storageError || this.telemetry.info().storageError,
      metrics: { days: structuredClone(this.value.days), totals: totalsOf(this.value.days), activeDays: this.value.days.filter(day => EVENTS.some(event => day[event] > 0)).length },
    };
  }
  save() {
    const data = JSON.stringify(this.value, null, 2) + '\n';
    const task = this.pending.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      await writeFile(this.file + '.tmp', data, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
      this.storageError = false;
    }).catch(error => { this.storageError = true; throw error; });
    this.pending = task;
    return task;
  }
  async setPreferences(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.entries(patch).some(([name, value]) => name === 'language' ? !['system', 'ko', 'en'].includes(value) : !['onboardingDismissed', 'metricsEnabled', 'telemetryEnabled'].includes(name) || typeof value !== 'boolean')) throw new TypeError(this.tr("설정 값이 올바르지 않아요."));
    // Apply telemetry intent at API entry. A later revoke must supersede an
    // enable even while unrelated local preferences are waiting on disk.
    const { telemetryEnabled, ...localPatch } = patch;
    const telemetryChange = telemetryEnabled === undefined ? Promise.resolve() : this.telemetry.setEnabled(telemetryEnabled);
    void telemetryChange.catch(() => {});
    return this.change(async () => {
      if (!Object.keys(localPatch).length) { await telemetryChange; return this.info(); }
      const wasEnabled = this.value.preferences.metricsEnabled;
      const previousLanguage = this.value.preferences.language;
      Object.assign(this.value.preferences, localPatch);
      if (!this.value.preferences.metricsEnabled) {
        this.value.days = [];
        this.metricsReady = false;
      }
      try { await this.save(); }
      catch (error) {
        if (Object.hasOwn(localPatch, 'language')) this.value.preferences.language = previousLanguage;
        if (patch.metricsEnabled === true && !wasEnabled) {
          this.value.preferences.metricsEnabled = false;
          this.value.days = [];
        }
        throw error;
      }
      this.metricsReady = this.value.preferences.metricsEnabled;
      await telemetryChange;
      return this.info();
    });
  }
  change(action) {
    const result = this.changes.then(action);
    this.changes = result.catch(() => {});
    return result;
  }
  tr(message, values) { return translate(resolveLocale(this.value.preferences.language, this.systemLocale), message, values); }
  record(event) {
    // An event must never queue an enabled snapshot before consent is durable.
    if (!this.metricsReady || !this.value.preferences.metricsEnabled || !EVENTS.includes(event)) return false;
    this.value.days = this.cleanDays(this.value.days);
    const date = this.now().toISOString().slice(0, 10);
    let day = this.value.days.find(row => row.date === date);
    if (!day) { day = { date, ...totalsOf([]) }; this.value.days.push(day); }
    day[event] = Math.min(day[event] + 1, 1000000);
    this.value.days = this.cleanDays(this.value.days);
    void this.save().catch(() => {});
    return true;
  }
  clearMetrics() { return this.change(async () => { this.value.days = []; await this.save(); return this.info(); }); }
  async flush() {
    await this.changes;
    const [local, telemetry] = await Promise.allSettled([this.pending, this.telemetry.flush()]);
    if (local.status === 'rejected') throw local.reason;
    if (telemetry.status === 'rejected') throw telemetry.reason;
  }
  diagnostics() {
    const info = this.info();
    return {
      schema: 1, app: 'Mosaic', version: this.version, platform: process.platform, architecture: process.arch,
      runtime: { electron: process.versions.electron || null, chromium: process.versions.chrome || null, node: process.versions.node },
      channel: this.config.channel, settingsRecovered: this.recovered, storageError: this.storageError,
      networkTelemetry: info.preferences.telemetryEnabled, metricsEnabled: info.preferences.metricsEnabled,
      metrics: info.metrics,
      note: 'Numeric local counts only. AI completion means the provider turn finished, not a verified website outcome. No page content, account details, file paths or credentials are included.',
    };
  }
  link(topic) {
    if (Object.hasOwn(HELP, topic)) return HELP[topic];
    if (topic === 'releases' && this.config.repository) return 'https://github.com/' + this.config.repository + '/releases';
    if (topic === 'issues' && this.config.repository) return 'https://github.com/' + this.config.repository + '/issues';
    if (topic === 'support' && this.config.supportUrl) return this.config.supportUrl;
    if (topic === 'support' && this.config.supportEmail) return 'mailto:' + encodeURIComponent(this.config.supportEmail);
    if (topic === 'update' && this.update?.status === 'available') return this.update.url;
    throw new Error(this.tr("현재 사용할 수 없는 안내예요."));
  }
  checkUpdates() {
    if (!this.config.repository) return Promise.resolve({ status: 'unconfigured', currentVersion: this.version, message: this.tr("이 미리보기에는 업데이트 배포 주소가 아직 등록되지 않았어요.") });
    if (this.checking) return this.checking;
    this.checking = this.fetchUpdate().finally(() => { this.checking = null; });
    return this.checking;
  }
  async fetchUpdate() {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl('https://api.github.com/repos/' + this.config.repository + '/releases?per_page=10', {
        signal: controller.signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mosaic-update-check' },
      });
      const rows = await boundedJson(response), current = versionParts(this.version);
      if (!Array.isArray(rows) || rows.length > 100 || !current) throw new Error('Invalid releases');
      const releases = rows.flatMap(row => {
        if (!row || row.draft !== false || typeof row.tag_name !== 'string') return [];
        const latestVersion = row.tag_name.replace(/^v/, ''), parts = versionParts(latestVersion);
        const url = releaseUrl(this.config.repository, row.tag_name, row.html_url);
        if (!parts || !url || (this.config.channel === 'stable' && (row.prerelease || parts.pre.length)) || compareVersions(parts, current) <= 0) return [];
        return [{ latestVersion, parts, url }];
      }).sort((a, b) => compareVersions(b.parts, a.parts));
      const latest = releases[0];
      this.update = latest ? { status: 'available', currentVersion: this.version, latestVersion: latest.latestVersion, url: latest.url, message: this.tr("새 버전이 있어요. 변경 내용을 확인하고 작업을 저장한 뒤 설치해 주세요.") } : { status: 'current', currentVersion: this.version, message: this.tr("현재 채널에서 확인된 새 버전이 없어요.") };
    } catch {
      this.update = { status: 'error', currentVersion: this.version, message: this.tr("업데이트를 확인하지 못했어요. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.") };
    } finally { clearTimeout(timer); }
    return { ...this.update };
  }
}
