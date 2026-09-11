/**
 * ShellGitFetcher — resolve a ref to a commit and archive its tree, against a
 * real local git repository (not a mock: the CLI framing is the point).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ShellGitFetcher } from '../src/index.ts';

const run = promisify(execFile);

// A local repo we can resolve and archive without any network.
let repoDir: string;
let headSha: string;

before(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'ma-git-src-'));
  const git = (...args: string[]) => run('git', ['-C', repoDir, ...args]);
  await git('init', '--quiet', '--initial-branch=main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await writeFile(join(repoDir, 'SKILL.md'), '# a git skill');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'initial');
  const { stdout } = await git('rev-parse', 'HEAD');
  headSha = stdout.trim();
});

after(async () => {
  await rm(repoDir, { recursive: true, force: true }).catch(() => {});
});

describe('ShellGitFetcher', () => {
  test('resolves a branch ref to its commit sha', async () => {
    const fetcher = new ShellGitFetcher();
    const sha = await fetcher.resolveCommit(repoDir, 'main');
    assert.equal(sha, headSha);
  });

  test('returns a full sha ref unchanged without hitting the network', async () => {
    const fetcher = new ShellGitFetcher();
    assert.equal(await fetcher.resolveCommit(repoDir, headSha), headSha);
  });

  test('archives the tree at a commit as a readable tar', async () => {
    const fetcher = new ShellGitFetcher();
    const tar = await fetcher.fetchArchive(repoDir, headSha);
    // A tar stores entry names as plaintext in its headers; a valid archive of
    // this commit therefore contains the filename verbatim.
    const text = Buffer.from(tar).toString('latin1');
    assert.ok(tar.length > 0, 'the archive is non-empty');
    assert.ok(text.includes('SKILL.md'), 'the archive contains the committed file');
  });

  test('refuses a repo argument that looks like an option', async () => {
    const fetcher = new ShellGitFetcher();
    await assert.rejects(fetcher.resolveCommit('--upload-pack=touch /tmp/x', 'main'), /looks like an option/);
  });
});
