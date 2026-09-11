/**
 * Capability resolution and installation.
 *
 * Skills, plugins and MCP servers are what turn a general harness into a
 * specific agent, so how they are resolved decides whether a run is
 * reproducible. The rule here: **a capability is identified by its content
 * digest, not by where it came from.**
 *
 * A version records the digest it resolved. Re-running that version a month
 * later installs byte-identical artifacts, even if the branch has moved, the
 * registry entry was republished, or the upload was replaced. Source fields
 * describe provenance; the digest decides what actually runs.
 */

import { conflict, notFound, randomToken, sha256Hex, validationError, type Clock, type Logger } from '@ma/core';
import type { CapabilityRef, CapabilitySource } from '@ma/contracts';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** A resolved artifact, ready to install. */
export interface CapabilityArtifact {
  digest: string;
  /** Archive bytes, or the file content for a single-file skill. */
  content: Uint8Array;
  /** Where it came from, for the audit trail. */
  provenance: {
    source: CapabilitySource;
    repo?: string;
    commit?: string;
    version?: string;
  };
}

/**
 * Fetches artifacts from one kind of source.
 *
 * Implementations must be *content-addressed on the way out*: whatever they
 * fetch, the digest they return has to be of the bytes they return.
 */
export interface CapabilityResolver {
  readonly source: CapabilitySource;
  /**
   * Resolve a reference to concrete bytes.
   *
   * For a mutable reference (a branch, a `latest` tag) this pins it — the
   * returned provenance records the exact commit or version resolved, so the
   * result can be reproduced.
   */
  resolve(ref: CapabilityRef): Promise<CapabilityArtifact>;
}

/** Content-addressed artifact storage. */
export interface ArtifactStore {
  has(digest: string): Promise<boolean>;
  get(digest: string): Promise<Uint8Array | undefined>;
  /** Store bytes under their own digest. Idempotent by construction. */
  put(content: Uint8Array): Promise<string>;
}

/** In-memory storage, for development and tests. */
export class MemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, Uint8Array>();

  has(digest: string): Promise<boolean> {
    return Promise.resolve(this.#artifacts.has(digest));
  }

  get(digest: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.#artifacts.get(digest));
  }

  put(content: Uint8Array): Promise<string> {
    const digest = sha256Hex(content);
    // Content-addressed, so re-putting identical bytes is a no-op rather than
    // a duplicate.
    if (!this.#artifacts.has(digest)) this.#artifacts.set(digest, content);
    return Promise.resolve(digest);
  }

  get size(): number {
    return this.#artifacts.size;
  }
}

/**
 * Content-addressed artifact storage on disk.
 *
 * Survives a restart and is shared across control-plane processes, so a skill
 * uploaded or git-fetched by one process is downloadable by any other — the
 * in-memory store lost every capability on restart, which made the download
 * endpoint (and thus every installed skill) fail after a bounce.
 *
 * A blob is written to a temp name and renamed into place, so a crash mid-write
 * never leaves a truncated file under a digest that promises its content.
 */
export class FilesystemArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async has(digest: string): Promise<boolean> {
    return (await this.get(digest)) !== undefined;
  }

  async get(digest: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(digest)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(content: Uint8Array): Promise<string> {
    const digest = sha256Hex(content);
    const path = this.#path(digest);
    // Content-addressed: identical bytes already stored are a no-op.
    if (await this.has(digest)) return digest;
    await mkdir(dirname(path), { recursive: true });
    const staging = `${path}.${randomToken(8)}.partial`;
    try {
      await writeFile(staging, content);
      await rename(staging, path);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => {});
      throw error;
    }
    return digest;
  }

  #path(digest: string): string {
    // The digest becomes a filesystem path here, so it is validated rather than
    // trusted to have been computed by us.
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw validationError('A capability digest must be 64 lowercase hex characters');
    }
    // Shard by the first two hex chars so one directory does not accumulate
    // every artifact.
    return join(this.#root, digest.slice(0, 2), digest);
  }
}

/** Uploaded artifacts, addressed by the digest of what was uploaded. */
export class UploadResolver implements CapabilityResolver {
  readonly source = 'upload' as const;
  readonly #artifacts: ArtifactStore;

  constructor(artifacts: ArtifactStore) {
    this.#artifacts = artifacts;
  }

  async resolve(ref: CapabilityRef): Promise<CapabilityArtifact> {
    const content = await this.#artifacts.get(ref.digest);
    if (!content) throw notFound('Artifact', ref.digest);
    return {
      digest: ref.digest,
      content,
      provenance: { source: 'upload', ...(ref.version ? { version: ref.version } : {}) },
    };
  }
}

/**
 * A curated registry of shared capabilities.
 *
 * Entries are versioned and immutable once published: republishing over a
 * version would change what an existing agent runs without anyone editing it,
 * which is precisely what content addressing exists to prevent.
 */
export class RegistryResolver implements CapabilityResolver {
  readonly source = 'registry' as const;
  readonly #entries = new Map<string, { digest: string; content: Uint8Array; version: string }>();
  readonly #artifacts: ArtifactStore;

  constructor(artifacts: ArtifactStore) {
    this.#artifacts = artifacts;
  }

  /** Publish a version. Fails if that exact version already exists. */
  async publish(name: string, version: string, content: Uint8Array): Promise<string> {
    const key = `${name}@${version}`;
    if (this.#entries.has(key)) {
      throw conflict('This registry version has already been published', { name, version });
    }
    const digest = await this.#artifacts.put(content);
    this.#entries.set(key, { digest, content, version });
    // `latest` is a moving pointer, resolved once at version-creation time and
    // then frozen into the digest.
    this.#entries.set(`${name}@latest`, { digest, content, version });
    return digest;
  }

  async resolve(ref: CapabilityRef): Promise<CapabilityArtifact> {
    const key = `${ref.name}@${ref.version || 'latest'}`;
    const entry = this.#entries.get(key);
    if (!entry) throw notFound('Registry capability', key);

    return {
      digest: entry.digest,
      content: entry.content,
      provenance: { source: 'registry', version: entry.version },
    };
  }
}

/** Fetches a repository at a commit. */
export interface GitFetcher {
  /** Resolve a ref (branch, tag, sha) to a concrete commit sha. */
  resolveCommit(repo: string, ref: string): Promise<string>;
  /** Fetch the tree at a commit as an archive. */
  fetchArchive(repo: string, commit: string): Promise<Uint8Array>;
}

/**
 * Capabilities from a Git repository.
 *
 * A branch is resolved to a commit at version-creation time and that commit is
 * what the version records. Otherwise "install the skill from main" would mean
 * something different every time the branch moved, and two sessions of the same
 * version could run different code.
 */
export class GitResolver implements CapabilityResolver {
  readonly source = 'git' as const;
  readonly #fetcher: GitFetcher;
  readonly #artifacts: ArtifactStore;

  constructor(fetcher: GitFetcher, artifacts: ArtifactStore) {
    this.#fetcher = fetcher;
    this.#artifacts = artifacts;
  }

  async resolve(ref: CapabilityRef): Promise<CapabilityArtifact> {
    if (!ref.repo) throw validationError('A git capability needs a repo', { name: ref.name });

    const commit = ref.commit ?? (await this.#fetcher.resolveCommit(ref.repo, ref.ref ?? 'HEAD'));
    const content = await this.#fetcher.fetchArchive(ref.repo, commit);
    const digest = await this.#artifacts.put(content);

    return {
      digest,
      content,
      provenance: { source: 'git', repo: ref.repo, commit },
    };
  }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface InstallPlan {
  ref: CapabilityRef;
  artifact: CapabilityArtifact;
  /** True when the resolved digest differs from what the reference claimed. */
  digestChanged: boolean;
}

export interface CapabilityServiceOptions {
  resolvers: CapabilityResolver[];
  artifacts: ArtifactStore;
  clock: Clock;
  logger?: Logger;
}

export class CapabilityService {
  readonly #resolvers = new Map<CapabilitySource, CapabilityResolver>();
  readonly #artifacts: ArtifactStore;
  readonly #logger: Logger | undefined;

  constructor(options: CapabilityServiceOptions) {
    for (const resolver of options.resolvers) this.#resolvers.set(resolver.source, resolver);
    this.#artifacts = options.artifacts;
    this.#logger = options.logger;
  }

  /**
   * Pin a reference for storage on a version.
   *
   * Called when a version is *created*, never when a session starts. Resolving
   * at session time would mean a running agent's capabilities could change
   * under it — the exact drift immutable versions exist to prevent.
   */
  async pin(ref: CapabilityRef): Promise<CapabilityRef> {
    // A builtin is part of the runtime image; there is nothing to fetch.
    if (ref.source === 'builtin') return ref;

    const resolver = this.#resolvers.get(ref.source);
    if (!resolver) {
      throw validationError(`No resolver is registered for '${ref.source}' capabilities`, {
        name: ref.name,
        source: ref.source,
      });
    }

    const artifact = await resolver.resolve(ref);

    return {
      ...ref,
      digest: artifact.digest,
      ...(artifact.provenance.commit ? { commit: artifact.provenance.commit } : {}),
      ...(artifact.provenance.version ? { version: artifact.provenance.version } : {}),
    };
  }

  /** Pin a whole set, reporting every failure rather than the first. */
  async pinAll(refs: readonly CapabilityRef[]): Promise<{
    pinned: CapabilityRef[];
    failures: { name: string; reason: string }[];
  }> {
    const pinned: CapabilityRef[] = [];
    const failures: { name: string; reason: string }[] = [];

    for (const ref of refs) {
      try {
        pinned.push(await this.pin(ref));
      } catch (error) {
        // Collected rather than thrown: an author fixing three broken skills
        // should learn about all three in one attempt.
        failures.push({
          name: ref.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { pinned, failures };
  }

  /**
   * Prepare the artifacts a version needs, verifying each digest.
   *
   * The verification is the point: an artifact store returning bytes that do
   * not hash to the requested digest has been corrupted or tampered with, and
   * installing it anyway would defeat content addressing entirely.
   */
  async plan(refs: readonly CapabilityRef[]): Promise<InstallPlan[]> {
    const plans: InstallPlan[] = [];

    for (const ref of refs) {
      if (ref.source === 'builtin') continue;

      const content = await this.#artifacts.get(ref.digest);
      if (!content) {
        // Not cached: re-resolve, which for a pinned commit or version fetches
        // exactly the same bytes.
        const resolver = this.#resolvers.get(ref.source);
        if (!resolver) throw notFound('CapabilityResolver', ref.source);
        const artifact = await resolver.resolve(ref);

        if (artifact.digest !== ref.digest) {
          throw conflict('The resolved artifact does not match the pinned digest', {
            name: ref.name,
            expected: ref.digest,
            actual: artifact.digest,
          });
        }
        await this.#artifacts.put(artifact.content);
        plans.push({ ref, artifact, digestChanged: false });
        continue;
      }

      const actual = sha256Hex(content);
      if (actual !== ref.digest) {
        throw conflict('A stored artifact does not match its digest', {
          name: ref.name,
          expected: ref.digest,
          actual,
        });
      }

      plans.push({
        ref,
        artifact: { digest: ref.digest, content, provenance: { source: ref.source } },
        digestChanged: false,
      });
    }

    return plans;
  }

  /**
   * Would re-resolving this reference produce different bytes?
   *
   * Useful before publishing a new version: it answers "has the branch moved
   * since I pinned this?" without changing anything.
   */
  async hasDrifted(ref: CapabilityRef): Promise<{ drifted: boolean; currentDigest?: string }> {
    if (ref.source === 'builtin') return { drifted: false };

    const resolver = this.#resolvers.get(ref.source);
    if (!resolver) return { drifted: false };

    try {
      // Deliberately drop the pin, so this asks what the *reference* points at
      // now rather than re-confirming the digest we already hold.
      const { commit: _commit, ...unpinned } = ref;
      const artifact = await resolver.resolve(unpinned as CapabilityRef);
      return {
        drifted: artifact.digest !== ref.digest,
        currentDigest: artifact.digest,
      };
    } catch (error) {
      this.#logger?.warn('drift check failed', { name: ref.name, error });
      return { drifted: false };
    }
  }
}
