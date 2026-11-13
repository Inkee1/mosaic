import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWindowsPackage } from './windows-release.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--replace')) throw new Error('Usage: node scripts/package-win.mjs [--replace]');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 packaging requires Windows x64.');
// Electron 45 downloads its runtime on first use rather than npm postinstall.
// Packaging copies dist directly, so invoke the pinned package's installer first.
console.log('Preparing the pinned Electron runtime...');
await promisify(execFile)(process.execPath, [resolve(root, 'node_modules/electron/install.js')], { cwd: root, windowsHide: true, timeout: 240000, maxBuffer: 1024 * 1024 });
const { output } = await createWindowsPackage(root, { replace: args.includes('--replace') });
console.log('Windows runtime folder created: ' + output);
console.log('Unsigned package. Run the native suite, then npm run installer:win.');
