import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { verifyReleaseBundle } from './verify-release-bundle.mjs';
import { verifyRemoteTag } from './release-git.mjs';

const execute = promisify(execFile);
try {
  if (process.argv.length !== 4 || !['--check', '--publish'].includes(process.argv[2])) throw new Error('Usage: node scripts/publish-release.mjs --check|--publish DIRECTORY');
  const repository = process.env.GITHUB_REPOSITORY, commit = process.env.GITHUB_SHA;
  if (!repository || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Set the exact GITHUB_REPOSITORY and GITHUB_SHA of the tested source checkout.');
  const directory = resolve(process.argv[3]);
  const bundle = await verifyReleaseBundle(directory, { repository, commit });
  const tag = 'v' + bundle.version;
  if (process.argv[2] === '--check') console.log('Ready to publish ' + repository + ' ' + tag + '; no remote changes made.');
  else {
    const gh = args => execute('gh', args, { windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 });
    const read = async endpoint => {
      let stdout;
      try { ({ stdout } = await gh(['api', endpoint, '--include'])); }
      catch (error) {
        if (/^HTTP\/\S+\s+404\b/m.test(error.stdout || '')) return null;
        throw new Error('Cannot verify GitHub release refs; inspect the remote state before retrying.');
      }
      const body = stdout.replace(/\r\n/g, '\n').split('\n\n').slice(1).join('\n\n');
      return JSON.parse(body);
    };
    const remoteCommit = await read('repos/' + repository + '/git/commits/' + commit);
    if (remoteCommit?.sha !== commit) throw new Error('Tested commit is not available in the destination repository.');
    await verifyRemoteTag({ repository, tag, commit, read });
    // Creation refuses an existing release. Uploads finish while the release is
    // still a draft; failures never replace or expose a partial published release.
    await gh(['release', 'create', tag, ...bundle.files.filter(item => item.file !== 'release-notes.md').map(item => join(directory, item.file)), join(directory, 'RELEASE.json'),
      '--repo', repository, '--target', commit, '--title', 'Mosaic ' + bundle.version,
      '--notes-file', join(directory, 'release-notes.md'), '--draft', ...(bundle.channel === 'beta' ? ['--prerelease'] : [])]);
    await verifyRemoteTag({ repository, tag, commit, read });
    await gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=' + (bundle.channel === 'beta'), '--latest=' + (bundle.channel === 'stable')]);
    if (!await verifyRemoteTag({ repository, tag, commit, read })) throw new Error('Release was published but its tag could not be verified. Inspect the remote release.');
    console.log('Published https://github.com/' + repository + '/releases/tag/' + tag);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
