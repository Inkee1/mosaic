import { t } from '../../shared/i18n.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { CdpConnection, chromeEndpoint } from './cdp.mjs';
import { ChromeContents } from './contents.mjs';
import { chromeWebUrl, findChrome } from '../external-browser.mjs';

export function chromeProfileDirectory(directory, paneId, profileId) {
  if (![paneId, profileId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value))) throw new Error('Invalid Chrome owner');
  const key = createHash('sha256').update(paneId + '\0' + profileId).digest('hex').slice(0, 40);
  return join(resolve(directory), 'chrome-profiles', key);
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const owner = (paneId, profileId) => paneId + '\0' + profileId;
const allowed = url => { if (url === 'about:blank' || url === '') return true; try { chromeWebUrl(url); return true; } catch { return false; } };

export class ChromeGroup {
  constructor(runtime, options, connection, endpoint, directory, metadata) {
    Object.assign(this, { runtime, ...options, connection, endpoint, directory });
    this.targets = new Map();
    this.attaching = new Map();
    this.rootId = metadata?.endpoint === endpoint ? metadata.rootId : null;
    this.activeId = this.rootId;
    this.binding = '__mosaicInput_' + randomBytes(12).toString('hex');
    this.disposed = false;
    connection.on('event', event => this.event(event));
    connection.on('closed', () => { for (const target of this.targets.values()) target.dispose(); if (!this.disposed) { this.runtime.changed(this); this.runtime.onDisconnect?.(this.paneId, this.profileId); } });
  }
  changed() { if (!this.disposed) this.runtime.changed(this); }
  async save() { await writeFile(join(this.directory, 'mosaic-connection.json'), JSON.stringify({ endpoint: this.endpoint, rootId: this.rootId, pid: this.pid }), { mode: 0o600 }); }
  async initialize(guard) {
    await this.connection.send('Target.setDiscoverTargets', { discover: true }); guard();
    const { targetInfos } = await this.connection.send('Target.getTargets'); guard();
    await Promise.all(targetInfos.filter(info => info.type === 'page').map(info => this.attach(info)));
    guard();
    if (!this.rootId) this.rootId = [...this.targets.values()].find(target => !target.info.openerId && allowed(target.getURL()))?.id || [...this.targets.keys()][0];
    this.activeId = this.targets.has(this.rootId) ? this.rootId : this.targets.keys().next().value;
    await this.save();
  }
  async attach(info) {
    if (this.disposed || this.connection.closed || info.type !== 'page') return;
    if (this.attaching.has(info.targetId)) return this.attaching.get(info.targetId);
    if (this.targets.has(info.targetId)) return this.targets.get(info.targetId);
    const operation = (async () => {
      const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      if (this.disposed || this.connection.closed) return;
      const target = new ChromeContents(this, info, sessionId);
      this.targets.set(target.id, target);
      if (!this.rootId) this.rootId = target.id;
      this.activeId = target.id;
      const script = `(() => { const notify = () => { try { window[${JSON.stringify(this.binding)}]('input'); } catch {} }; for (const type of ['pointerdown','keydown','wheel']) addEventListener(type, event => { if (event.isTrusted) notify(); }, { capture:true, passive:true }); })()`;
      await Promise.all([target.send('Page.enable'), target.send('Runtime.enable'), target.send('Runtime.addBinding', { name: this.binding }), target.send('Emulation.setFocusEmulationEnabled', { enabled: true })]);
      await target.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
      await target.executeJavaScript(script).catch(() => {});
      const { frameTree } = await target.send('Page.getFrameTree');
      target.mainFrameId = frameTree.frame.id;
      if (target.navigationIntent?.source === 'initial' && frameTree.frame.url === target.navigationIntent.url) target.navigationIntent = null;
      await target.refreshHistory();
      this.changed();
      return target;
    })().catch(error => {
      const target = this.targets.get(info.targetId);
      // A popup can close during attachment. Persistent setup failures must
      // remain visible and must never present the target as ready for input.
      if (target && !target.isDestroyed()) { target.setupError = error.message; this.changed(); }
    }).finally(() => this.attaching.delete(info.targetId));
    this.attaching.set(info.targetId, operation);
    return operation;
  }
  event({ method, params = {}, sessionId }) {
    if (this.disposed) return;
    if (method === 'Target.targetCreated') void this.attach(params.targetInfo);
    else if (method === 'Target.targetInfoChanged') {
      const target = this.targets.get(params.targetInfo.targetId);
      if (target) { target.info = params.targetInfo; this.changed(); }
    } else if (method === 'Target.targetDestroyed') {
      const target = this.targets.get(params.targetId);
      target?.dispose(); this.targets.delete(params.targetId);
      if (this.activeId === params.targetId) this.activeId = this.targets.has(target?.info.openerId) ? target.info.openerId : this.targets.keys().next().value;
      this.changed();
    } else {
      const target = [...this.targets.values()].find(item => item.sessionId === sessionId);
      if (!target) return;
      if (method === 'Runtime.bindingCalled' && params.name === this.binding && params.payload === 'input') {
        this.activeId = target.id;
        this.runtime.onManual(this.paneId, this.profileId);
        this.changed();
      } else if (method.startsWith('Page.')) target.event(method, params);
    }
  }
  async list() {
    await Promise.allSettled([...this.attaching.values()]);
    return [...this.targets.values()].filter(target => !target.isDestroyed()).map(target => ({
      targetId: target.id === this.rootId ? 'main' : 'chrome-' + target.id,
      parentTargetId: target.info.openerId ? (target.info.openerId === this.rootId ? 'main' : 'chrome-' + target.info.openerId) : undefined,
      title: target.getTitle().slice(0, 120), url: target.getURL(), browser: 'chrome',
      active: target.id === this.activeId, loading: target.loading, accessible: !target.setupError && allowed(target.getURL()), dialog: target.dialog || undefined, error: target.setupError,
    }));
  }
  target(id, { navigate = false } = {}) {
    const actual = id === 'main' ? this.rootId : id ? (id.startsWith('chrome-') ? id.slice(7) : null) : (this.activeId || this.rootId);
    const target = this.targets.get(actual);
    if (!target || target.isDestroyed()) throw new Error(t('Chrome 탭을 찾을 수 없어요. list_targets로 다시 확인해 주세요.'));
    if (target.setupError) throw new Error(t('Chrome 탭 연결을 완료하지 못했어요: {error}', { error: target.setupError }));
    if (!navigate && !allowed(target.getURL())) throw new Error(t('이 Chrome 페이지는 AI 제어 대상이 아니에요. HTTP(S) 주소로 먼저 이동해 주세요.'));
    return target;
  }
  disconnect() { this.disposed = true; this.connection.close(); }
}

export class ChromeRuntime {
  constructor({ directory, onChange = () => {}, onManual = () => {}, onDisconnect = () => {} }) {
    Object.assign(this, { directory, onChange, onManual, onDisconnect });
    this.groups = new Map(); this.pending = new Map(); this.generations = new Map();
  }
  changed(group) { if (this.groups.get(owner(group.paneId, group.profileId)) === group) this.onChange(group.paneId, group); }
  async open({ paneId, profileId, url }, guard = () => {}) {
    guard(); chromeWebUrl(url);
    const key = owner(paneId, profileId);
    const existing = this.groups.get(key);
    if (existing?.profileId === profileId && !existing.connection.closed) return existing;
    if (this.pending.has(key)) { const group = await this.pending.get(key); guard(); return group; }
    this.disconnect(paneId, profileId);
    const generation = this.generations.get(key);
    const check = () => { guard(); if (generation !== this.generations.get(key)) throw new Error(t('Chrome 연결이 취소됐어요.')); };
    const operation = this.connect({ paneId, profileId, url }, check).finally(() => { if (this.pending.get(key) === operation) this.pending.delete(key); });
    this.pending.set(key, operation);
    return operation;
  }
  async connect(options, guard) {
    const directory = chromeProfileDirectory(this.directory, options.paneId, options.profileId);
    await mkdir(directory, { recursive: true }); guard();
    const endpointFile = join(directory, 'DevToolsActivePort');
    let metadata;
    try { metadata = JSON.parse(await readFile(join(directory, 'mosaic-connection.json'), 'utf8')); } catch {}
    let connection, endpoint, pid = metadata?.pid;
    try {
      endpoint = chromeEndpoint(await readFile(endpointFile, 'utf8')); guard();
      connection = await CdpConnection.connect(endpoint, { timeoutMs: 1200 });
      connection.timeoutMs = 10000;
    } catch (error) { guard(); }
    let launched = false;
    if (!connection) {
      const executable = findChrome();
      if (!executable) throw new Error(t('Chrome을 찾지 못했어요. Chrome을 설치한 뒤 다시 시도해 주세요.'));
      guard();
      const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + directory, '--no-first-run', '--no-default-browser-check', 'about:blank'], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error(t('Chrome을 실행하지 못했어요.')))); });
      child.unref(); pid = child.pid; launched = true;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        guard();
        try { endpoint = chromeEndpoint(await readFile(endpointFile, 'utf8')); connection = await CdpConnection.connect(endpoint, { timeoutMs: 1000 }); connection.timeoutMs = 10000; break; } catch { await sleep(150); }
      }
      if (!connection) throw new Error(t('Chrome 연결에 시간이 걸려요. 열려 있는 전용 Chrome을 확인한 뒤 다시 연결해 주세요.'));
    }
    const group = new ChromeGroup(this, { ...options, pid }, connection, endpoint, directory, metadata);
    try {
      guard(); await group.initialize(guard); guard();
      if (!group.rootId) {
        const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' }); guard();
        await group.attach({ targetId, type: 'page', url: 'about:blank', title: '' });
        group.rootId = targetId; group.activeId = targetId;
      }
      guard();
      this.groups.set(owner(options.paneId, options.profileId), group);
      const root = group.targets.get(group.rootId);
      if (root && (launched || root.getURL() === 'about:blank')) { guard(); await root.loadURL(options.url); }
      guard(); await group.save(); guard(); this.changed(group);
      return group;
    } catch (error) { group.disconnect(); const key = owner(options.paneId, options.profileId); if (this.groups.get(key) === group) this.groups.delete(key); throw error; }
  }
  disconnect(paneId, profileId) {
    const keys = profileId ? [owner(paneId, profileId)] : [...new Set([...this.groups.keys(), ...this.pending.keys()])].filter(key => key.startsWith(paneId + '\0'));
    for (const key of keys) {
      this.generations.set(key, (this.generations.get(key) || 0) + 1);
      this.pending.delete(key);
      const group = this.groups.get(key); this.groups.delete(key); group?.disconnect();
    }
  }
  disconnectAll() { for (const key of new Set([...this.groups.keys(), ...this.pending.keys()])) this.disconnect(...key.split('\0')); }
}
