import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const address = 'http://127.0.0.1:4317';

async function isMosaicRunning() {
  let response;
  try {
    response = await fetch(address, { signal: AbortSignal.timeout(1500) });
  } catch {
    return false;
  }
  const html = await response.text();
  if (!response.ok || !html.includes('<title>Mosaic'))
    throw new Error(
      'Port 4317 is in use by another app. Close that app or run Vite on a different port.',
    );
  return true;
}

try {
  if (!(await isMosaicRunning())) {
    const runtime = resolve(project, '.runtime');
    await mkdir(runtime, { recursive: true });
    const out = openSync(resolve(runtime, 'vite.stdout.log'), 'a');
    const err = openSync(resolve(runtime, 'vite.stderr.log'), 'a');
    const process = spawn(
      globalThis.process.execPath,
      [
        resolve(project, 'node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        '4317',
        '--strictPort',
      ],
      {
        cwd: project,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', out, err],
      },
    );
    process.on('error', (error) => {
      console.error(error.message);
      globalThis.process.exitCode = 1;
    });
    if (process.pid) await writeFile(resolve(runtime, 'vite.pid'), String(process.pid));
    process.unref();
    closeSync(out);
    closeSync(err);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await isMosaicRunning()) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Mosaic did not start. See mosaic/.runtime/vite.stderr.log.');
  }
  console.log('Mosaic UI is ready: ' + address);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
