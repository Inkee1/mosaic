import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateReleaseEvidence } from '../../scripts/release-evidence.mjs';
import { verifyReleaseBundle } from '../../scripts/verify-release-bundle.mjs';

function fixture() {
  const context = { version: '0.7.4', sourceSha256: 'a'.repeat(64), packageManifestSha256: 'b'.repeat(64), artifacts: [
    { kind: 'installer', file: 'Mosaic-0.7.4-win-x64-setup.exe', sha256: 'c'.repeat(64) },
    { kind: 'portable', file: 'Mosaic-0.7.4-win-x64-portable.zip', sha256: 'd'.repeat(64) },
  ] };
  const checks = Object.fromEntries(['core', 'ui', 'native'].map(suite => [suite, {
    schemaVersion: 1, suite, version: context.version, passed: true, sourceSha256: context.sourceSha256,
    ...(suite === 'native' ? { packageManifestSha256: context.packageManifestSha256 } : {}),
  }]));
  const installer = { schemaVersion: 1, version: context.version, passed: true, executed: true,
    packageManifestSha256: context.packageManifestSha256, artifacts: structuredClone(context.artifacts) };
  return { context, checks, installer };
}

test('release evidence requires executed tests and installation bound to the final source and artifacts', () => {
  const good = fixture();
  assert.deepEqual(validateReleaseEvidence(good), []);
  for (const suite of ['core', 'ui', 'native']) {
    const missing = fixture(); delete missing.checks[suite];
    assert.ok(validateReleaseEvidence(missing).includes(suite + '-tests'));
    const stale = fixture(); stale.checks[suite].sourceSha256 = 'e'.repeat(64);
    assert.ok(validateReleaseEvidence(stale).includes(suite + '-tests'));
    const failed = fixture(); failed.checks[suite].passed = false;
    assert.ok(validateReleaseEvidence(failed).includes(suite + '-tests'));
  }
});

test('another package or archive extraction alone cannot stand in for installation smoke', () => {
  const wrongRuntime = fixture(); wrongRuntime.checks.native.packageManifestSha256 = 'e'.repeat(64);
  assert.ok(validateReleaseEvidence(wrongRuntime).includes('native-tests'));
  for (const mutate of [
    item => { item.executed = false; },
    item => { item.passed = false; },
    item => { item.version = '0.7.3'; },
    item => { item.packageManifestSha256 = 'e'.repeat(64); },
    item => { item.artifacts[0].sha256 = 'e'.repeat(64); },
    item => { item.artifacts.pop(); },
    item => { item.artifacts.push(item.artifacts[0]); },
  ]) {
    const bad = fixture(); mutate(bad.installer);
    assert.ok(validateReleaseEvidence(bad).includes('installer-smoke'));
  }
});

test('publication refuses another repository, modified downloads, extra files and incomplete verification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-release-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stem = 'Mosaic-0.7.4', name = stem + '-win-x64';
  const files = [name + '-setup.exe', name + '-portable.zip', name + '-artifacts.json', name + '-SHA256SUMS.txt', stem + '-source.zip', stem + '-source-manifest.json', stem + '-source-SHA256SUMS.txt', 'release-notes.md'];
  for (const file of files) await writeFile(join(directory, file), 'fixture');
  const bundle = { schemaVersion: 1, version: '0.7.4', repository: 'example/mosaic', channel: 'beta', publicReady: true,
    signingMode: 'unsigned-beta', signed: false, warnings: [{ code: 'unsigned-beta', message: 'Unsigned beta.' }],
    checks: { core: true, ui: true, native: true }, installerExecuted: true, blockers: [], commit: 'f'.repeat(40),
    files: files.map(file => ({ file, sha256: createHash('sha256').update('fixture').digest('hex') })) };
  const put = () => writeFile(join(directory, 'RELEASE.json'), JSON.stringify(bundle));
  await put();
  assert.equal((await verifyReleaseBundle(directory, { repository: 'example/mosaic', commit: 'f'.repeat(40) })).version, '0.7.4');
  bundle.channel = 'stable'; await put();
  await assert.rejects(verifyReleaseBundle(directory), /signing|unsigned/i);
  bundle.channel = 'beta'; bundle.signingMode = 'required'; await put();
  await assert.rejects(verifyReleaseBundle(directory), /signing|unsigned/i);
  bundle.signed = true; await put();
  assert.equal((await verifyReleaseBundle(directory)).signed, true);
  bundle.signingMode = 'unsigned-beta'; bundle.signed = false; bundle.warnings = []; await put();
  await assert.rejects(verifyReleaseBundle(directory), /unsigned|warning/i);
  bundle.warnings = [{ code: 'unsigned-beta', message: 'Unsigned beta.' }]; await put();
  for (const value of [undefined, null, 'false', 0]) {
    bundle.signed = value; await put();
    await assert.rejects(verifyReleaseBundle(directory), /signing/i);
  }
  bundle.signed = false; await put();
  await assert.rejects(verifyReleaseBundle(directory, { repository: 'different/mosaic', commit: 'f'.repeat(40) }), /repository/i);
  await assert.rejects(verifyReleaseBundle(directory, { repository: 'example/mosaic', commit: 'e'.repeat(40) }), /commit/i);
  await writeFile(join(directory, files[0]), 'tampered');
  await assert.rejects(verifyReleaseBundle(directory), /hash/i);
  await writeFile(join(directory, files[0]), 'fixture');
  await writeFile(join(directory, 'profile.json'), 'private');
  await assert.rejects(verifyReleaseBundle(directory), /unexpected/i);
  await rm(join(directory, 'profile.json'));
  bundle.installerExecuted = false; await put();
  await assert.rejects(verifyReleaseBundle(directory), /evidence/i);
  bundle.installerExecuted = true; bundle.files[0].file = '../outside.exe'; await put();
  await assert.rejects(verifyReleaseBundle(directory), /files/i);
});
