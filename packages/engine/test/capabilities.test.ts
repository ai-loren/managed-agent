/**
 * Capability tests.
 *
 * The property under test throughout is reproducibility: a version pinned today
 * must install byte-identical artifacts later, whatever happens to the branch,
 * the registry entry, or the upload it came from.
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, TestClock, nullLogger, sha256Hex } from '@ma/core';
import type { CapabilityRef } from '@ma/contracts';

import {
  CapabilityService,
  FilesystemArtifactStore,
  GitResolver,
  MemoryArtifactStore,
  RegistryResolver,
  UploadResolver,
  type GitFetcher,
} from '../src/index.ts';

const START = 1_700_000_000_000;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function ref(overrides: Partial<CapabilityRef> = {}): CapabilityRef {
  return {
    name: 'code-review',
    source: 'registry',
    digest: '0'.repeat(64),
    version: '',
    description: '',
    ...overrides,
  };
}

describe('artifact store', () => {
  test('addresses content by its own digest', async () => {
    const store = new MemoryArtifactStore();
    const digest = await store.put(bytes('skill content'));

    assert.equal(digest, sha256Hex(bytes('skill content')));
    assert.equal(await store.has(digest), true);
    assert.deepEqual(await store.get(digest), bytes('skill content'));
  });

  test('storing identical bytes twice is one artifact', async () => {
    const store = new MemoryArtifactStore();
    const first = await store.put(bytes('same'));
    const second = await store.put(bytes('same'));

    assert.equal(first, second);
    assert.equal(store.size, 1);
  });
});

describe('registry resolver', () => {
  let artifacts: MemoryArtifactStore;
  let registry: RegistryResolver;

  beforeEach(() => {
    artifacts = new MemoryArtifactStore();
    registry = new RegistryResolver(artifacts);
  });

  test('resolves a published version', async () => {
    const digest = await registry.publish('code-review', '1.0.0', bytes('v1 content'));
    const artifact = await registry.resolve(ref({ version: '1.0.0' }));

    assert.equal(artifact.digest, digest);
    assert.equal(artifact.provenance.version, '1.0.0');
  });

  test('refuses to republish over an existing version', async () => {
    // Republishing would change what an existing agent runs without anyone
    // editing it — exactly what content addressing exists to prevent.
    await registry.publish('code-review', '1.0.0', bytes('original'));
    await assert.rejects(
      registry.publish('code-review', '1.0.0', bytes('replacement')),
      (error: unknown) => MaError.is(error) && error.status === 409,
    );
  });

  test('latest follows the newest publish', async () => {
    await registry.publish('code-review', '1.0.0', bytes('v1'));
    await registry.publish('code-review', '2.0.0', bytes('v2'));

    const latest = await registry.resolve(ref({ version: '' }));
    assert.equal(latest.provenance.version, '2.0.0');
  });

  test('reports a missing capability rather than resolving to nothing', async () => {
    await assert.rejects(
      registry.resolve(ref({ name: 'never-published' })),
      (error: unknown) => MaError.is(error) && error.status === 404,
    );
  });
});

describe('git resolver', () => {
  let artifacts: MemoryArtifactStore;
  let head: string;
  let fetcher: GitFetcher;

  beforeEach(() => {
    artifacts = new MemoryArtifactStore();
    head = 'a'.repeat(40);
    fetcher = {
      resolveCommit: () => Promise.resolve(head),
      fetchArchive: (_repo, commit) => Promise.resolve(bytes(`tree at ${commit}`)),
    };
  });

  test('resolves a branch to the commit it currently points at', async () => {
    const resolver = new GitResolver(fetcher, artifacts);
    const artifact = await resolver.resolve(
      ref({ source: 'git', repo: 'org/skills', ref: 'main' }),
    );

    assert.equal(artifact.provenance.commit, head);
    assert.equal(artifact.digest, sha256Hex(bytes(`tree at ${head}`)));
  });

  test('a pinned commit is fetched as given, not re-resolved', async () => {
    // Otherwise "install from main" would mean something different every time
    // the branch moved, and two sessions of one version could differ.
    let resolveCalled = false;
    const resolver = new GitResolver(
      {
        resolveCommit: () => {
          resolveCalled = true;
          return Promise.resolve('b'.repeat(40));
        },
        fetchArchive: (_repo, commit) => Promise.resolve(bytes(`tree at ${commit}`)),
      },
      artifacts,
    );

    const pinned = 'c'.repeat(40);
    const artifact = await resolver.resolve(
      ref({ source: 'git', repo: 'org/skills', ref: 'main', commit: pinned }),
    );

    assert.equal(resolveCalled, false, 'a pinned commit must not consult the branch');
    assert.equal(artifact.provenance.commit, pinned);
  });

  test('requires a repository', async () => {
    const resolver = new GitResolver(fetcher, artifacts);
    await assert.rejects(
      resolver.resolve(ref({ source: 'git' })),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });
});

describe('capability service', () => {
  let artifacts: MemoryArtifactStore;
  let registry: RegistryResolver;
  let service: CapabilityService;
  let head: string;

  beforeEach(() => {
    artifacts = new MemoryArtifactStore();
    registry = new RegistryResolver(artifacts);
    head = 'a'.repeat(40);

    service = new CapabilityService({
      artifacts,
      clock: new TestClock(START),
      logger: nullLogger,
      resolvers: [
        registry,
        new UploadResolver(artifacts),
        new GitResolver(
          {
            resolveCommit: () => Promise.resolve(head),
            fetchArchive: (_repo, commit) => Promise.resolve(bytes(`tree at ${commit}`)),
          },
          artifacts,
        ),
      ],
    });
  });

  test('pinning records the resolved digest and provenance', async () => {
    await registry.publish('code-review', '1.2.0', bytes('the skill'));
    const pinned = await service.pin(ref({ version: '1.2.0' }));

    assert.equal(pinned.digest, sha256Hex(bytes('the skill')));
    assert.equal(pinned.version, '1.2.0');
  });

  test('pinning a branch freezes the commit', async () => {
    const pinned = await service.pin(ref({ source: 'git', repo: 'org/skills', ref: 'main' }));
    assert.equal(pinned.commit, head);

    // The branch moves; the pinned reference does not follow it.
    head = 'd'.repeat(40);
    const plans = await service.plan([pinned]);
    assert.equal(plans[0]!.artifact.digest, pinned.digest);
  });

  test('a builtin needs no resolution', async () => {
    const builtin = ref({ source: 'builtin', name: 'bash' });
    assert.deepEqual(await service.pin(builtin), builtin);
    assert.deepEqual(await service.plan([builtin]), []);
  });

  test('reports every unresolvable capability, not just the first', async () => {
    // An author fixing three broken skills should learn about all three in one
    // attempt rather than one per round trip.
    const result = await service.pinAll([
      ref({ name: 'missing-one' }),
      ref({ name: 'missing-two' }),
      ref({ name: 'missing-three' }),
    ]);

    assert.equal(result.pinned.length, 0);
    assert.equal(result.failures.length, 3);
    assert.deepEqual(
      result.failures.map((failure) => failure.name).sort(),
      ['missing-one', 'missing-three', 'missing-two'],
    );
  });

  test('pins what it can and reports what it cannot', async () => {
    await registry.publish('works', '1.0.0', bytes('fine'));
    const result = await service.pinAll([
      ref({ name: 'works', version: '1.0.0' }),
      ref({ name: 'broken' }),
    ]);

    assert.equal(result.pinned.length, 1);
    assert.equal(result.failures.length, 1);
  });

  test('rejects a source with no registered resolver', async () => {
    const bare = new CapabilityService({
      artifacts,
      clock: new TestClock(START),
      resolvers: [],
    });
    await assert.rejects(
      bare.pin(ref()),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('planning verifies the stored bytes against the digest', async () => {
    // A store returning bytes that do not hash to the requested digest has been
    // corrupted or tampered with; installing anyway defeats the whole scheme.
    await registry.publish('code-review', '1.0.0', bytes('genuine'));
    const pinned = await service.pin(ref({ version: '1.0.0' }));

    const tampered = { ...pinned, digest: sha256Hex(bytes('something else')) };
    await assert.rejects(service.plan([tampered]), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.status, 409);
      return true;
    });
  });

  test('re-fetches an artifact that is no longer cached', async () => {
    await registry.publish('code-review', '1.0.0', bytes('cacheable'));
    const pinned = await service.pin(ref({ version: '1.0.0' }));

    const cold = new CapabilityService({
      artifacts: new MemoryArtifactStore(),
      clock: new TestClock(START),
      resolvers: [registry],
    });

    const plans = await cold.plan([pinned]);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.artifact.digest, pinned.digest);
  });

  test('detects that a branch has moved since it was pinned', async () => {
    const pinned = await service.pin(ref({ source: 'git', repo: 'org/skills', ref: 'main' }));
    assert.equal((await service.hasDrifted(pinned)).drifted, false);

    head = 'e'.repeat(40);
    const drift = await service.hasDrifted(pinned);
    assert.equal(drift.drifted, true, 'an author should be able to ask before republishing');
    assert.notEqual(drift.currentDigest, pinned.digest);
  });

  test('a builtin never drifts', async () => {
    assert.equal((await service.hasDrifted(ref({ source: 'builtin' }))).drifted, false);
  });
});

describe('FilesystemArtifactStore', () => {
  const dirs: string[] = [];
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('round-trips content across two instances over the same root (a restart)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ma-artifacts-'));
    dirs.push(root);

    const first = new FilesystemArtifactStore(root);
    const content = bytes('a skill archive');
    const digest = await first.put(content);
    assert.equal(digest, sha256Hex(content));

    // A fresh instance over the same root — as a second process, or after a
    // restart — must see the bytes the first wrote.
    const second = new FilesystemArtifactStore(root);
    assert.ok(await second.has(digest), 'the artifact survives a restart');
    assert.deepEqual(await second.get(digest), content);
  });

  test('is content-addressed: re-putting identical bytes is a no-op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ma-artifacts-'));
    dirs.push(root);
    const store = new FilesystemArtifactStore(root);
    const content = bytes('same');
    const a = await store.put(content);
    const b = await store.put(content);
    assert.equal(a, b);
  });

  test('returns undefined for an unknown digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ma-artifacts-'));
    dirs.push(root);
    const store = new FilesystemArtifactStore(root);
    assert.equal(await store.get('0'.repeat(64)), undefined);
    assert.equal(await store.has('0'.repeat(64)), false);
  });

  test('refuses a malformed digest rather than building a bad path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ma-artifacts-'));
    dirs.push(root);
    const store = new FilesystemArtifactStore(root);
    await assert.rejects(store.get('../etc/passwd'), (e: unknown) => MaError.is(e));
  });
});
