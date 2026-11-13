import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { windowsDiagnostics, explainWindowsFailure } from './windows-diagnostics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packaged = join(root, 'release', 'Mosaic-' + pkg.version + '-win-x64', 'Mosaic.exe');
const executable = existsSync(packaged)
  ? packaged
  : join(root, 'node_modules/electron/dist/electron.exe');
const report = await windowsDiagnostics(executable);
console.log(JSON.stringify({ executable, ...report }, null, 2));
if (report.smartAppControl === 1 && report.signature !== 'Valid')
  console.log('\n' + explainWindowsFailure(report));
else console.log('\n진단 완료. 실제 실행과 사이트 동작 검증은 별도로 진행합니다.');
