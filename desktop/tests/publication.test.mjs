import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { auditPublication, stampBuild } from '../../scripts/audit-publication.mjs';
import { exportSource, readSourceArchive } from '../../scripts/export-source.mjs';
import { evaluateRelease, windowsJson } from '../../scripts/check-release.mjs';
import { copyReleaseAsset } from '../../scripts/release-evidence.mjs';

const pending = { repository: null, supportEmail: null, publisher: null, channel: 'beta', licenseStatus: 'pending', licenseFile: null };
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function put(root, path, contents) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof contents === 'object' && !Buffer.isBuffer(contents) ? JSON.stringify(contents, null, 2) : contents);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mosaic-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, 'package.json', { name: 'mosaic-ui', version: '0.7.0', type: 'module' });
  await put(root, 'package-lock.json', { name: 'mosaic-ui', version: '0.7.0', lockfileVersion: 3 });
  await put(root, 'release.config.json', pending);
  await put(root, 'README.md', '# Mosaic\nPreview source; license pending.\n');
  await put(root, 'src/main.tsx', 'export const app = "Mosaic";\n');
  await put(root, 'index.html', '<div id="root"></div>');
  await put(root, 'desktop/main.mjs', 'export const fixture = true;');
  await put(root, 'desktop/credentials.mjs', 'export const storageName = "credentials.bin";\n');
  await put(root, 'desktop/tests/credentials.test.mjs', 'const password = "p-secret";\n');
  await put(root, 'docs/distribution/privacy.md', '# Privacy\nLocal settings.\n');
  return root;
}

test('source publication keeps runnable code and tests while omitting local data and ledgers', async (t) => {
  const root = await fixture(t);
  for (const path of ['.env', 'src/.env.production', 'desktop/agent-connection.json', 'desktop/credentials.bin', 'desktop/chrome-profiles/Default/Preferences', 'desktop/sessions/private.json', 'desktop/ai-connections/run.json', 'desktop/ai-workspaces/chat/config.json', 'tests/test-results/trace.zip', 'docs/superpowers/plans/private.md', 'docs/implementation-notes.md', '.superpowers/session.json', 'node_modules/private.json', 'release/profile.json'])
    await put(root, path, 'private local contents');
  const result = await auditPublication({ root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.source.files.map((file) => file.path).sort(), [
    'README.md', 'desktop/credentials.mjs', 'desktop/main.mjs', 'desktop/tests/credentials.test.mjs', 'docs/distribution/privacy.md',
    'index.html', 'package-lock.json', 'package.json', 'release.config.json', 'src/main.tsx',
  ].sort());
  assert.ok(result.source.excluded > 0);
});

test('credential-shaped literals fail even in tests and docs, without leaking their values', async (t) => {
  const root = await fixture(t);
  const credential = ['gh', 'p_', randomBytes(20).toString('hex')].join('');
  await put(root, 'desktop/tests/leak.test.mjs', 'const fixtureToken = "' + credential + '";\n');
  await put(root, 'docs/distribution/leak.md', ['-----BEGIN ', 'PRIVATE KEY-----\n', 'secret-key-material'].join(''));
  const result = await auditPublication({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.rule === 'github-token' && finding.path.endsWith('leak.test.mjs')));
  assert.ok(result.findings.some((finding) => finding.rule === 'private-key'));
  assert.equal(JSON.stringify(result).includes(credential), false);
  assert.equal(JSON.stringify(result).includes('secret-key-material'), false);
  await assert.rejects(exportSource({ root }), /audit/i);
});

test('source export includes only named release workflows and community files', async (t) => {
  const root = await fixture(t);
  const selected = ['SECURITY.md', '.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/ISSUE_TEMPLATE/bug-report.yml', '.github/ISSUE_TEMPLATE/config.yml'];
  for (const path of selected) await put(root, path, '# Public release support\n');
  for (const path of ['.github/private-notes.md', '.github/workflows/private.yml', '.github/ISSUE_TEMPLATE/customer-data.json']) await put(root, path, 'Private local note');
  const result = await auditPublication({ root });
  for (const path of selected) assert.ok(result.source.files.some(file => file.path === path), path);
  assert.equal(result.source.files.some(file => /private|customer-data/.test(file.path)), false);
});

test('generic embedded secrets and personal paths are findings while reserved example data is allowed', async (t) => {
  const root = await fixture(t);
  await put(root, 'tests/example.spec.ts', 'const password = "p-secret"; const email = "person@example.test"; const home = "C:/Users/test/AppData/Local";\n');
  assert.equal((await auditPublication({ root })).ok, true);
  const secret = randomBytes(24).toString('base64');
  const email = ['individual.83420', '@', 'gmail.com'].join('');
  await put(root, 'src/config.ts', 'export const API_KEY = "' + secret + '";\nexport const email = "' + email + '";\n');
  await put(root, 'docs/distribution/local.md', ['C:/Users/', 'private-person-83420', '/Desktop/project'].join(''));
  const result = await auditPublication({ root });
  assert.equal(result.ok, false);
  for (const rule of ['embedded-credential', 'personal-email', 'personal-home-path'])
    assert.ok(result.findings.some((finding) => finding.rule === rule), rule);
  for (const value of [secret, email, 'private-person-83420']) assert.equal(JSON.stringify(result).includes(value), false);
});

test('a selected directory junction cannot publish files outside the source root', async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'mosaic-publication-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await put(outside, 'private.mjs', 'export const privateData = true;');
  await symlink(outside, join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await auditPublication({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.rule === 'symbolic-link'));
  assert.equal(result.source.files.some((file) => file.path.includes('private.mjs')), false);
  await assert.rejects(exportSource({ root }), /audit/i);
});

test('packaged app audit rejects private state and embedded credentials in built JavaScript', async (t) => {
  const root = await fixture(t);
  const packageRoot = join(root, 'release/app');
  const credential = ['sk', '-proj-', randomBytes(30).toString('hex')].join('');
  await put(packageRoot, 'resources/app/dist/assets/main.js', 'const key="' + credential + '";');
  await put(packageRoot, 'resources/app/agent-connection.json', { token: 'fixture-only' });
  await put(packageRoot, 'resources/app/.env', 'fixture-only');
  const result = await auditPublication({ root, packageRoot });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.scope === 'package' && finding.rule === 'provider-token'));
  assert.ok(result.findings.some((finding) => finding.scope === 'package' && finding.rule === 'private-path'));
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test('upstream notices retain author attribution but do not exempt embedded credentials', async (t) => {
  const root = await fixture(t), packageRoot = join(root, 'release/app');
  const attribution = ['copyright.author', '@', 'gmail.com'].join('');
  await put(packageRoot, 'LICENSE', 'Copyright ' + attribution);
  assert.equal((await auditPublication({ root, packageRoot })).ok, true);
  const credential = ['gh', 'p_', randomBytes(20).toString('hex')].join('');
  await put(packageRoot, 'LICENSE', 'Copyright ' + attribution + '\n' + credential);
  const result = await auditPublication({ root, packageRoot });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((entry) => entry.rule === 'github-token'));
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test('exact installer notices allow attribution in source and packages while all credentials remain checked', async (t) => {
  const root = await fixture(t), packageRoot = join(root, 'release/app');
  const author = ['copyright.author', '@', 'gmail.com'].join('');
  const notices = ['NSIS-LICENSE.txt', 'ELECTRON-BUILDER-LICENSE.txt', 'STDUTILS-LGPL.txt', 'STDUTILS-LGPL-CLARIFICATION.txt', '7ZIP-LICENSE.txt', '7ZIP-COPYING.txt'];
  for (const file of notices) {
    await put(root, 'installer/' + file, 'Copyright ' + author);
    await put(packageRoot, 'THIRD-PARTY-NOTICES/' + file, 'Copyright ' + author);
  }
  const accepted = await auditPublication({ root, packageRoot });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.findings));
  for (const file of notices) assert.ok(accepted.source.files.some((entry) => entry.path === 'installer/' + file));
  const credential = ['gh', 'p_', randomBytes(20).toString('hex')].join('');
  await put(root, 'installer/NSIS-LICENSE.txt', 'Copyright ' + author + '\n' + credential);
  await put(packageRoot, 'THIRD-PARTY-NOTICES/7ZIP-LICENSE.txt', credential);
  await put(root, 'installer/customer-notes.txt', author);
  const rejected = await auditPublication({ root, packageRoot });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.findings.some((entry) => entry.scope === 'source' && entry.rule === 'github-token'));
  assert.ok(rejected.findings.some((entry) => entry.scope === 'package' && entry.rule === 'github-token'));
  assert.ok(rejected.findings.some((entry) => entry.path === 'installer/customer-notes.txt' && entry.rule === 'personal-email'));
  assert.equal(JSON.stringify(rejected).includes(credential), false);
});

test('a linked package root is rejected before any external file is inspected', async (t) => {
  const root = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'mosaic-package-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await put(outside, 'private.json', '{}');
  await symlink(outside, join(root, 'linked-package'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await auditPublication({ root, packageRoot: join(root, 'linked-package') });
  assert.equal(result.ok, false);
  assert.equal(result.package?.files.some((file) => file.path === 'private.json') || false, false);
});

test('export contains only audited bytes, reproducible archive entries and a verified manifest', async (t) => {
  const root = await fixture(t);
  await put(root, '.env', 'never export');
  const first = await exportSource({ root });
  const bytes = await readFile(first.archive);
  const entries = readSourceArchive(bytes);
  assert.equal(entries.has('.env'), false);
  assert.equal(entries.get('src/main.tsx').toString(), 'export const app = "Mosaic";\n');
  const manifest = JSON.parse(entries.get('SOURCE-MANIFEST.json').toString());
  assert.deepEqual(manifest.files, JSON.parse(await readFile(first.manifest, 'utf8')).files);
  for (const file of manifest.files) assert.equal(hash(entries.get(file.path)), file.sha256);
  const second = await exportSource({ root });
  assert.deepEqual(await readFile(second.archive), bytes);
  const damaged = Buffer.from(bytes);
  damaged[50] ^= 1;
  assert.throws(() => readSourceArchive(damaged), /archive|CRC|ZIP/i);
  const linkEntry = Buffer.from(bytes);
  const central = linkEntry.readUInt32LE(linkEntry.length - 6);
  linkEntry.writeUInt32LE(0xa1ff0000, central + 38);
  assert.throws(() => readSourceArchive(linkEntry), /archive|CRC|ZIP/i);
});

test('exported TypeScript module sources retain declarations and still typecheck independently', async (t) => {
  const root = await fixture(t);
  await put(root, 'shared/contract.mjs', 'export const count = value => value.length;');
  await put(root, 'shared/contract.d.mts', 'export declare function count(value: string): number;');
  await put(root, 'shared/legacy.cjs', 'module.exports = value => value.length;');
  await put(root, 'shared/legacy.d.cts', 'declare function length(value: string): number; export = length;');
  await put(root, 'src/contract.mts', "import { count } from '../shared/contract.mjs'; import length from '../shared/legacy.cjs'; const result: number = count('source') + length('archive');");
  await put(root, 'src/common.cts', 'const result: number = 1; export = result;');
  const result = await exportSource({ root });
  const entries = readSourceArchive(await readFile(result.archive));
  for (const path of ['shared/contract.d.mts', 'shared/legacy.d.cts', 'src/contract.mts', 'src/common.cts']) assert.ok(entries.has(path), path + ' must be exported');
  const unpacked = join(root, 'release/unpacked');
  for (const [path, data] of entries) await put(unpacked, path, data);
  const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
  await promisify(execFile)(process.execPath, [tsc, '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', join(unpacked, 'src/contract.mts'), join(unpacked, 'src/common.cts')], { windowsHide: true });
  await put(root, 'dist/index.html', '<div>Built</div>');
  const stamp = await stampBuild({ root });
  for (const path of ['shared/contract.d.mts', 'shared/legacy.d.cts']) assert.ok(stamp.inputs.some((file) => file.path === path), path + ' must participate in build provenance');
});

async function releaseFixture(t, releaseConfig = pending) {
  const root = await fixture(t);
  await put(root, 'release.config.json', releaseConfig);
  const packageRoot = join(root, 'release/Mosaic-0.7.0-win-x64');
  await put(packageRoot, 'Mosaic.exe', 'not an executable signature fixture');
  await put(packageRoot, 'resources/app/package.json', { version: '0.7.0' });
  await put(packageRoot, 'resources/app/release.config.json', releaseConfig);
  await put(packageRoot, 'resources/app/desktop/main.mjs', 'export const fixture = true;');
  await put(packageRoot, 'README.md', await readFile(join(root, 'README.md')));
  await put(packageRoot, 'resources/app/desktop/credentials.mjs', await readFile(join(root, 'desktop/credentials.mjs')));
  await put(packageRoot, 'docs/distribution/privacy.md', await readFile(join(root, 'docs/distribution/privacy.md')));
  for (const path of ['LICENSE', 'LICENSES.chromium.html', 'UI-LICENSES.txt']) await put(packageRoot, path, 'Fixture notice.');
  for (const file of ['NSIS-LICENSE.txt', 'ELECTRON-BUILDER-LICENSE.txt', 'STDUTILS-LGPL.txt', 'STDUTILS-LGPL-CLARIFICATION.txt', '7ZIP-LICENSE.txt', '7ZIP-COPYING.txt']) {
    await put(root, 'installer/' + file, 'Upstream notice fixture.');
    await put(packageRoot, 'THIRD-PARTY-NOTICES/' + file, 'Upstream notice fixture.');
  }
  await put(root, 'dist/index.html', '<script src="assets/main.js"></script>');
  await put(root, 'dist/assets/main.js', 'const app="Mosaic";');
  const stamp = await stampBuild({ root });
  for (const file of stamp.outputs) await put(packageRoot, 'resources/app/dist/' + file.path, await readFile(join(root, 'dist', file.path)));
  await put(packageRoot, 'resources/app/dist/BUILD-SOURCE.json', await readFile(join(root, 'dist/BUILD-SOURCE.json')));
  const artifacts = [];
  for (const [kind, suffix] of [['installer', 'setup.exe'], ['portable', 'portable.zip']]) {
    const file = 'Mosaic-0.7.0-win-x64-' + suffix;
    const data = Buffer.from('fixture ' + kind);
    await put(root, 'release/' + file, data);
    artifacts.push({ kind, file, bytes: data.length, sha256: hash(data) });
  }
  const packageAudit = await auditPublication({ root, packageRoot });
  await put(packageRoot, 'PACKAGE-MANIFEST.json', { schemaVersion: 1, files: packageAudit.package.files });
  await put(root, 'release/Mosaic-0.7.0-win-x64-artifacts.json', { schemaVersion: 1, version: '0.7.0', platform: 'win32-x64', artifacts, packageManifestSha256: hash(await readFile(join(packageRoot, 'PACKAGE-MANIFEST.json'))), signed: true });
  await put(root, 'release/Mosaic-0.7.0-win-x64-SHA256SUMS.txt', artifacts.map((item) => item.sha256 + '  ' + item.file).join('\n') + '\n');
  await exportSource({ root });
  return root;
}

test('draft validation can pass audited artifacts but public validation reports identity, license and signatures', async (t) => {
  const root = await releaseFixture(t);
  const draft = await evaluateRelease({ root, mode: 'draft' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.publicReady, false);
  for (const code of ['repository', 'support-contact', 'publisher', 'license', 'signatures'])
    assert.ok(draft.blockers.some((entry) => entry.code === code), code);
  const publicResult = await evaluateRelease({ root, mode: 'public' });
  assert.equal(publicResult.ok, false);
  assert.ok(publicResult.blockers.some((entry) => entry.code === 'signatures'));
});

test('collection binds every source and binary asset to the bytes checked by the release gate', async t => {
  const root = await releaseFixture(t);
  const report = await evaluateRelease({ root, mode: 'draft' });
  assert.equal(report.validatedAssets?.length, 7);
  for (const item of report.validatedAssets) {
    const file = join(root, 'release', item.file);
    assert.equal(item.sha256, hash(await readFile(file)));
  }
  const source = report.validatedAssets.find(item => item.file.endsWith('-source.zip'));
  const file = join(root, 'release', source.file), output = join(root, 'copied.zip');
  await copyReleaseAsset(file, output, source.sha256);
  await writeFile(file, 'changed after validation');
  await assert.rejects(copyReleaseAsset(file, output, source.sha256), /validated|changed|hash/i);
});

test('a contact form satisfies the support gate without an email and changing it requires repackaging', async (t) => {
  const config = { ...pending, supportUrl: 'https://forms.gle/mosaic-contact-fixture' };
  const root = await releaseFixture(t, config);
  let result = await evaluateRelease({ root, mode: 'draft' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(!result.blockers.some(item => /^support-/.test(item.code)));
  await put(root, 'release.config.json', { ...config, supportUrl: 'https://forms.gle/updated-contact-fixture' });
  result = await evaluateRelease({ root, mode: 'draft' });
  assert.ok(result.errors.some(item => item.code === 'config-mismatch'));
  await put(root, 'release.config.json', { ...config, supportUrl: 'https://support.example.test/contact' });
  result = await evaluateRelease({ root, mode: 'draft' });
  assert.ok(result.blockers.some(item => item.code === 'support-contact'));
});

test('requested usage counting blocks public release until the configured destination matches the package', async (t) => {
  const root = await releaseFixture(t);
  await put(root, 'release.config.json', { ...pending, telemetryRequired: true });
  let result = await evaluateRelease({ root, mode: 'draft' });
  assert.ok(result.blockers.some(item => item.code === 'telemetry-configuration'));
  const config = { host: 'https://us.i.posthog.com', projectToken: 'phc_' + 'x'.repeat(40) };
  await put(root, 'telemetry.config.json', config);
  await put(root, 'release/Mosaic-0.7.0-win-x64/resources/app/telemetry.config.json', config);
  result = await evaluateRelease({ root, mode: 'draft' });
  assert.ok(!result.blockers.some(item => item.code === 'telemetry-configuration'));
  await put(root, 'telemetry.config.json', { ...config, host: 'https://eu.i.posthog.com' });
  result = await evaluateRelease({ root, mode: 'draft' });
  assert.ok(result.errors.some(item => item.code === 'telemetry-config-mismatch'));
});

test('a source edit after export, artifact tampering and missing notices fail the draft gate', async (t) => {
  const root = await releaseFixture(t);
  await put(root, 'src/main.tsx', 'export const app = "Changed";');
  await put(root, 'release/Mosaic-0.7.0-win-x64-portable.zip', 'tampered archive');
  await rm(join(root, 'release/Mosaic-0.7.0-win-x64/UI-LICENSES.txt'));
  const result = await evaluateRelease({ root, mode: 'draft' });
  assert.equal(result.ok, false);
  for (const code of ['source-stale', 'artifact-integrity', 'notices'])
    assert.ok(result.errors.some((entry) => entry.code === code), code);
});

test('metadata cannot bypass the release gate with URLs, path traversal or an invented license marker', async (t) => {
  const root = await releaseFixture(t);
  await put(root, 'release.config.json', { ...pending, repository: 'https://github.com/owner/repo', publisher: ' ', supportEmail: 'bad contact', licenseStatus: 'approved', licenseFile: '../LICENSE' });
  const result = await evaluateRelease({ root, mode: 'public' });
  assert.equal(result.ok, false);
  for (const code of ['repository', 'support-contact', 'publisher', 'license'])
    assert.ok(result.blockers.some((entry) => entry.code === code), code);
  assert.ok(result.errors.some((entry) => entry.code === 'config-mismatch'));
});

test('draft release requires the shipped installer component notices', async (t) => {
  const root = await releaseFixture(t);
  await rm(join(root, 'release/Mosaic-0.7.0-win-x64/THIRD-PARTY-NOTICES/NSIS-LICENSE.txt'));
  const result = await evaluateRelease({ root, mode: 'draft' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'notices'));
});

test('same-version repackaging invalidates old installer and portable payload bindings', async (t) => {
  const root = await releaseFixture(t), packageRoot = join(root, 'release/Mosaic-0.7.0-win-x64');
  await put(packageRoot, 'resources/app/desktop/main.mjs', 'export const fixture = false;');
  const audit = await auditPublication({ root, packageRoot });
  await put(packageRoot, 'PACKAGE-MANIFEST.json', { schemaVersion: 1, files: audit.package.files.filter((file) => file.path !== 'PACKAGE-MANIFEST.json') });
  const result = await evaluateRelease({ root, mode: 'draft' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'artifact-payload'));
  assert.ok(result.errors.some((entry) => entry.code === 'package-source'));
});

test('fresh source export cannot hide stale renderer compilation or packaged runtime code', async (t) => {
  const root = await releaseFixture(t);
  await put(root, 'src/main.tsx', 'export const app = "Next build";');
  await put(root, 'desktop/main.mjs', 'export const fixture = "Next runtime";');
  await exportSource({ root });
  const result = await evaluateRelease({ root, mode: 'draft' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'build-stale'));
  assert.ok(result.errors.some((entry) => entry.code === 'package-source'));
});

test('build provenance records output hashes and refuses a missing build', async (t) => {
  const root = await fixture(t);
  await assert.rejects(stampBuild({ root }), /build|dist/i);
  await put(root, 'dist/index.html', '<div>Built</div>');
  const stamp = await stampBuild({ root });
  assert.equal(stamp.inputs.some((entry) => entry.path === 'src/main.tsx'), true);
  assert.equal(stamp.inputs.some((entry) => entry.path.startsWith('desktop/')), false);
  assert.equal(stamp.outputs.find((entry) => entry.path === 'index.html').sha256, hash(Buffer.from('<div>Built</div>')));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/BUILD-SOURCE.json'), 'utf8')), stamp);
});

test('Windows signature JSON preserves Korean publisher names', { skip: process.platform !== 'win32' }, async () => {
  const value = await windowsJson("[pscustomobject]@{name=([string][char]0xBAA8+[char]0xC790+[char]0xC774+[char]0xD06C)}|ConvertTo-Json -Compress");
  assert.equal(value.name, '모자이크');
});
