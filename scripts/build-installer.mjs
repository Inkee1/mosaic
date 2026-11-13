import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build, Platform, Arch } from 'electron-builder';
import { assertContained, assertNoLinkedParents, exists, pathsForRelease, verifyPackage, writeArtifactManifest } from './windows-release.mjs';
import { collectSigningTargets, inspectSignatures, signingCertificate, validateCertificateInput } from './windows-signatures.mjs';

export async function prepareInstaller(root, { certificate } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const paths = pathsForRelease(root, pkg.version);
  await assertNoLinkedParents(root, paths.output);
  const info = await verifyPackage(paths.output);
  if (info.version !== pkg.version) throw new Error('Packaged version differs from package.json; rebuild the runtime');
  const sourceConfig = await readFile(join(root, 'release.config.json'), 'utf8');
  if (sourceConfig !== await readFile(join(paths.output, 'resources/app/release.config.json'), 'utf8')) {
    throw new Error('Packaged release configuration is stale; rebuild the runtime');
  }
  const config = JSON.parse(await readFile(join(root, 'installer/electron-builder.json'), 'utf8'));
  if (config.appId !== 'org.mosaic.browser' || config.nsis?.perMachine !== false ||
      config.nsis?.allowElevation !== false || config.nsis?.deleteAppDataOnUninstall !== false || config.nsis?.runAfterFinish !== false) {
    throw new Error('Installer configuration violates per-user/data-preservation requirements');
  }
  if (certificate) {
    await signingCertificate(validateCertificateInput(certificate));
    const records = await inspectSignatures((await collectSigningTargets(root, pkg.version)).filter(item => item.kind === 'runtime'), root);
    if (!records.length || records.some(item => item.status !== 'Valid')) throw new Error('Sign the complete runtime before assembling a signed installer');
    config.forceCodeSigning = true;
    delete config.win.signAndEditExecutable;
    config.win.signExecutable = true;
    config.win.signtoolOptions = { certificateSha1: certificate, signingHashAlgorithms: ['sha256'], rfc3161TimeStampServer: 'https://timestamp.digicert.com' };
  }
  config.electronVersion = pkg.devDependencies.electron;
  config.extraMetadata = { name: 'mosaic-browser', productName: 'Mosaic' };
  return { pkg, paths, config };
}

export async function buildInstaller(root, options = {}) {
  if (process.platform !== 'win32') throw new Error('Build this Windows installer on Windows');
  const { pkg, paths, config } = await prepareInstaller(root, options);
  const stage = assertContained(paths.release, join(paths.release, `.installer-build-${randomUUID()}`));
  await assertNoLinkedParents(paths.release, stage);
  await mkdir(stage, { recursive: true });
  // Explicitly never publish, never discover a signing identity in the default build.
  // Signed builds require the caller's explicit certificate argument.
  const previousDiscovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  try {
    config.directories.output = stage;
    await build({ projectDir: root, prepackaged: paths.output,
      targets: Platform.WINDOWS.createTarget(['nsis', 'zip'], Arch.x64), config, publish: 'never' });
    await verifyPackage(paths.output);
    for (const target of [paths.installer, paths.portable]) {
      await assertNoLinkedParents(root, target);
      const built = join(stage, basename(target));
      if (!await exists(built)) throw new Error('Builder did not produce expected artifact: ' + basename(target));
      await rename(built, target);
    }
    const records = await inspectSignatures(await collectSigningTargets(root, pkg.version), root);
    const signed = records.length > 0 && records.every(item => item.status === 'Valid');
    if (options.certificate && !signed) throw new Error('Signed build has invalid or missing Authenticode signatures');
    await assertNoLinkedParents(root, paths.signatures);
    await writeFile(paths.signatures, JSON.stringify({ schemaVersion: 1, version: pkg.version, verifiedAt: new Date().toISOString(), signed, files: records }, null, 2) + '\n');
    const manifest = await writeArtifactManifest(root, pkg.version, { signed });
    console.log('Installer and portable ZIP created; checksums: ' + paths.checksums);
    console.log(signed ? 'All shipped executable signatures verified.' : 'Unsigned preview. A trusted publisher certificate is still required for public release.');
    return manifest;
  } finally {
    if (previousDiscovery === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
    else process.env.CSC_IDENTITY_AUTO_DISCOVERY = previousDiscovery;
    await assertNoLinkedParents(paths.release, stage);
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let certificate;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--certificate') certificate = validateCertificateInput(args[++i]);
    else if (args[i] === '--check') check = true;
    else throw new Error('Usage: node scripts/build-installer.mjs [--check] [--certificate SHA1]');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (check) {
    const { paths } = await prepareInstaller(root, { certificate });
    console.log('Installer inputs verified: ' + paths.output);
  } else await buildInstaller(root, { certificate });
}
