import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { CredentialVault, fillCredential } from '../credentials.mjs';

// The platform crypto dependency is substituted here; the native suite also
// round-trips the same vault through real Windows safeStorage.
function encryption() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptStringAsync: async (bytes) => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return {
        result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
          'utf8',
        ),
      };
    },
  };
}
const record = {
  profileId: 'brand',
  url: 'https://example.com/login',
  username: 'P',
  password: 'p-secret',
};

test('concurrent P/Q saves remain separate, encrypted, and scoped to exact origin and profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-vault-'));
  const crypto = encryption(),
    vault = new CredentialVault(directory, crypto);
  await Promise.all([
    vault.save(record),
    vault.save({ ...record, username: 'Q', password: 'q-secret' }),
  ]);
  const restored = new CredentialVault(directory, crypto);
  const list = await restored.list({ profileId: 'brand', url: 'https://example.com/elsewhere' });
  assert.deepEqual(
    list.map((r) => r.username),
    ['P', 'Q'],
  );
  assert.equal(JSON.stringify(list).includes('secret'), false);
  assert.equal(
    (await readFile(join(directory, 'credentials.bin'))).includes(Buffer.from('p-secret')),
    false,
  );
  assert.deepEqual(await restored.list({ profileId: 'different' }), []);
  await assert.rejects(restored.get('brand', list[0].id, 'https://other.example.com'));
  await assert.rejects(restored.get('different', list[0].id, 'https://example.com'));
  await restored.remove('brand', list[0].id);
  assert.deepEqual(
    (await restored.list({ profileId: 'brand' })).map((r) => r.username),
    ['Q'],
  );
});

test('corrupt or unavailable encryption never overwrites existing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-vault-bad-'));
  const crypto = encryption();
  const bytes = Buffer.from('broken encrypted file');
  await writeFile(join(directory, 'credentials.bin'), bytes);
  const vault = new CredentialVault(directory, crypto);
  await assert.rejects(vault.save(record), /보존/);
  assert.deepEqual(await readFile(join(directory, 'credentials.bin')), bytes);
  const locked = new CredentialVault(directory, {
    ...crypto,
    isAsyncEncryptionAvailable: async () => false,
  });
  await assert.rejects(locked.save(record), /암호화/);
  assert.deepEqual(await readFile(join(directory, 'credentials.bin')), bytes);
});

test('fill rejects a navigation or profile replacement while the vault is loading', async () => {
  let release;
  const secret = new Promise((resolve) => {
    release = resolve;
  });
  let url = 'https://example.com/login',
    executions = 0;
  const entry = {
    profileId: 'brand',
    view: {
      webContents: {
        getURL: () => url,
        isDestroyed: () => false,
        executeJavaScriptInIsolatedWorld: async () => {
          executions++;
          return { filled: 2 };
        },
      },
    },
  };
  let current = entry;
  const manager = { get: () => current, userInput: () => {} };
  const operation = fillCredential(
    manager,
    { get: () => secret },
    { paneId: 'pane', profileId: 'brand', credentialId: 'cred', origin: 'https://example.com' },
  );
  current = { ...entry };
  url = 'https://attacker.example/';
  release(record);
  await assert.rejects(operation, /바뀌어/);
  assert.equal(executions, 0);
});

test('insecure public origins and credentials in URL are rejected before persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-vault-origin-'));
  const vault = new CredentialVault(directory, encryption());
  for (const url of ['http://example.com/', 'file:///tmp/a', 'https://me:pass@example.com/'])
    assert.throws(() => vault.save({ ...record, url }));
  assert.deepEqual(await vault.list({ profileId: 'brand' }), []);
});
