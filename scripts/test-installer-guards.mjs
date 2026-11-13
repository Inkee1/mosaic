import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMakeNsisPath } from 'app-builder-lib/out/toolsets/windows.js';
import { spawnAndWriteWithOutput } from 'builder-util';
import { nsisTemplatesDir } from 'app-builder-lib/out/targets/nsis/nsisUtil.js';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = join(root, 'release/.installer-smoke');
await mkdir(parent, { recursive: true });
const workspace = await mkdtemp(join(parent, 'path-guards-'));
const profile = join(workspace, 'User');
const roaming = join(profile, 'AppData/Roaming');
const local = join(profile, 'AppData/Local');
const data = join(roaming, 'MosaicBrowser');
await mkdir(data, { recursive: true });
await mkdir(local, { recursive: true });
const sentinel = join(data, 'preserved.txt');
await writeFile(sentinel, 'Never delete this fixture.');
const linked = join(workspace, 'linked');
await symlink(data, linked, 'junction');
const executable = join(workspace, 'guard.exe');
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const diagnostic = join(workspace, 'guard-diagnostic.txt');
const guardedSource = (await readFile(join(root, 'installer/path-guards.nsh'), 'utf8')).replace('  SetErrorLevel 1639',
  `  FileOpen $R0 "${quote(diagnostic)}" w\n  FileWrite $R0 "INSTDIR=$INSTDIR | 2=$2 | 3=$3 | 4=$4 | 5=$5 | 6=$6 | 7=$7 | 8=$8 | 9=$9"\n  FileClose $R0\n  SetErrorLevel 1639`);
const instrumentedGuard = join(workspace, 'path-guards.nsh');
await writeFile(instrumentedGuard, guardedSource);
const script = `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${quote(executable)}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "${quote(instrumentedGuard)}"
Function .onInit
  !insertmacro mosaicValidateInstallDirectory "${quote(roaming)}" "${quote(local)}" "${quote(profile)}"
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`;
const config = JSON.parse(await readFile(join(root, 'installer/electron-builder.json'), 'utf8'));
const nsis = await getMakeNsisPath(config.toolsets?.nsis);
await spawnAndWriteWithOutput(nsis.path, ['-INPUTCHARSET', 'UTF8', '-'], script, { env: { ...process.env, ...nsis.env }, cwd: nsisTemplatesDir });
const rejected = [data, join(data, 'profiles/Mosaic'), roaming, join(profile, 'AppData'), local, profile,
  workspace, join(workspace, '..'), join(data, '..', 'MosaicBrowser'), data.toLowerCase(), join(linked, 'Mosaic'),
  parse(workspace).root, '\\\\mosaic-guard-invalid\\share\\'];
for (const target of rejected) {
  let code = 0;
  try { await execute(executable, ['/S', `/D=${target}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 15000 }); }
  catch (error) { code = error.code; }
  assert.equal(code, 1639, `Guard must reject isolated protected target: ${target}`);
  assert.equal(await readFile(sentinel, 'utf8'), 'Never delete this fixture.');
}
for (const target of [join(local, 'Programs/Mosaic'), join(workspace, 'safe/Mosaic'), join(roaming, 'MosaicBrowser-other/Mosaic')]) {
  try { await execute(executable, ['/S', `/D=${target}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 15000 }); }
  catch (error) { throw new Error('Safe fixture rejected: ' + await readFile(diagnostic, 'utf8'), { cause: error }); }
}
console.log(`Native NSIS path guards passed: ${rejected.length} unsafe paths rejected, 3 dedicated app paths allowed; fixture preserved.`);
