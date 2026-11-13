import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySourceCommit, verifyRemoteTag } from '../../scripts/release-git.mjs';

test('release source must match the selected repository and exact committed tree, including CRLF bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mosaic-release-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async args => (await promisify(execFile)('git', args, { cwd: root, windowsHide: true })).stdout.trim();
  await git(['init', '-b', 'main']);
  await git(['config', 'core.autocrlf', 'true']);
  await git(['remote', 'add', 'origin', 'https://github.com/example/mosaic.git']);
  const files = [{ path: '.gitattributes', data: Buffer.from('* -text\n') }, { path: 'README.md', data: Buffer.from('Mosaic\r\n') }];
  for (const file of files) await writeFile(join(root, file.path), file.data);
  await git(['add', '.']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=user@example.test', 'commit', '-m', 'fixture']);
  const commit = await git(['rev-parse', 'HEAD']);
  assert.equal(await verifySourceCommit(root, { commit, repository: 'example/mosaic', files }), commit);
  await assert.rejects(verifySourceCommit(root, { commit, repository: 'other/mosaic', files }), /repository/i);
  await assert.rejects(verifySourceCommit(root, { commit, repository: 'example/mosaic', files: files.slice(1) }), /file|tree/i);
  await assert.rejects(verifySourceCommit(root, { commit, repository: 'example/mosaic', files: [...files, { path: 'new.md', data: Buffer.from('uncommitted') }] }), /file|tree/i);
  files[1].data = Buffer.from('uncommitted edit');
  await assert.rejects(verifySourceCommit(root, { commit, repository: 'example/mosaic', files }), /bytes|commit/i);
});

test('existing lightweight and annotated release tags must resolve to the tested commit', async () => {
  const commit = 'a'.repeat(40), tagSha = 'b'.repeat(40), wrong = 'c'.repeat(40);
  const options = { repository: 'example/mosaic', tag: 'v0.7.4', commit };
  assert.equal(await verifyRemoteTag({ ...options, read: async () => null }), false);
  assert.equal(await verifyRemoteTag({ ...options, read: async () => ({ object: { type: 'commit', sha: commit } }) }), true);
  assert.equal(await verifyRemoteTag({ ...options, read: async path => ({ object: path.includes('/git/tags/') ? { type: 'commit', sha: commit } : { type: 'tag', sha: tagSha } }) }), true);
  await assert.rejects(verifyRemoteTag({ ...options, read: async () => ({ object: { type: 'commit', sha: wrong } }) }), /commit/i);
  await assert.rejects(verifyRemoteTag({ ...options, read: async () => ({ object: { type: 'tag', sha: tagSha } }) }), /tag/i);
});
