import { t } from '../shared/i18n.mjs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

// Only the main process owns this file. No plaintext fallback, including when
// the OS key is temporarily unavailable or an existing file cannot be read.
export class EncryptedStore {
  constructor(file, crypto, validate) {
    this.file = file;
    this.crypto = crypto;
    this.validate = validate;
    this.pending = Promise.resolve();
  }
  async available() {
    if (!(await this.crypto.isAsyncEncryptionAvailable()))
      throw new Error(t('Windows 암호화 저장소를 사용할 수 없어요. 비밀번호를 저장하지 않았습니다.'));
  }
  async load() {
    await this.available();
    let bytes;
    try {
      bytes = await readFile(this.file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      if (bytes.length > 32 * 1024 * 1024) throw new Error('Too large');
      const { result } = await this.crypto.decryptStringAsync(bytes);
      const value = JSON.parse(result);
      if (!this.validate(value)) throw new Error('Invalid data');
      return value;
    } catch {
      throw new Error(t('암호화된 저장소를 읽지 못했어요. 기존 파일은 그대로 보존했습니다.'));
    }
  }
  save(value) {
    if (!this.validate(value)) return Promise.reject(new Error(t('저장 데이터가 올바르지 않아요.')));
    const json = JSON.stringify(value);
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        await this.available();
        const encrypted = await this.crypto.encryptStringAsync(json);
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(this.file + '.tmp', encrypted, { mode: 0o600 });
        await rename(this.file + '.tmp', this.file);
      });
    this.pending = operation;
    return operation;
  }
  flush() {
    return this.pending;
  }
}
