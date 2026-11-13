import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';
import { assertContained, assertNoLinkedParents, collectFiles, exists, pathsForRelease, sha256File, verifyPackage } from './windows-release.mjs';
import { powershellJson } from './windows-signatures.mjs';
import { extractChecked, verifyArtifactInputs } from './verify-windows-artifacts.mjs';

const execute = promisify(execFile);

export function protectedProfileProcesses(processes, directory) {
  const root = win32.resolve(directory).toLowerCase();
  return processes.filter(record => {
    if (record.name?.toLowerCase() === 'mosaic.exe') return true;
    if (!['chrome.exe', 'msedge.exe'].includes(record.name?.toLowerCase())) return false;
    const match = /(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|(\S+)))/i.exec(record.commandLine || '');
    const profile = match && (match[1] || match[2] || match[3]);
    if (!profile || !win32.isAbsolute(profile)) return false;
    const relativePath = win32.relative(root, win32.resolve(profile).toLowerCase());
    return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('..\\') && !win32.isAbsolute(relativePath));
  }).map(({ name, processId }) => ({ name, processId }));
}

export function normalizeInstallState(state, guid) {
  const identity = value => typeof value === 'string' ? value.replace(/^\{|\}$/g, '').toLowerCase() : null;
  const samePath = (a, b) => win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase();
  return { ...state, installs: state.installs.map(record => {
    if (record.installLocation || record.source !== 'uninstall' || identity(record.id) !== identity(guid)) return record;
    const locations = state.installs.filter(item => item.source === 'install' && item.hive === record.hive && identity(item.id) === identity(guid) && typeof item.installLocation === 'string' && win32.isAbsolute(item.installLocation));
    const executable = /^"([^"]+)"(?:\s|$)/.exec(record.uninstallString || '')?.[1];
    if (locations.length !== 1 || !executable || !win32.isAbsolute(executable) || win32.basename(executable).toLowerCase() !== 'uninstall mosaic.exe' || !samePath(win32.dirname(executable), locations[0].installLocation)) return record;
    // NSIS stores InstallLocation in its app key, separate from Uninstall.
    return { ...record, installLocation: locations[0].installLocation };
  }) };
}

export function assertSmokePreflight(state, destination) {
  const target = resolve(destination).toLowerCase();
  if (!Array.isArray(state.installs) || !Array.isArray(state.processes) || !Array.isArray(state.shortcuts)) {
    throw new Error('Cannot verify existing installation state');
  }
  if (state.installs.some(item => !item.installLocation || resolve(item.installLocation).toLowerCase() !== target)) {
    throw new Error('An existing installation must be protected; use a clean Windows account or VM for smoke testing');
  }
  if (state.processes.length) throw new Error('Mosaic or a browser using its profile is running; installer smoke will not close or kill it');
  if (state.shortcuts.length) throw new Error('Existing Mosaic shortcut detected; installer smoke will not overwrite it');
  if (state.cacheDirectories?.length) throw new Error('Existing Mosaic installer cache must be protected; use a clean Windows account');
}

export async function inspectWindowsInstallState(root) {
  const config = JSON.parse(await readFile(join(root, 'installer/electron-builder.json'), 'utf8'));
  const script = `
$uninstallRoots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
$installs=@(foreach($base in $uninstallRoots){if(Test-Path -LiteralPath $base){foreach($key in Get-ChildItem -LiteralPath $base){$p=Get-ItemProperty -LiteralPath $key.PSPath;if($p.DisplayName -match '^Mosaic(?:\\s|$)'){[pscustomobject]@{hive=$base.Substring(0,4);source='uninstall';id=$key.PSChildName;uninstallString=$p.UninstallString;installLocation=$p.InstallLocation;version=$p.DisplayVersion}}}}})
foreach($hive in @('HKCU','HKLM')){$key=$hive+':\\Software\\'+$env:MOSAIC_INSTALLER_GUID;if(Test-Path -LiteralPath $key){$p=Get-ItemProperty -LiteralPath $key;$installs+=@([pscustomobject]@{hive=$hive;source='install';id=$env:MOSAIC_INSTALLER_GUID;installLocation=$p.InstallLocation;version=$null})}}
$processes=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('Mosaic.exe','chrome.exe','msedge.exe')} | ForEach-Object {[pscustomobject]@{name=$_.Name;processId=$_.ProcessId;commandLine=$_.CommandLine}})
$shell=New-Object -ComObject WScript.Shell
$shortcutRoots=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms'))
$shortcuts=@(for($i=0;$i -lt $shortcutRoots.Count;$i++){$base=$shortcutRoots[$i];if($base -and (Test-Path -LiteralPath $base)){$recursive=$i -ge 2;foreach($item in Get-ChildItem -LiteralPath $base -Filter 'Mosaic.lnk' -File -Recurse:$recursive -ErrorAction Stop){[pscustomobject]@{path=$item.FullName;target=$shell.CreateShortcut($item.FullName).TargetPath}}}})
$caches=@(foreach($name in @('mosaic-browser-updater','mosaic-ui-updater')){$p=Join-Path $env:LOCALAPPDATA $name;if(Test-Path -LiteralPath $p){$p}})
[pscustomobject]@{installs=@($installs);processes=@($processes);shortcuts=@($shortcuts);cacheDirectories=@($caches)}|ConvertTo-Json -Depth 5 -Compress`;
  const state = await powershellJson(script, { MOSAIC_INSTALLER_GUID: config.nsis.guid });
  state.processes = protectedProfileProcesses(state.processes, join(process.env.APPDATA, 'MosaicBrowser'));
  return normalizeInstallState(state, config.nsis.guid);
}

function assertOwnedInstall(state, destination) {
  const target = resolve(destination).toLowerCase();
  if (state.processes.length || state.installs.some(item => item.hive === 'HKLM' || !item.installLocation || resolve(item.installLocation).toLowerCase() !== target)) {
    throw new Error('Installation state changed outside the isolated destination; refusing further changes');
  }
  if (state.shortcuts.some(item => resolve(item.target).toLowerCase() !== join(target, 'Mosaic.exe').toLowerCase())) {
    throw new Error('A shortcut now targets another installation; refusing further changes');
  }
}

async function dataFingerprint(directory) {
  const rows = [];
  async function visit(path) {
    if (!await exists(path)) return;
    const info = await lstat(path);
    if (info.isSymbolicLink()) { rows.push([relative(directory, path), 'link']); return; }
    if (info.isFile()) rows.push([relative(directory, path), info.size, info.mtimeMs]);
    else if (info.isDirectory()) for (const child of (await readdir(path)).sort()) await visit(join(path, child));
  }
  await visit(directory);
  return { files: rows.length, fingerprint: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}

async function runInstaller(file, destination) {
  // NSIS requires /D last and unquoted, including when the path contains spaces.
  await execute(file, ['/S', '/currentuser', `/D=${destination}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 180000, maxBuffer: 1024 * 1024 });
}

async function verifyInstalledPayload(destination, packageDirectory) {
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'PACKAGE-MANIFEST.json'), 'utf8'));
  for (const file of manifest.files) {
    const path = assertContained(destination, join(destination, file.path));
    if ((await stat(path)).size !== file.bytes || await sha256File(path) !== file.sha256) {
      throw new Error('Installed file differs from packaged payload: ' + file.path);
    }
  }
}

export async function uninstallOwned(root, destination) {
  assertOwnedInstall(await inspectWindowsInstallState(root), destination);
  await execute(join(destination, 'Uninstall Mosaic.exe'), ['/S', '/currentuser'], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (!await exists(join(destination, 'Mosaic.exe'))) {
      const state = await inspectWindowsInstallState(root);
      if (!state.installs.length && !state.shortcuts.length) return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Isolated uninstall did not remove application files/registration/shortcuts within 60 seconds');
}

async function buildUpgradeBaseline(root, workspace, currentVersion) {
  const oldVersion = '0.6.2';
  const old = pathsForRelease(root, oldVersion).output;
  if (currentVersion === oldVersion || !await exists(join(old, 'Mosaic.exe'))) return null;
  await assertNoLinkedParents(root, old);
  await collectFiles(old);
  const metadata = JSON.parse(await readFile(join(old, 'resources/app/package.json'), 'utf8'));
  if (metadata.version !== oldVersion) throw new Error('Previous runtime version does not match its directory');
  const originalHash = await sha256File(join(old, 'Mosaic.exe'));
  const config = JSON.parse(await readFile(join(root, 'installer/electron-builder.json'), 'utf8'));
  const output = join(workspace, 'baseline');
  config.directories.output = output;
  config.extraMetadata = { version: oldVersion, name: 'mosaic-browser', productName: 'Mosaic' };
  await build({ projectDir: root, prepackaged: old, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config, publish: 'never' });
  if (await sha256File(join(old, 'Mosaic.exe')) !== originalHash) throw new Error('Previous runtime unexpectedly changed during installer generation');
  return { version: oldVersion, file: join(output, `Mosaic-${oldVersion}-win-x64-setup.exe`), runtimeUnchanged: true };
}

export async function recordInstallerPreflight(root) {
  const { version, paths, manifest, packageManifestSha256 } = await verifyArtifactInputs(root);
  await assertNoLinkedParents(root, paths.smoke);
  const report = { schemaVersion: 1, version, passed: false, status: 'not-run', executed: false,
    packageManifestSha256, artifacts: manifest.artifacts.map(({ kind, file, sha256 }) => ({ kind, file, sha256 })),
    steps: [], reason: 'Preflight only. No installer, application, or uninstaller was executed.', completedAt: new Date().toISOString() };
  try { assertSmokePreflight(await inspectWindowsInstallState(root), join(paths.release, '.installer-smoke/not-run/Mosaic')); }
  catch (error) { report.status = 'blocked'; report.reason = error.message; }
  await writeFile(paths.smoke, JSON.stringify(report, null, 2) + '\n');
  return report;
}

export async function smokeInstaller(root) {
  const { version, paths, manifest: artifacts, packageManifestSha256 } = await verifyArtifactInputs(root);
  await assertNoLinkedParents(root, paths.smoke);
  const parent = join(paths.release, '.installer-smoke');
  await assertNoLinkedParents(root, parent);
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, 'run-'));
  const destination = validateSmokeDestination(join(workspace, 'Mosaic'), workspace);
  const before = await inspectWindowsInstallState(root);
  try { assertSmokePreflight(before, destination); }
  catch (error) {
    await writeFile(paths.smoke, JSON.stringify({ schemaVersion: 1, version, passed: false,
      status: 'blocked', executed: false, packageManifestSha256,
      artifacts: artifacts.artifacts.map(({ kind, file, sha256 }) => ({ kind, file, sha256 })),
      steps: [], reason: error.message, completedAt: new Date().toISOString(),
    }, null, 2) + '\n');
    throw error;
  }
  const realData = join(process.env.APPDATA, 'MosaicBrowser');
  const userDataBefore = await dataFingerprint(realData);
  const profile = join(workspace, 'profile', 'MosaicBrowser');
  await mkdir(profile, { recursive: true });
  const sentinel = join(profile, 'installer-preservation.txt');
  await writeFile(sentinel, 'Preserve this isolated profile through upgrade and uninstall.');
  const report = { schemaVersion: 1, version, passed: false, status: 'running', executed: false, packageManifestSha256,
    artifacts: artifacts.artifacts.map(({ kind, file, sha256 }) => ({ kind, file, sha256 })),
    steps: [], workspace: relative(root, workspace).split(sep).join('/') };
  let installed = false;
  const cacheHashes = new Set([await sha256File(paths.installer)]);
  try {
    console.log('Extracting and verifying portable ZIP...');
    const portable = join(workspace, 'portable');
    await extractChecked(paths.portable, portable);
    await verifyPackage(portable);
    report.steps.push('portable-extracted-and-payload-hashes-verified');
    console.log('Extracting installer container...');
    const installerPayload = join(workspace, 'installer-extracted');
    await extractChecked(paths.installer, installerPayload);
    await verifyPackage(installerPayload);
    report.steps.push('installer-payload-extracted-and-hashes-verified');
    const baseline = await buildUpgradeBaseline(root, workspace, version);
    console.log('Installing into isolated destination...');
    report.executed = true;
    if (baseline) {
      cacheHashes.add(await sha256File(baseline.file));
      await runInstaller(baseline.file, destination);
      installed = true;
      const old = JSON.parse(await readFile(join(destination, 'resources/app/package.json'), 'utf8'));
      if (old.version !== baseline.version) throw new Error('Baseline installer did not install the previous version');
      report.upgradeFrom = baseline.version;
      report.previousRuntimeUnchanged = baseline.runtimeUnchanged;
      report.steps.push('previous-version-installed');
    } else {
      await runInstaller(paths.installer, destination);
      installed = true;
      report.upgradeFrom = version;
      report.limitation = 'Previous runtime was unavailable; upgrade code path tested as same-version reinstall.';
      report.steps.push('fresh-current-version-installed');
    }
    assertOwnedInstall(await inspectWindowsInstallState(root), destination);
    console.log('Upgrading/reinstalling and verifying installed payload...');
    await runInstaller(paths.installer, destination);
    await verifyInstalledPayload(destination, paths.output);
    const afterInstall = await inspectWindowsInstallState(root);
    assertOwnedInstall(afterInstall, destination);
    if (!afterInstall.installs.some(item => item.hive === 'HKCU' && item.version === version)) throw new Error('Per-user uninstall registration/version missing');
    if (await readFile(sentinel, 'utf8') !== 'Preserve this isolated profile through upgrade and uninstall.') throw new Error('Upgrade changed isolated profile');
    report.steps.push('upgrade-payload-and-per-user-registration-verified', 'silent-install-did-not-start-app');
    console.log('Launching installed application with an isolated profile...');
    const { _electron } = await import('@playwright/test');
    const app = await _electron.launch({ executablePath: join(destination, 'Mosaic.exe'), args: [], env: { ...process.env, MOSAIC_USER_DATA: profile } });
    try {
      await app.firstWindow();
      const state = await app.evaluate(({ app, BrowserWindow }) => {
        BrowserWindow.getAllWindows().forEach(window => window.hide());
        return { version: app.getVersion(), userData: app.getPath('userData') };
      });
      if (state.version !== version || resolve(state.userData) !== resolve(profile)) throw new Error('Installed application did not use expected version/isolated profile');
    } finally { await app.close(); }
    report.steps.push('installed-application-launched-with-isolated-profile');
    console.log('Checking app-data deletion flag is rejected...');
    let deletionRejected = false;
    // _?= keeps NSIS in this process so its rejection exit code is observable.
    // Without it the bootstrap process exits before the temporary uninstaller.
    try { await execute(join(destination, 'Uninstall Mosaic.exe'), ['/S', '--delete-app-data', '/currentuser', `_?=${destination}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 60000 }); }
    catch (error) { deletionRejected = error.code === 1639; }
    if (!deletionRejected || !await exists(join(destination, 'Mosaic.exe'))) throw new Error('Uninstaller did not reject --delete-app-data safely');
    report.steps.push('delete-app-data-option-rejected');
    console.log('Uninstalling isolated application...');
    await uninstallOwned(root, destination);
    installed = false;
    if (await readFile(sentinel, 'utf8') !== 'Preserve this isolated profile through upgrade and uninstall.') throw new Error('Uninstall changed isolated profile');
    report.steps.push('uninstall-removed-app-registration-and-shortcuts', 'isolated-profile-preserved');
    const userDataAfter = await dataFingerprint(realData);
    if (JSON.stringify(userDataBefore) !== JSON.stringify(userDataAfter)) throw new Error('Real MosaicBrowser profile metadata changed during smoke test');
    report.realUserDataMetadataUnchanged = true;
    report.passed = true;
    report.status = 'passed';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    throw error;
  } finally {
    if (installed) {
      try { await uninstallOwned(root, destination); report.failureCleanup = 'uninstalled'; }
      catch { report.failureCleanup = 'left-in-place-to-protect-existing-state'; }
    }
    // NSIS caches its own installer in LOCALAPPDATA. Preflight proved these
    // directories absent; remove only the exact installer bytes created here.
    for (const name of ['mosaic-browser-updater', 'mosaic-ui-updater']) {
      const cache = join(process.env.LOCALAPPDATA, name);
      if (await exists(cache)) {
        await assertNoLinkedParents(process.env.LOCALAPPDATA, cache);
        const file = join(cache, 'installer.exe');
        if (await exists(file) && cacheHashes.has(await sha256File(file))) await rm(file);
        if ((await readdir(cache)).length === 0) await rmdir(cache);
      }
    }
    report.completedAt = new Date().toISOString();
    await writeFile(paths.smoke, JSON.stringify(report, null, 2) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--run', '--inspect', '--record-preflight'].includes(arg))) throw new Error('Usage: node scripts/smoke-installer.mjs [--inspect | --record-preflight | --run]');
  if (args.includes('--run')) {
    const result = await smokeInstaller(root);
    console.log('Installer smoke passed: ' + result.steps.join(', '));
  } else if (args.includes('--record-preflight')) {
    const report = await recordInstallerPreflight(root);
    console.log('Installer smoke not executed; preflight status: ' + report.status);
    console.log(report.reason);
  } else {
    const state = await inspectWindowsInstallState(root);
    console.log(JSON.stringify(state, null, 2));
    console.log('Read-only inspection complete. --run tests only after all existing state checks pass.');
  }
}

export function validateSmokeDestination(destination, workspace) {
  try { return assertContained(workspace, destination); }
  catch { throw new Error('Smoke destination must be strictly inside its isolated workspace'); }
}
