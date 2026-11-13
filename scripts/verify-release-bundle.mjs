import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsForRelease, sha256File } from './windows-release.mjs';

export async function verifyReleaseBundle(directory, { repository, commit, requirePublic = true } = {}) {
  if ((await lstat(directory)).isSymbolicLink() || (await lstat(join(directory, 'RELEASE.json'))).isSymbolicLink()) throw new Error('Linked release bundle');
  const bundle = JSON.parse(await readFile(join(directory, 'RELEASE.json'), 'utf8'));
  if (bundle.schemaVersion !== 1 || !['beta', 'stable'].includes(bundle.channel)) throw new Error('Invalid release metadata');
  const { name } = pathsForRelease(directory, bundle.version), stem = 'Mosaic-' + bundle.version;
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(bundle.repository || '') || (repository && bundle.repository.toLowerCase() !== repository.toLowerCase())) throw new Error('Release repository does not match');
  if (commit && bundle.commit !== commit) throw new Error('Release commit does not match');
  if (requirePublic && (bundle.publicReady !== true || bundle.installerExecuted !== true || !Array.isArray(bundle.blockers) || bundle.blockers.length || ['core', 'ui', 'native'].some(suite => bundle.checks?.[suite] !== true))) throw new Error('Public release evidence is incomplete');
  const expected = [name + '-setup.exe', name + '-portable.zip', name + '-artifacts.json', name + '-SHA256SUMS.txt', stem + '-source.zip', stem + '-source-manifest.json', stem + '-source-SHA256SUMS.txt', 'release-notes.md'].sort();
  if (!Array.isArray(bundle.files) || JSON.stringify(bundle.files.map(item => item.file).sort()) !== JSON.stringify(expected)) throw new Error('Release files do not match the allowlist');
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...expected, 'RELEASE.json'].sort())) throw new Error('Unexpected files in release bundle');
  for (const item of bundle.files) {
    const file = join(directory, item.file), metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(item.sha256) || await sha256File(file) !== item.sha256) throw new Error('Release file hash mismatch: ' + item.file);
  }
  return bundle;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-release-bundle.mjs DIRECTORY');
    const bundle = await verifyReleaseBundle(process.argv[2], { repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA });
    console.log('Verified public release bundle for ' + bundle.repository + ' v' + bundle.version);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
