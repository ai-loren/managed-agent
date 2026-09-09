/**
 * Artifact tests.
 *
 * The download path is what these are mostly about. An artifact is bytes an
 * agent chose, served back to a human's browser from the same origin as the
 * console — so the interesting questions are all about what the control plane
 * refuses to take the agent's word for.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MaError, TestClock, newId, nullLogger } from '@ma/core';
import type { Principal } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import {
  AgentService,
  ArtifactService,
  MemoryBlobStore,
  QuotaService,
  RoleAuthorizer,
  WorkspaceService,
  sanitizePath,
  sniffContentType,
  type AuthContext,
} from '../src/index.ts';

const START = 1_700_000_000_000;
const encoder = new TextEncoder();

let store: SqliteStore;
let clock: TestClock;
let blobs: MemoryBlobStore;
let artifacts: ArtifactService;
let workspaces: WorkspaceService;
let context: AuthContext;
let workspaceId: string;
let sessionId: string;

beforeEach(async () => {
  store = createMemoryStore();
  clock = new TestClock(START);
  blobs = new MemoryBlobStore();

  const principal: Principal = await store.principals.create({
    id: newId('principal'),
    type: 'user',
    subject: 'operator',
    displayName: 'Operator',
    email: '',
    isAdmin: true,
    disabled: false,
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'system',
  });
  context = { principal } as AuthContext;

  const deps = {
    store,
    clock,
    logger: nullLogger,
    authorizer: new RoleAuthorizer(),
    quota: new QuotaService(store, clock),
  };
  workspaces = new WorkspaceService(deps);
  const agents = new AgentService(deps);
  artifacts = new ArtifactService({ ...deps, blobs });

  const workspace = await workspaces.create(context, { name: 'Team', slug: 'artifacts-test' });
  workspaceId = workspace.id;
  const agent = await agents.create(context, {
    workspaceId,
    name: 'Reporter',
    spec: { systemPrompt: 'x', model: { modelId: 'm' } },
  });
  const session = await store.sessions.create({
    id: newId('session'),
    workspaceId,
    agentId: agent.id,
    resolvedVersion: 1,
    title: '',
    status: 'ready',
    origin: 'api',
    credentialIds: [],
    lastSeq: 0,
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: principal.id,
  });
  sessionId = session.id;
});

afterEach(async () => {
  await store.close();
});

function publish(path: string, content: string | Uint8Array) {
  return artifacts.publish({
    workspaceId,
    sessionId,
    path,
    bytes: typeof content === 'string' ? encoder.encode(content) : content,
  });
}

describe('content type sniffing', () => {
  test('never returns a type a browser will execute', () => {
    // The headline risk. An agent writes `report.html` containing a script that
    // reads the console's token; a human opens it from the same origin the
    // console is served from. Honouring a declared `text/html` would be stored
    // XSS, so the declared type is ignored entirely and HTML is just text.
    for (const hostile of [
      '<script>alert(document.cookie)</script>',
      '<!DOCTYPE html><html><body onload="fetch(`/steal`)">',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    ]) {
      const type = sniffContentType(encoder.encode(hostile));
      assert.ok(!/html|xml|javascript|svg/i.test(type), `${type} is renderable`);
    }
  });

  test('recognises formats that are safe to name', () => {
    assert.equal(sniffContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'image/png');
    assert.equal(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff])), 'image/jpeg');
    assert.equal(sniffContentType(new Uint8Array([0x25, 0x50, 0x44, 0x46])), 'application/pdf');
    assert.match(sniffContentType(encoder.encode('plain words')), /^text\/plain/);
  });

  test('a file containing NUL is not text', () => {
    // Calling it text invites a viewer to guess at an encoding, and a guess is
    // exactly what content sniffing exists to avoid.
    assert.equal(
      sniffContentType(new Uint8Array([0x68, 0x69, 0x00, 0x01])),
      'application/octet-stream',
    );
  });
});

describe('path sanitisation', () => {
  test('strips what would splice a header', () => {
    // `path` reaches a `Content-Disposition` filename. A CR or LF there ends
    // the header and begins another.
    assert.equal(sanitizePath('report\r\nSet-Cookie: admin=1'), 'reportSet-Cookie: admin=1');
    assert.equal(sanitizePath('a\u0000b'), 'ab');
  });

  test('drops traversal segments, which are meaningless here anyway', () => {
    // Not a security control — the blob is addressed by digest, so this string
    // never reaches a filesystem — but a path claiming to be /etc/passwd is
    // alarming to read in a listing and says nothing true.
    assert.equal(sanitizePath('../../etc/passwd'), 'etc/passwd');
    assert.equal(sanitizePath('./nested/./file.txt'), 'nested/file.txt');
    assert.equal(sanitizePath('C:\\Users\\x\\out.bin'), 'C:/Users/x/out.bin');
  });

  test('refuses a path with nothing left after cleaning', () => {
    assert.throws(() => sanitizePath('../..'), (error: unknown) => MaError.is(error));
    assert.throws(() => sanitizePath('///'), (error: unknown) => MaError.is(error));
  });
});

describe('publishing', () => {
  test('records the digest it computed, not one it was given', () => {
    // Nothing in the request names the digest. If it did, an agent could point
    // a row at any blob in its workspace and download content it never wrote.
    const bytes = encoder.encode('measured content');
    return publish('out.txt', bytes).then(async ({ artifact }) => {
      const { createHash } = await import('node:crypto');
      assert.equal(artifact.digest, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(artifact.sizeBytes, bytes.byteLength);
    });
  });

  test('a retried upload returns the original row', async () => {
    const first = await publish('report.md', 'same bytes');
    const retry = await publish('report.md', 'same bytes');

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.artifact.id, first.artifact.id);
    assert.equal(await store.artifacts.totalBytes(workspaceId), first.artifact.sizeBytes);
  });

  test('refuses an artifact past the size limit', async () => {
    const small = new ArtifactService({
      store,
      clock,
      logger: nullLogger,
      authorizer: new RoleAuthorizer(),
      quota: new QuotaService(store, clock),
      blobs,
      maxBytes: 10,
    });

    await assert.rejects(
      small.publish({ workspaceId, sessionId, path: 'big.bin', bytes: encoder.encode('far too long') }),
      (error: unknown) => MaError.is(error) && error.code === 'ARTIFACT_TOO_LARGE',
    );
  });

  test('refuses an upload past the storage quota, and stores no bytes', async () => {
    await workspaces.updateQuota(context, workspaceId, { maxStorageMb: 0 });

    await assert.rejects(
      publish('over.bin', 'anything at all'),
      (error: unknown) => MaError.is(error) && error.status === 429,
    );
    assert.equal(blobs.size, 0, 'a refused upload must not leave bytes behind');
  });

  test('leaves no row behind when writing the bytes fails', async () => {
    // The row is written first, so the storage limit is enforced atomically.
    // That ordering means a failed write must roll the row back, or a download
    // would 404 forever against a record that says the content exists.
    const failing = new ArtifactService({
      store,
      clock,
      logger: nullLogger,
      authorizer: new RoleAuthorizer(),
      quota: new QuotaService(store, clock),
      blobs: {
        put: () => Promise.reject(new Error('disk full')),
        get: () => Promise.resolve(undefined),
        delete: () => Promise.resolve(),
      },
    });

    await assert.rejects(
      failing.publish({ workspaceId, sessionId, path: 'doomed.bin', bytes: encoder.encode('x') }),
    );
    assert.deepEqual((await store.artifacts.list({ workspaceId })).items, []);
  });
});

describe('download and purge', () => {
  test('returns the bytes that were stored', async () => {
    const { artifact } = await publish('notes.txt', 'exactly this');
    const result = await artifacts.download(context, artifact.id);
    assert.equal(new TextDecoder().decode(result.bytes), 'exactly this');
  });

  test('records every download in the audit trail', async () => {
    // The only path by which agent-authored bytes reach a person, so it is the
    // one worth being able to ask about afterwards.
    const { artifact } = await publish('notes.txt', 'content');
    await artifacts.download(context, artifact.id);

    const entries = await store.audit.list({ workspaceId, action: 'artifact.download' });
    assert.equal(entries.items.length, 1);
    assert.equal(entries.items[0]?.resourceId, artifact.id);
  });

  test('purging frees the bytes but keeps the record', async () => {
    const { artifact } = await publish('report.md', 'findings');
    await artifacts.purge(context, artifact.id, 'operator asked');

    assert.equal(blobs.size, 0);
    const row = await store.artifacts.get(artifact.id);
    assert.equal(row?.status, 'purged');
    assert.equal(row?.sizeBytes, 8, 'the record of what existed survives its content');
  });

  test('purging one of two artifacts sharing a blob leaves the other readable', async () => {
    // Deduplication is only safe if deletion is reference-counted. Without it,
    // deleting one artifact silently breaks every other with identical content.
    const a = await publish('first.txt', 'identical');
    const b = await publish('second.txt', 'identical');
    assert.equal(a.artifact.digest, b.artifact.digest);

    await artifacts.purge(context, a.artifact.id, 'delete the first');

    const survivor = await artifacts.download(context, b.artifact.id);
    assert.equal(new TextDecoder().decode(survivor.bytes), 'identical');

    await artifacts.purge(context, b.artifact.id, 'delete the second');
    assert.equal(blobs.size, 0, 'the last reference takes the blob with it');
  });

  test('downloading a purged artifact says so, rather than 404', async () => {
    const { artifact } = await publish('gone.txt', 'content');
    await artifacts.purge(context, artifact.id, 'cleanup');

    await assert.rejects(
      artifacts.download(context, artifact.id),
      (error: unknown) => MaError.is(error) && error.code === 'ARTIFACT_PURGED',
    );
  });

  test('re-publishing after a purge restores the content', async () => {
    // The dedupe key is (session, path, digest) and a purged row still matches
    // it. So a re-publish of the same bytes at the same path used to dedupe
    // straight onto the tombstone — returning created:false, skipping the byte
    // write — and every later download 404'd as purged forever. The row must be
    // revived and the bytes re-stored.
    const first = await publish('report.md', 'the findings');
    await artifacts.purge(context, first.artifact.id, 'cleared too eagerly');
    assert.equal(blobs.size, 0, 'precondition: the bytes are gone');

    const again = await publish('report.md', 'the findings');
    assert.equal(again.created, true, 're-publishing a purged artifact is a real write');

    const back = await artifacts.download(context, again.artifact.id);
    assert.equal(new TextDecoder().decode(back.bytes), 'the findings');

    const row = await store.artifacts.get(again.artifact.id);
    assert.equal(row?.status, 'available', 'the revived row is live again');
    assert.equal(row?.purgedAt, undefined, 'and no longer a tombstone');
  });

  test('a revived artifact reuses its original row rather than orphaning it', async () => {
    // Reviving must happen in place: UNIQUE(session, path, digest) forbids a
    // second row, and the history ("this session produced a report") lives on
    // the original id.
    const first = await publish('same.md', 'identical bytes');
    const originalId = first.artifact.id;
    await artifacts.purge(context, originalId, 'purge');

    const again = await publish('same.md', 'identical bytes');
    assert.equal(again.artifact.id, originalId, 'the same row comes back to life');

    const rows = await store.artifacts.list({ workspaceId });
    assert.equal(rows.items.length, 1, 'no duplicate row was created');
  });

  test('reviving a purged artifact is charged against the storage quota', async () => {
    // A live retry adds no bytes, but a purged row freed its bytes on purge —
    // reviving it puts them back, so it must face the same quota check an insert
    // would, not sail through as a free retry.
    const first = await publish('quota.bin', 'some bytes');
    await artifacts.purge(context, first.artifact.id, 'free the bytes');

    // Now there is no room. The revive must be refused, proving the quota check
    // runs on the revive branch and not only on a first insert.
    await workspaces.updateQuota(context, workspaceId, { maxStorageMb: 0 });

    await assert.rejects(
      publish('quota.bin', 'some bytes'),
      (error: unknown) => MaError.is(error) && error.status === 429,
    );
    // And a refused revive leaves the row a tombstone, not half-alive.
    assert.equal((await store.artifacts.get(first.artifact.id))?.status, 'purged');
  });

  test('a record whose bytes vanished is an internal fault, not a missing resource', async () => {
    // Reporting this as 404 would send an operator looking for a deletion that
    // never happened.
    const { artifact } = await publish('orphan.txt', 'content');
    await blobs.delete(workspaceId, artifact.digest);

    await assert.rejects(
      artifacts.download(context, artifact.id),
      (error: unknown) =>
        MaError.is(error) && error.code === 'ARTIFACT_CONTENT_MISSING' && error.status >= 500,
    );
  });

  test('the retention sweep purges only what is due', async () => {
    const keep = new ArtifactService({
      store,
      clock,
      logger: nullLogger,
      authorizer: new RoleAuthorizer(),
      quota: new QuotaService(store, clock),
      blobs,
      retentionDays: 7,
    });

    const { artifact } = await keep.publish({
      workspaceId,
      sessionId,
      path: 'ages.txt',
      bytes: encoder.encode('old'),
    });
    assert.ok(artifact.expiresAt, 'retention sets an expiry');

    assert.equal(await keep.purgeExpired(), 0, 'nothing is due yet');
    await clock.advance(8 * 24 * 60 * 60 * 1000);
    assert.equal(await keep.purgeExpired(), 1);
    assert.equal((await store.artifacts.get(artifact.id))?.status, 'purged');
  });
});
