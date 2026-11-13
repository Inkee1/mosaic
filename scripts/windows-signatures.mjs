import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { assertNoLinkedParents, collectFiles, exists, pathsForRelease, sha256File, verifyPackage, writePackageManifest } from './windows-release.mjs';

const execute = promisify(execFile);

export function validateCertificateInput(value) {
  if (typeof value !== 'string' || !/^[A-Fa-f0-9]{40}$/.test(value) || value.length !== 40) {
    throw new Error('A certificate SHA1 thumbprint of exactly 40 hexadecimal characters is required');
  }
  return value.toUpperCase();
}

export async function collectSigningTargets(root, version) {
  const paths = pathsForRelease(root, version);
  await assertNoLinkedParents(root, paths.output);
  const files = (await collectFiles(paths.output))
    .filter(file => ['.exe', '.dll', '.node'].includes(extname(file).toLowerCase()))
    .map(file => ({ kind: 'runtime', file }));
  if (await exists(paths.installer)) {
    await assertNoLinkedParents(root, paths.installer);
    files.push({ kind: 'installer', file: paths.installer });
  }
  return files;
}

export async function powershellJson(command, extraEnv = {}) {
  if (process.platform !== 'win32') throw new Error('Windows is required for Authenticode and installer checks');
  const env = { ...process.env, ...extraEnv };
  // Let Windows PowerShell rebuild its module path instead of inheriting PowerShell 7 modules through Node.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" + command], {
    windowsHide: true, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

export async function inspectSignatures(targets, root) {
  const records = await powershellJson(`$files=ConvertFrom-Json $env:MOSAIC_SIGNATURE_FILES;$rows=@(foreach($file in $files){$s=Get-AuthenticodeSignature -LiteralPath $file;[pscustomobject]@{file=$file;status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint}});ConvertTo-Json -InputObject $rows -Compress`, {
    MOSAIC_SIGNATURE_FILES: JSON.stringify(targets.map(item => item.file)),
  });
  return records.map(record => ({
    ...record,
    file: relative(root, record.file).split(sep).join('/'),
    kind: targets.find(target => target.file.toLowerCase() === record.file.toLowerCase())?.kind,
  }));
}

export async function signingCertificate(thumbprint) {
  thumbprint = validateCertificateInput(thumbprint);
  const cert = await powershellJson(`$c=Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\'+$env:MOSAIC_SIGN_CERT);[pscustomobject]@{subject=$c.Subject;issuer=$c.Issuer;hasKey=$c.HasPrivateKey;expires=$c.NotAfter.ToUniversalTime().ToString('o');codeSigning=@($c.EnhancedKeyUsageList.ObjectId)-contains '1.3.6.1.5.5.7.3.3';chainValid=$c.Verify()}|ConvertTo-Json -Compress`, { MOSAIC_SIGN_CERT: thumbprint });
  if (!cert.hasKey || !cert.codeSigning || !cert.chainValid || cert.subject === cert.issuer || Date.parse(cert.expires) <= Date.now()) {
    throw new Error('An unexpired, trusted code-signing certificate with its private key is required');
  }
  return { ...cert, thumbprint };
}

export async function findSignTool() {
  if (process.env.MOSAIC_SIGNTOOL && await exists(process.env.MOSAIC_SIGNTOOL)) return process.env.MOSAIC_SIGNTOOL;
  const sdk = join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Windows Kits/10/bin');
  if (await exists(sdk)) {
    for (const version of (await readdir(sdk)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const file = join(sdk, version, 'x64/signtool.exe');
      if (await exists(file)) return file;
    }
  }
  throw new Error('Windows SDK signtool.exe is required. Set MOSAIC_SIGNTOOL to its full path if necessary.');
}

export async function signRuntime(root, version, thumbprint) {
  const cert = await signingCertificate(thumbprint);
  const signTool = await findSignTool();
  const paths = pathsForRelease(root, version);
  await verifyPackage(paths.output);
  const targets = (await collectSigningTargets(root, version)).filter(item => item.kind === 'runtime');
  for (const { file } of targets) {
    await execute(signTool, ['sign', '/sha1', cert.thumbprint, '/s', 'My', '/fd', 'SHA256', '/tr', 'https://timestamp.digicert.com', '/td', 'SHA256', file], { windowsHide: true, timeout: 120000 });
    await execute(signTool, ['verify', '/pa', '/all', file], { windowsHide: true, timeout: 60000 });
    console.log('Signed and verified: ' + relative(paths.output, file));
  }
  const signatures = await inspectSignatures(targets, root);
  if (!signatures.length || signatures.some(item => item.status !== 'Valid')) throw new Error('Runtime signature verification failed');
  const infoPath = join(paths.output, 'BUILD-INFO.json');
  const info = JSON.parse(await readFile(infoPath, 'utf8'));
  await writeFile(infoPath, JSON.stringify({ ...info, signed: true, signer: cert.subject,
    certificateThumbprint: cert.thumbprint, signedAt: new Date().toISOString(),
    runtimeSha256: await sha256File(join(paths.output, 'Mosaic.exe')),
    nativeRuntimeVerified: false, reason: 'Runtime signatures verified; rebuild installer and rerun native verification.',
  }, null, 2) + '\n');
  await writePackageManifest(paths.output);
  return cert;
}
