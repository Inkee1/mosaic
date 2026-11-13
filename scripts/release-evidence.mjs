import { prepareSource, sha256 } from './audit-publication.mjs';
import { copyFile, lstat } from 'node:fs/promises';
import { sha256File } from './windows-release.mjs';

export async function copyReleaseAsset(source, destination, expectedSha256) {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(expectedSha256 || '') || await sha256File(source) !== expectedSha256) throw new Error('Release asset differs from the validated bytes.');
  await copyFile(source, destination);
  if (await sha256File(destination) !== expectedSha256 || await sha256File(source) !== expectedSha256) throw new Error('Release asset changed during collection.');
}

export async function sourceIdentity(root) {
  const source = await prepareSource(root);
  if (source.findings.length) throw new Error('Source audit failed; release evidence cannot be recorded.');
  return sha256(JSON.stringify(source.entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))));
}

const artifactIdentity = artifacts => JSON.stringify((Array.isArray(artifacts) ? artifacts : []).map(({ kind, file, sha256 }) => ({ kind, file, sha256 })).sort((a, b) => String(a.file).localeCompare(String(b.file))));

export function validateReleaseEvidence({ context, checks = {}, installer }) {
  const missing = [];
  for (const suite of ['core', 'ui', 'native']) {
    const check = checks[suite];
    if (check?.schemaVersion !== 1 || check.suite !== suite || check.passed !== true || check.version !== context.version ||
        check.sourceSha256 !== context.sourceSha256 || (suite === 'native' && check.packageManifestSha256 !== context.packageManifestSha256)) missing.push(suite + '-tests');
  }
  if (installer?.schemaVersion !== 1 || installer.passed !== true || installer.executed !== true || installer.version !== context.version ||
      installer.packageManifestSha256 !== context.packageManifestSha256 || artifactIdentity(installer.artifacts) !== artifactIdentity(context.artifacts)) missing.push('installer-smoke');
  return missing;
}
