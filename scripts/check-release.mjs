import { readFile, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { auditPublication, buildInputs, INSTALLER_NOTICE_FILES, projectRoot, sha256 } from './audit-publication.mjs';
import { readSourceArchive } from './export-source.mjs';
import { validateTelemetryConfig } from '../desktop/usage-telemetry.mjs';
import { normalizeSupportUrl } from '../desktop/support-contact.mjs';

const execute = promisify(execFile);
export async function windowsJson(command, extraEnv = {}) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" + command], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, ...extraEnv } });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const configKeys = ['repository', 'supportEmail', 'supportUrl', 'channel', 'licenseStatus', 'licenseFile', 'publisher', 'telemetryRequired', 'windowsSigning'];
const configIdentity = (value) => JSON.stringify(configKeys.map((key) => value?.[key]));
const fileIdentity = (files) => JSON.stringify([...files].map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path, 'en')));
async function ordinaryFile(root, file) {
  const full = join(root, file), metadata = await lstat(full);
  const rest = relative(await realpath(root), await realpath(full));
  if (!metadata.isFile() || metadata.isSymbolicLink() || rest === '..' || rest.startsWith('..' + sep) || rest.includes(':')) throw new Error('Unsafe file.');
  return readFile(full);
}
function checksumMap(text) {
  const map = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}([^/\\:\x00-\x1f]+)$/.exec(line);
    if (!match || map.has(match[2])) throw new Error('Invalid checksums.');
    map.set(match[2], match[1]);
  }
  return map;
}

async function signatures(files, publisher) {
  if (process.platform !== 'win32') return files.map(({ file }) => ({ file, status: 'WindowsVerificationRequired', trusted: false }));
  // Paths are passed in an environment variable, never interpolated into shell code.
  const command = `$ErrorActionPreference='Stop';$items=ConvertFrom-Json $env:MOSAIC_RELEASE_SIGNATURE_FILES;$out=@(foreach($i in $items){$s=Get-AuthenticodeSignature -LiteralPath $i.absolute;[pscustomobject]@{file=$i.file;status=$s.Status.ToString();name=if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''};selfSigned=if($s.SignerCertificate){$s.SignerCertificate.Subject -eq $s.SignerCertificate.Issuer}else{$true};timestamp=($null -ne $s.TimeStamperCertificate)}});ConvertTo-Json -InputObject $out -Compress`;
  try {
    const rows = await windowsJson(command, { MOSAIC_RELEASE_SIGNATURE_FILES: JSON.stringify(files) });
    if (!Array.isArray(rows) || rows.length !== files.length) throw new Error();
    return files.map(({ file }) => {
      const result = rows.find((row) => row.file === file);
      return { file, status: result?.status || 'Unverified', trusted: result?.status === 'Valid' && result.selfSigned === false && result.timestamp === true && typeof publisher === 'string' && result.name?.toLowerCase() === publisher.toLowerCase() };
    });
  } catch { return files.map(({ file }) => ({ file, status: 'Unverified', trusted: false })); }
}

export function evaluateSigningPolicy(config, results) {
  const signingMode = config.windowsSigning ?? 'required';
  const blockers = [], warnings = [];
  const signed = results.length > 0 && results.every(item => item.status === 'Valid' && item.trusted === true);
  const block = (code, message) => blockers.push({ code, message });
  if (!['required', 'unsigned-beta'].includes(signingMode) || (signingMode === 'unsigned-beta' && config.channel !== 'beta'))
    block('signing-policy', 'Unsigned distribution must be explicitly selected with windowsSigning=unsigned-beta and channel=beta. Stable releases require signing.');
  if (signingMode === 'unsigned-beta') {
    if (!results.length || results.some(item => !['Valid', 'NotSigned'].includes(item.status)))
      block('signatures', 'Unsigned beta still requires live Windows inspection: only valid signatures or unsigned files are allowed. Invalid or unavailable verification blocks release.');
    if (!signed) warnings.push({ code: 'unsigned-beta', message: 'This beta is unsigned. Windows may show an unknown-publisher or SmartScreen warning. Verify the official download and SHA-256 checksum before running.' });
  } else {
    if (typeof config.publisher !== 'string' || !config.publisher.trim() || config.publisher.trim() !== config.publisher || /[\x00-\x1f]/.test(config.publisher))
      block('publisher', 'Set the confirmed publisher name matching the signing certificate common name.');
    if (!signed) block('signatures', 'All shipped EXE/DLL/NODE files and the installer need current, trusted, timestamped Authenticode verification matching the configured publisher. Stored signed flags are not evidence.');
  }
  return { signingMode, signed, blockers, warnings };
}

export async function evaluateRelease({ root = projectRoot, mode = 'draft' } = {}) {
  if (!['draft', 'public'].includes(mode)) throw new Error('Choose draft or public release mode.');
  root = resolve(root);
  const errors = [], blockers = [], validatedAssets = [];
  const bindAsset = (file, bytes) => validatedAssets.push({ file, sha256: sha256(bytes) });
  const fail = (code, message) => { if (!errors.some((entry) => entry.code === code)) errors.push({ code, message }); };
  const block = (code, message) => blockers.push({ code, message });
  let pkg, config;
  try {
    pkg = await json(join(root, 'package.json'));
    config = await json(join(root, 'release.config.json'));
    if (!VERSION.test(pkg.version) || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
  } catch { return { schemaVersion: 1, mode, ok: false, publicReady: false, errors: [{ code: 'configuration', message: 'Valid package version and release.config.json are required.' }], blockers: [] }; }
  const version = pkg.version, base = `Mosaic-${version}-win-x64`;
  const release = join(root, 'release'), packageRoot = join(release, base);
  if (config.telemetryRequired === true) {
    let local, packed;
    try { local = validateTelemetryConfig(JSON.parse((await ordinaryFile(root, 'telemetry.config.json')).toString('utf8'))); } catch {}
    try { packed = validateTelemetryConfig(JSON.parse((await ordinaryFile(packageRoot, 'resources/app/telemetry.config.json')).toString('utf8'))); } catch {}
    if (!local || !packed) block('telemetry-configuration', 'Connect the confirmed analytics project and package its validated public ingestion configuration.');
    else if (JSON.stringify(local) !== JSON.stringify(packed)) fail('telemetry-config-mismatch', 'Repackage after changing the telemetry destination; the shipped configuration differs.');
  }
  if (typeof config.repository !== 'string' || !REPOSITORY.test(config.repository) || config.repository.endsWith('.git')) block('repository', 'Set the confirmed GitHub owner/repository in release.config.json.');
  const supportUrl = normalizeSupportUrl(config.supportUrl);
  const hasSupportUrl = supportUrl && !/(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test|localhost)$/i.test(new URL(supportUrl).hostname);
  const hasSupportEmail = typeof config.supportEmail === 'string' && /^[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(config.supportEmail) && !/@(?:.*\.)?(?:example\.(?:com|net|org)|invalid|test)$/i.test(config.supportEmail);
  if (!hasSupportUrl && !hasSupportEmail) block('support-contact', 'Set a monitored, approved HTTPS contact form URL or support email.');
  if (!['stable', 'beta'].includes(config.channel)) block('channel', 'Select the stable or beta release channel.');
  let approvedLicense = false;
  if (config.licenseStatus === 'approved' && /^LICENSE(?:\.txt|\.md)?$/.test(config.licenseFile || '')) {
    try {
      const bytes = await ordinaryFile(root, config.licenseFile);
      const content = bytes.toString('utf8');
      approvedLicense = bytes.length >= 80 && !/\b(?:TODO|TBD|license pending|not yet licensed)\b/i.test(content);
    } catch { /* remains a blocker */ }
  }
  if (!approvedLicense) block('license', 'Obtain the owner\'s license decision, include the approved LICENSE text, and set licenseStatus to approved with licenseFile. A pending source archive grants no open-source license.');

  const audit = await auditPublication({ root, packageRoot });
  if (!audit.ok) fail('publication-audit', 'Source or package audit found private data, credentials, unsupported content or unsafe links. See redacted findings.');
  const packageFiles = audit.package?.files || [];
  for (const path of ['Mosaic.exe', 'resources/app/package.json', 'resources/app/release.config.json', 'resources/app/desktop/main.mjs']) {
    if (!packageFiles.some((entry) => entry.path === path && entry.bytes > 0)) fail('package-missing', 'Build the complete Windows application folder for the current version.');
  }
  for (const path of ['LICENSE', 'LICENSES.chromium.html', 'UI-LICENSES.txt']) {
    if (!packageFiles.some((entry) => entry.path === path && entry.bytes > 0)) fail('notices', 'Preserve Electron/Chromium and bundled UI dependency notices in the package.');
  }
  if (!packageFiles.some((entry) => entry.path.startsWith('docs/distribution/') && entry.bytes > 0)) fail('documentation', 'Bundle the distribution documentation.');
  const runtimeSource = (path) => /^desktop\/(?:[^/]+\.(?:mjs|cjs|js|html)|(?:ai|chrome)\/.+\.(?:mjs|cjs|js|html))$/.test(path) || /^shared\/.+\.(?:mjs|cjs|js)$/.test(path) || path === 'scripts/mcp.mjs';
  const sourceFiles = new Map(audit.source.files.map((file) => [file.path, file]));
  const packedFiles = new Map(packageFiles.map((file) => [file.path, file]));
  for (const name of INSTALLER_NOTICE_FILES) {
    const upstream = sourceFiles.get('installer/' + name), shipped = packedFiles.get('THIRD-PARTY-NOTICES/' + name);
    if (!upstream?.bytes || !shipped?.bytes || upstream.sha256 !== shipped.sha256) fail('notices', 'Bundle unchanged NSIS, electron-builder, StdUtils and 7-Zip notices from installer/ into THIRD-PARTY-NOTICES/.');
  }
  for (const file of audit.source.files) {
    const target = runtimeSource(file.path) ? 'resources/app/' + file.path : file.path === 'README.md' || file.path.startsWith('docs/distribution/') ? file.path : null;
    if (target && packedFiles.get(target)?.sha256 !== file.sha256) fail('package-source', 'Repackage the current runtime sources, README and distribution documents; the shipped bytes differ.');
  }
  for (const file of packageFiles) {
    if (file.path.startsWith('resources/app/')) {
      const local = file.path.slice('resources/app/'.length);
      if (runtimeSource(local) && sourceFiles.get(local)?.sha256 !== file.sha256) fail('package-source', 'Packaged runtime files must match the currently audited source.');
    }
  }
  try {
    const stamp = await json(join(packageRoot, 'resources/app/dist/BUILD-SOURCE.json'));
    if (stamp.schemaVersion !== 1 || !Array.isArray(stamp.inputs) || !Array.isArray(stamp.outputs)) throw new Error();
    if (fileIdentity(stamp.inputs) !== fileIdentity(buildInputs(audit.source.files))) fail('build-stale', 'Renderer inputs changed after the recorded build. Run npm run build, then repackage and rebuild artifacts.');
    const actual = packageFiles.filter((file) => file.path.startsWith('resources/app/dist/') && file.path !== 'resources/app/dist/BUILD-SOURCE.json').map((file) => ({ ...file, path: file.path.slice('resources/app/dist/'.length) }));
    if (fileIdentity(stamp.outputs) !== fileIdentity(actual) || !actual.some((file) => file.path === 'index.html')) fail('build-output', 'Packaged renderer files differ from the recorded build outputs.');
  } catch { fail('build-provenance', 'A build-generated dist/BUILD-SOURCE.json with current input/output hashes is required.'); }
  try {
    const packed = await json(join(packageRoot, 'resources/app/package.json'));
    if (packed.version !== version) fail('package-version', 'Packaged app version differs from package.json.');
    if (configIdentity(await json(join(packageRoot, 'resources/app/release.config.json'))) !== configIdentity(config)) fail('config-mismatch', 'Rebuild the package after changing release.config.json.');
    const manifest = await json(join(packageRoot, 'PACKAGE-MANIFEST.json'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || fileIdentity(manifest.files) !== fileIdentity(packageFiles.filter((file) => file.path !== 'PACKAGE-MANIFEST.json'))) fail('package-integrity', 'The package file manifest is stale or the application folder was changed.');
  } catch { fail('package-integrity', 'A readable package manifest and packaged metadata are required.'); }

  const expectedArtifacts = [{ kind: 'installer', file: base + '-setup.exe' }, { kind: 'portable', file: base + '-portable.zip' }];
  try {
    const manifestBytes = await ordinaryFile(release, base + '-artifacts.json');
    const checksumBytes = await ordinaryFile(release, base + '-SHA256SUMS.txt');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const checksums = checksumMap(checksumBytes.toString('utf8'));
    if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.platform !== 'win32-x64' || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) throw new Error();
    const payloadHash = sha256(await ordinaryFile(packageRoot, 'PACKAGE-MANIFEST.json'));
    if (manifest.packageManifestSha256 !== payloadHash) fail('artifact-payload', 'Installer/portable artifacts were built from a different application payload. Rebuild both artifacts.');
    for (const expected of expectedArtifacts) {
      const recorded = manifest.artifacts.filter((item) => item.kind === expected.kind && item.file === expected.file);
      if (recorded.length !== 1) throw new Error();
      const data = await ordinaryFile(release, expected.file), digest = sha256(data);
      if (!data.length || data.length !== recorded[0].bytes || digest !== recorded[0].sha256 || checksums.get(expected.file) !== digest) throw new Error();
      bindAsset(expected.file, data);
    }
    bindAsset(base + '-artifacts.json', manifestBytes);
    bindAsset(base + '-SHA256SUMS.txt', checksumBytes);
  } catch { fail('artifact-integrity', 'Installer/portable files, artifact manifest and SHA256SUMS must agree for the current version.'); }

  try {
    const stem = `Mosaic-${version}-source`;
    const bytes = await ordinaryFile(release, stem + '.zip');
    const manifestBytes = await ordinaryFile(release, stem + '-manifest.json');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const checksumBytes = await ordinaryFile(release, stem + '-SHA256SUMS.txt');
    const checksums = checksumMap(checksumBytes.toString('utf8'));
    const entries = readSourceArchive(bytes);
    if (checksums.get(stem + '.zip') !== sha256(bytes) || checksums.get(stem + '-manifest.json') !== sha256(manifestBytes) || !entries.get('SOURCE-MANIFEST.json')?.equals(manifestBytes) || manifest.schemaVersion !== 1 || manifest.version !== version || !Array.isArray(manifest.files) || entries.size !== manifest.files.length + 1) throw new Error();
    for (const file of manifest.files) {
      const data = entries.get(file.path);
      if (!data || data.length !== file.bytes || sha256(data) !== file.sha256) throw new Error();
    }
    if (fileIdentity(manifest.files) !== fileIdentity(audit.source.files)) fail('source-stale', 'Source files changed since export. Re-run export-source.mjs after the final edit.');
    bindAsset(stem + '.zip', bytes);
    bindAsset(stem + '-manifest.json', manifestBytes);
    bindAsset(stem + '-SHA256SUMS.txt', checksumBytes);
  } catch { fail('source-integrity', 'Generate an audited source archive, matching manifest and source checksums.'); }

  const signatureFiles = packageFiles.filter((entry) => ['.exe', '.dll', '.node'].includes(extname(entry.path).toLowerCase())).map((entry) => ({ file: base + '/' + entry.path, absolute: join(packageRoot, entry.path) }));
  signatureFiles.push({ file: base + '-setup.exe', absolute: join(release, base + '-setup.exe') });
  const signatureResults = await signatures(signatureFiles, config.publisher);
  const signing = evaluateSigningPolicy(config, signatureResults);
  blockers.push(...signing.blockers);
  if (approvedLicense) {
    const license = audit.source.files.find((entry) => entry.path === config.licenseFile);
    const packedLicense = packageFiles.find((entry) => entry.path === 'MOSAIC-LICENSE.txt');
    if (!license || !packedLicense || packedLicense.sha256 !== license.sha256) fail('license-copy', 'Bundle the approved Mosaic license as MOSAIC-LICENSE.txt without replacing Electron LICENSE.');
  }
  const publicReady = errors.length === 0 && blockers.length === 0;
  return {
    schemaVersion: 1, version, mode, ok: errors.length === 0 && (mode === 'draft' || publicReady), publicReady,
    sourceSha256: sha256(JSON.stringify(audit.source.files)), validatedAssets,
    signingMode: signing.signingMode, signed: signing.signed, warnings: signing.warnings,
    scope: 'Artifact integrity, publication allowlist and live Windows signatures. Native/install smoke tests and owner legal approval remain separate release requirements.',
    errors, blockers, audit: { ok: audit.ok, sourceFiles: audit.source.files.length, packageFiles: packageFiles.length, findings: audit.findings }, signatures: signatureResults,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--draft', '--public'].includes(args[0])) throw new Error();
    const report = await evaluateRelease({ mode: args[0].slice(2) });
    await mkdir(join(projectRoot, 'release'), { recursive: true });
    await writeFile(join(projectRoot, 'release', `release-check-${report.mode}.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch { console.error('Release check failed. Usage: node scripts/check-release.mjs --draft | --public. No file contents are logged.'); process.exitCode = 1; }
}
