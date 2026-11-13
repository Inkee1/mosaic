import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createWindowsPackage, pathsForRelease, verifyPackage, writeArtifactManifest,
} from '../../scripts/windows-release.mjs';
import { assertSmokePreflight, normalizeInstallState, validateSmokeDestination } from '../../scripts/smoke-installer.mjs';
import * as installerSmoke from '../../scripts/smoke-installer.mjs';
import { collectSigningTargets, validateCertificateInput } from '../../scripts/windows-signatures.mjs';
import { validateArchivePaths, verifyArtifactInputs } from '../../scripts/verify-windows-artifacts.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mosaic-packaging-test-'));
  const files = {
    'package.json': JSON.stringify({ version: '1.2.3', devDependencies: { electron: '45.2.3' } }),
    'release.config.json': JSON.stringify({ repository: null, licenseStatus: 'pending' }),
    'README.md': 'Mosaic user instructions',
    'dist/index.html': '<html>Mosaic</html>',
    'dist/assets/app.js': 'export const app = true;',
    'shared/validation.mjs': 'export const valid = true;',
    'desktop/main.mjs': 'import "./app-services.mjs";',
    'desktop/preload.cjs': 'module.exports = {};',
    'desktop/app-services.mjs': 'export const settings = {};',
    'desktop/ai/providers.mjs': 'export const providers = [];',
    'desktop/chrome/runtime.mjs': 'export const runtime = true;',
    'desktop/tests/private.test.mjs': 'never ship tests',
    'desktop/.env': 'never ship environment',
    'scripts/mcp.mjs': 'export const bridge = true;',
    'docs/distribution/setup.md': 'Install and use Mosaic',
    'docs/superpowers/private.md': 'never ship development ledgers',
    'docs/windows-runtime.md': 'never ship machine-specific history',
    'node_modules/electron/dist/electron.exe': 'fixture PE',
    'node_modules/electron/dist/LICENSE': 'Electron license',
    'node_modules/electron/dist/LICENSES.chromium.html': 'Chromium notices',
    'node_modules/electron/dist/resources/default_app.asar': 'default app',
    'node_modules/react/LICENSE': 'React license',
    'node_modules/react-dom/LICENSE': 'React DOM license',
    'node_modules/lucide-react/LICENSE': 'Lucide license',
    'installer/NSIS-LICENSE.txt': 'NSIS original license',
    'installer/ELECTRON-BUILDER-LICENSE.txt': 'Builder original license',
    'installer/STDUTILS-LGPL.txt': 'LGPL original license',
    'installer/STDUTILS-LGPL-CLARIFICATION.txt': 'StdUtils linking clarification',
    'installer/7ZIP-LICENSE.txt': '7-Zip original license',
    'installer/7ZIP-COPYING.txt': '7-Zip copying terms',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test('runtime packaging includes app services, configuration and only distribution documents', async () => {
  const root = await fixture();
  const { output } = await createWindowsPackage(root);
  assert.equal(await readFile(join(output, 'resources/app/desktop/app-services.mjs'), 'utf8'), 'export const settings = {};');
  assert.equal(JSON.parse(await readFile(join(output, 'resources/app/release.config.json'), 'utf8')).licenseStatus, 'pending');
  assert.equal(await readFile(join(output, 'docs/distribution/setup.md'), 'utf8'), 'Install and use Mosaic');
  for (const omitted of ['docs/superpowers', 'docs/windows-runtime.md', 'resources/app/desktop/tests', 'resources/app/desktop/.env', 'resources/default_app.asar']) {
    await assert.rejects(lstat(join(output, omitted)), { code: 'ENOENT' });
  }
  const info = JSON.parse(await readFile(join(output, 'BUILD-INFO.json'), 'utf8'));
  assert.equal(info.userDataDirectory, 'MosaicBrowser');
  assert.equal(info.nativeRuntimeVerified, false);
  assert.equal(info.runtimeSha256, createHash('sha256').update('fixture PE').digest('hex'));
  assert.equal((await verifyPackage(output)).version, '1.2.3');
  assert.equal(await readFile(join(output, 'THIRD-PARTY-NOTICES/NSIS-LICENSE.txt'), 'utf8'), 'NSIS original license');
});

test('packaging ships only validated public ingestion configuration and rejects management credentials', async () => {
  const root = await fixture();
  const config = { host: 'https://us.i.posthog.com', projectToken: 'phc_' + 'x'.repeat(40) };
  await writeFile(join(root, 'telemetry.config.json'), JSON.stringify(config));
  const { output } = await createWindowsPackage(root);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'resources/app/telemetry.config.json'), 'utf8')), config);
  await writeFile(join(root, 'telemetry.config.json'), JSON.stringify({ ...config, projectToken: 'phx_' + 'x'.repeat(40) }));
  await assert.rejects(createWindowsPackage(root, { replace: true }), /telemetry|집계|configuration/i);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'resources/app/telemetry.config.json'), 'utf8')), config);
});

test('repackaging refuses an existing release unless explicitly replacing that version', async () => {
  const root = await fixture();
  const { output } = await createWindowsPackage(root);
  await writeFile(join(output, 'preserve-existing.txt'), 'keep');
  await assert.rejects(createWindowsPackage(root), /already exists/i);
  assert.equal(await readFile(join(output, 'preserve-existing.txt'), 'utf8'), 'keep');
  const old = join(root, 'release/Mosaic-0.6.2-win-x64/keep.txt');
  await mkdir(join(old, '..'), { recursive: true });
  await writeFile(old, 'older release');
  await createWindowsPackage(root, { replace: true });
  await assert.rejects(lstat(join(output, 'preserve-existing.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(old, 'utf8'), 'older release');
});

test('invalid versions cannot escape or name a release directory', () => {
  for (const version of ['../escape', '1.2', '1.2.3/other', '1.2.3\n', '', '01.2.3']) {
    assert.throws(() => pathsForRelease('C:/workspace', version), /version/i);
  }
});

test('packaging rejects linked runtime sources and preserves an existing release on failure', async () => {
  const root = await fixture();
  const { output } = await createWindowsPackage(root);
  const external = await mkdtemp(join(tmpdir(), 'mosaic-outside-package-'));
  await writeFile(join(external, 'private.txt'), 'must stay outside');
  await symlink(external, join(root, 'dist/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createWindowsPackage(root, { replace: true }), /symbolic|linked|reparse/i);
  assert.equal(await readFile(join(output, 'Mosaic.exe'), 'utf8'), 'fixture PE');
});

test('package verification rejects added files and modified bytes before installer assembly', async () => {
  const root = await fixture();
  const { output } = await createWindowsPackage(root);
  await writeFile(join(output, 'resources/app/desktop/main.mjs'), 'modified');
  await assert.rejects(verifyPackage(output), /hash|changed|mismatch/i);
  const second = await fixture();
  const other = (await createWindowsPackage(second)).output;
  await writeFile(join(other, 'credentials.json'), '{}');
  await assert.rejects(verifyPackage(other), /unexpected|manifest/i);
});

test('artifact manifest hashes the shipped installer and portable bytes', async () => {
  const root = await fixture();
  await createWindowsPackage(root);
  const paths = pathsForRelease(root, '1.2.3');
  await mkdir(paths.release, { recursive: true });
  await writeFile(paths.installer, 'installer bytes');
  await writeFile(paths.portable, 'portable bytes');
  const manifest = await writeArtifactManifest(root, '1.2.3');
  assert.deepEqual(manifest.artifacts.map(item => item.kind), ['installer', 'portable']);
  assert.equal(manifest.artifacts[0].sha256, createHash('sha256').update('installer bytes').digest('hex'));
  assert.equal(manifest.artifacts[1].bytes, 14);
  assert.equal(manifest.packageManifestSha256, createHash('sha256').update(await readFile(join(paths.output, 'PACKAGE-MANIFEST.json'))).digest('hex'));
  const sums = await readFile(paths.checksums, 'utf8');
  assert.match(sums, /  Mosaic-1\.2\.3-win-x64-setup\.exe\n/);
  assert.match(sums, /  Mosaic-1\.2\.3-win-x64-portable\.zip\n/);
});

test('installer smoke refuses real installs, running apps, and occupied shortcuts', () => {
  const clean = { installs: [], processes: [], shortcuts: [] };
  assert.doesNotThrow(() => assertSmokePreflight(clean, 'C:/isolated/app'));
  assert.throws(() => assertSmokePreflight({ ...clean, installs: [{ installLocation: 'C:/Users/user/AppData/Local/Programs/Mosaic' }] }, 'C:/isolated/app'), /existing installation/i);
  assert.throws(() => assertSmokePreflight({ ...clean, processes: [{ name: 'Mosaic.exe', processId: 12 }] }, 'C:/isolated/app'), /running/i);
  assert.throws(() => assertSmokePreflight({ ...clean, shortcuts: ['C:/Users/user/Desktop/Mosaic.lnk'] }, 'C:/isolated/app'), /shortcut/i);
});

test('installer smoke detects a live dedicated Chrome profile after Mosaic has closed', () => {
  assert.equal(typeof installerSmoke.protectedProfileProcesses, 'function');
  const directory = 'C:\\Users\\Test User\\AppData\\Roaming\\MosaicBrowser';
  for (const argument of [
    '"--user-data-dir=' + directory + '\\chrome-profiles\\example"',
    '--user-data-dir="' + directory + '\\chrome-profiles\\example"',
  ]) {
    const processes = installerSmoke.protectedProfileProcesses([
      { name: 'chrome.exe', processId: 42, commandLine: 'chrome.exe ' + argument },
    ], directory);
    assert.deepEqual(processes, [{ name: 'chrome.exe', processId: 42 }]);
    assert.throws(() => assertSmokePreflight({ installs: [], processes, shortcuts: [] }, 'C:/isolated/app'), /running/i);
  }
});

test('installer smoke ignores unrelated browser profiles and never exposes command lines', () => {
  assert.equal(typeof installerSmoke.protectedProfileProcesses, 'function');
  const directory = 'C:\\Users\\Test\\AppData\\Roaming\\MosaicBrowser';
  const processes = installerSmoke.protectedProfileProcesses([
    { name: 'chrome.exe', processId: 41, commandLine: 'chrome.exe --user-data-dir=' + directory + '-other' },
    { name: 'chrome.exe', processId: 42, commandLine: 'chrome.exe --user-data-dir=C:\\unrelated\\profile' },
    { name: 'Mosaic.exe', processId: 43, commandLine: 'Mosaic.exe private arguments' },
    { name: 'msedge.exe', processId: 44, commandLine: 'msedge.exe --user-data-dir=' + directory.toLowerCase() + '\\chrome-profiles\\example' },
  ], directory);
  assert.deepEqual(processes, [{ name: 'Mosaic.exe', processId: 43 }, { name: 'msedge.exe', processId: 44 }]);
});

test('NSIS uninstall records use the matching app registry path when InstallLocation is absent', () => {
  const guid = 'caea9f6a-a946-5bfd-8929-50d16b3c7d3d';
  const directory = 'C:\\isolated\\Mosaic';
  const registration = { hive: 'HKCU', source: 'uninstall', id: guid, installLocation: null, version: '0.6.2', uninstallString: '"' + directory + '\\Uninstall Mosaic.exe" /currentuser' };
  const location = { hive: 'HKCU', source: 'install', id: guid, installLocation: directory, version: null };
  const state = { installs: [registration, location], processes: [], shortcuts: [], cacheDirectories: [] };
  const normalized = normalizeInstallState(state, guid);
  assert.equal(normalized.installs[0].installLocation, directory);
  assert.equal(normalized.installs[0].version, '0.6.2');
  assert.equal(registration.installLocation, null);
  assert.doesNotThrow(() => assertSmokePreflight(normalized, directory));
});

test('registry path fallback cannot adopt another identity, hive, or uninstaller target', () => {
  const guid = 'caea9f6a-a946-5bfd-8929-50d16b3c7d3d';
  const directory = 'C:\\isolated\\Mosaic';
  const registration = { hive: 'HKCU', source: 'uninstall', id: guid, installLocation: null, uninstallString: '"' + directory + '\\Uninstall Mosaic.exe" /currentuser' };
  const location = { hive: 'HKCU', source: 'install', id: guid, installLocation: directory };
  for (const [record, stored] of [
    [{ ...registration, id: 'another-product' }, location],
    [registration, { ...location, hive: 'HKLM' }],
    [{ ...registration, uninstallString: '"C:\\unrelated\\Uninstall Mosaic.exe"' }, location],
    [{ ...registration, uninstallString: '"' + directory + '\\Different.exe"' }, location],
  ]) {
    const state = normalizeInstallState({ installs: [record, stored], processes: [], shortcuts: [], cacheDirectories: [] }, guid);
    assert.equal(state.installs[0].installLocation, null);
    assert.throws(() => assertSmokePreflight(state, directory), /existing installation/i);
  }
});

test('installer smoke destination is strictly within its isolated workspace', () => {
  const base = join(tmpdir(), 'mosaic-installer-smoke-test');
  assert.equal(validateSmokeDestination(join(base, 'app'), base), join(base, 'app'));
  for (const path of [base, join(base, '..'), base + '-other/app', join(base, '../MosaicBrowser')]) {
    assert.throws(() => validateSmokeDestination(path, base), /isolated|destination/i);
  }
});

test('signing preparation includes shipped executables and installer, but never the portable archive', async () => {
  const root = await fixture();
  const paths = await createWindowsPackage(root);
  await writeFile(join(paths.output, 'runtime.dll'), 'library');
  await writeFile(paths.installer, 'installer');
  await writeFile(paths.portable, 'zip');
  const targets = await collectSigningTargets(root, '1.2.3');
  assert.deepEqual(targets.map(item => item.kind), ['runtime', 'runtime', 'installer']);
  assert.ok(targets.some(item => item.file === paths.installer));
  assert.ok(!targets.some(item => item.file === paths.portable));
});

test('signing rejects missing or shell-shaped certificate identifiers before calling Windows', () => {
  for (const value of [undefined, '', 'a'.repeat(39), 'z'.repeat(40), 'a'.repeat(40) + '; whoami']) {
    assert.throws(() => validateCertificateInput(value), /certificate|thumbprint/i);
  }
  assert.equal(validateCertificateInput('ab'.repeat(20)), 'AB'.repeat(20));
});

test('packaging includes the explicitly approved license without replacing Electron notices', async () => {
  const root = await fixture();
  await writeFile(join(root, 'release.config.json'), JSON.stringify({ licenseStatus: 'approved', licenseFile: 'LICENSE.md' }));
  await writeFile(join(root, 'LICENSE.md'), 'Chosen application license');
  const { output } = await createWindowsPackage(root);
  assert.equal(await readFile(join(output, 'MOSAIC-LICENSE.txt'), 'utf8'), 'Chosen application license');
  assert.equal(await readFile(join(output, 'LICENSE'), 'utf8'), 'Electron license');
});

test('archive verification requires both exact artifact identities and the matching runtime manifest', async () => {
  const root = await fixture();
  const paths = await createWindowsPackage(root);
  await writeFile(paths.installer, 'installer bytes');
  await writeFile(paths.portable, 'portable bytes');
  const manifest = await writeArtifactManifest(root, '1.2.3');
  await writeFile(paths.artifacts, JSON.stringify({ ...manifest, artifacts: [] }));
  await assert.rejects(verifyArtifactInputs(root), /artifact/i);
  await writeFile(paths.artifacts, JSON.stringify({ ...manifest, packageManifestSha256: '0'.repeat(64) }));
  await assert.rejects(verifyArtifactInputs(root), /runtime|manifest/i);
  await writeFile(paths.artifacts, JSON.stringify(manifest));
  await writeFile(paths.portable, 'changed archive');
  await assert.rejects(verifyArtifactInputs(root), /hash|changed|mismatch/i);
});

test('archive extraction refuses traversal and absolute entry names before writing files', () => {
  for (const path of ['../private', 'a/../../private', 'a\\..\\private', 'C:/private', '\\\\server\\share', '/root/file']) {
    assert.throws(() => validateArchivePaths([path]), /unsafe/i);
  }
  assert.doesNotThrow(() => validateArchivePaths(['resources/app/desktop/main.mjs', 'Mosaic.exe']));
});
