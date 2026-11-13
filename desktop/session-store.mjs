import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EncryptedStore } from './encrypted-store.mjs';

export function cookieDetails(cookie) {
  if (cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now() / 1000)
    return null;
  const hostname = cookie.domain.replace(/^\./, '');
  const details = {
    url: (cookie.secure ? 'https://' : 'http://') + hostname + (cookie.path || '/'),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
  };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (cookie.sameSite) details.sameSite = cookie.sameSite;
  if (cookie.expirationDate !== undefined) details.expirationDate = cookie.expirationDate;
  return details;
}

export class SessionStore {
  constructor(directory, crypto, report = () => {}) {
    this.directory = directory;
    this.crypto = crypto;
    this.report = report;
    this.entries = new Map();
  }
  prepare(key, session, seed, seedReady) {
    if (this.entries.has(key)) return this.entries.get(key).ready;
    const file = join(
      this.directory,
      'sessions',
      createHash('sha256').update(key).digest('hex') + '.bin',
    );
    const store = new EncryptedStore(
      file,
      this.crypto,
      (v) =>
        v?.version === 1 &&
        Array.isArray(v.cookies) &&
        v.cookies.length <= 30000 &&
        v.cookies.every(
          (c) =>
            c &&
            typeof c.name === 'string' &&
            typeof c.value === 'string' &&
            typeof c.domain === 'string',
        ),
    );
    const entry = { session, store, ready: null, pending: Promise.resolve(), timer: null };
    this.entries.set(key, entry);
    entry.ready = (async () => {
      const snapshot = await store.load();
      let cookies = snapshot?.cookies;
      // This snapshot is the committed cookie set, including deletions. Native
      // cookie persistence can lag behind its atomic write during a crash.
      // Never merge stale native auth cookies back into a logged-out snapshot.
      if (snapshot) await session.clearStorageData({ storages: ['cookies'] });
      if (!snapshot && seed) {
        await seedReady;
        // A pre-existing partition (e.g. interrupted first run) is its own
        // source of truth. Never merge a changed template into an existing pane.
        cookies = await session.cookies.get({});
        if (!cookies.length) cookies = await seed.cookies.get({});
      }
      for (const cookie of cookies || []) {
        const details = cookieDetails(cookie);
        if (details) await session.cookies.set(details);
      }
      await this.capture(entry);
      session.cookies.on('changed', () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(
          () => this.capture(entry).catch((error) => this.report(error.message)),
          150,
        );
      });
    })();
    entry.ready.catch(() => {
      entry.failed = true;
    });
    return entry.ready;
  }
  capture(entry) {
    const operation = entry.pending
      .catch(() => {})
      .then(async () => {
        const cookies = await entry.session.cookies.get({});
        await entry.store.save({ version: 1, cookies });
        entry.session.flushStorageData();
        await entry.session.cookies.flushStore();
      });
    entry.pending = operation;
    return operation;
  }
  async flush() {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        clearTimeout(entry.timer);
        try {
          await entry.ready;
        } catch {
          return;
        } // Failed initialization never opened a site.
        await this.capture(entry);
      }),
    );
  }
}
