import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js';
import { assertNoLinkedParents, pathsForRelease, sha256File, verifyPackage } from './windows-release.mjs';

const execute = promisify(execFile);

export function validateArchivePaths(paths) {
  for (const path of paths) {
    if (!path || isAbsolute(path) || /^[\\/]/.test(path) || path.includes(':') || path.split(/[\\/]/).includes('..')) {
      throw new Error('Unsafe path in generated archive');
    }
  }
}

export async function verifyArtifactInputs(root) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const paths = pathsForRelease(root, version);
  await assertNoLinkedParents(root, paths.output);
  await assertNoLinkedParents(root, paths.artifacts);
  await verifyPackage(paths.output);
  const manifest = JSON.parse(await readFile(paths.artifacts, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.platform !== 'win32-x64' || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) {
    throw new Error('Invalid artifact manifest identity or missing artifacts');
  }
  const packageManifestSha256 = await sha256File(join(paths.output, 'PACKAGE-MANIFEST.json'));
  if (manifest.packageManifestSha256 !== packageManifestSha256) throw new Error('Artifact manifest refers to a different runtime package');
  for (const [kind, file] of [['installer', paths.installer], ['portable', paths.portable]]) {
    const matching = manifest.artifacts.filter(item => item.kind === kind && item.file === basename(file));
    if (matching.length !== 1) throw new Error('Artifact identities do not match the current version');
    await assertNoLinkedParents(root, file);
    if ((await stat(file)).size !== matching[0].bytes || await sha256File(file) !== matching[0].sha256) throw new Error('Artifact hash/size mismatch');
  }
  return { version, paths, manifest, packageManifestSha256 };
}

export async function extractChecked(archive, destination) {
  const path7za = await getPath7za();
  const { stdout } = await execute(path7za, ['l', '-slt', archive], { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  validateArchivePaths(stdout.split(/\r?\n/).filter(line => line.startsWith('Path = ')).slice(1).map(line => line.slice(7)));
  await mkdir(destination, { recursive: true });
  await execute(path7za, ['x', '-y', `-o${destination}`, archive], { windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
}

export async function verifyWindowsArtifacts(root) {
  const { version, paths, manifest, packageManifestSha256 } = await verifyArtifactInputs(root);
  const parent = join(paths.release, '.artifact-verification');
  await assertNoLinkedParents(root, join(paths.release, paths.name + '-artifact-verification.json'));
  await assertNoLinkedParents(root, parent);
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, 'run-'));
  const report = { schemaVersion: 1, version, passed: false, packageManifestSha256,
    artifacts: manifest.artifacts.map(({ kind, file, sha256 }) => ({ kind, file, sha256 })),
    steps: [], workspace: relative(root, workspace).split(sep).join('/'),
    scope: 'Archive extraction and payload hashes only. No installer, app, or uninstaller was executed.' };
  try {
    for (const [kind, archive] of [['installer', paths.installer], ['portable', paths.portable]]) {
      console.log('Extracting and verifying ' + kind + ' payload...');
      const extracted = join(workspace, kind);
      await extractChecked(archive, extracted);
      await verifyPackage(extracted);
      if (await sha256File(join(extracted, 'PACKAGE-MANIFEST.json')) !== packageManifestSha256) throw new Error('Extracted package manifest does not match build inputs');
      report.steps.push(kind + '-payload-extracted-and-all-file-hashes-verified');
    }
    report.passed = true;
    return report;
  } catch (error) { report.error = error.message; throw error; }
  finally {
    report.completedAt = new Date().toISOString();
    await writeFile(join(paths.release, paths.name + '-artifact-verification.json'), JSON.stringify(report, null, 2) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/verify-windows-artifacts.mjs');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  await verifyWindowsArtifacts(root);
  console.log('Both archive payloads match the packaged runtime. Installer execution remains a separate smoke test.');
}
