import { mkdir, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSource, projectRoot, sha256 } from './audit-publication.mjs';

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const safeName = (name) => typeof name === 'string' && name.length > 0 && !name.startsWith('/') && !/[\\:\x00-\x1f]/.test(name) && name.split('/').every((part) => part && part !== '.' && part !== '..');

// Small source bundles use standard uncompressed ZIP32. Fixed timestamps and sorted
// names produce identical archives for identical audited bytes, without external tools.
function sourceZip(entries) {
  if (entries.length >= 65535) throw new Error('Source archive has too many entries.');
  const chunks = [], central = [];
  let offset = 0;
  for (const { path, data } of entries) {
    if (!safeName(path) || data.length > 16 * 1024 * 1024) throw new Error('Invalid source archive entry.');
    const name = Buffer.from(path, 'utf8'), checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    chunks.push(header, name, data);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
    if (offset > 64 * 1024 * 1024) throw new Error('Source archive exceeds 64 MiB.');
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

export function readSourceArchive(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 64 * 1024 * 1024) throw new Error();
    const end = bytes.length - 22;
    if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 20)) throw new Error();
    const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
    if (bytes.readUInt16LE(end + 8) !== count || start + bytes.readUInt32LE(end + 12) !== end) throw new Error();
    const entries = new Map();
    let local = 0, central = start;
    for (let index = 0; index < count; index++) {
      if (bytes.readUInt32LE(central) !== 0x02014b50 || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error();
      const nameLength = bytes.readUInt16LE(central + 28), size = bytes.readUInt32LE(central + 24), checksum = bytes.readUInt32LE(central + 16);
      if (bytes.readUInt16LE(central + 8) !== 0x800 || bytes.readUInt16LE(central + 10) || bytes.readUInt32LE(central + 20) !== size || bytes.readUInt16LE(central + 30) || bytes.readUInt16LE(central + 32) || bytes.readUInt16LE(central + 34) || bytes.readUInt16LE(central + 36) || bytes.readUInt32LE(central + 38) || bytes.readUInt32LE(central + 42) !== local || size > 16 * 1024 * 1024) throw new Error();
      const name = bytes.subarray(central + 46, central + 46 + nameLength).toString('utf8');
      if (!safeName(name) || entries.has(name)) throw new Error();
      if (bytes.readUInt16LE(local + 6) !== 0x800 || bytes.readUInt16LE(local + 8) || bytes.readUInt32LE(local + 14) !== checksum || bytes.readUInt32LE(local + 18) !== size || bytes.readUInt32LE(local + 22) !== size || bytes.readUInt16LE(local + 26) !== nameLength || bytes.readUInt16LE(local + 28)) throw new Error();
      if (bytes.subarray(local + 30, local + 30 + nameLength).toString('utf8') !== name) throw new Error();
      const dataStart = local + 30 + nameLength, dataEnd = dataStart + size;
      if (dataEnd > start) throw new Error();
      const data = bytes.subarray(dataStart, dataEnd);
      if (crc32(data) !== checksum) throw new Error();
      entries.set(name, data);
      local = dataEnd;
      central += 46 + nameLength;
    }
    if (local !== start || central !== end) throw new Error();
    return entries;
  } catch { throw new Error('Invalid source ZIP archive or CRC.'); }
}

async function atomicWrite(file, data) {
  const temp = file + '.' + process.pid + '.tmp';
  await writeFile(temp, data, { flag: 'wx' });
  await rename(temp, file);
}
export async function exportSource({ root = projectRoot } = {}) {
  root = await realpath(resolve(root));
  const audited = await prepareSource(root);
  if (audited.findings.length) throw new Error('Publication audit failed; no source archive was written. Run audit-publication.mjs for redacted findings.');
  const packageEntry = audited.entries.find((entry) => entry.path === 'package.json');
  const lockEntry = audited.entries.find((entry) => entry.path === 'package-lock.json');
  const configEntry = audited.entries.find((entry) => entry.path === 'release.config.json');
  if (!packageEntry || !lockEntry || !configEntry) throw new Error('Source export requires package.json, package-lock.json and release.config.json.');
  const pkg = JSON.parse(packageEntry.data.toString('utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(pkg.version)) throw new Error('Invalid release version.');
  const config = JSON.parse(configEntry.data.toString('utf8'));
  const manifest = {
    schemaVersion: 1, version: pkg.version, licenseStatus: config.licenseStatus,
    scope: 'Explicit publication allowlist; no profiles, connection state, environment files, logs or local development ledgers.',
    files: audited.entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };
  const manifestData = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const archiveData = sourceZip([...audited.entries, { path: 'SOURCE-MANIFEST.json', data: manifestData }]);
  readSourceArchive(archiveData);
  const output = join(root, 'release');
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink()) throw new Error('Release output must not be a symbolic link.');
  const rest = relative(root, await realpath(output));
  if (rest !== 'release' && rest !== 'release' + sep) throw new Error('Unsafe release output.');
  const base = `Mosaic-${pkg.version}-source`;
  const archive = join(output, base + '.zip'), manifestFile = join(output, base + '-manifest.json'), checksumFile = join(output, base + '-SHA256SUMS.txt');
  await atomicWrite(archive, archiveData);
  await atomicWrite(manifestFile, manifestData);
  await atomicWrite(checksumFile, `${sha256(archiveData)}  ${base}.zip\n${sha256(manifestData)}  ${base}-manifest.json\n`);
  return { archive, manifest: manifestFile, checksums: checksumFile, files: manifest.files.length, bytes: archiveData.length, sha256: sha256(archiveData) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('No arguments supported.');
    const result = await exportSource();
    console.log(JSON.stringify({ ...result, archive: relative(projectRoot, result.archive), manifest: relative(projectRoot, result.manifest), checksums: relative(projectRoot, result.checksums) }, null, 2));
  } catch (error) {
    console.error(error.message.startsWith('Publication audit failed') ? error.message : 'Source export failed. Verify the release configuration and source audit; file contents are not logged.');
    process.exitCode = 1;
  }
}
