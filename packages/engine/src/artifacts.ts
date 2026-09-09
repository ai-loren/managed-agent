/**
 * Artifact storage: the bytes an agent produced, kept after its sandbox is gone.
 *
 * Two things are separated here on purpose.
 *
 * **The blob store holds bytes; the repository holds records.** A blob is
 * addressed by the SHA-256 of its content, so two artifacts with identical
 * content share one blob and a record can only ever name content that was
 * actually stored. Nothing in a request chooses a storage path.
 *
 * **An `artifact.created` event is an announcement, not a record.** A sandbox
 * may append those events and every field in them is attacker-chosen. Records
 * are written here, from bytes this process received and hashed itself. If the
 * two were ever merged, an agent could point a row at content it never
 * uploaded.
 *
 * The download path carries the residual risk. Bytes an agent wrote are served
 * back to a human's browser, from the same origin as the console, so the
 * response headers are as much a part of this file as the storage is.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  MaError,
  newId,
  notFound,
  randomToken,
  validationError,
  type Clock,
  type Logger,
} from '@ma/core';
import { artifactMachine, type Artifact } from '@ma/contracts';
import type { Page, Store } from '@ma/store';

import { BaseService, type ServiceDeps } from './agents.ts';
import type { AuthContext } from './authz.ts';

/**
 * Where artifact bytes live.
 *
 * Deliberately small, and deliberately content-addressed: `put` takes bytes and
 * returns nothing, because the caller already knows the digest — it computed
 * it. A store that accepted a caller-chosen key would be one traversal string
 * away from writing outside itself.
 */
export interface BlobStore {
  /** Store bytes under their digest. Idempotent: the same digest is the same blob. */
  put(workspaceId: string, digest: string, bytes: Uint8Array): Promise<void>;
  /** Read bytes back, or `undefined` when the blob is gone. */
  get(workspaceId: string, digest: string): Promise<Uint8Array | undefined>;
  /** Remove bytes. Idempotent: deleting what is already gone is success. */
  delete(workspaceId: string, digest: string): Promise<void>;
}

export interface FilesystemBlobStoreOptions {
  /** Root directory. Created on demand. */
  root: string;
  logger?: Logger;
}

/**
 * A blob store over a directory tree.
 *
 * Layout is `<root>/<workspaceId>/<digest[0:2]>/<digest>`: sharded by the first
 * byte so no directory holds a million entries, and scoped by workspace so a
 * tenant's bytes are separable on disk — which is what makes "delete this
 * workspace" a directory removal rather than a query.
 *
 * Every path component is derived from a validated digest or a validated
 * workspace id, never from anything a caller supplied.
 */
export class FilesystemBlobStore implements BlobStore {
  readonly #root: string;
  readonly #logger: Logger | undefined;

  constructor(options: FilesystemBlobStoreOptions) {
    this.#root = options.root;
    this.#logger = options.logger;
  }

  async put(workspaceId: string, digest: string, bytes: Uint8Array): Promise<void> {
    const path = this.#path(workspaceId, digest);
    await mkdir(dirname(path), { recursive: true });

    // Write to a temporary name and rename into place. A crash mid-write would
    // otherwise leave a truncated file under a digest that promises its
    // content — and every later read would trust it. Rename is atomic within a
    // filesystem, so a blob either exists whole or not at all.
    const staging = `${path}.${randomToken(8)}.partial`;
    try {
      await writeFile(staging, bytes);
      await rename(staging, path);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => {
        // The write already failed; a leftover temp file is not worth masking it.
      });
      throw error;
    }
  }

  async get(workspaceId: string, digest: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.#path(workspaceId, digest));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async delete(workspaceId: string, digest: string): Promise<void> {
    await rm(this.#path(workspaceId, digest), { force: true }).catch((error: unknown) => {
      this.#logger?.warn('failed to delete a blob', { workspaceId, digest, error });
    });
  }

  #path(workspaceId: string, digest: string): string {
    // Both components are validated rather than trusted. A digest reaching here
    // has been computed by us, but this is the function that turns a string
    // into a filesystem path and it should not depend on that being true
    // somewhere else.
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw validationError('A blob digest must be 64 lowercase hex characters');
    }
    if (!/^ws_[0-9A-Z]{26}$/.test(workspaceId)) {
      throw validationError('A blob workspace id must be a workspace ULID');
    }
    return join(this.#root, workspaceId, digest.slice(0, 2), digest);
  }
}

/** An in-memory blob store, for tests and for a `:memory:` deployment. */
export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, Uint8Array>();

  put(workspaceId: string, digest: string, bytes: Uint8Array): Promise<void> {
    this.#blobs.set(`${workspaceId}/${digest}`, bytes);
    return Promise.resolve();
  }

  get(workspaceId: string, digest: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.#blobs.get(`${workspaceId}/${digest}`));
  }

  delete(workspaceId: string, digest: string): Promise<void> {
    this.#blobs.delete(`${workspaceId}/${digest}`);
    return Promise.resolve();
  }

  get size(): number {
    return this.#blobs.size;
  }
}

export interface ArtifactServiceOptions extends ServiceDeps {
  blobs: BlobStore;
  /** Largest single artifact. Beyond this an upload is refused outright. */
  maxBytes?: number;
  /** Retention, in days. 0 keeps artifacts until something deletes them. */
  retentionDays?: number;
}

export interface PublishRequest {
  workspaceId: string;
  sessionId: string;
  /** The agent's label for the file. Display only. */
  path: string;
  bytes: Uint8Array;
  turn?: number;
}

/** 25 MB. Large enough for a report or a build log, small enough to hold in memory. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export class ArtifactService extends BaseService {
  readonly #blobs: BlobStore;
  readonly #maxBytes: number;
  readonly #retentionDays: number;

  constructor(options: ArtifactServiceOptions) {
    super(options);
    this.#blobs = options.blobs;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#retentionDays = options.retentionDays ?? 0;
  }

  /**
   * Store bytes a sandbox produced.
   *
   * Called from the runtime bridge with a session-scoped identity, so there is
   * no `AuthContext` here: the sandbox's authority is its token, and the
   * session it resolves to is the only one it may write for. The caller passes
   * `workspaceId` and `sessionId` from that resolved identity, never from the
   * request body.
   */
  async publish(request: PublishRequest): Promise<{ artifact: Artifact; created: boolean }> {
    if (request.bytes.byteLength > this.#maxBytes) {
      throw new MaError({
        code: 'ARTIFACT_TOO_LARGE',
        category: 'validation',
        message: `An artifact may be at most ${this.#maxBytes} bytes; this one is ${request.bytes.byteLength}`,
      });
    }

    const workspace = await this.requireWorkspace(request.workspaceId);

    // Computed here, over the bytes actually received. Everything downstream
    // that trusts this row trusts this line.
    const digest = createHash('sha256').update(request.bytes).digest('hex');
    const contentType = sniffContentType(request.bytes);
    const now = this.clock.now();

    const artifact: Artifact = {
      id: newId('artifact', now),
      workspaceId: workspace.id,
      sessionId: request.sessionId,
      ...(request.turn === undefined ? {} : { turn: request.turn }),
      path: sanitizePath(request.path),
      contentType,
      sizeBytes: request.bytes.byteLength,
      digest,
      status: 'available',
      ...(this.#retentionDays > 0
        ? { expiresAt: now + this.#retentionDays * 24 * 60 * 60 * 1000 }
        : {}),
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: request.sessionId,
    };

    // The row first, atomically against the storage limit, and only then the
    // bytes. The other order would let a refused upload leave orphaned bytes on
    // disk with nothing referencing them — invisible, and charged to nobody.
    const limitBytes = workspace.quota.maxStorageMb * 1024 * 1024;
    const stored = await this.store.artifacts.createWithinStorageLimit(artifact, limitBytes);

    if (!stored) {
      throw new MaError({
        code: 'QUOTA_EXCEEDED',
        category: 'quota',
        message: `This workspace has used its ${workspace.quota.maxStorageMb} MB of artifact storage`,
        details: { dimension: 'storageMb', limit: workspace.quota.maxStorageMb },
      });
    }

    if (stored.created) {
      try {
        await this.#blobs.put(workspace.id, digest, request.bytes);
      } catch (error) {
        // The bytes never landed, so the row must not claim they exist or every
        // download would 404 forever. How to undo depends on what `created`
        // meant. A brand-new row (its id is the one we just minted) is removed
        // outright. A *revived* purged row kept its original id — deleting it
        // would erase real history ("this session produced a report"), so it is
        // returned to `purged` instead, exactly where it was a moment ago.
        const wasRevived = stored.artifact.id !== artifact.id;
        if (wasRevived) {
          await this.store.artifacts
            .update(stored.artifact.id, { status: 'purged', purgedAt: now, updatedAt: now })
            .catch(() => {
              this.logger?.error('failed to re-purge a revived artifact row', {
                artifactId: stored.artifact.id,
              });
            });
        } else {
          await this.store.artifacts.delete(stored.artifact.id).catch(() => {
            this.logger?.error('failed to roll back an artifact row', {
              artifactId: stored.artifact.id,
            });
          });
        }
        throw error;
      }
    }

    return stored;
  }

  /** List a workspace's artifacts, optionally narrowed to one session. */
  async list(
    context: AuthContext,
    workspaceId: string,
    filter: { sessionId?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<Artifact>> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'artifact.read');
    return this.store.artifacts.list({ workspaceId, ...filter });
  }

  /** One artifact's metadata. */
  async get(context: AuthContext, artifactId: string): Promise<Artifact> {
    const artifact = await this.#require(artifactId);
    const workspace = await this.requireWorkspace(artifact.workspaceId);
    this.authorizer.require(context, workspace, 'artifact.read', { resourceId: artifactId });
    return artifact;
  }

  /**
   * Read an artifact's bytes.
   *
   * A separate action from `artifact.read` because they are different powers:
   * listing tells an operator what an agent produced, downloading hands them
   * content an agent chose. Auditing the second is the point — it is the only
   * path by which agent-authored bytes reach a person.
   */
  async download(
    context: AuthContext,
    artifactId: string,
  ): Promise<{ artifact: Artifact; bytes: Uint8Array }> {
    const artifact = await this.#require(artifactId);
    const workspace = await this.requireWorkspace(artifact.workspaceId);
    this.authorizer.require(context, workspace, 'artifact.download', { resourceId: artifactId });

    if (artifact.status === 'purged') {
      throw new MaError({
        code: 'ARTIFACT_PURGED',
        category: 'precondition',
        message: 'This artifact’s content has been deleted; only its record remains',
      });
    }

    const bytes = await this.#blobs.get(artifact.workspaceId, artifact.digest);
    if (!bytes) {
      // The row says the bytes exist and they do not. That is a storage fault,
      // not a missing resource, and reporting it as a 404 would send an
      // operator looking for a deletion that never happened.
      throw new MaError({
        code: 'ARTIFACT_CONTENT_MISSING',
        category: 'internal',
        message: 'The artifact record exists but its content could not be read',
        details: { artifactId },
      });
    }

    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'artifact.download',
      resourceKind: 'artifact',
      resourceId: artifactId,
      outcome: 'allowed',
    });

    return { artifact, bytes };
  }

  /**
   * Delete an artifact's content.
   *
   * The row survives as `purged`: "this session produced a report" should stay
   * answerable after the report is gone, and a deletion that erased the record
   * too would make the event log disagree with itself.
   */
  async purge(context: AuthContext, artifactId: string, reason: string): Promise<Artifact> {
    const artifact = await this.#require(artifactId);
    const workspace = await this.requireWorkspace(artifact.workspaceId);
    this.authorizer.require(context, workspace, 'artifact.delete', { resourceId: artifactId });

    const purged = await this.#purge(artifact);

    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'artifact.delete',
      resourceKind: 'artifact',
      resourceId: artifactId,
      outcome: 'allowed',
      reason,
    });

    return purged;
  }

  /**
   * Purge artifacts past their retention window.
   *
   * Runs on the scheduler's loop, like every other sweep here.
   */
  async purgeExpired(limit = 50): Promise<number> {
    const due = await this.store.artifacts.findExpired(this.clock.now(), limit);
    let purged = 0;

    for (const artifact of due) {
      try {
        await this.#purge(artifact);
        purged++;
      } catch (error) {
        // One unpurgeable artifact must not stop the sweep.
        this.logger?.warn('failed to purge an expired artifact', {
          artifactId: artifact.id,
          error,
        });
      }
    }

    return purged;
  }

  /**
   * Mark a record purged and remove its bytes if nothing else needs them.
   *
   * The reference count is what makes deduplication safe to undo: two artifacts
   * with identical content share one blob, so removing the blob when the first
   * is deleted would break the second. The row is flipped first, so the count
   * that follows already excludes it.
   */
  async #purge(artifact: Artifact): Promise<Artifact> {
    if (artifact.status === 'purged') return artifact;
    artifactMachine.assert(artifact.status, 'purged');

    const now = this.clock.now();
    const updated = await this.store.artifacts.update(artifact.id, {
      status: 'purged',
      purgedAt: now,
      updatedAt: now,
    });

    const remaining = await this.store.artifacts.countByDigest(
      artifact.workspaceId,
      artifact.digest,
    );
    if (remaining === 0) {
      await this.#blobs.delete(artifact.workspaceId, artifact.digest);
    }

    return updated;
  }

  async #require(artifactId: string): Promise<Artifact> {
    const artifact = await this.store.artifacts.get(artifactId);
    if (!artifact) throw notFound('Artifact', artifactId);
    return artifact;
  }
}

/**
 * A display label for an agent-chosen path.
 *
 * Not a security control — the blob is addressed by digest, so this string
 * never reaches a filesystem. It is sanitised because it *is* echoed to a
 * human, in a JSON body and in a `Content-Disposition` filename, and a
 * newline there would splice a header.
 */
export function sanitizePath(path: string): string {
  const cleaned = path
    // Control characters, which is what header injection needs.
    .replace(/[ -]/g, '')
    .replace(/\\/g, '/')
    // Traversal segments are meaningless for a label and alarming to read.
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');

  if (cleaned.length === 0) throw validationError('An artifact path cannot be empty');
  return cleaned.slice(0, 1024);
}

/**
 * Guess a content type from the bytes themselves.
 *
 * The uploader's declared type is deliberately ignored: it ends up in a
 * `Content-Type` header on a same-origin download, and letting an agent choose
 * `text/html` there is stored XSS against whoever opens it.
 *
 * The list is short on purpose. Anything unrecognised is
 * `application/octet-stream`, which browsers download rather than render — the
 * safe default, and the right one for the overwhelmingly common case of a
 * build artifact nobody wants previewed. Nothing here ever returns a type a
 * browser will execute.
 */
export function sniffContentType(bytes: Uint8Array): string {
  const head = bytes.subarray(0, 16);
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => head[index] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'application/zip';
  if (starts(0x1f, 0x8b)) return 'application/gzip';

  // Text only if every byte is printable or ordinary whitespace. `text/plain`
  // is safe to serve — a browser shows it rather than executing it — but a file
  // containing NUL is not text, and calling it text invites a viewer to guess.
  const printable = bytes.every(
    (byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f),
  );
  return printable ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}
