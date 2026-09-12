/**
 * Platform-managed volume storage.
 *
 * A volume is named, never a host path. This is the one place that maps a
 * (workspace, name) pair to a directory on disk, and it confines every such
 * directory under a single configured root, namespaced by workspace:
 *
 *   <root>/<workspaceId>/<name>
 *
 * — the same shape the artifact blob store uses, and for the same reason: a
 * workspace can only ever reach storage under its own prefix, and "delete this
 * workspace" is a directory removal. Both path components are validated here
 * rather than trusted from the spec, because this is the function that turns
 * strings into a filesystem path. A volume that would escape its workspace
 * prefix is refused, not clamped.
 *
 * Absent configuration means volumes are disabled: `resolve` throws, so a spec
 * that declares mounts is refused rather than silently given nothing — the same
 * fail-closed posture as a missing egress proxy.
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve as resolvePath, relative, isAbsolute } from 'node:path';

import { MaError } from '@ma/core';

/** A single path segment: letters, digits, dot, dash, underscore. No separators. */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORKSPACE_ID = /^ws_[0-9A-Z]{26}$/;

export interface VolumeManagerOptions {
  /**
   * Root under which every workspace's volumes live. Absent means volumes are
   * disabled and any declared mount is refused.
   */
  root?: string;
}

export class VolumeManager {
  readonly #root: string | undefined;

  constructor(options: VolumeManagerOptions = {}) {
    // `:memory:` mirrors the database/artifact convention for an ephemeral run —
    // there is nowhere durable to put a volume, so treat it as disabled.
    this.#root = options.root && options.root !== ':memory:' ? options.root : undefined;
  }

  /** Whether this deployment can service volume mounts at all. */
  get enabled(): boolean {
    return this.#root !== undefined;
  }

  /**
   * Resolve (workspace, name) to its on-disk directory, creating it on demand.
   *
   * Throws when volumes are disabled, when either component is malformed, or —
   * defence in depth — when the joined path would escape the workspace prefix.
   */
  async resolve(workspaceId: string, name: string): Promise<string> {
    const dir = this.pathFor(workspaceId, name);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** The path a (workspace, name) maps to, validated but not created. */
  pathFor(workspaceId: string, name: string): string {
    if (!this.#root) {
      throw new MaError({
        code: 'VOLUMES_UNAVAILABLE',
        category: 'precondition',
        message: 'This deployment has no volume storage configured (set MA_VOLUME_ROOT)',
      });
    }
    if (!WORKSPACE_ID.test(workspaceId)) {
      throw new MaError({
        code: 'VOLUME_BAD_WORKSPACE',
        category: 'validation',
        message: 'A volume workspace id must be a workspace ULID',
      });
    }
    if (!VOLUME_NAME.test(name)) {
      throw new MaError({
        code: 'VOLUME_BAD_NAME',
        category: 'validation',
        message: 'A volume name must be a single path segment',
      });
    }
    const workspaceRoot = join(this.#root, workspaceId);
    const dir = join(workspaceRoot, name);
    // The regexes already forbid separators and `..`, but confirm the resolved
    // path really sits under the workspace root — the archive extractor's
    // discipline: refuse an escape rather than trust a lexical check alone.
    const rel = relative(workspaceRoot, resolvePath(dir));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new MaError({
        code: 'VOLUME_ESCAPE',
        category: 'validation',
        message: 'A volume path must stay within its workspace',
      });
    }
    return dir;
  }
}
