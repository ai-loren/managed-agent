/**
 * Sandbox tests.
 *
 * The local driver is exercised with real child processes rather than a mock:
 * process lifecycle is exactly the part where a mock would agree with whatever
 * the code does and tell us nothing.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, newId, nullLogger, systemClock } from '@ma/core';
import type { Agent, SandboxSpec, Session } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import {
  LocalSandboxDriver,
  SandboxBroker,
  computePoolKey,
  type ProvisionRequest,
  type ProvisionedSandbox,
  type SandboxDriver,
  type SandboxHealth,
} from '../src/index.ts';

const NOW = 1_700_000_000_000;
const WORKSPACE = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';

function makeSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: 'managed-agent/runtime:latest',
    cpu: 2,
    memoryMb: 4096,
    diskMb: 20_480,
    idleTimeoutSeconds: 900,
    maxLifetimeSeconds: 86_400,
    network: { egress: 'allowlist', allowedHosts: [] },
    setupCommands: [],
    allowReuse: true,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: newId('session'),
    workspaceId: WORKSPACE,
    agentId: newId('agent'),
    resolvedVersion: 1,
    title: '',
    status: 'provisioning',
    origin: 'api',
    credentialIds: [],
    lastSeq: 0,
    turnCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 0,
    },
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'pr_test',
    ...overrides,
  };
}

function makeAgent(workspaceId: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id: newId('agent'),
    workspaceId,
    name: 'Test Agent',
    description: '',
    status: 'active',
    latestVersion: 1,
    labels: [],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'pr_test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pool keys — the isolation boundary
// ---------------------------------------------------------------------------

describe('pool keys', () => {
  test('identical inputs produce the same key', () => {
    const input = { workspaceId: WORKSPACE, spec: makeSpec(), credentialIds: ['cr_a'] };
    assert.equal(computePoolKey(input), computePoolKey({ ...input }));
  });

  test('credential order does not affect the key', () => {
    // Otherwise two logically identical sets would never share a sandbox.
    const a = computePoolKey({ workspaceId: WORKSPACE, spec: makeSpec(), credentialIds: ['cr_a', 'cr_b'] });
    const b = computePoolKey({ workspaceId: WORKSPACE, spec: makeSpec(), credentialIds: ['cr_b', 'cr_a'] });
    assert.equal(a, b);
  });

  test('a different credential set produces a different key', () => {
    // A warm sandbox holds resolved secrets in its environment; sharing it
    // across credential sets would leak them.
    const a = computePoolKey({ workspaceId: WORKSPACE, spec: makeSpec(), credentialIds: ['cr_a'] });
    const b = computePoolKey({ workspaceId: WORKSPACE, spec: makeSpec(), credentialIds: ['cr_b'] });
    assert.notEqual(a, b);
  });

  test('workspaces never share a pool', () => {
    const a = computePoolKey({ workspaceId: 'ws_a', spec: makeSpec(), credentialIds: [] });
    const b = computePoolKey({ workspaceId: 'ws_b', spec: makeSpec(), credentialIds: [] });
    assert.notEqual(a, b);
  });

  test('image, resources, network and setup all change the key', () => {
    const base = { workspaceId: WORKSPACE, credentialIds: [] as string[] };
    const original = computePoolKey({ ...base, spec: makeSpec() });

    for (const variant of [
      makeSpec({ image: 'other:latest' }),
      makeSpec({ cpu: 4 }),
      makeSpec({ memoryMb: 8192 }),
      makeSpec({ network: { egress: 'allow', allowedHosts: [] } }),
      makeSpec({ setupCommands: [{ name: 's', command: 'echo hi', timeoutSeconds: 10, optional: false }] }),
    ]) {
      assert.notEqual(computePoolKey({ ...base, spec: variant }), original);
    }
  });

  test('allowReuse is part of the key, not just an acquire-time check', () => {
    // The acquire path tests the *requester's* allowReuse. Without this in the
    // key, a session that permits reuse claims a sandbox created by one that
    // forbade it: same key, and claimFromPool filters only on key, status and
    // lease.
    const base = { workspaceId: WORKSPACE, credentialIds: [] as string[] };
    assert.notEqual(
      computePoolKey({ ...base, spec: makeSpec({ allowReuse: false }) }),
      computePoolKey({ ...base, spec: makeSpec({ allowReuse: true }) }),
    );
  });

  test('cosmetic fields do not fragment the pool', () => {
    // Idle timeout does not change what the environment *is*, so two sessions
    // differing only there should still be able to share.
    const a = computePoolKey({ workspaceId: WORKSPACE, spec: makeSpec(), credentialIds: [] });
    const b = computePoolKey({
      workspaceId: WORKSPACE,
      spec: makeSpec({ idleTimeoutSeconds: 60 }),
      credentialIds: [],
    });
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

/** A driver that records calls and can be made to fail in specific ways. */
class StubDriver implements SandboxDriver {
  readonly name = 'stub';
  provisioned: ProvisionRequest[] = [];
  destroyed: { ref: string; reason: string }[] = [];
  failWith: Error | undefined;
  healthResult: SandboxHealth = 'healthy';

  provision(request: ProvisionRequest): Promise<ProvisionedSandbox> {
    if (this.failWith) {
      const error = this.failWith;
      this.failWith = undefined;
      return Promise.reject(error);
    }
    this.provisioned.push(request);
    return Promise.resolve({
      providerRef: `ref-${request.sandboxId}`,
      endpoint: `http://127.0.0.1:9000/${request.sandboxId}`,
    });
  }

  health(): Promise<SandboxHealth> {
    return Promise.resolve(this.healthResult);
  }

  destroy(ref: string, reason: string): Promise<void> {
    this.destroyed.push({ ref, reason });
    return Promise.resolve();
  }
}

describe('broker', () => {
  let store: SqliteStore;
  let driver: StubDriver;
  let broker: SandboxBroker;
  let agentId: string;

  beforeEach(async () => {
    store = createMemoryStore();
    // Sandboxes are workspace-scoped and the schema enforces it, so the
    // workspace has to exist before any of this is meaningful.
    await store.workspaces.create({
      id: WORKSPACE,
      slug: 'test-workspace',
      name: 'Test',
      description: '',
      status: 'active',
      members: [],
      quota: {
        maxConcurrentSessions: 100,
        maxSandboxes: 100,
        maxTokensPerDay: 1_000_000,
        maxStorageMb: 1024,
        maxAgents: 100,
        eventRetentionDays: 90,
      },
      systemPrompt: '',
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: 'pr_test',
    });
    driver = new StubDriver();
    broker = new SandboxBroker({
      store,
      clock: systemClock,
      drivers: [driver],
      logger: nullLogger,
      leaseSeconds: 60,
    });
    // Sessions reference an agent (FK), so the reuse tests that persist real
    // session rows need one to exist.
    const agent = await store.agents.create(makeAgent(WORKSPACE));
    agentId = agent.id;
  });

  afterEach(async () => {
    await broker.close();
    await store.close();
  });

  test('cold-starts a sandbox and records it as ready', async () => {
    const session = makeSession();
    const result = await broker.acquire({ session, spec: makeSpec(), env: {}, credentialIds: [] });

    assert.equal(result.reused, false);
    assert.equal(result.sandbox.status, 'ready');
    assert.ok(result.sandbox.endpoint);
    assert.ok(result.runtimeToken.length > 20, 'a cold start mints a callback token');
    assert.equal(driver.provisioned.length, 1);
  });

  test('never puts a credential id in the driver request', async () => {
    // Drivers see resolved values only; credential identity stays in the engine.
    const session = makeSession();
    await broker.acquire({
      session,
      spec: makeSpec(),
      env: { API_KEY: 'resolved-value' },
      credentialIds: ['cr_secret_id'],
    });
    const request = driver.provisioned[0]!;
    assert.equal(JSON.stringify(request).includes('cr_secret_id'), false);
    assert.equal(request.env.API_KEY, 'resolved-value');
  });

  test('does not reuse a sandbox a live session still holds', async () => {
    // One agent-core process serves one session for its life, so a sandbox may
    // only be reused once its holder has finished. While the first session is
    // live, a second acquire of the same pool key must cold-start its own rather
    // than share — otherwise the second session's turns report under the first.
    const spec = makeSpec();
    const first = makeSession({ agentId, status: 'ready' });
    await store.sessions.create(first);
    const acquired = await broker.acquire({ session: first, spec, env: {}, credentialIds: [] });

    const second = makeSession({ agentId, status: 'provisioning' });
    await store.sessions.create(second);
    const result = await broker.acquire({ session: second, spec, env: {}, credentialIds: [] });

    assert.equal(result.reused, false, 'a sandbox with a live holder must not be shared');
    assert.notEqual(result.sandbox.id, acquired.sandbox.id);
    assert.equal(driver.provisioned.length, 2, 'the second session cold-starts its own');
  });

  test('reuses a warm sandbox once the previous session has finished', async () => {
    // The sequential-reuse case the pool exists for: the first session ended, so
    // its environment is genuinely idle and the next session of the same pool key
    // adopts it instead of paying a cold start.
    const spec = makeSpec();
    const first = makeSession({ agentId, status: 'ready' });
    await store.sessions.create(first);
    const acquired = await broker.acquire({ session: first, spec, env: {}, credentialIds: [] });
    await store.sessions.update(first.id, { status: 'terminated' });

    const second = makeSession({ agentId, status: 'provisioning' });
    await store.sessions.create(second);
    const result = await broker.acquire({ session: second, spec, env: {}, credentialIds: [] });

    assert.equal(result.reused, true, 'a finished holder makes the sandbox reusable');
    assert.equal(result.sandbox.id, acquired.sandbox.id);
    assert.equal(driver.provisioned.length, 1, 'reuse must avoid a second cold start');
  });

  test('does not reuse across differing credential sets', async () => {
    const spec = makeSpec();
    await broker.acquire({ session: makeSession(), spec, env: {}, credentialIds: ['cr_a'] });
    const second = await broker.acquire({
      session: makeSession(),
      spec,
      env: {},
      credentialIds: ['cr_b'],
    });
    assert.equal(second.reused, false);
    assert.equal(driver.provisioned.length, 2);
  });

  test('does not reuse when the spec forbids it', async () => {
    const spec = makeSpec({ allowReuse: false });
    await broker.acquire({ session: makeSession(), spec, env: {}, credentialIds: [] });
    const second = await broker.acquire({ session: makeSession(), spec, env: {}, credentialIds: [] });
    assert.equal(second.reused, false);
  });

  test('a session permitting reuse cannot claim one that forbade it', async () => {
    // The direction the existing test missed. Session one asks for an
    // environment nobody else may enter; session two asks for a shareable one
    // and was handed the first — which is an isolation break, not a
    // performance win.
    const exclusive = await broker.acquire({
      session: makeSession(),
      spec: makeSpec({ allowReuse: false }),
      env: {},
      credentialIds: [],
    });

    const shareable = await broker.acquire({
      session: makeSession(),
      spec: makeSpec({ allowReuse: true }),
      env: {},
      credentialIds: [],
    });

    assert.equal(shareable.reused, false, 'a non-shareable sandbox must not be handed out');
    assert.notEqual(shareable.sandbox.id, exclusive.sandbox.id);
  });

  test('never destroys a sandbox another session still holds', async () => {
    // The second half of the same bug. `release` read allowReuse from the
    // *stored* spec — the first session's — so when a sandbox that had been
    // wrongly shared was released by its creator, it took the destroy path
    // while the other session was still working inside it.
    const first = makeSession();
    const second = makeSession();
    const spec = makeSpec({ allowReuse: false });

    const acquired = await broker.acquire({ session: first, spec, env: {}, credentialIds: [] });
    // Force the sharing the pool key now prevents, so the release guard is
    // tested on its own rather than only through a path that can no longer
    // reach it.
    await store.sandboxes.update(acquired.sandbox.id, {
      sessionIds: [first.id, second.id],
      updatedAt: NOW,
    });

    await broker.release(acquired.sandbox.id, first.id, 'first session done');

    const after = await store.sandboxes.get(acquired.sandbox.id);
    assert.equal(after?.status, 'ready', 'a sandbox in use must not be torn down');
    assert.deepEqual(after?.sessionIds, [second.id]);
    assert.deepEqual(driver.destroyed, [], 'the driver must not have been asked to destroy it');

    // And the last holder leaving does drain it.
    await broker.release(acquired.sandbox.id, second.id, 'second session done');
    assert.equal((await store.sandboxes.get(acquired.sandbox.id))?.status, 'released');
    assert.equal(driver.destroyed.length, 1);
  });

  test('refuses to exceed the workspace sandbox quota', async () => {
    // `maxSandboxes` was consulted only at *session* admission and never on the
    // path that actually creates a sandbox, so it did not bind at all: a
    // workspace with a cap of 2 provisioned as many sandboxes as it had
    // sessions. Not a race — serial calls sailed past it too.
    await store.workspaces.update(WORKSPACE, {
      quota: {
        maxConcurrentSessions: 100,
        maxSandboxes: 2,
        maxTokensPerDay: 1_000_000,
        maxStorageMb: 1024,
        maxAgents: 100,
        eventRetentionDays: 90,
      },
      updatedAt: NOW,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        broker.acquire({
          session: makeSession(),
          // Non-shareable, so each acquire needs its own sandbox rather than
          // reusing one from the pool.
          spec: makeSpec({ allowReuse: false }),
          env: {},
          credentialIds: [],
        }),
      ),
    );

    const acquired = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(acquired, 2, `acquired ${acquired} sandboxes against a limit of 2`);

    // The driver must not have been asked to start the ones that were refused:
    // a container created and then rejected is exactly the leak the cap exists
    // to prevent.
    assert.equal(driver.provisioned.length, 2, 'no sandbox may be started past the cap');

    const refusal = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(MaError.is(refusal.reason));
    assert.equal(refusal.reason.code, 'SANDBOX_QUOTA_EXCEEDED');
    assert.equal(refusal.reason.retryable, true, 'sandboxes free up, so a retry is worth suggesting');
  });

  test('prewarming tops a pool up to its configured depth', async () => {
    // `prewarm` had zero callers, including tests — so nothing established it
    // even works. It stays unwired on purpose (see the note on the method: the
    // missing piece is a policy for *when* to warm, not the warming itself),
    // but an operator who wires it should find a method that does what it says.
    const warming = new SandboxBroker({
      store,
      clock: systemClock,
      drivers: [driver],
      logger: nullLogger,
      prewarmPerPool: 2,
    });
    const spec = makeSpec();

    assert.equal(await warming.prewarm(WORKSPACE, spec, [], {}), 2, 'fills an empty pool');
    assert.equal(await warming.prewarm(WORKSPACE, spec, [], {}), 0, 'a full pool is left alone');
    assert.equal(driver.provisioned.length, 2);
  });

  test('prewarming is off unless configured', async () => {
    // The default costs nothing: idle sandboxes are a real bill.
    assert.equal(await broker.prewarm(WORKSPACE, makeSpec(), [], {}), 0);
    assert.equal(driver.provisioned.length, 0);
  });

  test('records the row before calling the driver so a hang cannot leak', async () => {
    // If provisioning dies mid-call, the reaper must still find something.
    driver.failWith = new Error('image not found');
    const session = makeSession();
    await assert.rejects(broker.acquire({ session, spec: makeSpec(), env: {}, credentialIds: [] }));

    const listed = await store.sandboxes.list({ workspaceId: WORKSPACE, statuses: ['lost'] });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.error?.code, 'SANDBOX_IMAGE_UNAVAILABLE');
  });

  test('classifies capacity problems as retryable and missing images as not', async () => {
    driver.failWith = new Error('all zones reached replica limit');
    await assert.rejects(
      broker.acquire({ session: makeSession(), spec: makeSpec(), env: {}, credentialIds: [] }),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.retryable, true, 'capacity may free up');
        return true;
      },
    );

    driver.failWith = new Error('image not found: nope:latest');
    await assert.rejects(
      broker.acquire({ session: makeSession(), spec: makeSpec(), env: {}, credentialIds: [] }),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.retryable, false, 'a missing image will fail identically forever');
        return true;
      },
    );
  });

  test('heartbeat extends a live lease and fails for a reaped sandbox', async () => {
    const result = await broker.acquire({
      session: makeSession(),
      spec: makeSpec(),
      env: {},
      credentialIds: [],
    });
    assert.equal(await broker.heartbeat(result.sandbox.id), true);

    await store.sandboxes.update(result.sandbox.id, { status: 'lost' });
    assert.equal(
      await broker.heartbeat(result.sandbox.id),
      false,
      'a reaped sandbox must tell the runtime to stop',
    );
  });

  test('keeps a shared sandbox alive until its last holder releases', async () => {
    // With reuse OFF the last holder tears the environment down; a still-held
    // sandbox is never destroyed out from under a live session.
    const spec = makeSpec({ allowReuse: false });
    const a = makeSession();
    const b = makeSession();
    const first = await broker.acquire({ session: a, spec, env: {}, credentialIds: [] });
    // Force the sharing the pool key normally prevents, to exercise the release
    // guard directly.
    await store.sandboxes.update(first.sandbox.id, {
      sessionIds: [a.id, b.id],
      updatedAt: NOW,
    });

    await broker.release(first.sandbox.id, a.id, 'session a done');
    assert.equal((await store.sandboxes.get(first.sandbox.id))?.status, 'ready');
    assert.equal(driver.destroyed.length, 0);

    await broker.release(first.sandbox.id, b.id, 'session b done');
    assert.equal((await store.sandboxes.get(first.sandbox.id))?.status, 'released');
    assert.equal(driver.destroyed.length, 1);
  });

  test('keeps the last holder’s sandbox warm when reuse is enabled', async () => {
    // The reuse contract: releasing the last holder of an allowReuse sandbox
    // parks it warm and holderless rather than destroying it, so the next
    // session of the same pool key can rebind it instead of cold-starting.
    const spec = makeSpec({ allowReuse: true });
    const session = makeSession();
    const acquired = await broker.acquire({ session, spec, env: {}, credentialIds: [] });

    await broker.release(acquired.sandbox.id, session.id, 'session done');

    const after = await store.sandboxes.get(acquired.sandbox.id);
    assert.equal(after?.status, 'ready', 'a reusable sandbox is kept warm, not destroyed');
    assert.deepEqual(after?.sessionIds, [], 'it is holderless, ready for the next claim');
    assert.ok(after?.idleSince !== undefined, 'it is marked idle for the reaper');
    assert.deepEqual(driver.destroyed, [], 'the driver was not asked to destroy it');
  });

  test('releasing an unknown sandbox is a no-op', async () => {
    await broker.release(newId('sandbox'), 'sn_x', 'gone');
    assert.equal(driver.destroyed.length, 0);
  });

  test('the reaper extends a lease when the sandbox is actually alive', async () => {
    // A slow heartbeat must not cost a user their session.
    const result = await broker.acquire({
      session: makeSession(),
      spec: makeSpec(),
      env: {},
      credentialIds: [],
    });
    await store.sandboxes.update(result.sandbox.id, { leaseExpiresAt: NOW });
    driver.healthResult = 'healthy';

    const outcome = await broker.reapExpiredLeases();
    assert.deepEqual(outcome.recovered, [result.sandbox.id]);
    assert.deepEqual(outcome.reaped, []);
  });

  test('the reaper reclaims a sandbox that is genuinely gone', async () => {
    const result = await broker.acquire({
      session: makeSession(),
      spec: makeSpec(),
      env: {},
      credentialIds: [],
    });
    await store.sandboxes.update(result.sandbox.id, { leaseExpiresAt: NOW });
    driver.healthResult = 'gone';

    const outcome = await broker.reapExpiredLeases();
    assert.deepEqual(outcome.reaped, [result.sandbox.id]);
    assert.equal(driver.destroyed.length, 1);
  });

  test('a reaped sandbox is no longer offered for reuse', async () => {
    const spec = makeSpec();
    const first = await broker.acquire({ session: makeSession(), spec, env: {}, credentialIds: [] });
    await store.sandboxes.update(first.sandbox.id, { leaseExpiresAt: NOW });
    driver.healthResult = 'gone';
    await broker.reapExpiredLeases();

    const second = await broker.acquire({ session: makeSession(), spec, env: {}, credentialIds: [] });
    assert.equal(second.reused, false);
    assert.notEqual(second.sandbox.id, first.sandbox.id);
  });

  test('reuses a warm sandbox for the next session after the first releases', async () => {
    // The end-to-end reuse path: a session releases (keep-warm), the next
    // session of the same pool key claims the warm sandbox rather than cold
    // starting. This is what the whole feature exists to do.
    const spec = makeSpec({ allowReuse: true });
    const first = makeSession();
    const acquired = await broker.acquire({ session: first, spec, env: {}, credentialIds: [] });
    await broker.release(acquired.sandbox.id, first.id, 'first done');

    const second = makeSession();
    const reused = await broker.acquire({ session: second, spec, env: {}, credentialIds: [] });
    assert.equal(reused.reused, true, 'the second session reuses the warm sandbox');
    assert.equal(reused.sandbox.id, acquired.sandbox.id, 'same environment, no cold start');
    assert.equal(reused.runtimeToken, '', 'a reused sandbox keeps its original token');

    const row = await store.sandboxes.get(acquired.sandbox.id);
    assert.deepEqual(row?.sessionIds, [second.id], 'the warm sandbox now holds only the new session');
    assert.equal(row?.idleSince, undefined, 'claiming clears the idle marker');
    assert.equal(driver.provisioned.length, 1, 'only one cold start across both sessions');
  });

  test('the idle reaper destroys a warm sandbox past its idle window', async () => {
    const spec = makeSpec({ allowReuse: true, idleTimeoutSeconds: 30 });
    const session = makeSession();
    const acquired = await broker.acquire({ session, spec, env: {}, credentialIds: [] });
    await broker.release(acquired.sandbox.id, session.id, 'done');

    // Still fresh: the reaper leaves it alone.
    assert.deepEqual(await broker.reapIdleSandboxes(), []);
    assert.equal((await store.sandboxes.get(acquired.sandbox.id))?.status, 'ready');

    // Age it past the idle window (broker reads the real clock).
    await store.sandboxes.update(acquired.sandbox.id, { idleSince: Date.now() - 31_000 });
    const reaped = await broker.reapIdleSandboxes();
    assert.deepEqual(reaped, [acquired.sandbox.id], 'an over-idle sandbox is reaped');
    assert.equal((await store.sandboxes.get(acquired.sandbox.id))?.status, 'released');
    assert.equal(driver.destroyed.length, 1);
  });

  test('the idle reaper ignores a held sandbox', async () => {
    // Only holderless (idle_since set) sandboxes are eligible; one still serving
    // a session must never be reaped as idle.
    const spec = makeSpec({ allowReuse: true, idleTimeoutSeconds: 30 });
    const acquired = await broker.acquire({ session: makeSession(), spec, env: {}, credentialIds: [] });
    // Held sandboxes have no idle_since, so even an ancient createdAt is ignored
    // by the idle reaper (max-lifetime teardown happens on release, not here).
    assert.deepEqual(await broker.reapIdleSandboxes(), []);
    assert.equal((await store.sandboxes.get(acquired.sandbox.id))?.status, 'ready');
  });

  test('the idle reaper destroys a warm sandbox past its max lifetime', async () => {
    // A warm sandbox still inside its idle window but past its hard lifetime
    // ceiling is torn down. Inserted directly with an old createdAt because that
    // field is immutable through `update`.
    const now = Date.now();
    const spec = makeSpec({ allowReuse: true, idleTimeoutSeconds: 86_400, maxLifetimeSeconds: 60 });
    const sandbox = await store.sandboxes.create({
      id: newId('sandbox'),
      workspaceId: WORKSPACE,
      provider: driver.name,
      status: 'ready',
      endpoint: 'http://127.0.0.1:1',
      spec,
      poolKey: 'pk',
      sessionIds: [],
      leaseExpiresAt: now + 60_000,
      idleSince: now - 5_000, // fresh idle, but...
      providerRef: 'ref',
      runtimeTokenHash: '',
      createdAt: now - 61_000, // ...older than its 60s lifetime ceiling
      updatedAt: now,
      createdBy: 'system',
    });

    const reaped = await broker.reapIdleSandboxes();
    assert.deepEqual(reaped, [sandbox.id], 'a sandbox past its max lifetime is reaped even if not idle-timed-out');
    assert.equal((await store.sandboxes.get(sandbox.id))?.status, 'released');
  });

  test('discard tears down a sandbox that could not be rebound', async () => {
    // The rebind-failure fallback: the provisioner discards the warm sandbox it
    // claimed and cold-starts instead. The claiming session is dropped and the
    // environment destroyed.
    const spec = makeSpec({ allowReuse: true });
    const first = makeSession();
    const acquired = await broker.acquire({ session: first, spec, env: {}, credentialIds: [] });
    await broker.release(acquired.sandbox.id, first.id, 'first done');
    const second = makeSession();
    await broker.acquire({ session: second, spec, env: {}, credentialIds: [] });

    await broker.discard(acquired.sandbox.id, second.id, 'rebind failed');

    assert.equal((await store.sandboxes.get(acquired.sandbox.id))?.status, 'released');
    assert.equal(driver.destroyed.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Local driver — real processes
// ---------------------------------------------------------------------------

describe('local driver', () => {
  let driver: LocalSandboxDriver;
  let scriptDir: string;

  beforeEach(async () => {
    scriptDir = await mkdtemp(join(tmpdir(), 'ma-driver-test-'));
  });

  afterEach(async () => {
    await driver?.close();
  });

  /** Writes a script and returns a driver configured to run it. */
  async function driverRunning(body: string, startupTimeoutMs = 5000): Promise<LocalSandboxDriver> {
    const script = join(scriptDir, `agent-${Math.random().toString(36).slice(2, 8)}.mjs`);
    await writeFile(script, body, 'utf8');
    driver = new LocalSandboxDriver({
      clock: systemClock,
      logger: nullLogger,
      args: [script],
      startupTimeoutMs,
    });
    return driver;
  }

  const request: ProvisionRequest = {
    sandboxId: 'sb_test_1',
    workspaceId: WORKSPACE,
    spec: makeSpec(),
    env: {},
    runtimeToken: 'token-abc',
    controlPlaneUrl: 'http://127.0.0.1:8080',
  };

  test('starts a process and reads its endpoint from the ready marker', async () => {
    const local = await driverRunning(`
      console.log('AGENT_CORE_READY http://127.0.0.1:4321');
      setInterval(() => {}, 1000);
    `);

    const sandbox = await local.provision(request);
    assert.equal(sandbox.endpoint, 'http://127.0.0.1:4321');
    assert.equal(await local.health(sandbox.providerRef), 'healthy');
    await local.destroy(sandbox.providerRef, 'test over');
  });

  test('passes configuration through the environment, not the command line', async () => {
    // Anything in argv is readable by every user on the host.
    const local = await driverRunning(`
      const token = process.env.MA_RUNTIME_TOKEN;
      const custom = process.env.CUSTOM_VAR;
      console.log('AGENT_CORE_READY http://127.0.0.1:1/' + token + '/' + custom);
      setInterval(() => {}, 1000);
    `);

    const sandbox = await local.provision({ ...request, env: { CUSTOM_VAR: 'from-env' } });
    assert.ok(sandbox.endpoint.includes('token-abc'));
    assert.ok(sandbox.endpoint.includes('from-env'));
    await local.destroy(sandbox.providerRef, 'done');
  });

  test('does not leak the host environment into the sandbox', async () => {
    const local = await driverRunning(`
      console.log('AGENT_CORE_READY http://x/' + (process.env.MA_TEST_HOST_LEAK ?? 'absent'));
      setInterval(() => {}, 1000);
    `);

    process.env.MA_TEST_HOST_LEAK = 'should-not-appear';
    try {
      const sandbox = await local.provision(request);
      assert.ok(sandbox.endpoint.endsWith('/absent'), 'host variables must not be inherited');
      await local.destroy(sandbox.providerRef, 'done');
    } finally {
      delete process.env.MA_TEST_HOST_LEAK;
    }
  });

  test('reports a startup failure with the process stderr', async () => {
    const local = await driverRunning(`
      console.error('config file is missing');
      process.exit(3);
    `);

    await assert.rejects(local.provision(request), (error: unknown) => {
      const message = (error as Error).message;
      assert.ok(message.includes('config file is missing'), 'the cause must reach the operator');
      return true;
    });
  });

  test('times out a process that never signals readiness', async () => {
    const local = await driverRunning(`setInterval(() => {}, 1000);`, 300);
    await assert.rejects(local.provision(request), /did not become ready/);
    assert.equal(local.runningCount, 0, 'a failed start must not leak the process');
  });

  test('destroy stops the process and is idempotent', async () => {
    const local = await driverRunning(`
      console.log('AGENT_CORE_READY http://127.0.0.1:1');
      setInterval(() => {}, 1000);
    `);

    const sandbox = await local.provision(request);
    await local.destroy(sandbox.providerRef, 'first');
    assert.equal(await local.health(sandbox.providerRef), 'gone');
    // The reaper legitimately calls destroy for something already gone.
    await local.destroy(sandbox.providerRef, 'second');
    assert.equal(local.runningCount, 0);
  });

  test('reports an exited process as gone', async () => {
    const local = await driverRunning(`
      console.log('AGENT_CORE_READY http://127.0.0.1:1');
      setTimeout(() => process.exit(0), 50);
    `);

    const sandbox = await local.provision(request);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await local.health(sandbox.providerRef), 'gone');
  });

  test('health is gone for an unknown reference', async () => {
    const local = await driverRunning(`console.log('AGENT_CORE_READY http://x');`);
    assert.equal(await local.health('never-existed'), 'gone');
  });

  test('close stops every running sandbox', async () => {
    const local = await driverRunning(`
      console.log('AGENT_CORE_READY http://127.0.0.1:1');
      setInterval(() => {}, 1000);
    `);

    await local.provision(request);
    await local.provision({ ...request, sandboxId: 'sb_test_2' });
    assert.equal(local.runningCount, 2);

    await local.close();
    assert.equal(local.runningCount, 0);
  });
});
