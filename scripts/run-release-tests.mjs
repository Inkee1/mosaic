import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from './audit-publication.mjs';
import { pathsForRelease, sha256File } from './windows-release.mjs';
import { sourceIdentity } from './release-evidence.mjs';

const suite = process.argv[2];
try {
  if (process.argv.length !== 3 || !['core', 'ui', 'native'].includes(suite)) throw new Error('Usage: node scripts/run-release-tests.mjs core|ui|native');
  const { version } = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const paths = pathsForRelease(projectRoot, version), directory = join(paths.release, 'checks');
  await mkdir(directory, { recursive: true });
  const file = join(directory, suite + '.json');
  const record = { schemaVersion: 1, version, suite, passed: false, sourceSha256: await sourceIdentity(projectRoot), startedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(record, null, 2) + '\n');
  const env = { ...process.env };
  let args;
  if (suite === 'core') args = ['--test', ...(await readdir(join(projectRoot, 'desktop/tests'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'desktop/tests/' + name)];
  else {
    args = ['node_modules/@playwright/test/cli.js', 'test'];
    if (suite === 'ui') {
      const port = await new Promise((resolve, reject) => {
        const server = createServer(); server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
      });
      env.MOSAIC_TEST_UI_PORT = String(port);
    }
    if (suite === 'native') {
      args.push('--config', 'playwright.desktop.config.ts');
      env.MOSAIC_TEST_EXECUTABLE = join(paths.output, 'Mosaic.exe');
      record.packageManifestSha256 = await sha256File(join(paths.output, 'PACKAGE-MANIFEST.json'));
    }
  }
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: projectRoot, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
  const unchanged = record.sourceSha256 === await sourceIdentity(projectRoot) && (suite !== 'native' || record.packageManifestSha256 === await sha256File(join(paths.output, 'PACKAGE-MANIFEST.json')));
  Object.assign(record, { passed: exitCode === 0 && unchanged, exitCode, unchanged, completedAt: new Date().toISOString() });
  await writeFile(file, JSON.stringify(record, null, 2) + '\n');
  if (!record.passed) throw new Error('Release tests failed or their source/package changed during the run.');
  console.log('Recorded passing ' + suite + ' tests for ' + version + '.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
