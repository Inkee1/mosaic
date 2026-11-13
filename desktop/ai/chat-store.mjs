import { t } from '../../shared/i18n.mjs';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ACTIVE_STATUSES = new Set(['queued', 'running', 'stopping']);
const statuses = new Set([...ACTIVE_STATUSES, 'idle', 'completed', 'interrupted', 'error']);
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const text = (v, max) => typeof v === 'string' && v.length <= max;
export const emptyChatState = () => ({ version: 1, revision: 0, chats: [], maxConcurrent: 2 });

export function validChatState(value) {
  try {
    if (value?.version !== 1 || !Array.isArray(value.chats) || value.chats.length > 200 || value.maxConcurrent !== 2) return false;
    if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) return false;
    const ids = new Set();
    for (const chat of value.chats) {
      if (!id(chat.id) || ids.has(chat.id) || !id(chat.setId)) return false;
      ids.add(chat.id);
      if (!['claude', 'codex'].includes(chat.provider) || !text(chat.title, 120) || !chat.title.trim()) return false;
      if (!text(chat.model, 200) || !text(chat.effort, 40) || typeof chat.archived !== 'boolean' || !statuses.has(chat.status)) return false;
      if (!Array.isArray(chat.paneIds) || chat.paneIds.length > 32 || chat.paneIds.some((p) => !id(p)) || new Set(chat.paneIds).size !== chat.paneIds.length) return false;
      if (!text(chat.createdAt, 40) || !text(chat.updatedAt, 40)) return false;
      if (chat.sessionId !== undefined && !text(chat.sessionId, 300)) return false;
      if (!Array.isArray(chat.messages) || chat.messages.length > 500 || !Array.isArray(chat.events) || chat.events.length > 100) return false;
      for (const message of chat.messages) {
        if (!id(message.id) || !['user', 'assistant', 'system'].includes(message.role) || !text(message.content, 250000) || !text(message.createdAt, 40)) return false;
      }
      for (const event of chat.events) if (!id(event.id) || !text(event.type, 100) || !text(event.message, 1200) || !text(event.createdAt, 40)) return false;
    }
    return true;
  } catch { return false; }
}

/** History is independent of browser workspace saves. Broken files are never
 * silently replaced with empty chats; a valid previous snapshot can recover. */
export class ChatStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'ai-chats.json');
    this.pending = Promise.resolve();
    this.blocked = false;
  }
  load() {
    let found = false;
    for (const file of [this.file, this.file + '.bak']) {
      if (!existsSync(file)) continue;
      found = true;
      try {
        if (statSync(file).size > 32 * 1024 * 1024) throw new Error('Too large');
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (!validChatState(value)) continue;
        if (file.endsWith('.bak')) value.recoveryNotice = t('이전 AI 대화 저장본에서 복구했어요.');
        for (const chat of value.chats) if (ACTIVE_STATUSES.has(chat.status)) {
          chat.status = 'interrupted';
          chat.error = t('앱이 종료되어 작업이 중단됐어요. 다음 메시지로 이어갈 수 있어요.');
        }
        return value;
      } catch {}
    }
    if (found) {
      this.blocked = true;
      return { ...emptyChatState(), recoveryNotice: t('AI 대화 저장 파일을 읽지 못했어요. 원본을 보존했으며 덮어쓰지 않습니다. ai-chats.json과 .bak 파일을 확인해 주세요.') };
    }
    return emptyChatState();
  }
  save(value) {
    if (this.blocked) return Promise.reject(new Error(t('AI 대화 저장소 복구가 필요해요. 기존 기록은 보존했습니다.')));
    if (!validChatState(value)) return Promise.reject(new Error(t('AI 대화 데이터가 올바르지 않아요.')));
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 32 * 1024 * 1024) return Promise.reject(new Error(t('AI 대화 저장 공간이 가득 찼어요. 기록을 정리해 주세요.')));
    const operation = this.pending.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      await writeFile(this.file + '.tmp', json, { encoding: 'utf8', mode: 0o600 });
      if (existsSync(this.file)) {
        try {
          if (validChatState(JSON.parse(readFileSync(this.file, 'utf8')))) await copyFile(this.file, this.file + '.bak');
        } catch {}
      }
      await rename(this.file + '.tmp', this.file);
    });
    this.pending = operation;
    return operation;
  }
  flush() { return this.pending; }
}
