/**
 * VolumeManager tests — the workspace-isolation boundary for managed volumes.
 *
 * This is the one place a (workspace, name) pair becomes a directory on disk, so
 * it is where cross-workspace reach and path traversal are refused. The tests
 * exercise the real filesystem: confinement that only holds against a mock is no
 * confinement at all.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

import { MaError } from '@ma/core';

import { VolumeManager } from '../src/index.ts';

const WS_A = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const WS_B = 'ws_01BXYZ3NDEKTSV4RRFFQ69G5FB';

describe('VolumeManager', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ma-volumes-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('is disabled with no root, refusing any mount', () => {
    // Fail-closed: a deployment with no volume storage refuses rather than
    // silently handing a spec that declares mounts an empty directory.
    const disabled = new VolumeManager();
    assert.equal(disabled.enabled, false);
    assert.throws(() => disabled.pathFor(WS_A, 'cache'), (error: unknown) => {
      assert.ok(error instanceof MaError);
      assert.equal(error.code, 'VOLUMES_UNAVAILABLE');
      return true;
    });
  });

  test(':memory: is treated as disabled, like the store and artifacts', () => {
    const ephemeral = new VolumeManager({ root: ':memory:' });
    assert.equal(ephemeral.enabled, false);
  });

  test('confines a volume to <root>/<workspaceId>/<name>', async () => {
    const volumes = new VolumeManager({ root });
    assert.equal(volumes.enabled, true);
    const dir = await volumes.resolve(WS_A, 'cache');
    assert.equal(dir, join(root, WS_A, 'cache'));
    // resolve creates it on demand.
    const info = await stat(dir);
    assert.ok(info.isDirectory());
  });

  test('two workspaces get disjoint directories', () => {
    const volumes = new VolumeManager({ root });
    const a = volumes.pathFor(WS_A, 'cache');
    const b = volumes.pathFor(WS_B, 'cache');
    assert.notEqual(a, b);
    // Neither can reach the other: each stays under its own workspace prefix.
    assert.ok(a.startsWith(join(root, WS_A)));
    assert.ok(b.startsWith(join(root, WS_B)));
    const rel = relative(join(root, WS_A), b);
    assert.ok(rel.startsWith('..') || isAbsolute(rel));
  });

  test('rejects a non-ULID workspace id', () => {
    const volumes = new VolumeManager({ root });
    for (const bad of ['..', 'ws_short', '../../etc', 'ws_' + 'x'.repeat(26), '']) {
      assert.throws(() => volumes.pathFor(bad, 'cache'), (error: unknown) => {
        assert.ok(error instanceof MaError);
        assert.equal(error.code, 'VOLUME_BAD_WORKSPACE');
        return true;
      }, `${JSON.stringify(bad)} must be refused as a workspace id`);
    }
  });

  test('rejects a volume name that is not a single path segment', () => {
    const volumes = new VolumeManager({ root });
    for (const bad of ['..', 'a/b', '../escape', '/abs', '', '.']) {
      assert.throws(() => volumes.pathFor(WS_A, bad), (error: unknown) => {
        assert.ok(error instanceof MaError);
        assert.equal(error.code, 'VOLUME_BAD_NAME');
        return true;
      }, `${JSON.stringify(bad)} must be refused as a volume name`);
    }
  });

  test('a valid name never escapes its workspace prefix', () => {
    // Defence in depth beyond the regex: whatever a validated name resolves to
    // must sit under the workspace root, exactly as the archive extractor
    // re-checks a path after joining rather than trusting the lexical form.
    const volumes = new VolumeManager({ root });
    const workspaceRoot = join(root, WS_A);
    const dir = volumes.pathFor(WS_A, 'cache');
    const rel = relative(workspaceRoot, dir);
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel));
  });
});
