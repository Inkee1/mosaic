import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieDetails } from '../session-store.mjs';
import { SessionStore } from '../session-store.mjs';
import { EncryptedStore } from '../encrypted-store.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

test('a committed logout snapshot removes stale native cookies after an interrupted flush', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-cookie-recovery-'));
  // Test-only codec: this case exercises reconciliation, not platform crypto.
  const crypto = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => Buffer.from(text),
    decryptStringAsync: async (bytes) => ({ result: bytes.toString() }),
  };
  const key = 'fixture-session';
  const file = join(directory, 'sessions', createHash('sha256').update(key).digest('hex') + '.bin');
  await new EncryptedStore(file, crypto, () => true).save({ version: 1, cookies: [] });
  let jar = [
    {
      name: 'auth',
      value: 'old-session',
      domain: 'example.com',
      hostOnly: true,
      path: '/',
      expirationDate: Date.now() / 1000 + 3600,
    },
  ];
  const cookies = Object.assign(new EventEmitter(), {
    get: async () => structuredClone(jar),
    set: async (value) => {
      jar.push(value);
    },
    flushStore: async () => {},
  });
  const session = {
    cookies,
    flushStorageData() {},
    clearStorageData: async () => {
      jar = [];
    },
  };
  const registry = new SessionStore(directory, crypto);
  await registry.prepare(key, session);
  assert.deepEqual(jar, [], 'a native database lag must not resurrect a logged-out session');
  assert.deepEqual((await new EncryptedStore(file, crypto, () => true).load()).cookies, []);
});

test('restart omits expired cookies while preserving host-only secure HttpOnly attributes', () => {
  const cookie = {
    name: '__Host-login',
    value: 'fixture',
    domain: 'example.com',
    path: '/',
    hostOnly: true,
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  };
  assert.equal(cookieDetails({ ...cookie, expirationDate: 1 }), null);
  const details = cookieDetails(cookie);
  assert.deepEqual(details, {
    url: 'https://example.com/',
    name: '__Host-login',
    value: 'fixture',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  });
});

test('domain and persistent expiry remain attached when preparing a fresh pane', () => {
  const expirationDate = Date.now() / 1000 + 10000;
  assert.deepEqual(
    cookieDetails({
      name: 'login',
      value: 'test',
      domain: '.example.com',
      hostOnly: false,
      path: '/account',
      expirationDate,
    }),
    {
      url: 'http://example.com/account',
      name: 'login',
      value: 'test',
      domain: '.example.com',
      path: '/account',
      secure: false,
      httpOnly: false,
      expirationDate,
    },
  );
});
