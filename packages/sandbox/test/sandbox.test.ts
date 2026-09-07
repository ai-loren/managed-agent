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
import type { SandboxSpec, Session } from '@ma/contracts';
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

  test('reuses a warm sandbox for a matching pool key', async () => {
    const spec = makeSpec();
    const first = await broker.acquire({ session: makeSession(), spec, env: {}, credentialIds: [] });
    const second = await broker.acquire({ session: makeSession(), spec, env: {}, credentialIds: [] });

    assert.equal(second.reused, true);
    assert.equal(second.sandbox.id, first.sandbox.id);
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
    const spec = makeSpec();
    const a = makeSession();
    const b = makeSession();
    const first = await broker.acquire({ session: a, spec, env: {}, credentialIds: [] });
    await broker.acquire({ session: b, spec, env: {}, credentialIds: [] });

    await broker.release(first.sandbox.id, a.id, 'session a done');
    assert.equal((await store.sandboxes.get(first.sandbox.id))?.status, 'ready');
    assert.equal(driver.destroyed.length, 0);

    await broker.release(first.sandbox.id, b.id, 'session b done');
    assert.equal((await store.sandboxes.get(first.sandbox.id))?.status, 'released');
    assert.equal(driver.destroyed.length, 1);
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
