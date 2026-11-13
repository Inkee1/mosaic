import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateTelemetryConfig } from '../desktop/usage-telemetry.mjs';

export function assertContained(parent, candidate) {
  const target = resolve(candidate);
  const local = relative(resolve(parent), target);
  if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) {
    throw new Error('Destination must remain strictly inside its designated directory');
  }
  return target;
}

export function pathsForRelease(root, version) {
  if (typeof version !== 'string' || version.length > 80 || version !== version.trim() ||
      !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version)) {
    throw new Error('Release version must be a safe three-part semantic version');
  }
  const release = join(resolve(root), 'release');
  const name = `Mosaic-${version}-win-x64`;
  return {
    release, name,
    output: assertContained(release, join(release, name)),
    installer: join(release, `${name}-setup.exe`),
    portable: join(release, `${name}-portable.zip`),
    artifacts: join(release, `${name}-artifacts.json`),
    checksums: join(release, `${name}-SHA256SUMS.txt`),
    signatures: join(release, `${name}-signatures.json`),
    smoke: join(release, `${name}-installer-smoke.json`),
  };
}

export async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function assertNoLinkedParents(parent, target) {
  const full = assertContained(parent, target);
  let current = resolve(parent);
  for (const segment of relative(current, full).split(sep)) {
    current = join(current, segment);
    if (await exists(current) && (await lstat(current)).isSymbolicLink()) {
      throw new Error('Linked or reparse paths are not allowed in release inputs or outputs');
    }
  }
}

export async function collectFiles(directory) {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Symbolic links are not allowed in packages');
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not allowed in packages');
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Unsupported special file in package');
  }
  return files;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyChecked(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Only regular, unlinked files may be packaged');
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyTree(source, destination, accept = () => true) {
  for (const path of await collectFiles(source)) {
    const local = relative(source, path);
    if (accept(local)) await copyChecked(path, join(destination, local));
  }
}

export async function writePackageManifest(output) {
  const files = [];
  for (const file of await collectFiles(output)) {
    const local = relative(output, file).split(sep).join('/');
    if (local === 'PACKAGE-MANIFEST.json') continue;
    files.push({ path: local, bytes: (await stat(file)).size, sha256: await sha256File(file) });
  }
  await writeFile(join(output, 'PACKAGE-MANIFEST.json'), JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n');
}

export async function verifyPackage(output) {
  const manifest = JSON.parse(await readFile(join(output, 'PACKAGE-MANIFEST.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid package manifest');
  const actual = new Set((await collectFiles(output)).map(file => relative(output, file).split(sep).join('/')));
  actual.delete('PACKAGE-MANIFEST.json');
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !actual.delete(entry.path)) throw new Error('Package manifest has missing or duplicate files');
    const path = assertContained(output, join(output, entry.path));
    if ((await stat(path)).size !== entry.bytes || await sha256File(path) !== entry.sha256) {
      throw new Error('Package file hash mismatch: ' + entry.path);
    }
  }
  if (actual.size) throw new Error('Unexpected files outside package manifest');
  const info = JSON.parse(await readFile(join(output, 'BUILD-INFO.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(output, 'resources/app/package.json'), 'utf8'));
  if (pkg.version !== info.version || info.platform !== 'win32-x64' || info.userDataDirectory !== 'MosaicBrowser') {
    throw new Error('Packaged version/platform/data-directory metadata mismatch');
  }
  return info;
}

export async function createWindowsPackage(projectRoot, { replace = false } = {}) {
  const root = resolve(projectRoot);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const paths = pathsForRelease(root, pkg.version);
  let telemetryConfig = {};
  const telemetryFile = join(root, 'telemetry.config.json');
  if (await exists(telemetryFile)) {
    await assertNoLinkedParents(root, telemetryFile);
    if ((await stat(telemetryFile)).size > 4096) throw new Error('Invalid telemetry configuration');
    telemetryConfig = validateTelemetryConfig(JSON.parse(await readFile(telemetryFile, 'utf8')));
    if (!telemetryConfig) throw new Error('Invalid telemetry configuration; only public ingestion credentials are allowed');
  }
  await assertNoLinkedParents(root, paths.output);
  if (await exists(paths.output) && !replace) throw new Error('Release directory already exists; use --replace to rebuild only this version');
  const runtime = join(root, 'node_modules/electron/dist');
  for (const file of ['dist/index.html', 'desktop/main.mjs', 'desktop/preload.cjs', 'desktop/app-services.mjs', 'release.config.json']) {
    await assertNoLinkedParents(root, join(root, file));
    await stat(join(root, file));
  }
  await stat(join(runtime, 'electron.exe'));
  const stage = assertContained(paths.release, join(paths.release, `.${paths.name}-staging-${randomUUID()}`));
  const backup = assertContained(paths.release, join(paths.release, `.${paths.name}-previous-${randomUUID()}`));
  await mkdir(stage, { recursive: true });
  let backedUp = false;
  try {
    await copyTree(runtime, stage, local => local.split(sep).join('/') !== 'resources/default_app.asar');
    await rename(join(stage, 'electron.exe'), join(stage, 'Mosaic.exe'));
    const icon = join(root, 'installer/icon.ico');
    if (await exists(icon)) {
      const { editWindowsResources } = await import('app-builder-lib/out/util/resEdit.js');
      await editWindowsResources({ file: join(stage, 'Mosaic.exe'), iconPath: icon,
        fileVersion: pkg.version, productVersion: pkg.version, requestedExecutionLevel: 'asInvoker',
        versionStrings: { FileDescription: 'Mosaic', ProductName: 'Mosaic', InternalName: 'Mosaic',
          OriginalFilename: 'Mosaic.exe', CompanyName: '', LegalCopyright: '' },
      });
    }
    const app = join(stage, 'resources/app');
    await copyTree(join(root, 'dist'), join(app, 'dist'));
    await copyTree(join(root, 'shared'), join(app, 'shared'), local => /\.(?:mjs|cjs|js)$/.test(local));
    for (const entry of await readdir(join(root, 'desktop'), { withFileTypes: true })) {
      if (!entry.name.startsWith('.') && /\.(?:mjs|cjs|js|html)$/.test(entry.name)) {
        await copyChecked(join(root, 'desktop', entry.name), join(app, 'desktop', entry.name));
      }
    }
    for (const folder of ['ai', 'chrome']) {
      await copyTree(join(root, 'desktop', folder), join(app, 'desktop', folder), local => /\.(?:mjs|cjs|js|html)$/.test(local));
    }
    await copyChecked(join(root, 'scripts/mcp.mjs'), join(app, 'scripts/mcp.mjs'));
    await copyChecked(join(root, 'release.config.json'), join(app, 'release.config.json'));
    await writeFile(join(app, 'telemetry.config.json'), JSON.stringify(telemetryConfig, null, 2) + '\n');
    await writeFile(join(app, 'package.json'), JSON.stringify({
      name: 'mosaic-browser', productName: 'Mosaic', version: pkg.version, type: 'module', main: 'desktop/main.mjs',
    }, null, 2) + '\n');
    await copyChecked(join(root, 'README.md'), join(stage, 'README.md'));
    await copyTree(join(root, 'docs/distribution'), join(stage, 'docs/distribution'), local => /\.(?:md|txt|html|css|svg)$/i.test(local));
    const releaseConfig = JSON.parse(await readFile(join(root, 'release.config.json'), 'utf8'));
    if (releaseConfig.licenseStatus === 'approved') {
      if (!['LICENSE', 'LICENSE.txt', 'LICENSE.md'].includes(releaseConfig.licenseFile)) throw new Error('Approved licenseFile must name a root LICENSE file');
      await copyChecked(join(root, releaseConfig.licenseFile), join(stage, 'MOSAIC-LICENSE.txt'));
    }
    let notices = '';
    for (const name of ['react', 'react-dom', 'lucide-react']) {
      notices += `\n\n${name}\n${await readFile(join(root, 'node_modules', name, 'LICENSE'), 'utf8')}`;
    }
    await writeFile(join(stage, 'UI-LICENSES.txt'), notices);
    for (const name of ['NSIS-LICENSE.txt', 'ELECTRON-BUILDER-LICENSE.txt', 'STDUTILS-LGPL.txt', 'STDUTILS-LGPL-CLARIFICATION.txt', '7ZIP-LICENSE.txt', '7ZIP-COPYING.txt']) {
      await copyChecked(join(root, 'installer', name), join(stage, 'THIRD-PARTY-NOTICES', name));
    }
    await writeFile(join(stage, 'BUILD-INFO.json'), JSON.stringify({
      schemaVersion: 1, version: pkg.version, electron: pkg.devDependencies.electron,
      platform: 'win32-x64', userDataDirectory: 'MosaicBrowser',
      runtimeSha256: await sha256File(join(stage, 'Mosaic.exe')),
      signed: false, nativeRuntimeVerified: false,
      reason: 'Unsigned package. Native execution and installer smoke tests are separate verification steps.',
    }, null, 2) + '\n');
    await writePackageManifest(stage);
    await verifyPackage(stage);
    if (await exists(paths.output)) { await rename(paths.output, backup); backedUp = true; }
    try { await rename(stage, paths.output); }
    catch (error) { if (backedUp) await rename(backup, paths.output); throw error; }
    if (backedUp) { await assertNoLinkedParents(paths.release, backup); await rm(backup, { recursive: true }); }
    return { ...paths, version: pkg.version };
  } finally {
    if (await exists(stage)) { await assertNoLinkedParents(paths.release, stage); await rm(stage, { recursive: true }); }
  }
}

export async function writeArtifactManifest(root, version, { signed = false } = {}) {
  const paths = pathsForRelease(root, version);
  for (const file of [paths.artifacts, paths.checksums]) await assertNoLinkedParents(root, file);
  const artifacts = [];
  for (const [kind, file] of [['installer', paths.installer], ['portable', paths.portable]]) {
    await assertNoLinkedParents(root, file);
    artifacts.push({ kind, file: basename(file), bytes: (await stat(file)).size, sha256: await sha256File(file) });
  }
  const manifest = { schemaVersion: 1, version, platform: 'win32-x64', userDataDirectory: 'MosaicBrowser', signed,
    packageManifestSha256: await sha256File(join(paths.output, 'PACKAGE-MANIFEST.json')), artifacts };
  await writeFile(paths.artifacts, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(paths.checksums, artifacts.map(file => `${file.sha256}  ${file.file}\n`).join(''));
  return manifest;
}
