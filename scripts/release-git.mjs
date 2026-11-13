import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const repositoryName = value => /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(value || '');

export async function verifySourceCommit(root, { commit, repository, files }) {
  if (!sha(commit) || !repositoryName(repository)) throw new Error('A source commit and repository are required.');
  const git = async args => (await execute('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const canonical = async value => { const path = await realpath(value); return process.platform === 'win32' ? path.toLowerCase() : path; };
  if (await canonical((await git(['rev-parse', '--show-toplevel'])).trim()) !== await canonical(root)) throw new Error('Release source must be the repository root.');
  const remote = (await git(['remote', 'get-url', 'origin'])).trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*?)(?:\.git)?$/i.exec(remote);
  if (!match || match[1].toLowerCase() !== repository.toLowerCase()) throw new Error('Source repository does not match the release destination.');
  if ((await git(['rev-parse', '--verify', commit + '^{commit}'])).trim() !== commit) throw new Error('Invalid release commit.');
  const tree = (await git(['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match) throw new Error('Unsupported entry in source commit tree.');
    return { path: match[3], oid: match[2] };
  });
  if (JSON.stringify(tree.map(item => item.path).sort()) !== JSON.stringify(files.map(item => item.path).sort())) throw new Error('Audited source file list differs from the commit tree.');
  const expected = new Map(tree.map(item => [item.path, item.oid]));
  for (const file of files) {
    const oid = createHash('sha1').update('blob ' + file.data.length + '\0').update(file.data).digest('hex');
    if (oid !== expected.get(file.path)) throw new Error('Audited source bytes differ from the selected commit: ' + file.path);
  }
  return commit;
}

export async function verifyRemoteTag({ repository, tag, commit, read }) {
  if (!repositoryName(repository) || !sha(commit) || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/i.test(tag)) throw new Error('Invalid release tag identity.');
  let row = await read('repos/' + repository + '/git/ref/tags/' + encodeURIComponent(tag));
  if (row === null) return false;
  const visited = new Set();
  for (let depth = 0; depth < 8; depth++) {
    const object = row?.object;
    if (!sha(object?.sha)) throw new Error('Invalid remote tag.');
    if (object.type === 'commit') {
      if (object.sha !== commit) throw new Error('Existing release tag points to another commit.');
      return true;
    }
    if (object.type !== 'tag' || visited.has(object.sha)) throw new Error('Invalid or cyclic annotated tag.');
    visited.add(object.sha);
    row = await read('repos/' + repository + '/git/tags/' + object.sha);
  }
  throw new Error('Annotated tag nesting is too deep.');
}
