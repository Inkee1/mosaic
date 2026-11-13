import { t } from '../shared/i18n.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, rename, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validState } from '../shared/validation.mjs';

export class WorkspaceStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'workspace.json');
    this.pending = Promise.resolve();
    this.recovered = false;
  }
  load() {
    for (const file of [this.file, this.file + '.bak']) {
      try {
        const state = JSON.parse(readFileSync(file, 'utf8'));
        if (validState(state)) {
          this.recovered = file.endsWith('.bak');
          return state;
        }
      } catch {}
    }
    return null;
  }
  save(value) {
    if (!validState(value))
      return Promise.reject(new Error(t('작업 공간 데이터가 올바르지 않아 저장하지 않았어요.')));
    const json = JSON.stringify(value, null, 2);
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true });
        await writeFile(this.file + '.tmp', json, { encoding: 'utf8', mode: 0o600 });
        if (existsSync(this.file)) {
          try {
            if (validState(JSON.parse(readFileSync(this.file, 'utf8'))))
              await copyFile(this.file, this.file + '.bak');
          } catch {}
        }
        await rename(this.file + '.tmp', this.file);
      });
    this.pending = operation;
    return operation;
  }
  async flush() {
    await this.pending;
  }
}
