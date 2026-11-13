import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoLinkedParents, pathsForRelease } from './windows-release.mjs';
import { collectSigningTargets, findSignTool, inspectSignatures, signingCertificate, signRuntime, validateCertificateInput } from './windows-signatures.mjs';
import { buildInstaller } from './build-installer.mjs';

const args = process.argv.slice(2);
let certificate;
let mode = 'plan';
let selectedMode = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--certificate') certificate = validateCertificateInput(args[++i]);
  else if (['--plan', '--verify', '--sign'].includes(args[i]) && !selectedMode) {
    mode = args[i].slice(2); selectedMode = true;
  } else throw new Error('Usage: node scripts/sign-win.mjs [--plan | --verify | --sign] [--certificate SHA1]');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const paths = pathsForRelease(root, version);
await assertNoLinkedParents(root, paths.signatures);
const targets = await collectSigningTargets(root, version);
if (mode === 'sign') {
  validateCertificateInput(certificate);
  await signRuntime(root, version, certificate);
  // Rebuild both artifacts so embedded runtime + generated uninstaller + outer
  // installer all carry signatures. Builder signs its generated uninstaller.
  await buildInstaller(root, { certificate });
  console.log('Signed runtime, installer/uninstaller and portable ZIP rebuilt. Rerun native and installer verification.');
} else if (mode === 'verify') {
  const files = await inspectSignatures(targets, root);
  const signed = files.length > 0 && files.every(file => file.status === 'Valid') && files.some(file => file.kind === 'installer');
  await writeFile(paths.signatures, JSON.stringify({ schemaVersion: 1, version, verifiedAt: new Date().toISOString(), signed, files }, null, 2) + '\n');
  console.log(JSON.stringify({ signed, files }, null, 2));
  if (!signed) process.exitCode = 1;
} else {
  if (certificate) {
    const cert = await signingCertificate(certificate);
    await findSignTool();
    console.log('Certificate and signing tool ready: ' + cert.subject);
  }
  console.log(targets.map(item => `${item.kind}: ${relative(root, item.file).split(sep).join('/')}`).join('\n'));
  console.log('Also signed during NSIS generation: embedded Uninstall Mosaic.exe.');
  console.log('Plan only: no bytes changed. Use --certificate SHA1 --sign to sign the runtime and rebuild all artifacts.');
  if (!certificate) console.log('Trusted code-signing certificate not configured. No certificate is created or purchased.');
}
