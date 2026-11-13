import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { projectRoot, prepareSource, sha256 } from './audit-publication.mjs';
import { evaluateRelease } from './check-release.mjs';
import { pathsForRelease, sha256File, assertNoLinkedParents } from './windows-release.mjs';
import { copyReleaseAsset, sourceIdentity, validateReleaseEvidence } from './release-evidence.mjs';
import { verifySourceCommit } from './release-git.mjs';

try {
  const arg = process.argv[2];
  if (process.argv.length !== 3 || !['--draft', '--public'].includes(arg)) throw new Error('Usage: node scripts/collect-release.mjs --draft|--public');
  const mode = arg.slice(2), report = await evaluateRelease({ mode });
  if (!report.ok) throw new Error('Release gate refused: ' + [...report.errors, ...report.blockers].map(item => item.code).join(', '));
  const config = JSON.parse(await readFile(join(projectRoot, 'release.config.json'), 'utf8'));
  const paths = pathsForRelease(projectRoot, report.version);
  const validated = new Map(report.validatedAssets.map(item => [item.file, item.sha256]));
  const manifestBytes = await readFile(paths.artifacts);
  if (sha256(manifestBytes) !== validated.get(paths.name + '-artifacts.json')) throw new Error('Artifact manifest changed after validation.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const readOptional = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
  const checks = Object.fromEntries(await Promise.all(['core', 'ui', 'native'].map(async suite => [suite, await readOptional(join(paths.release, 'checks', suite + '.json'))])));
  const context = { version: report.version, sourceSha256: report.sourceSha256, packageManifestSha256: manifest.packageManifestSha256, artifacts: manifest.artifacts };
  const evidenceBlockers = validateReleaseEvidence({ context, checks, installer: await readOptional(paths.smoke) });
  let commit = null;
  try {
    const source = await prepareSource(projectRoot);
    if (source.findings.length) throw new Error('Source audit failed.');
    commit = await verifySourceCommit(projectRoot, { commit: process.env.GITHUB_SHA, repository: config.repository, files: source.entries });
    if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.toLowerCase() !== config.repository.toLowerCase()) throw new Error('CI repository does not match.');
  } catch (error) {
    commit = null;
    if (mode === 'public') throw error;
    evidenceBlockers.push('source-commit');
  }
  if (mode === 'public' && evidenceBlockers.length) throw new Error('Final release evidence missing or stale: ' + evidenceBlockers.join(', '));
  const parent = join(paths.release, '.bundles');
  await assertNoLinkedParents(projectRoot, parent);
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'release-'));
  const stem = 'Mosaic-' + report.version;
  const files = [...manifest.artifacts.map(item => item.file), paths.name + '-artifacts.json', paths.name + '-SHA256SUMS.txt', stem + '-source.zip', stem + '-source-manifest.json', stem + '-source-SHA256SUMS.txt'];
  for (const file of files) {
    await copyReleaseAsset(join(paths.release, file), join(directory, file), validated.get(file));
  }
  const notes = await readFile(join(projectRoot, 'docs/distribution/release-notes.md'), 'utf8');
  await writeFile(join(directory, 'release-notes.md'), notes);
  files.push('release-notes.md');
  if (context.sourceSha256 !== await sourceIdentity(projectRoot)) throw new Error('Source changed during release collection.');
  const bundle = { schemaVersion: 1, ...context, repository: config.repository, channel: config.channel,
    commit,
    publicReady: report.publicReady && evidenceBlockers.length === 0,
    blockers: [...report.blockers.map(item => item.code), ...evidenceBlockers],
    checks: Object.fromEntries(['core', 'ui', 'native'].map(suite => [suite, !evidenceBlockers.includes(suite + '-tests')])),
    installerExecuted: !evidenceBlockers.includes('installer-smoke'),
    files: await Promise.all(files.map(async file => ({ file, sha256: await sha256File(join(directory, file)) }))),
    completedAt: new Date().toISOString() };
  await writeFile(join(directory, 'RELEASE.json'), JSON.stringify(bundle, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'directory=' + relative(projectRoot, directory).split(sep).join('/') + '\n');
  console.log(JSON.stringify({ directory, publicReady: bundle.publicReady, blockers: bundle.blockers }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
