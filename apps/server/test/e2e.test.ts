/**
 * End-to-end tests.
 *
 * The whole platform, wired as production wires it, exercised over HTTP. Unit
 * tests prove each part behaves; these prove the parts were connected to each
 * other correctly — which is a different failure and the one integration tests
 * exist to catch.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, hashToken, newId, nullLogger, randomToken, systemClock } from '@ma/core';
import { ManagedAgentClient } from '@ma/sdk';

import { buildPlatform, type Platform } from '../src/platform.ts';
import type { ServerConfig } from '../src/config.ts';

let platform: Platform;
let client: ManagedAgentClient;
let baseUrl: string;
let token: string;

function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: ':memory:',
    logLevel: 'error',
    controlPlaneUrl: 'http://127.0.0.1:0',
    corsOrigins: [],
    encryptionKeys: InMemoryKeyProvider.generate(),
    sandbox: { driver: 'local', leaseSeconds: 60, prewarmPerPool: 0 },
    // The scheduler is driven explicitly in the one test that needs it, so the
    // rest are not racing a background loop.
    scheduler: { enabled: false, tickMs: 1000, batchSize: 5, auditRetentionDays: 0 },
    rateLimit: { limit: 10_000, windowMs: 60_000 },
    artifacts: { root: ':memory:', maxMb: 25, retentionDays: 0 },
    trustForwardedFor: false,
  };
}

before(async () => {
  platform = buildPlatform({ config: testConfig(), logger: nullLogger, clock: systemClock });

  const now = systemClock.now();
  token = randomToken(32);
  const principal = await platform.store.principals.create({
    id: newId('principal', now),
    type: 'user',
    subject: 'e2e-admin',
    displayName: 'Admin',
    email: '',
    isAdmin: true,
    disabled: false,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    createdBy: 'bootstrap',
  });
  await platform.store.apiKeys.create({
    id: newId('apiKey', now),
    principalId: principal.id,
    name: 'e2e',
    prefix: token.slice(0, 8),
    tokenHash: hashToken(token),
    scopes: ['ma:*'],
    createdAt: now,
    updatedAt: now,
    createdBy: principal.id,
  });

  const address = await platform.start();
  baseUrl = `http://${address.host}:${address.port}`;
  client = new ManagedAgentClient({ baseUrl, token, clock: systemClock });
});

after(async () => {
  await platform.stop();
});

describe('platform end to end', () => {
  test('starts, serves and reports its version', async () => {
    const health = await client.health();
    assert.equal(health.status, 'ok');
  });

  test('an uploaded document becomes retrievable', async () => {
    // The route created the row and dropped `content` on the floor, so every
    // document sat at `pending` forever and the knowledge base was permanently
    // empty — while the API reported success. There was no route-level test for
    // datasets at all, which is how it shipped: the engine test staged content
    // itself and so never exercised the path that forgot to.
    const { workspace } = await client.createWorkspace({
      name: 'Knowledge',
      slug: `kb-${Date.now().toString(36)}`,
    });

    const created = await fetch(`${baseUrl}/v1/workspaces/${workspace.id}/datasets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Runbooks' }),
    }).then((response) => response.json() as Promise<{ dataset: { id: string } }>);

    const uploaded = await fetch(`${baseUrl}/v1/datasets/${created.dataset.id}/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'deploys.md',
        content: 'To deploy, run the release pipeline and wait for green.',
      }),
    }).then((response) => response.json() as Promise<{ document: { id: string; status: string } }>);

    assert.equal(uploaded.document.status, 'pending', 'ingestion is asynchronous');

    // The scheduler drives ingestion. It is disabled in this suite, so the tick
    // is driven explicitly — deterministic, and no background loop racing the
    // assertions.
    await platform.scheduler.tick();
    const document = await platform.store.documents.get(uploaded.document.id);

    assert.equal(document?.status, 'ready', `document ended ${document?.status}`);
    assert.ok(document.chunkCount > 0, 'a ready document must have produced chunks');
  });

  test('carries a workspace through to a running session', async () => {
    // The path every user takes, exercised through the public client rather
    // than the services directly.
    const { workspace } = await client.createWorkspace({
      name: 'Platform Team',
      slug: 'platform-team',
    });

    const { agent } = await client.createAgent(workspace.id, {
      name: 'Reviewer',
      description: 'Reviews changes',
    });

    const published = await client.createVersion(agent.id, {
      spec: {
        model: { modelId: 'test/model' },
        systemPrompt: 'You review code.',
        tools: { mode: 'strict', allow: ['read_file'] },
      },
      changeSummary: 'initial',
    });
    assert.equal(published.version.version, 1);

    const { session } = await client.createSession({ agentId: agent.id, title: 'first review' });
    assert.equal(session.resolvedVersion, 1);
    assert.equal(session.status, 'queued');

    // The creation is on the log, which is what makes the run reconstructable.
    const events = await client.readEvents(session.id);
    assert.ok(events.events.some((event) => event.type === 'session.created'));
    assert.equal(events.earliestSeq, 1);
  });

  test('accepts a nested agent spec at creation', async () => {
    // Found by using the CLI against a real server: the create route typed
    // `spec` as a flat string map, so any real configuration — a model object,
    // a tool policy — was rejected before it reached the version schema.
    const { workspace } = await client.createWorkspace({ name: 'Nested', slug: 'nested-spec' });
    const { agent } = await client.createAgent(workspace.id, {
      name: 'Configured',
      spec: {
        model: { modelId: 'test/model' },
        systemPrompt: 'Configured at creation.',
        tools: { mode: 'strict', allow: ['read_file'] },
      },
    });

    assert.equal(agent.latestVersion, 1, 'the inline spec becomes version 1');
    const version = await client.getVersion(agent.id, 1);
    assert.equal(version.version.model.modelId, 'test/model');
    assert.equal(version.version.tools.mode, 'strict');
  });

  test('a running session keeps its pinned version when the agent moves on', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Pinning', slug: 'pinning' });
    const { agent } = await client.createAgent(workspace.id, { name: 'Pinned' });
    await client.createVersion(agent.id, { spec: { model: { modelId: 'test/v1' } } });

    const { session } = await client.createSession({ agentId: agent.id });
    await client.createVersion(agent.id, { spec: { model: { modelId: 'test/v2' } } });

    const reread = await client.getSession(session.id);
    assert.equal(reread.session.resolvedVersion, 1, 'a live session must not shift underneath itself');
    assert.equal((await client.getAgent(agent.id)).agent.latestVersion, 2);
  });

  test('a version patch merges rather than replacing', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Merging', slug: 'merging' });
    const { agent } = await client.createAgent(workspace.id, { name: 'Merger' });
    await client.createVersion(agent.id, {
      spec: { model: { modelId: 'test/model' }, systemPrompt: 'original' },
    });

    const patched = await client.createVersion(agent.id, { spec: { systemPrompt: 'updated' } });
    assert.equal(patched.version.systemPrompt, 'updated');
    assert.equal(
      patched.version.model.modelId,
      'test/model',
      'a field the caller did not mention must survive',
    );
    assert.deepEqual(patched.diff.changed, ['systemPrompt']);
  });

  test('credentials round-trip without their value ever leaving', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Secrets', slug: 'secrets-team' });
    const { credential } = await client.createCredential(workspace.id, {
      ownerType: 'workspace',
      type: 'api_key',
      name: 'downstream',
      value: 'THE-REAL-SECRET-VALUE',
    });

    const listed = await client.listCredentials(workspace.id);
    const serialized = JSON.stringify(listed);
    assert.equal(serialized.includes('THE-REAL-SECRET-VALUE'), false);
    assert.ok(listed.items.some((item) => item.id === credential.id));

    // And the sealed form in the store is genuinely not the plaintext.
    const sealed = await platform.store.credentials.getSealed(credential.id);
    assert.ok(sealed);
    assert.equal(sealed.includes('THE-REAL-SECRET-VALUE'), false);
  });

  test('quota refuses a session and frees up when one ends', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Capped', slug: 'capped-team' });
    const stored = await platform.store.workspaces.get(workspace.id);
    await platform.store.workspaces.update(workspace.id, {
      quota: { ...stored!.quota, maxConcurrentSessions: 1 },
    });

    const { agent } = await client.createAgent(workspace.id, { name: 'Limited' });
    await client.createVersion(agent.id, { spec: { model: { modelId: 'test/model' } } });

    const first = await client.createSession({ agentId: agent.id });
    await assert.rejects(client.createSession({ agentId: agent.id }), (error: unknown) => {
      const failure = error as { code: string; retryAfterSeconds?: number };
      assert.equal(failure.code, 'QUOTA_EXCEEDED');
      assert.ok(failure.retryAfterSeconds);
      return true;
    });

    await client.terminate(first.session.id, 'making room');
    const second = await client.createSession({ agentId: agent.id });
    assert.ok(second.session.id);
  });

  test('the SDK deduplicates a retried create', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Idem', slug: 'idem-team' });
    const { agent } = await client.createAgent(workspace.id, { name: 'Once' });
    await client.createVersion(agent.id, { spec: { model: { modelId: 'test/model' } } });

    const key = ManagedAgentClient.idempotencyKey();
    const first = await client.createSession({ agentId: agent.id, idempotencyKey: key });
    const retry = await client.createSession({ agentId: agent.id, idempotencyKey: key });

    assert.equal(retry.session.id, first.session.id, 'a retry must not start a second agent');
  });

  test('an inbound webhook creates a receipt and deduplicates its retry', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Triggers', slug: 'triggers-team' });
    const { agent } = await client.createAgent(workspace.id, { name: 'Responder' });
    await client.createVersion(agent.id, { spec: { model: { modelId: 'test/model' } } });

    const { credential } = await client.createCredential(workspace.id, {
      ownerType: 'workspace',
      type: 'api_key',
      name: 'hook secret',
      value: 'hook-signing-secret',
    });

    const now = systemClock.now();
    const connector = await platform.store.connectors.create({
      id: newId('connector', now),
      workspaceId: workspace.id,
      type: 'webhook',
      name: 'alerts',
      description: '',
      status: 'active',
      agentId: agent.id,
      externalKey: 'alerts',
      sessionPolicy: 'new_per_event',
      config: {},
      secretCredentialId: credential.id,
      ownerPrincipalId: (await platform.store.principals.getBySubject('e2e-admin'))!.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'test',
    });

    const body = JSON.stringify({ prompt: 'investigate the alert', eventId: 'alert-1' });
    const timestamp = systemClock.now();
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'hook-signing-secret')
      .update(`${timestamp}.${body}`)
      .digest('hex');

    const deliver = async (): Promise<Response> =>
      fetch(`${baseUrl}/ingress/v1/${workspace.id}/${connector.externalKey}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ma-signature': signature,
          'x-ma-timestamp': String(timestamp),
        },
        body,
      });

    const first = await deliver();
    const firstBody = (await first.json()) as { status: string; receiptId: string };
    assert.equal(first.status, 202);
    assert.equal(firstBody.status, 'accepted');

    // The source system retries; the platform must not start a second run.
    const retry = await deliver();
    const retryBody = (await retry.json()) as { status: string; receiptId: string };
    assert.equal(retryBody.status, 'duplicate');
    assert.equal(retryBody.receiptId, firstBody.receiptId);
  });

  test('rejects an unsigned inbound delivery', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Unsigned', slug: 'unsigned-team' });
    const response = await fetch(`${baseUrl}/ingress/v1/${workspace.id}/nonexistent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'let me in' }),
    });
    // Not found rather than unauthorized: the connector genuinely does not
    // exist, and saying so does not leak anything.
    assert.equal(response.status, 404);
    await response.text();
  });

  test('deleting a connector frees its external key and removes its history', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Deletable', slug: 'deletable-team' });
    const { agent } = await client.createAgent(workspace.id, { name: 'Doomed' });
    const now = systemClock.now();
    const connector = await platform.store.connectors.create({
      id: newId('connector', now),
      workspaceId: workspace.id,
      type: 'webhook',
      name: 'to-delete',
      description: '',
      status: 'active',
      agentId: agent.id,
      externalKey: 'doomed-key',
      sessionPolicy: 'new_per_event',
      config: {},
      ownerPrincipalId: (await platform.store.principals.getBySubject('e2e-admin'))!.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'test',
    });
    // A receipt in its history, to prove the delete takes children with it.
    await platform.store.receipts.createIfAbsent({
      id: newId('receipt', now),
      connectorId: connector.id,
      workspaceId: workspace.id,
      externalEventId: 'evt-1',
      status: 'succeeded',
      attempt: 1,
      maxAttempts: 5,
      payloadSummary: '',
      responseContext: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'connector',
    });

    const deleted = await fetch(`${baseUrl}/v1/connectors/${connector.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(deleted.status, 204);
    await deleted.text();

    // The row is gone...
    assert.equal(await platform.store.connectors.get(connector.id), undefined);
    // ...its receipts cascaded...
    const receipts = await platform.store.receipts.list({ connectorId: connector.id });
    assert.equal(receipts.items.length, 0, 'the delivery history was removed with the connector');
    // ...and its external key no longer resolves at ingress.
    const afterDelete = await fetch(`${baseUrl}/ingress/v1/${workspace.id}/${connector.externalKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'anyone home?' }),
    });
    assert.equal(afterDelete.status, 404, 'the freed key stops accepting deliveries');
    await afterDelete.text();
  });

  test('the scheduler expires a session past its lease', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Expiry', slug: 'expiry-team' });
    const { agent } = await client.createAgent(workspace.id, { name: 'Ephemeral' });
    await client.createVersion(agent.id, { spec: { model: { modelId: 'test/model' } } });

    const { session } = await client.createSession({ agentId: agent.id, ttlSeconds: 60 });
    // Reach past the lease directly rather than waiting a minute.
    await platform.store.sessions.update(session.id, { expiresAt: systemClock.now() - 1000 });

    const expired = await platform.scheduler.expireSessions();
    assert.equal(expired, 1);

    const reread = await client.getSession(session.id);
    assert.equal(reread.session.status, 'terminated');
  });

  test('a session whose sandbox lease lapses recovers on the scheduler tick', async () => {
    // The self-healing path, wired end to end: the reaper reclaims a sandbox
    // whose lease lapsed, the composition root hands the reaped ids back to the
    // scheduler, and recovery returns the still-in-TTL session to `queued` so it
    // re-provisions — rather than sitting `ready` against a sandbox that is gone.
    const { workspace } = await client.createWorkspace({ name: 'Recover', slug: 'recover-team' });
    const { agent } = await client.createAgent(workspace.id, { name: 'Resilient' });
    await client.createVersion(agent.id, { spec: { model: { modelId: 'test/model' } } });

    const { session } = await client.createSession({ agentId: agent.id, ttlSeconds: 86_400 });

    // Seed a `ready` session bound to a sandbox whose lease has already lapsed,
    // rather than spawning a real child process. The sandbox's providerRef names
    // an environment the local driver never provisioned, so its health check
    // reports it `gone` and the reaper reclaims it — exactly the lost-sandbox
    // condition, without the flakiness of a real process.
    const sandboxId = newId('sandbox');
    await platform.store.sandboxes.create({
      id: sandboxId,
      workspaceId: workspace.id,
      provider: 'local',
      status: 'ready',
      endpoint: 'http://127.0.0.1:9',
      spec: {} as never,
      poolKey: 'recover-pool',
      sessionIds: [session.id],
      leaseExpiresAt: systemClock.now() - 1000,
      providerRef: 'never-provisioned-' + sandboxId,
      runtimeTokenHash: hashToken(randomToken(32)),
      createdAt: systemClock.now(),
      updatedAt: systemClock.now(),
      createdBy: session.id,
    });
    await platform.store.sessions.compareAndSetStatus(session.id, 'queued', 'ready', {
      sandboxId,
    });

    await platform.scheduler.tick();

    // The session must have recovered to `queued` with its dead sandbox cleared,
    // ready to re-provision — not stranded `ready` against a released sandbox.
    const recovered = await platform.store.sessions.get(session.id);
    assert.equal(recovered?.status, 'queued', 'a lost sandbox re-queues its session');
    assert.equal(recovered?.sandboxId, undefined, 'the dead sandbox reference is cleared');
  });

  test('an audit trail records who did what', async () => {
    const { workspace } = await client.createWorkspace({ name: 'Audited', slug: 'audited-team' });
    await client.createAgent(workspace.id, { name: 'Watched' });

    const entries = await platform.store.audit.list({ workspaceId: workspace.id });
    assert.ok(entries.items.length > 0);
    assert.ok(entries.items.every((entry) => entry.principalId.length > 0));
  });

  test('shuts down cleanly with work in the store', async () => {
    // A separate platform, so the shared one survives for the other tests.
    const other = buildPlatform({ config: testConfig(), logger: nullLogger, clock: systemClock });
    await other.start();
    await other.stop();
    // Stopping twice must not throw: a supervisor may signal more than once.
    await other.stop();
  });
});
