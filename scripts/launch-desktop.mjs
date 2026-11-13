import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsDiagnostics, explainWindowsFailure } from './windows-diagnostics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packaged = join(root, 'release', 'Mosaic-' + pkg.version + '-win-x64', 'Mosaic.exe');
const executable = existsSync(packaged)
  ? packaged
  : join(root, 'node_modules/electron/dist/electron.exe');
if (!existsSync(executable) || !existsSync(join(root, 'dist/index.html'))) {
  console.error('Build Mosaic first: cd mosaic && npm install && npm run build');
  process.exitCode = 1;
} else {
  try {
    const child = spawn(executable, existsSync(packaged) ? [] : [root], {
      cwd: root,
      stdio: 'inherit',
      // This is the user-facing desktop app; hiding its first window can leave
      // Chromium running in the background without a visible workspace.
      windowsHide: false,
    });
    child.on('error', async (error) => {
      console.error('Mosaic could not start: ' + error.message);
      try {
        console.error(explainWindowsFailure(await windowsDiagnostics(executable)));
      } catch {
        console.error('진단 명령: npm run diagnose');
      }
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    console.error('Mosaic could not start: ' + error.message);
    console.error(explainWindowsFailure(await windowsDiagnostics(executable)));
    process.exitCode = 1;
  }
}
