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
    rateLimit: { ip: { limit: 10_000, windowMs: 60_000 }, principal: { limit: 10_000, windowMs: 60_000 } },
    modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
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

    // The dataset's rolled-up sizeBytes must reflect the ingested content. It used
    // to under-count by one document: the create route seeded document.sizeBytes
    // with the content length, so ingestion's delta (dataset - current + new) was
    // `- N + N = 0` and the dataset total never accrued it.
    const dataset = await platform.store.datasets.get(created.dataset.id);
    assert.equal(
      dataset?.sizeBytes,
      document.sizeBytes,
      'the dataset sizeBytes must accrue the document it ingested, not stay at 0',
    );
    assert.ok(dataset!.sizeBytes > 0, 'and it is the real byte length, not zero');
  });

  test('deleting a dataset removes its rows and evicts it from the search index', async () => {
    // datasets.delete existed in the store but had no route and no sweep, so
    // datasets and their documents (and their in-memory chunks) grew unbounded.
    // The route now deletes the row (documents cascade) and evicts the chunks, so
    // retrieval stops returning them.
    const { workspace } = await client.createWorkspace({
      name: 'Deletable', slug: `del-${Date.now().toString(36)}`,
    });
    const dataset = await fetch(`${baseUrl}/v1/workspaces/${workspace.id}/datasets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete' }),
    }).then((r) => r.json() as Promise<{ dataset: { id: string } }>);
    const datasetId = dataset.dataset.id;

    const uploaded = await fetch(`${baseUrl}/v1/datasets/${datasetId}/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'doc.md', content: 'The deploy runbook lives here.' }),
    }).then((r) => r.json() as Promise<{ document: { id: string } }>);
    await platform.scheduler.tick();
    // It is searchable before the delete.
    assert.equal(
      (await platform.services.retrieval.search([datasetId], 'deploy runbook')).length,
      1,
      'searchable before delete',
    );

    const del = await fetch(`${baseUrl}/v1/datasets/${datasetId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(del.status, 200);
    const body = (await del.json()) as { documentsEvicted: number };
    assert.equal(body.documentsEvicted, 1, 'the one document was evicted');

    // The rows are gone (documents cascade) and the index no longer returns it.
    assert.equal(await platform.store.datasets.get(datasetId), undefined, 'the dataset row is gone');
    assert.equal(await platform.store.documents.get(uploaded.document.id), undefined, 'documents cascade');
    assert.equal(
      (await platform.services.retrieval.search([datasetId], 'deploy runbook')).length,
      0,
      'the chunks are evicted from the index',
    );
  });

  test('deleting one document decrements the dataset counts, evicts it, and is dataset-scoped', async () => {
    // documentCount was incremented on create but never decremented, and there was
    // no per-document delete route at all. The DELETE route now removes the row,
    // evicts its chunks (releasing knowledge-chunk quota), and decrements the
    // dataset counts — and refuses a document that does not belong to the dataset.
    const { workspace } = await client.createWorkspace({
      name: 'DocDelete', slug: `docdel-${Date.now().toString(36)}`,
    });
    const dataset = await fetch(`${baseUrl}/v1/workspaces/${workspace.id}/datasets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'docs' }),
    }).then((r) => r.json() as Promise<{ dataset: { id: string } }>);
    const datasetId = dataset.dataset.id;

    const uploaded = await fetch(`${baseUrl}/v1/datasets/${datasetId}/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'doc.md', content: 'The incident runbook lives here.' }),
    }).then((r) => r.json() as Promise<{ document: { id: string } }>);
    await platform.scheduler.tick();
    const documentId = uploaded.document.id;

    const beforeDs = await platform.store.datasets.get(datasetId);
    assert.equal(beforeDs?.documentCount, 1, 'create bumped documentCount to 1');
    assert.ok((beforeDs?.chunkCount ?? 0) > 0, 'ingestion recorded chunks');
    assert.equal(
      (await platform.services.retrieval.search([datasetId], 'incident runbook')).length,
      1,
      'searchable before delete',
    );

    // A mismatched dataset id must not delete it (IDOR guard) — 404, row intact.
    const otherDs = await fetch(`${baseUrl}/v1/workspaces/${workspace.id}/datasets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'other' }),
    }).then((r) => r.json() as Promise<{ dataset: { id: string } }>);
    const mismatched = await fetch(`${baseUrl}/v1/datasets/${otherDs.dataset.id}/documents/${documentId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(mismatched.status, 404, 'a document addressed under the wrong dataset is not-found');
    assert.ok(await platform.store.documents.get(documentId), 'the document survives a mismatched delete');

    // The real delete.
    const del = await fetch(`${baseUrl}/v1/datasets/${datasetId}/documents/${documentId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(del.status, 200);
    const body = (await del.json()) as { chunksEvicted: number };
    assert.equal(body.chunksEvicted, beforeDs!.chunkCount, 'reports the chunks it evicted');

    assert.equal(await platform.store.documents.get(documentId), undefined, 'the row is gone');
    const afterDs = await platform.store.datasets.get(datasetId);
    assert.equal(afterDs?.documentCount, 0, 'documentCount decremented to 0');
    assert.equal(afterDs?.chunkCount, 0, 'chunkCount decremented to 0');
    assert.equal(
      (await platform.services.retrieval.search([datasetId], 'incident runbook')).length,
      0,
      'evicted from the index',
    );
  });

  test('binding a dataset to an agent actually persists it into a new version', async () => {
    // The route validated ownership then returned 200 having written nothing, so
    // a bound dataset never reached the agent's retrieval tool. Binding now cuts a
    // new immutable version whose datasetIds include the bound one — assert the
    // version row actually carries it, not just that the call returned 200.
    const { workspace } = await client.createWorkspace({
      name: 'Binding', slug: `bind-${Date.now().toString(36)}`,
    });
    const { agent } = await client.createAgent(workspace.id, { name: 'Researcher' });
    await client.createVersion(agent.id, {
      spec: { model: { modelId: 'test/model' }, systemPrompt: 'v1' },
    });

    const dataset = await fetch(`${baseUrl}/v1/workspaces/${workspace.id}/datasets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Runbooks' }),
    }).then((r) => r.json() as Promise<{ dataset: { id: string } }>);

    const result = await client.bindDatasets(agent.id, [dataset.dataset.id]);
    assert.ok(result.version >= 2, 'binding cut a new version');
    assert.deepEqual(result.datasetIds, [dataset.dataset.id], 'the response reflects the binding');

    // The load-bearing assertion: the persisted version row carries the dataset,
    // so the retrieval tool (which reads version.datasetIds) will actually see it.
    const { version } = await client.getVersion(agent.id, result.version);
    assert.deepEqual(
      version.datasetIds,
      [dataset.dataset.id],
      'the bound dataset is persisted on the new version, not dropped',
    );
  });

  test('binding a dataset from another workspace is refused', async () => {
    // The tenant boundary on retrieval: a version must not name a dataset from
    // another workspace. Binding routes through createVersion, which enforces it.
    const a = await client.createWorkspace({ name: 'A', slug: `a-${Date.now().toString(36)}` });
    const b = await client.createWorkspace({ name: 'B', slug: `b-${Date.now().toString(36)}` });
    const { agent } = await client.createAgent(a.workspace.id, { name: 'Researcher' });
    await client.createVersion(agent.id, {
      spec: { model: { modelId: 'test/model' }, systemPrompt: 'v1' },
    });
    const foreign = await fetch(`${baseUrl}/v1/workspaces/${b.workspace.id}/datasets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Foreign' }),
    }).then((r) => r.json() as Promise<{ dataset: { id: string } }>);

    await assert.rejects(
      client.bindDatasets(agent.id, [foreign.dataset.id]),
      'a cross-workspace dataset binding must be refused',
    );
  });

  test('If-Match on a member update: ETag advances, a stale token is a 412', async () => {
    // Optimistic concurrency over HTTP. GET exposes the workspace version as an
    // ETag; a member PUT that echoes it as If-Match succeeds and the ETag advances;
    // replaying the now-stale token is refused with 412; and a PUT with no If-Match
    // still succeeds (the precondition is opt-in, backward compatible).
    const { workspace } = await client.createWorkspace({
      name: 'Concurrency', slug: `conc-${Date.now().toString(36)}`,
    });
    const membersUrl = `${baseUrl}/v1/workspaces/${workspace.id}/members`;
    const body = JSON.stringify({ members: [{ principalId: workspace.createdBy, role: 'owner' }] });

    // Read the current ETag.
    const got = await fetch(`${baseUrl}/v1/workspaces/${workspace.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const etag = got.headers.get('etag');
    assert.ok(etag, 'GET exposes an ETag');

    // A conditional update at the current version succeeds and advances the ETag.
    const ok = await fetch(membersUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'if-match': etag! },
      body,
    });
    assert.equal(ok.status, 200, 'a matching If-Match is accepted');
    const newEtag = ok.headers.get('etag');
    assert.ok(newEtag && newEtag !== etag, 'the ETag advanced after the write');

    // Replaying the stale token is refused.
    const stale = await fetch(membersUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'if-match': etag! },
      body,
    });
    assert.equal(stale.status, 412, 'a stale If-Match is a precondition failure');

    // No If-Match ⇒ unconditional, still succeeds.
    const unconditional = await fetch(membersUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    assert.equal(unconditional.status, 200, 'a member update without If-Match still succeeds');

    // A garbage If-Match is a 400, not a silently-ignored NaN.
    const garbage = await fetch(membersUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'if-match': 'not-a-version' },
      body,
    });
    assert.equal(garbage.status, 400, 'a malformed If-Match is rejected at the boundary');
  });

  test('reports daily usage history over HTTP', async () => {
    // The counter that backs the daily budgets doubles as a spend record; the
    // report endpoint exposes it. Record usage for today, then read it back
    // through the admin-gated route (the bootstrap principal is a platform admin).
    const { workspace } = await client.createWorkspace({
      name: 'Usage', slug: `usage-${Date.now().toString(36)}`,
    });
    const now = systemClock.now();
    const day = new Date(now);
    const utcDay = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    await platform.store.usage.addTokens(workspace.id, utcDay, 1000, 250, 4200);

    const response = await fetch(`${baseUrl}/v1/workspaces/${workspace.id}/usage`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const report = (await response.json()) as {
      days: { utcDay: number; inputTokens: number; outputTokens: number; costMicros: number }[];
      total: { inputTokens: number; outputTokens: number; costMicros: number };
    };
    const today = report.days.find((d) => d.utcDay === utcDay);
    assert.ok(today, 'today appears in the default (last 30 days) window');
    assert.equal(today.inputTokens, 1000);
    assert.equal(today.costMicros, 4200);
    assert.equal(report.total.costMicros, 4200, 'the total sums the window');
  });

  test('rejects an out-of-range epoch-ms usage bound instead of silently returning empty', async () => {
    // parseDay accepts `YYYY-MM-DD` or epoch-ms. An epoch-ms far past the valid
    // Date range (e.g. a 20-digit value → 1e20) is finite and integral, so it
    // slipped through, and downstream `new Date(1e20)` is Invalid Date whose
    // getUTC* are NaN — defeating the `to < from` and span guards (NaN
    // comparisons are all false) and returning a 200 with an empty report rather
    // than the validation error parseDay's contract promises. It must be a 400.
    const { workspace } = await client.createWorkspace({
      name: 'Usage OOR', slug: `usage-oor-${Date.now().toString(36)}`,
    });
    const response = await fetch(
      `${baseUrl}/v1/workspaces/${workspace.id}/usage?from=99999999999999999999`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, 400, 'an out-of-range epoch-ms bound is a validation error, not a silent empty 200');
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

    // Bind a runtime token to the sandbox in the bridge, as a live provision
    // would. When the reaper destroys the sandbox, the composition root must
    // forget this binding — otherwise the bridge's token/billing caches grow
    // unbounded (one leak per reaped sandbox) and a stray call on the old token
    // could misroute to the re-queued session.
    const runtimeToken = randomToken(32);
    platform.runtime.bind(runtimeToken, session.id, sandboxId);
    assert.ok(await platform.runtime.authenticate(runtimeToken), 'the token resolves before the reap');

    await platform.scheduler.tick();

    // The session must have recovered to `queued` with its dead sandbox cleared,
    // ready to re-provision — not stranded `ready` against a released sandbox.
    const recovered = await platform.store.sessions.get(session.id);
    assert.equal(recovered?.status, 'queued', 'a lost sandbox re-queues its session');
    assert.equal(recovered?.sandboxId, undefined, 'the dead sandbox reference is cleared');

    // And the bridge forgot the reaped sandbox's cached token binding.
    await assert.rejects(
      platform.runtime.authenticate(runtimeToken),
      'the reaped sandbox\'s token binding must be forgotten, not leaked',
    );
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
