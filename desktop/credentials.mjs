import { t } from '../shared/i18n.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { EncryptedStore } from './encrypted-store.mjs';

const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export function credentialOrigin(url) {
  const parsed = new URL(url);
  if (
    parsed.username ||
    parsed.password ||
    !(
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    )
  )
    throw new Error(t('비밀번호는 HTTPS 사이트에서만 사용할 수 있어요.'));
  return parsed.origin;
}
const metadata = ({ password, ...rest }) => rest;
const validRecord = (r) =>
  r &&
  validId(r.id) &&
  validId(r.profileId) &&
  typeof r.username === 'string' &&
  r.username.length > 0 &&
  r.username.length <= 320 &&
  typeof r.password === 'string' &&
  r.password.length > 0 &&
  r.password.length <= 8192 &&
  typeof r.origin === 'string' &&
  credentialOrigin(r.origin) === r.origin;

export class CredentialVault {
  constructor(directory, crypto) {
    this.store = new EncryptedStore(join(directory, 'credentials.bin'), crypto, (v) => {
      try {
        return (
          v?.version === 1 &&
          Array.isArray(v.entries) &&
          v.entries.length <= 2000 &&
          v.entries.every(validRecord)
        );
      } catch {
        return false;
      }
    });
    this.pending = Promise.resolve();
    this.loaded = null;
  }
  async load() {
    if (!this.loaded)
      this.loaded = this.store.load().then((value) => {
        this.data = value || { version: 1, entries: [] };
      });
    await this.loaded;
    return this.data;
  }
  async list({ profileId, url }) {
    if (!validId(profileId)) throw new Error(t('올바른 프로필을 선택해 주세요.'));
    const origin = url === undefined ? undefined : credentialOrigin(url);
    await this.pending.catch(() => {});
    return (await this.load()).entries
      .filter((r) => r.profileId === profileId && (!origin || r.origin === origin))
      .map(metadata);
  }
  mutate(fn) {
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        const next = structuredClone(await this.load());
        const result = fn(next);
        await this.store.save(next);
        this.data = next;
        return result;
      });
    this.pending = operation;
    return operation;
  }
  save({ profileId, url, username, password }) {
    const origin = credentialOrigin(url);
    const record = {
      id: randomUUID(),
      profileId,
      origin,
      username: typeof username === 'string' ? username.trim() : username,
      password,
      updatedAt: new Date().toISOString(),
    };
    if (!validRecord(record)) throw new Error(t('사이트, 아이디와 비밀번호를 확인해 주세요.'));
    return this.mutate((next) => {
      const previous = next.entries.find(
        (r) => r.profileId === profileId && r.origin === origin && r.username === record.username,
      );
      if (previous) {
        record.id = previous.id;
        Object.assign(previous, record);
      } else {
        if (next.entries.length >= 2000)
          throw new Error(t('비밀번호는 최대 2,000개까지 저장할 수 있어요.'));
        next.entries.push(record);
      }
      return metadata(record);
    });
  }
  remove(profileId, credentialId) {
    return this.mutate((next) => {
      const found = next.entries.find((r) => r.id === credentialId && r.profileId === profileId);
      if (!found) throw new Error(t('저장한 비밀번호를 찾을 수 없어요.'));
      next.entries = next.entries.filter((r) => r !== found);
    });
  }
  async get(profileId, credentialId, origin) {
    await this.pending.catch(() => {});
    const record = (await this.load()).entries.find(
      (r) => r.id === credentialId && r.profileId === profileId && r.origin === origin,
    );
    if (!record) throw new Error(t('이 프로필과 사이트에 맞는 비밀번호가 아니에요.'));
    return { ...record };
  }
  // A failed save has already rejected its caller and left the old file intact.
  // Waiting for it must not make the application impossible to close.
  flush() {
    return this.pending.catch(() => {});
  }
}

export async function fillCredential(manager, vault, { paneId, profileId, credentialId, origin }) {
  const entry = manager.get(paneId);
  if (entry.browser === 'chrome') throw new Error(t('Chrome 창에서 직접 로그인해 주세요.'));
  const wc = entry.view.webContents;
  const url = wc.getURL();
  if (entry.profileId !== profileId || credentialOrigin(url) !== origin)
    throw new Error(t('화면의 사이트 또는 프로필이 바뀌었어요. 다시 선택해 주세요.'));
  const record = await vault.get(profileId, credentialId, origin);
  if (manager.get(paneId) !== entry || entry.browser === 'chrome' || wc.isDestroyed() || wc.getURL() !== url)
    throw new Error(t('페이지가 바뀌어 비밀번호 입력을 취소했어요.'));
  manager.userInput(paneId);
  const result = await wc.executeJavaScriptInIsolatedWorld(
    1004,
    [
      {
        code: `(${fillForm.toString()})(${JSON.stringify({ url, username: record.username, password: record.password })})`,
      },
    ],
    true,
  );
  if (!result?.filled)
    throw new Error(
      localizeFillFailure(result?.message) ||
        t('채울 로그인 입력란을 찾지 못했어요. 로그인 페이지에서 다시 시도해 주세요.'),
    );
  return { filled: result.filled };
}

// Only Mosaic's own isolated-script results are translated; unknown site errors
// and the script's credential inputs retain their original text.
function localizeFillFailure(message) {
  switch (message) {
    case '페이지가 바뀌어 입력을 취소했어요.':
      return t('페이지가 바뀌어 입력을 취소했어요.');
    case '가입·비밀번호 변경 화면에는 자동으로 채우지 않아요.':
      return t('가입·비밀번호 변경 화면에는 자동으로 채우지 않아요.');
    case '다른 사이트로 제출되는 폼에는 비밀번호를 채우지 않아요.':
      return t('다른 사이트로 제출되는 폼에는 비밀번호를 채우지 않아요.');
    case '아이디 입력란이 여러 개예요. 직접 입력해 주세요.':
      return t('아이디 입력란이 여러 개예요. 직접 입력해 주세요.');
    default:
      return message;
  }
}

function fillForm({ url, username, password }) {
  if (location.href !== url) return { message: '페이지가 바뀌어 입력을 취소했어요.' };
  const visible = (el) =>
    !el.disabled &&
    !el.readOnly &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden';
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  if (passwords.length > 1 || passwords.some((el) => el.autocomplete === 'new-password'))
    return { message: '가입·비밀번호 변경 화면에는 자동으로 채우지 않아요.' };
  const passwordField = passwords[0];
  const root = passwordField?.form || document;
  if (
    passwordField?.form &&
    new URL(passwordField.form.action, location.href).origin !== location.origin
  )
    return { message: '다른 사이트로 제출되는 폼에는 비밀번호를 채우지 않아요.' };
  let users = [...root.querySelectorAll('input')].filter(
    (el) =>
      visible(el) &&
      ['text', 'email', 'tel'].includes(el.type) &&
      (['username', 'email'].includes(el.autocomplete) ||
        el.type === 'email' ||
        /user|login|email|identifier/i.test(el.name + ' ' + el.id)),
  );
  if (!users.length)
    users = [...root.querySelectorAll('input[type="text"], input:not([type])')].filter(visible);
  if (users.length > 1) return { message: '아이디 입력란이 여러 개예요. 직접 입력해 주세요.' };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const set = (field, value) => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (users[0]) set(users[0], username);
  if (passwordField) set(passwordField, password);
  (passwordField || users[0])?.focus();
  return { filled: Number(!!users[0]) + Number(!!passwordField) };
}
