/**
 * Sandbox tests.
 *
 * The local driver is exercised with real child processes rather than a mock:
 * process lifecycle is exactly the part where a mock would agree with whatever
 * the code does and tell us nothing.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, newId, nullLogger, systemClock } from '@ma/core';
import type { Agent, Sandbox, SandboxSpec, Session } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import {
  LocalSandboxDriver,
  SandboxBroker,
  VolumeManager,
  WARM_DECLARATION_TTL_MS,
  computePoolKey,
  type ProvisionRequest,
  type ProvisionedSandbox,
  type SandboxDriver,
  type SandboxHealth,
} from '../src/index.ts';

const NOW = 1_700_000_000_000;
const WORKSPACE = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const AGENT = 'ag_01ARZ3NDEKTSV4RRFFQ69G5FAV';

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
    mounts: [],
    runAs: '',
    prewarm: 0,
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
    const input = { workspaceId: WORKSPACE, agentId: AGENT, spec: makeSpec(), credentialIds: ['cr_a'] };
    assert.equal(computePoolKey(input), computePoolKey({ ...input }));
  });

  test('credential order does not affect the key', () => {
    // Otherwise two logically identical sets would never share a sandbox.
    const a = computePoolKey({ workspaceId: WORKSPACE, agentId: AGENT, spec: makeSpec(), credentialIds: ['cr_a', 'cr_b'] });
    const b = computePoolKey({ workspaceId: WORKSPACE, agentId: AGENT, spec: makeSpec(), credentialIds: ['cr_b', 'cr_a'] });
    assert.equal(a, b);
  });

  test('a different credential set produces a different key', () => {
    // A warm sandbox holds resolved secrets in its environment; sharing it
    // across credential sets would leak them.
    const a = computePoolKey({ workspaceId: WORKSPACE, agentId: AGENT, spec: makeSpec(), credentialIds: ['cr_a'] });
    const b = computePoolKey({ workspaceId: WORKSPACE, agentId: AGENT, spec: makeSpec(), credentialIds: ['cr_b'] });
    assert.notEqual(a, b);
  });

  test('a rotated credential value produces a different key', () => {
    // Same id, new fingerprint (the value was rotated). The warm sandbox still
    // holds the pre-rotation secret, so it must NOT be reused — a different key
    // forces a cold start with the freshly-resolved value.
    const base = { workspaceId: WORKSPACE, agentId: AGENT, spec: makeSpec(), credentialIds: ['cr_a'] };
    const v1 = computePoolKey({ ...base, credentialFingerprint: 'fp-v1' });
    const v2 = computePoolKey({ ...base, credentialFingerprint: 'fp-v2' });
    assert.notEqual(v1, v2, 'a rotated value must not reuse the stale sandbox');

    const v1again = computePoolKey({ ...base, credentialFingerprint: 'fp-v1' });
    assert.equal(v1, v1again, 'the same fingerprint is the same pool');
  });

  test('omitting the credential fingerprint leaves the legacy key unchanged', () => {
    // Backward compatibility: undefined is dropped by JSON.stringify, so a key
    // computed without a fingerprint must equal the historical one.
    const withoutField = computePoolKey({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      spec: makeSpec(),
      credentialIds: ['cr_a'],
    });
    const withUndefined = computePoolKey({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      spec: makeSpec(),
      credentialIds: ['cr_a'],
      credentialFingerprint: undefined,
    });
    assert.equal(withoutField, withUndefined);
  });

  test('workspaces never share a pool', () => {
    const a = computePoolKey({ workspaceId: 'ws_a', agentId: AGENT, spec: makeSpec(), credentialIds: [] });
    const b = computePoolKey({ workspaceId: 'ws_b', agentId: AGENT, spec: makeSpec(), credentialIds: [] });
    assert.notEqual(a, b);
  });

  test('image, resources, network and setup all change the key', () => {
    const base = { workspaceId: WORKSPACE, agentId: AGENT, credentialIds: [] as string[] };
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
    const base = { workspaceId: WORKSPACE, agentId: AGENT, credentialIds: [] as string[] };
    assert.notEqual(
      computePoolKey({ ...base, spec: makeSpec({ allowReuse: false }) }),
      computePoolKey({ ...base, spec: makeSpec({ allowReuse: true }) }),
    );
  });

  test('mounts are part of the key, so a warm sandbox never leaks its filesystem', () => {
    // The reuse-leak invariant: a reused warm sandbox keeps its mounted
    // filesystem across sessions, and claimFromPool matches on key alone. If
    // mounts were not hashed, an agent declaring no mounts could claim a warm
    // sandbox that has another agent's volume bound at /data — reading, or
    // (when writable) overwriting, its persisted data. Two specs differing only
    // in mounts MUST get different keys.
    const base = { workspaceId: WORKSPACE, agentId: AGENT, credentialIds: [] as string[] };
    const none = computePoolKey({ ...base, spec: makeSpec() });
    const withMount = computePoolKey({
      ...base,
      spec: makeSpec({ mounts: [{ name: 'cache', target: '/data', readOnly: true }] }),
    });
    assert.notEqual(none, withMount);

    // A different target, a different name, and a different read-only flag each
    // change what the environment *is*, so each must fragment the pool.
    const original = withMount;
    for (const variant of [
      makeSpec({ mounts: [{ name: 'cache', target: '/other', readOnly: true }] }),
      makeSpec({ mounts: [{ name: 'other', target: '/data', readOnly: true }] }),
      makeSpec({ mounts: [{ name: 'cache', target: '/data', readOnly: false }] }),
    ]) {
      assert.notEqual(computePoolKey({ ...base, spec: variant }), original);
    }
  });

  test('mount order does not fragment the pool', () => {
    // Two logically identical mount sets declared in a different order describe
    // the same environment and must share, like credential order.
    const base = { workspaceId: WORKSPACE, agentId: AGENT, credentialIds: [] as string[] };
    const a = computePoolKey({
      ...base,
      spec: makeSpec({
        mounts: [
          { name: 'cache', target: '/data', readOnly: true },
          { name: 'models', target: '/models', readOnly: true },
        ],
      }),
    });
    const b = computePoolKey({
      ...base,
      spec: makeSpec({
        mounts: [
          { name: 'models', target: '/models', readOnly: true },
          { name: 'cache', target: '/data', readOnly: true },
        ],
      }),
    });
    assert.equal(a, b);
  });

  test('runAs is part of the key, so a warm sandbox never leaks its identity', () => {
    // The same reuse-leak invariant as mounts, for identity: a reused warm
    // sandbox on the k8s driver keeps the ServiceAccount (and thus the cloud IAM
    // role) it was provisioned with. If runAs were not hashed, a session asking
    // for identity 's3-reader' could claim a warm sandbox bound to 'db-admin' —
    // acting with credentials it was never granted. Two specs differing only in
    // runAs MUST get different keys.
    const base = { workspaceId: WORKSPACE, agentId: AGENT, credentialIds: [] as string[] };
    const none = computePoolKey({ ...base, spec: makeSpec() });
    const asReader = computePoolKey({ ...base, spec: makeSpec({ runAs: 's3-reader' }) });
    const asAdmin = computePoolKey({ ...base, spec: makeSpec({ runAs: 'db-admin' }) });
    assert.notEqual(none, asReader, 'no identity and a scoped identity must not share');
    assert.notEqual(asReader, asAdmin, 'two different identities must not share');
  });

  test('cosmetic fields do not fragment the pool', () => {
    // Idle timeout does not change what the environment *is*, so two sessions
    // differing only there should still be able to share.
    const a = computePoolKey({ workspaceId: WORKSPACE, agentId: AGENT, spec: makeSpec(), credentialIds: [] });
    const b = computePoolKey({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      spec: makeSpec({ idleTimeoutSeconds: 60 }),
      credentialIds: [],
    });
    assert.equal(a, b);
  });

  test('two agents never share a pool, so a reused runtime token stays within one agent', () => {
    // The reuse-leak invariant for identity across agents: a warm sandbox's
    // runtime token is reused by whichever session next claims it, and that token
    // is exposed to the (untrusted) agent code inside. If the pool spanned agents,
    // agent A could retain its token and, once its sandbox was reused by agent B
    // (same workspace, spec and credentials), replay it and act as B — reading B's
    // datasets, permitted models and skill bytes (all resolved from
    // session.agentId). Two inputs differing only in agentId MUST get different
    // keys, so claimFromPool (which matches on key alone) can never hand one
    // agent's warm sandbox to another.
    const base = { workspaceId: WORKSPACE, spec: makeSpec(), credentialIds: ['cr_a'] };
    const agentA = computePoolKey({ ...base, agentId: 'ag_aaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const agentB = computePoolKey({ ...base, agentId: 'ag_bbbbbbbbbbbbbbbbbbbbbbbbbb' });
    assert.notEqual(agentA, agentB, 'different agents must not share a warm-sandbox pool');

    // The same agent with the same shape still shares — reuse is confined, not
    // disabled.
    const agentAagain = computePoolKey({ ...base, agentId: 'ag_aaaaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.equal(agentA, agentAagain, "an agent's own same-shape sessions still share");
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
  /** Awaited inside health(), so a test can inject a concurrent heartbeat while
   * the reaper is mid-probe — the exact TOCTOU window the lease CAS closes. */
  onHealth: (() => Promise<void>) | undefined;

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

  async health(): Promise<SandboxHealth> {
    if (this.onHealth) await this.onHealth();
    return this.healthResult;
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
        maxCostMicrosPerDay: 0,
        maxStorageMb: 1024,
        maxAgents: 100,
        maxKnowledgeChunks: 100_000,
        eventRetentionDays: 90,
      },
      systemPrompt: '',
      version: 1,
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
        maxCostMicrosPerDay: 0,
        maxStorageMb: 1024,
        maxAgents: 100,
        maxKnowledgeChunks: 100_000,
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

    assert.equal(await warming.prewarm(WORKSPACE, AGENT, spec, [], {}), 2, 'fills an empty pool');
    assert.equal(await warming.prewarm(WORKSPACE, AGENT, spec, [], {}), 0, 'a full pool is left alone');
    assert.equal(driver.provisioned.length, 2);
  });

  test('prewarming is off unless configured', async () => {
    // The default costs nothing: idle sandboxes are a real bill.
    assert.equal(await broker.prewarm(WORKSPACE, AGENT, makeSpec(), [], {}), 0);
    assert.equal(driver.provisioned.length, 0);
  });

  test('a prewarmed sandbox becomes reapable after its first reuse', async () => {
    // The immortal-prewarm bug: a prewarmed sandbox carried a synthetic holder,
    // and claim used to append the real session rather than replace it. On
    // release the holder set was never empty, so the sandbox was never marked
    // idle and escaped every reaper — immortal after its first reuse. With the
    // replace fix, release leaves it holderless and idle, and the reaper collects
    // it.
    const warming = new SandboxBroker({
      store,
      clock: systemClock,
      drivers: [driver],
      logger: nullLogger,
      prewarmPerPool: 1,
    });
    const spec = makeSpec({ idleTimeoutSeconds: 30 });
    assert.equal(await warming.prewarm(WORKSPACE, agentId, spec, [], {}), 1);

    // A real session claims the warm sandbox, then finishes. Same agent as the
    // prewarm, since the pool is scoped per agent.
    const session = makeSession({ agentId, status: 'ready' });
    await store.sessions.create(session);
    const acquired = await warming.acquire({ session, spec, env: {}, credentialIds: [] });
    assert.equal(acquired.reused, true, 'the prewarmed sandbox was adopted');
    await store.sessions.update(session.id, { status: 'terminated' });
    await warming.release(acquired.sandbox.id, session.id, 'done');

    // Released holderless and idle — the synthetic prewarm holder is gone.
    const afterRelease = await store.sandboxes.get(acquired.sandbox.id);
    assert.deepEqual(afterRelease?.sessionIds, [], 'no phantom prewarm holder lingers');
    assert.ok(afterRelease?.idleSince !== undefined, 'it is marked idle for the reaper');

    // And the idle reaper now collects it once past its idle timeout.
    await store.sandboxes.update(acquired.sandbox.id, { idleSince: Date.now() - 31_000 });
    const reaped = await warming.reapIdleSandboxes();
    assert.ok(reaped.includes(acquired.sandbox.id), 'the once-immortal sandbox is now reaped');
    await warming.close();
  });

  test('a per-agent depth warms a pool even with the platform-wide pool off', async () => {
    const spec = makeSpec({ allowReuse: true, prewarm: 2 });
    assert.equal(await broker.prewarm(WORKSPACE, AGENT, spec, [], {}, undefined, spec.prewarm), 2);
    assert.equal(await broker.prewarm(WORKSPACE, AGENT, spec, [], {}, undefined, spec.prewarm), 0, 'a full pool is left alone');
  });

  test('a pool refills while a session holds one of its sandboxes', async () => {
    const spec = makeSpec({ allowReuse: true, prewarm: 2 });
    assert.equal(await broker.prewarm(WORKSPACE, agentId, spec, [], {}, undefined, 2), 2);
    const session = makeSession({ agentId, status: 'ready' });
    await store.sessions.create(session);
    const claimed = await broker.acquire({ session, spec, env: {}, credentialIds: [] });
    assert.equal(claimed.reused, true);

    assert.equal(await broker.prewarm(WORKSPACE, agentId, spec, [], {}, undefined, 2), 1, 'the held one is not warm');
    const ready = (await store.sandboxes.list({ workspaceId: WORKSPACE, statuses: ['ready'], limit: 10 })).items;
    assert.equal(ready.filter((sandbox) => sandbox.idleSince !== undefined).length, 2);
  });

  test('a declared pool loses only what is beyond the depth last declared to idleness', async () => {
    const spec = makeSpec({ idleTimeoutSeconds: 30, allowReuse: true, prewarm: 3 });
    assert.equal(await broker.prewarm(WORKSPACE, AGENT, spec, [], {}, undefined, 3, { declared: true }), 3);
    // The agent lowers its depth; the next sweep declares the lower one.
    assert.equal(await broker.prewarm(WORKSPACE, AGENT, spec, [], {}, undefined, 2, { declared: true }), 0);
    const warm = async (): Promise<Sandbox[]> =>
      (await store.sandboxes.list({ workspaceId: WORKSPACE, statuses: ['ready'], limit: 10 })).items;
    for (const member of await warm()) {
      await store.sandboxes.update(member.id, { idleSince: Date.now() - 31_000 });
    }

    assert.equal((await broker.reapIdleSandboxes()).length, 1, 'three idle, two kept');
    assert.deepEqual(await broker.reapIdleSandboxes(), [], 'the declared depth is not reaped for idleness');
    assert.equal((await warm()).length, 2);

    const [oldest] = await warm();
    store.database.run('UPDATE sandboxes SET created_at = ? WHERE id = ?', [
      Date.now() - spec.maxLifetimeSeconds * 1000 - 1,
      oldest!.id,
    ]);
    assert.deepEqual(await broker.reapIdleSandboxes(), [oldest!.id], 'one past its lifetime is replaced regardless');
  });

  test('a pool no longer declared, or never declared by the sweep, loses its idle sandboxes', async () => {
    const spec = makeSpec({ idleTimeoutSeconds: 30, allowReuse: true, prewarm: 2 });
    const idle = async (): Promise<void> => {
      for (const member of (await store.sandboxes.list({ workspaceId: WORKSPACE, statuses: ['ready'], limit: 10 })).items) {
        await store.sandboxes.update(member.id, { idleSince: Date.now() - 31_000 });
      }
    };

    assert.equal(await broker.prewarm(WORKSPACE, AGENT, spec, [], {}, undefined, 2, { declared: true }), 2);
    // The sweep stopped visiting it: the agent was archived or its prewarm dropped.
    store.database.run('UPDATE sandboxes SET warm_declared_at = ?', [Date.now() - WARM_DECLARATION_TTL_MS - 1]);
    await idle();
    assert.equal((await broker.reapIdleSandboxes()).length, 2);

    // A top-up after a release is for the version the session ran, which may be an old one.
    assert.equal(await broker.prewarm(WORKSPACE, AGENT, spec, [], {}, undefined, 2), 2);
    await idle();
    assert.equal((await broker.reapIdleSandboxes()).length, 2);
  });

  test('a session that needs its own sandbox gets one by giving back a warm one, within the limit', async () => {
    await store.workspaces.update(WORKSPACE, {
      quota: {
        maxConcurrentSessions: 100, maxSandboxes: 2, maxTokensPerDay: 1_000_000, maxCostMicrosPerDay: 0,
        maxStorageMb: 1024, maxAgents: 100, maxKnowledgeChunks: 100_000, eventRetentionDays: 90,
      },
      updatedAt: NOW,
    });
    const warmSpec = makeSpec({ allowReuse: true, prewarm: 2 });
    assert.equal(await broker.prewarm(WORKSPACE, AGENT, warmSpec, [], {}, undefined, 2, { declared: true }), 2);

    const other = await broker.acquire({ session: makeSession(), spec: makeSpec({ allowReuse: false }), env: {}, credentialIds: [] });
    assert.equal(other.reused, false);
    const live = (await store.sandboxes.list({ workspaceId: WORKSPACE, statuses: ['pending', 'ready', 'draining'], limit: 10 })).items;
    assert.equal(live.length, 2, 'the limit still holds');
    assert.equal(live.filter((sandbox) => sandbox.idleSince !== undefined).length, 1, 'one warm sandbox was given back');
  });

  test('two top-ups of one pool at once stop at its depth', async () => {
    const spec = makeSpec({ allowReuse: true, prewarm: 2 });
    const created = await Promise.all([
      broker.prewarm(WORKSPACE, AGENT, spec, [], {}, undefined, 2, { declared: true }),
      broker.prewarm(WORKSPACE, AGENT, spec, [], {}, undefined, 2, { declared: true }),
    ]);
    assert.equal(created[0]! + created[1]!, 2);
    assert.equal(driver.provisioned.length, 2);
  });

  test('an agent that keeps no warm sandboxes loses every idle one, as before', async () => {
    const spec = makeSpec({ idleTimeoutSeconds: 30, allowReuse: true });
    const warming = new SandboxBroker({ store, clock: systemClock, drivers: [driver], logger: nullLogger, prewarmPerPool: 2 });
    assert.equal(await warming.prewarm(WORKSPACE, AGENT, spec, [], {}), 2);
    for (const member of (await store.sandboxes.list({ workspaceId: WORKSPACE, statuses: ['ready'], limit: 10 })).items) {
      await store.sandboxes.update(member.id, { idleSince: Date.now() - 31_000 });
    }
    assert.equal((await warming.reapIdleSandboxes()).length, 2);
    await warming.close();
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

  test('keeps the code a driver refused with, rather than guessing from its words', async () => {
    driver.failWith = new MaError({
      code: 'SANDBOX_EGRESS_UNENFORCEABLE',
      category: 'precondition',
      message: 'cannot hold this egress policy within the limits of this host',
    });
    await assert.rejects(
      broker.acquire({ session: makeSession(), spec: makeSpec(), env: {}, credentialIds: [] }),
      (error: unknown) => MaError.is(error) && error.code === 'SANDBOX_EGRESS_UNENFORCEABLE' && error.retryable === false,
    );
    const [lost] = (await store.sandboxes.list({ workspaceId: WORKSPACE, statuses: ['lost'] })).items;
    assert.equal(lost?.error?.code, 'SANDBOX_EGRESS_UNENFORCEABLE', 'not a retryable quota error for saying "limits"');
    assert.equal(lost?.error?.retryable, false);
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

  test('a heartbeat that renews the lease during the health probe is not reaped', async () => {
    // TOCTOU: the reaper reads an expired sandbox, then awaits driver.health()
    // (a real event-loop yield — a network probe). If a heartbeat lands in that
    // window it renews the lease and the runtime keeps executing; the reaper must
    // NOT then destroy it. Before the lease CAS, #markLost was a raw update by id
    // that ignored the renewed lease and tore down a live, heartbeating sandbox
    // mid-turn. Here health resolves 'gone' (the false-unreachable a slow/500ing
    // provider produces), but a heartbeat renews the lease during the probe.
    const result = await broker.acquire({
      session: makeSession(),
      spec: makeSpec(),
      env: {},
      credentialIds: [],
    });
    await store.sandboxes.update(result.sandbox.id, { leaseExpiresAt: NOW });
    driver.healthResult = 'gone';
    // The heartbeat arrives while the reaper is inside driver.health().
    driver.onHealth = async () => {
      await store.sandboxes.renewLease(result.sandbox.id, NOW + 120_000, NOW);
    };

    const outcome = await broker.reapExpiredLeases();

    assert.deepEqual(outcome.reaped, [], 'a sandbox whose lease was renewed mid-probe must not be reaped');
    assert.equal(driver.destroyed.length, 0, 'the live sandbox must not be destroyed');
    const after = await store.sandboxes.get(result.sandbox.id);
    assert.equal(after?.status, 'ready', 'the sandbox stays ready, not lost');
    assert.equal(after?.leaseExpiresAt, NOW + 120_000, 'the renewed lease survives');
  });

  test('heartbeat refuses to renew a held sandbox past its max lifetime', async () => {
    // A held sandbox heartbeats forever, so its lease never lapses and neither
    // reaper collects it. The hard lifetime ceiling was only checked on release,
    // so a long-lived held session outlived it indefinitely. The heartbeat must
    // refuse once past the ceiling — the falsey return stops the runtime and the
    // lease then lapses into the expired-lease reaper. createdAt is immutable
    // through `update`, so the row is inserted directly with an old one.
    const now = Date.now();
    const spec = makeSpec({ maxLifetimeSeconds: 60 });
    const held = makeSession();
    const sandbox = await store.sandboxes.create({
      id: newId('sandbox'),
      workspaceId: WORKSPACE,
      provider: driver.name,
      status: 'ready',
      endpoint: 'http://127.0.0.1:1',
      spec,
      poolKey: 'pk',
      sessionIds: [held.id],
      leaseExpiresAt: now + 60_000,
      providerRef: 'ref',
      runtimeTokenHash: '',
      createdAt: now - 61_000, // older than its 60s lifetime ceiling
      updatedAt: now,
      createdBy: 'system',
    });

    assert.equal(
      await broker.heartbeat(sandbox.id),
      false,
      'a held sandbox past its lifetime ceiling is told to stop',
    );
    // Refusal does not itself extend the lease, so it lapses on schedule.
    const after = await store.sandboxes.get(sandbox.id);
    assert.equal(after?.status, 'ready', 'the refusal alone does not tear it down');
  });

  test('heartbeat still renews a held sandbox within its max lifetime', async () => {
    // The guard must not misfire on a normal, in-lifetime sandbox.
    const spec = makeSpec({ maxLifetimeSeconds: 86_400 });
    const acquired = await broker.acquire({
      session: makeSession(),
      spec,
      env: {},
      credentialIds: [],
    });
    assert.equal(await broker.heartbeat(acquired.sandbox.id), true, 'a fresh held sandbox renews');
  });

  test('the lease reaper reaps a healthy sandbox that is past its max lifetime', async () => {
    // The recovery branch renews a still-healthy sandbox whose lease lapsed. For
    // one past its lifetime ceiling that would resurrect exactly what heartbeat
    // refused to keep alive, so the aged-out check must run BEFORE the health
    // probe: reap it, do not recover it.
    const now = Date.now();
    const spec = makeSpec({ maxLifetimeSeconds: 60 });
    const held = makeSession();
    const sandbox = await store.sandboxes.create({
      id: newId('sandbox'),
      workspaceId: WORKSPACE,
      provider: driver.name,
      status: 'ready',
      endpoint: 'http://127.0.0.1:1',
      spec,
      poolKey: 'pk',
      sessionIds: [held.id],
      leaseExpiresAt: now - 1_000, // lease already lapsed
      providerRef: 'ref',
      runtimeTokenHash: '',
      createdAt: now - 61_000, // past the 60s lifetime ceiling
      updatedAt: now,
      createdBy: 'system',
    });
    driver.healthResult = 'healthy'; // would be recovered if not for the age check

    const outcome = await broker.reapExpiredLeases();
    assert.deepEqual(outcome.reaped, [sandbox.id], 'an aged-out sandbox is reaped, not recovered');
    assert.deepEqual(outcome.recovered, [], 'a healthy but aged-out sandbox is never renewed');
    assert.equal(driver.destroyed.length, 1, 'the environment is torn down');
    assert.equal((await store.sandboxes.get(sandbox.id))?.status, 'released');
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
    // Same agent, sequential sessions — the pool is scoped per agent, so reuse
    // requires the claiming session to belong to the same agent as the warm one.
    const first = makeSession({ agentId: AGENT });
    const acquired = await broker.acquire({ session: first, spec, env: {}, credentialIds: [] });
    await broker.release(acquired.sandbox.id, first.id, 'first done');

    const second = makeSession({ agentId: AGENT });
    const reused = await broker.acquire({ session: second, spec, env: {}, credentialIds: [] });
    assert.equal(reused.reused, true, 'the second session reuses the warm sandbox');
    assert.equal(reused.sandbox.id, acquired.sandbox.id, 'same environment, no cold start');
    assert.equal(reused.runtimeToken, '', 'a reused sandbox keeps its original token');

    const row = await store.sandboxes.get(acquired.sandbox.id);
    assert.deepEqual(row?.sessionIds, [second.id], 'the warm sandbox now holds only the new session');
    assert.equal(row?.idleSince, undefined, 'claiming clears the idle marker');
    assert.equal(driver.provisioned.length, 1, 'only one cold start across both sessions');
  });

  test('a rotated credential forces a cold start instead of reusing a stale sandbox', async () => {
    // The end-to-end rotation guard: a warm sandbox baked the pre-rotation secret
    // into its env. After the value rotates (new fingerprint), the next session —
    // same credential ids — must NOT reuse it; it cold-starts with the fresh
    // value. A later session back on the original fingerprint reuses the original.
    const spec = makeSpec({ allowReuse: true });
    const ids = ['cr_a'];

    // Same agent throughout — reuse is scoped per agent.
    const first = makeSession({ agentId: AGENT });
    const a = await broker.acquire({
      session: first,
      spec,
      env: {},
      credentialIds: ids,
      credentialFingerprint: 'fp-v1',
    });
    await broker.release(a.sandbox.id, first.id, 'first done');

    // Rotate: same ids, new fingerprint → different pool key → cold start.
    const second = makeSession({ agentId: AGENT });
    const b = await broker.acquire({
      session: second,
      spec,
      env: {},
      credentialIds: ids,
      credentialFingerprint: 'fp-v2',
    });
    assert.equal(b.reused, false, 'a rotated credential must not reuse the stale sandbox');
    assert.notEqual(b.sandbox.id, a.sandbox.id, 'it is a fresh environment');
    assert.equal(driver.provisioned.length, 2, 'the rotation cost one cold start');
    await broker.release(b.sandbox.id, second.id, 'second done');

    // Back on the original fingerprint: the first sandbox is still warm and reused.
    const third = makeSession({ agentId: AGENT });
    const c = await broker.acquire({
      session: third,
      spec,
      env: {},
      credentialIds: ids,
      credentialFingerprint: 'fp-v1',
    });
    assert.equal(c.reused, true, 'the unrotated pool is still reusable');
    assert.equal(c.sandbox.id, a.sandbox.id, 'it reuses the original warm sandbox');
    assert.equal(driver.provisioned.length, 2, 'no extra cold start for the original pool');
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

  test('the idle reaper does not tear down a sandbox a live claim just took', async () => {
    // The reap race: `reapIdleSandboxes` reads the idle list, then for each one
    // drains and destroys. If a `claimFromPool` lands in that window, an
    // unguarded drain would destroy an environment a live session just claimed.
    // Simulate the race by claiming between the reaper's `findIdle` read and its
    // drain — the CAS on `idle_since` must make the reaper skip it.
    const spec = makeSpec({ allowReuse: true, idleTimeoutSeconds: 30 });
    const first = makeSession();
    const acquired = await broker.acquire({ session: first, spec, env: {}, credentialIds: [] });
    await broker.release(acquired.sandbox.id, first.id, 'first done');

    // Age it so, absent a race, the reaper would tear it down.
    const warm = await store.sandboxes.get(acquired.sandbox.id);
    await store.sandboxes.update(acquired.sandbox.id, { idleSince: Date.now() - 31_000 });
    const staleSnapshot = { ...warm!, idleSince: Date.now() - 31_000 };

    // Drive a real concurrent claim inside findIdle, then hand the reaper the
    // pre-claim snapshot it would have read a moment earlier.
    const live = makeSession();
    const realFindIdle = store.sandboxes.findIdle.bind(store.sandboxes);
    let raced = false;
    store.sandboxes.findIdle = async (now: number, limit: number) => {
      await realFindIdle(now, limit); // exercise the real query
      if (!raced) {
        raced = true;
        const claimed = await store.sandboxes.claimFromPool(warm!.poolKey, live.id, Date.now());
        assert.ok(claimed, 'a live session claims the warm sandbox mid-reap');
      }
      return [staleSnapshot];
    };

    try {
      const reaped = await broker.reapIdleSandboxes();
      assert.deepEqual(reaped, [], 'the claimed sandbox is not reaped');
    } finally {
      store.sandboxes.findIdle = realFindIdle;
    }

    assert.deepEqual(driver.destroyed, [], 'the driver was never asked to destroy the live sandbox');
    const survivor = await store.sandboxes.get(acquired.sandbox.id);
    assert.equal(survivor?.status, 'ready', 'the sandbox stays ready for its new holder');
    assert.deepEqual(survivor?.sessionIds, [live.id], 'the live session still holds it');
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

  test('a refusal agent-core reports on its way out keeps its code', async () => {
    const refusal = { code: 'SANDBOX_EGRESS_UNENFORCEABLE', message: "This sandbox's egress is restricted with a network namespace." };
    const local = await driverRunning(`
      process.stderr.write('AGENT_CORE_REFUSED ' + ${JSON.stringify(JSON.stringify(refusal))} + '\\n');
      process.stderr.write('agent core failed to start: MaError: x\\n');
      process.exit(1);
    `);
    await assert.rejects(local.provision(request), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, refusal.code);
      assert.equal(error.category, 'precondition');
      assert.equal(error.message, refusal.message);
      return true;
    });
  });

  test('a code outside the sandbox layer’s is not taken from a sandbox’s output', async () => {
    const local = await driverRunning(`
      process.stderr.write('AGENT_CORE_REFUSED {"code":"QUOTA_EXCEEDED","message":"pretend"}\\n');
      process.exit(1);
    `);
    await assert.rejects(local.provision(request), (error: unknown) => {
      assert.ok(!MaError.is(error) || error.code !== 'QUOTA_EXCEEDED');
      assert.match(String((error as Error).message), /exited during startup with code 1/);
      return true;
    });
  });

  test('refuses a declared runAs: a child process runs as the host user', async () => {
    // Fail-closed: a child process has no service-account and runs as the host
    // user, so a spec asking for a scoped identity cannot be honoured. Running it
    // anyway would grant more identity than the agent asked for — refuse instead.
    const local = await driverRunning(`
      console.log('AGENT_CORE_READY http://127.0.0.1:4321');
      setInterval(() => {}, 1000);
    `);

    await assert.rejects(
      local.provision({ ...request, spec: makeSpec({ runAs: 's3-reader' }) }),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'SANDBOX_IDENTITY_UNSUPPORTED');
        return true;
      },
    );
  });

  describe('egress enforcement (MA_LOCAL_EGRESS=enforce)', () => {
    /** Provision a script that records the environment it was started with. */
    async function provisionedEnv(
      options: Partial<ConstructorParameters<typeof LocalSandboxDriver>[0]>,
      spec: SandboxSpec,
      controlPlaneUrl = 'http://127.0.0.1:8080',
    ): Promise<Record<string, string>> {
      const out = join(scriptDir, `env-${Math.random().toString(36).slice(2, 8)}.json`);
      const script = join(scriptDir, 'agent-env.mjs');
      await writeFile(
        script,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n` +
          "console.log('AGENT_CORE_READY http://127.0.0.1:4321');\nsetInterval(() => {}, 1000);\n",
        'utf8',
      );
      driver = new LocalSandboxDriver({ clock: systemClock, logger: nullLogger, args: [script], startupTimeoutMs: 5000, egress: 'enforce', ...options });
      const sandbox = await driver.provision({ ...request, spec, controlPlaneUrl });
      const env = JSON.parse(await readFile(out, 'utf8')) as Record<string, string>;
      await driver.destroy(sandbox.providerRef, 'test over');
      return env;
    }
    const deny = makeSpec({ network: { egress: 'deny', allowedHosts: [] } });
    const allowlist = makeSpec({ network: { egress: 'allowlist', allowedHosts: ['api.example.com'] } });
    const refusal = (pattern: RegExp) => (error: unknown) =>
      MaError.is(error) && error.code === 'SANDBOX_EGRESS_UNENFORCEABLE' && pattern.test(error.message);

    test('on macOS a deny policy confines subprocesses to the control plane alone', async () => {
      const env = await provisionedEnv({ platform: 'darwin' }, deny);
      assert.equal(
        env.MA_EGRESS_CONFINE,
        'seatbelt:(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:8080"))',
      );
      assert.equal(env.HTTPS_PROXY, undefined);
    });

    test('on macOS an allowlist goes through a loopback proxy, and nothing else', async () => {
      const env = await provisionedEnv({ platform: 'darwin', egressProxy: 'http://127.0.0.1:3128' }, allowlist);
      assert.match(env.MA_EGRESS_CONFINE ?? '', /\(remote ip "localhost:8080"\)\)\(allow network-outbound \(remote ip "localhost:3128"\)\)$/);
      assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3128');
      assert.equal(env.no_proxy, '127.0.0.1,localhost,127.0.0.1:8080');
    });

    test('on macOS, with the managed proxy’s secret, the proxy URL carries this sandbox’s signed grant', async () => {
      const secret = 'a-shared-secret-of-at-least-thirty-two-chars';
      const env = await provisionedEnv({ platform: 'darwin', egressProxy: 'http://127.0.0.1:3128', egressProxySecret: secret }, allowlist);
      const url = new URL(env.HTTPS_PROXY!);
      assert.equal(`${url.protocol}//${url.host}`, 'http://127.0.0.1:3128');
      const [version, payload, signature] = decodeURIComponent(url.password).split('.');
      assert.equal(version, 'v1');
      assert.equal(signature, createHmac('sha256', secret).update(`v1.${payload}`).digest('base64url'));
      const grant = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { sid: string; hosts: string[] };
      assert.equal(decodeURIComponent(url.username), grant.sid);
      assert.deepEqual(grant.hosts, ['api.example.com']);
    });

    test('on macOS an allowlist with no proxy, or one off this host, is refused', async () => {
      await assert.rejects(provisionedEnv({ platform: 'darwin' }, allowlist), refusal(/api\.example\.com.*Set MA_EGRESS_PROXY/));
      await assert.rejects(
        provisionedEnv({ platform: 'darwin', egressProxy: 'http://proxy.internal:3128' }, allowlist),
        refusal(/not on this host's loopback\. Run it on 127\.0\.0\.1/),
      );
    });

    test('on Linux a deny policy puts subprocesses in a network namespace', async () => {
      const env = await provisionedEnv({ platform: 'linux', netnsAvailable: () => Promise.resolve(true) }, deny);
      assert.equal(env.MA_EGRESS_CONFINE, 'netns');
    });

    test('on Linux without unprivileged namespaces, or with an allowlist, it is refused', async () => {
      await assert.rejects(
        provisionedEnv({ platform: 'linux', netnsAvailable: () => Promise.resolve(false) }, deny),
        refusal(/unshare --net --map-root-user.*apparmor_restrict_unprivileged_userns=0.*MA_LOCAL_EGRESS=warn/),
      );
      await assert.rejects(
        provisionedEnv({ platform: 'linux', netnsAvailable: () => Promise.resolve(true) }, allowlist),
        refusal(/reaches nothing on the host\. Use the container driver/),
      );
    });

    test('a control plane off this host, or an OS with no confinement, is refused', async () => {
      await assert.rejects(provisionedEnv({ platform: 'darwin' }, deny, 'http://10.0.0.5:8080'), refusal(/Point MA_CONTROL_PLANE_URL at 127\.0\.0\.1/));
      await assert.rejects(provisionedEnv({ platform: 'win32' }, deny), refusal(/no subprocess confinement on win32/));
    });

    test('an allow policy is not confined', async () => {
      const env = await provisionedEnv({ platform: 'darwin' }, makeSpec({ network: { egress: 'allow', allowedHosts: [] } }));
      assert.equal(env.MA_EGRESS_CONFINE, undefined);
    });
  });

  test('warns (does not silently ignore) a restricted egress policy it cannot enforce', async () => {
    // The local driver shares the host network and cannot enforce deny/allowlist.
    // It must not pretend to — it warns on every restricted provision so an
    // operator learns the boundary is not real — while still allowing the default
    // dev flow to run (it does not fail-closed like container/k8s, or the platform
    // would be unusable out of the box on its default driver).
    const warnings: { message: string; egress?: unknown }[] = [];
    const script = join(scriptDir, `agent-egress.mjs`);
    await writeFile(script, "console.log('AGENT_CORE_READY http://127.0.0.1:4321');\nsetInterval(() => {}, 1000);\n", 'utf8');
    driver = new LocalSandboxDriver({
      clock: systemClock,
      logger: {
        ...nullLogger,
        warn: (message: string, fields?: Record<string, unknown>) =>
          warnings.push({ message, egress: fields?.egress }),
      },
      args: [script],
      startupTimeoutMs: 5000,
    });

    // A restricted (default allowlist) spec provisions but warns.
    const restricted = await driver.provision({ ...request, spec: makeSpec({ network: { egress: 'deny', allowedHosts: [] } }) });
    assert.ok(
      warnings.some((w) => w.egress === 'deny' && /egress/i.test(w.message)),
      'a restricted egress policy must produce a warning, not silence',
    );
    await driver.destroy(restricted.providerRef, 'test over');

    // An `allow` spec is honestly unrestricted — no warning.
    warnings.length = 0;
    const open = await driver.provision({ ...request, sandboxId: 'sb_open', spec: makeSpec({ network: { egress: 'allow', allowedHosts: [] } }) });
    assert.equal(warnings.length, 0, 'an allow policy needs no warning — nothing is being unenforced');
    await driver.destroy(open.providerRef, 'test over');
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

  test('delivers platform credential env, which sanitizeEnv would otherwise strip', async () => {
    // The silent-drop bug on the local driver too: an api_key/bearer_token
    // credential arrives as `MA_CRED_<NAME>`, but the supplied env is sanitised
    // (all `MA_*` stripped), so the trusted platform map must be delivered
    // separately or the secret never reaches the process.
    const local = await driverRunning(`
      const cred = process.env.MA_CRED_STRIPE ?? 'absent';
      console.log('AGENT_CORE_READY http://127.0.0.1:1/' + cred);
      setInterval(() => {}, 1000);
    `);

    const sandbox = await local.provision({
      ...request,
      credentialEnv: { MA_CRED_STRIPE: 'sk_live_secret' },
    });
    assert.ok(
      sandbox.endpoint.endsWith('/sk_live_secret'),
      'the platform credential value must reach the process',
    );
    await local.destroy(sandbox.providerRef, 'done');
  });

  test('a credential value cannot override the runtime token on the local driver', async () => {
    const local = await driverRunning(`
      console.log('AGENT_CORE_READY http://127.0.0.1:1/' + process.env.MA_RUNTIME_TOKEN);
      setInterval(() => {}, 1000);
    `);

    const sandbox = await local.provision({
      ...request,
      credentialEnv: { MA_RUNTIME_TOKEN: 'spoof' },
    });
    assert.ok(sandbox.endpoint.endsWith('/token-abc'), 'the real runtime token must win');
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

  describe('volume mounts', () => {
    let volumeRoot: string;

    beforeEach(async () => {
      volumeRoot = await mkdtemp(join(tmpdir(), 'ma-volroot-'));
    });

    afterEach(async () => {
      await rm(volumeRoot, { recursive: true, force: true });
    });

    /** A driver with volume storage configured, running the given script. */
    async function driverWithVolumes(body: string): Promise<LocalSandboxDriver> {
      const script = join(scriptDir, `agent-${Math.random().toString(36).slice(2, 8)}.mjs`);
      await writeFile(script, body, 'utf8');
      driver = new LocalSandboxDriver({
        clock: systemClock,
        logger: nullLogger,
        args: [script],
        startupTimeoutMs: 5000,
        volumes: new VolumeManager({ root: volumeRoot }),
      });
      return driver;
    }

    test('exposes a managed volume through MA_VOLUME_<NAME> and a workdir symlink', async () => {
      // The child sees the resolved path in the env and a symlink beside its
      // working directory; both point at the workspace-scoped managed dir.
      const local = await driverWithVolumes(`
        import { writeFileSync, realpathSync } from 'node:fs';
        const dir = process.env.MA_VOLUME_CACHE;
        // Prove the symlink at the target basename resolves to the same dir.
        const linked = realpathSync('cache');
        writeFileSync(dir + '/marker.txt', 'hello');
        console.log('AGENT_CORE_READY http://127.0.0.1:1/' + (linked === realpathSync(dir)));
        setInterval(() => {}, 1000);
      `);

      const sandbox = await local.provision({
        ...request,
        spec: makeSpec({ mounts: [{ name: 'cache', target: '/data/cache', readOnly: true }] }),
      });
      assert.ok(sandbox.endpoint.endsWith('/true'), 'the symlink must resolve to the managed dir');
      await local.destroy(sandbox.providerRef, 'done');

      // The write landed under <root>/<workspaceId>/cache — the managed location.
      const marker = await readFile(join(volumeRoot, WORKSPACE, 'cache', 'marker.txt'), 'utf8');
      assert.equal(marker, 'hello');
    });

    test('persists data across sessions of the same agent (the whole point)', async () => {
      // Session one writes; session two of the same (workspace, volume) reads it
      // back. This is cross-session persistence — what an ephemeral /workspace
      // cannot give.
      const writer = await driverWithVolumes(`
        import { writeFileSync } from 'node:fs';
        writeFileSync(process.env.MA_VOLUME_STATE + '/seen.txt', 'from-session-one');
        console.log('AGENT_CORE_READY http://127.0.0.1:1');
        setInterval(() => {}, 1000);
      `);
      const spec = makeSpec({ mounts: [{ name: 'state', target: '/data/state', readOnly: false }] });
      const first = await writer.provision({ ...request, sandboxId: 'sb_sess_1', spec });
      await writer.destroy(first.providerRef, 'session one over');

      const reader = await driverWithVolumes(`
        import { readFileSync } from 'node:fs';
        const seen = readFileSync(process.env.MA_VOLUME_STATE + '/seen.txt', 'utf8');
        console.log('AGENT_CORE_READY http://127.0.0.1:1/' + seen);
        setInterval(() => {}, 1000);
      `);
      const second = await reader.provision({ ...request, sandboxId: 'sb_sess_2', spec });
      assert.ok(
        second.endpoint.endsWith('/from-session-one'),
        'a later session must see the earlier one’s data',
      );
      await reader.destroy(second.providerRef, 'session two over');
    });

    test('a different workspace cannot see another workspace’s volume', async () => {
      // Workspace isolation: same volume name, different workspace, disjoint data.
      const spec = makeSpec({ mounts: [{ name: 'shared', target: '/data/shared', readOnly: false }] });
      const owner = await driverWithVolumes(`
        import { writeFileSync } from 'node:fs';
        writeFileSync(process.env.MA_VOLUME_SHARED + '/secret.txt', 'owner-only');
        console.log('AGENT_CORE_READY http://127.0.0.1:1');
        setInterval(() => {}, 1000);
      `);
      const ownerSandbox = await owner.provision({ ...request, sandboxId: 'sb_owner', spec });
      await owner.destroy(ownerSandbox.providerRef, 'done');

      const OTHER_WS = 'ws_01BXYZ3NDEKTSV4RRFFQ69G5FB';
      const intruder = await driverWithVolumes(`
        import { existsSync } from 'node:fs';
        console.log('AGENT_CORE_READY http://127.0.0.1:1/' + existsSync(process.env.MA_VOLUME_SHARED + '/secret.txt'));
        setInterval(() => {}, 1000);
      `);
      const intruderSandbox = await intruder.provision({
        ...request,
        sandboxId: 'sb_intruder',
        workspaceId: OTHER_WS,
        spec,
      });
      assert.ok(
        intruderSandbox.endpoint.endsWith('/false'),
        'another workspace must not reach the owner’s data',
      );
      await intruder.destroy(intruderSandbox.providerRef, 'done');
    });

    test('refuses a declared mount when no volume storage is configured', async () => {
      // Fail-closed even on the local driver: the spec asked for persistence the
      // deployment cannot give, so refuse rather than start without it.
      const script = join(scriptDir, 'agent-nomount.mjs');
      await writeFile(script, `console.log('AGENT_CORE_READY http://x'); setInterval(() => {}, 1000);`, 'utf8');
      driver = new LocalSandboxDriver({ clock: systemClock, logger: nullLogger, args: [script] });

      await assert.rejects(
        driver.provision({
          ...request,
          spec: makeSpec({ mounts: [{ name: 'cache', target: '/data', readOnly: true }] }),
        }),
        (error: unknown) => {
          assert.ok(MaError.is(error));
          assert.equal(error.code, 'SANDBOX_MOUNT_UNSUPPORTED');
          return true;
        },
      );
      assert.equal(driver.runningCount, 0, 'a refused mount must not leak a process');
    });
  });
});
