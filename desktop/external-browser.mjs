import { t } from '../shared/i18n.mjs';
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function chromeWebUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error(t('Chrome에서 열 수 없는 주소예요.'));
  let url;
  try { url = new URL(value); } catch { throw new Error(t('Chrome에서 열 수 없는 주소예요.')); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.length > 16384)
    throw new Error(t('Chrome에서 열 수 없는 주소예요.'));
  return url.href;
}

export function findChrome(env = process.env, exists = existsSync) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  return roots.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(exists);
}

export async function openInChrome(value, { env = process.env, exists = existsSync, launch = childProcess.spawn } = {}) {
  const url = chromeWebUrl(value);
  const executable = findChrome(env, exists);
  if (!executable) throw new Error(t('Chrome을 찾지 못했어요. Chrome을 설치한 뒤 다시 시도해 주세요.'));
  await new Promise((resolve, reject) => {
    // Keep the URL a single argument. No shell, profile import or remote-debugging flags.
    const child = launch(executable, [url], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', () => reject(new Error(t('Chrome을 열지 못했어요. 잠시 후 다시 시도해 주세요.'))));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
