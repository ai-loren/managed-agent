/**
 * A GitFetcher backed by the `git` CLI.
 *
 * Resolving a ref to a commit is a single `git ls-remote`; fetching the tree at
 * a commit is a shallow clone into a temp dir followed by `git archive`, which
 * produces a deterministic tar of exactly that commit. `git archive --remote`
 * is not supported by most https hosts, so the clone path is used instead.
 *
 * Every git invocation goes through `execFile` with an argument array — never a
 * shell — so a repo URL or ref cannot inject a command. The repo string is
 * additionally checked to look like a URL or path rather than an option, so a
 * value like `--upload-pack=...` cannot be smuggled in as the repo argument.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { GitFetcher } from './capabilities.ts';

const run = promisify(execFile);

export interface ShellGitFetcherOptions {
  /** The git executable. Defaults to `git` on PATH. */
  gitPath?: string;
  /** Per-command timeout. */
  timeoutMs?: number;
}

/** Reject a repo argument that is not plainly a URL or filesystem path. */
function assertSafeRepo(repo: string): void {
  if (repo.startsWith('-')) {
    throw new Error(`refusing a repo argument that looks like an option: ${repo}`);
  }
  const looksLikeUrl = /^(https?|git|ssh):\/\//.test(repo) || /^[^@\s]+@[^:\s]+:/.test(repo);
  const looksLikePath = repo.startsWith('/') || repo.startsWith('./') || repo.startsWith('../');
  if (!looksLikeUrl && !looksLikePath) {
    throw new Error(`refusing a repo that is neither a recognised URL nor a path: ${repo}`);
  }
}

/** Reject a ref that could be read as an option. */
function assertSafeRef(ref: string): void {
  if (ref.startsWith('-')) throw new Error(`refusing a ref that looks like an option: ${ref}`);
}

export class ShellGitFetcher implements GitFetcher {
  readonly #git: string;
  readonly #timeoutMs: number;

  constructor(options: ShellGitFetcherOptions = {}) {
    this.#git = options.gitPath ?? 'git';
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async resolveCommit(repo: string, ref: string): Promise<string> {
    assertSafeRepo(repo);
    assertSafeRef(ref);
    // A full 40-hex ref is already a commit; ls-remote would not list it.
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;

    const { stdout } = await run(this.#git, ['ls-remote', repo, ref], {
      timeout: this.#timeoutMs,
      maxBuffer: 1_000_000,
    });
    const line = stdout.split('\n').find((l) => l.trim().length > 0);
    const sha = line?.split(/\s+/)[0];
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`could not resolve '${ref}' in ${repo}`);
    }
    return sha;
  }

  async fetchArchive(repo: string, commit: string): Promise<Uint8Array> {
    assertSafeRepo(repo);
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`not a commit sha: ${commit}`);

    const dir = await mkdtemp(join(tmpdir(), 'ma-git-'));
    try {
      // Shallow-init and fetch exactly the one commit, then archive its tree.
      await run(this.#git, ['-C', dir, 'init', '--quiet'], { timeout: this.#timeoutMs });
      await run(this.#git, ['-C', dir, 'remote', 'add', 'origin', repo], { timeout: this.#timeoutMs });
      await run(this.#git, ['-C', dir, 'fetch', '--depth', '1', '--quiet', 'origin', commit], {
        timeout: this.#timeoutMs,
        maxBuffer: 50_000_000,
      });
      const out = join(dir, 'archive.tar');
      await run(this.#git, ['-C', dir, 'archive', '--format=tar', '-o', out, commit], {
        timeout: this.#timeoutMs,
        maxBuffer: 50_000_000,
      });
      return new Uint8Array(await readFile(out));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
