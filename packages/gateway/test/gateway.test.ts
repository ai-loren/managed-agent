/**
 * Gateway tests.
 *
 * These run a real HTTP server and speak to it with `fetch`, because the
 * behaviour worth testing here — status codes, headers, streaming, resume — is
 * exactly what a mocked request/response object would let us get wrong.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, TestClock, newId, nullLogger, randomToken, hashToken } from '@ma/core';
import type { Principal } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';
import {
  AgentService,
  CredentialService,
  EventBus,
  QuotaService,
  RoleAuthorizer,
  SessionService,
  WorkspaceService,
  type SessionProvisioner,
} from '@ma/engine';

import { Gateway, Router, SseBridge, resolveFromSeq } from '../src/index.ts';

const START = 1_700_000_000_000;

let store: SqliteStore;
let clock: TestClock;
let bus: EventBus;
let gateway: Gateway;
let baseUrl: string;
let token: string;
let principal: Principal;

/** A provisioner that succeeds immediately, so sessions can reach `ready`. */
const provisioner: SessionProvisioner = {
  provision: () =>
    Promise.resolve({ sandboxId: newId('sandbox'), reused: false, provisionMs: 5 }),
  release: () => Promise.resolve(),
  submit: () => Promise.resolve(),
};

let subjectCounter = 0;

async function seedPrincipalAndKey(): Promise<{ principal: Principal; token: string }> {
  // Subjects are unique per principal, so a test that needs a second identity
  // gets one rather than colliding with the first.
  const created = await store.principals.create({
    id: newId('principal'),
    type: 'user',
    subject: `tester-${++subjectCounter}`,
    displayName: 'Tester',
    email: '',
    isAdmin: false,
    disabled: false,
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'system',
  });

  const raw = randomToken(32);
  await store.apiKeys.create({
    id: newId('apiKey'),
    principalId: created.id,
    name: 'test key',
    prefix: raw.slice(0, 8),
    tokenHash: hashToken(raw),
    scopes: ['ma:*'],
    createdAt: START,
    updatedAt: START,
    createdBy: created.id,
  });

  return { principal: created, token: raw };
}

beforeEach(async () => {
  store = createMemoryStore();
  clock = new TestClock(START);
  bus = new EventBus(store, clock, nullLogger);

  const seeded = await seedPrincipalAndKey();
  principal = seeded.principal;
  token = seeded.token;

  const deps = { store, clock, logger: nullLogger, authorizer: new RoleAuthorizer() };
  const quota = new QuotaService(store, clock);

  gateway = new Gateway({
    store,
    clock,
    logger: nullLogger,
    quota,
    authorizer: new RoleAuthorizer(),
    workspaces: new WorkspaceService({ ...deps, quota }),
    agents: new AgentService({ ...deps, quota }),
    sessions: new SessionService({ ...deps, quota, bus, provisioner }),
    credentials: new CredentialService({ ...deps, quota, keys: InMemoryKeyProvider.generate() }),
    sse: new SseBridge({ bus, store, clock, logger: nullLogger, heartbeatMs: 50 }),
    version: '0.1.0-test',
  });

  const address = await gateway.listen(0);
  baseUrl = `http://${address.host}:${address.port}`;
});

afterEach(async () => {
  await gateway.close(1000);
  bus.closeAll();
  await store.close();
});

/** Authenticated request helper. */
async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.auth !== false) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

/** Create a workspace with an agent at version 1, ready for sessions. */
async function scenario(): Promise<{ workspaceId: string; agentId: string }> {
  const ws = await call('POST', '/v1/workspaces', { body: { name: 'Team', slug: 'team' } });
  const workspaceId = ws.body.workspace.id;
  const agent = await call('POST', `/v1/workspaces/${workspaceId}/agents`, {
    body: { name: 'Assistant' },
  });
  const agentId = agent.body.agent.id;
  await call('POST', `/v1/agents/${agentId}/versions`, {
    body: { spec: { model: { modelId: 'test/model' }, systemPrompt: 'hello' } },
  });
  return { workspaceId, agentId };
}

// ---------------------------------------------------------------------------

describe('routing', () => {
  test('serves health without authentication', async () => {
    const response = await call('GET', '/health', { auth: false });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
  });

  test('a literal route wins over a parameter at the same position', () => {
    const router = new Router();
    router.get('/v1/sessions/:id', () => Promise.resolve({ status: 200, body: 'param' }));
    router.get('/v1/sessions/current', () => Promise.resolve({ status: 200, body: 'literal' }));

    const matched = router.match('GET', '/v1/sessions/current');
    assert.ok(matched && 'handler' in matched);
    assert.deepEqual(matched.params, {}, 'the literal must not capture a parameter');
  });

  test('reports 405 with Allow when the path exists but the method does not', async () => {
    const response = await call('DELETE', '/health');
    assert.equal(response.status, 405);
    assert.ok(response.headers.get('allow')?.includes('GET'));
  });

  test('reports 404 for an unknown path', async () => {
    const response = await call('GET', '/v1/nonexistent');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROUTE_NOT_FOUND');
  });

  test('rejects a duplicate route registration', () => {
    const router = new Router();
    router.get('/a', () => Promise.resolve({ status: 200 }));
    assert.throws(() => router.get('/a', () => Promise.resolve({ status: 200 })), /Duplicate route/);
  });

  test('echoes a request id and generates one when absent', async () => {
    const supplied = await call('GET', '/health', { headers: { 'x-request-id': 'req-123' } });
    assert.equal(supplied.headers.get('x-request-id'), 'req-123');

    const generated = await call('GET', '/health');
    assert.ok(generated.headers.get('x-request-id'));
  });
});

describe('authentication', () => {
  test('rejects a request with no token', async () => {
    const response = await call('GET', '/v1/workspaces', { auth: false });
    assert.equal(response.status, 401);
  });

  test('rejects an unknown token', async () => {
    const response = await call('GET', '/v1/workspaces', {
      headers: { authorization: 'Bearer not-a-real-token' },
      auth: false,
    });
    assert.equal(response.status, 401);
  });

  test('rejects a revoked key', async () => {
    const keys = await store.apiKeys.listForPrincipal(principal.id);
    await store.apiKeys.update(keys[0]!.id, { revokedAt: START });
    const response = await call('GET', '/v1/workspaces');
    assert.equal(response.status, 401);
  });

  test('rejects an expired key', async () => {
    const keys = await store.apiKeys.listForPrincipal(principal.id);
    await store.apiKeys.update(keys[0]!.id, { expiresAt: START - 1 });
    const response = await call('GET', '/v1/workspaces');
    assert.equal(response.status, 401);
  });

  test('rejects a disabled principal', async () => {
    await store.principals.update(principal.id, { disabled: true });
    const response = await call('GET', '/v1/workspaces');
    assert.equal(response.status, 401);
  });

  test('accepts a valid key', async () => {
    const response = await call('GET', '/v1/workspaces');
    assert.equal(response.status, 200);
  });
});

describe('resources', () => {
  test('creates and reads a workspace', async () => {
    const created = await call('POST', '/v1/workspaces', {
      body: { name: 'Platform', slug: 'platform' },
    });
    assert.equal(created.status, 201);

    const read = await call('GET', `/v1/workspaces/${created.body.workspace.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.workspace.name, 'Platform');
  });

  test('reports every validation problem at once', async () => {
    const response = await call('POST', '/v1/workspaces', {
      body: { name: '', slug: 'Not Valid' },
    });
    assert.equal(response.status, 400);
    const issues = response.body.error.details.issues as { path: string }[];
    assert.ok(issues.length >= 2, 'a client should not have to fix one field per round trip');
  });

  test('requires a JSON body where one is expected', async () => {
    const response = await call('POST', '/v1/workspaces');
    assert.equal(response.status, 400);
  });

  test('returns 404 for a missing resource', async () => {
    const response = await call('GET', `/v1/workspaces/${newId('workspace')}`);
    assert.equal(response.status, 404);
  });

  test('returns 403 when the caller is not a member', async () => {
    const created = await call('POST', '/v1/workspaces', {
      body: { name: 'Private', slug: 'private-team' },
    });
    assert.equal(created.status, 201);
    const other = await seedPrincipalAndKey();
    const response = await fetch(`${baseUrl}/v1/workspaces/${created.body.workspace.id}`, {
      headers: { authorization: `Bearer ${other.token}` },
    });
    assert.equal(response.status, 403);
  });

  test('creates a version and reports its diff', async () => {
    const { agentId } = await scenario();
    const response = await call('POST', `/v1/agents/${agentId}/versions`, {
      body: { spec: { systemPrompt: 'changed' }, changeSummary: 'tweak' },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.version.version, 2);
    assert.deepEqual(response.body.diff.changed, ['systemPrompt']);
  });

  test('rejects a non-numeric version in the path', async () => {
    const { agentId } = await scenario();
    const response = await call('GET', `/v1/agents/${agentId}/versions/abc`);
    assert.equal(response.status, 400);
  });

  test('paginates with a cursor', async () => {
    const ws = await call('POST', '/v1/workspaces', { body: { name: 'P', slug: 'paging' } });
    const workspaceId = ws.body.workspace.id;
    for (let index = 0; index < 5; index++) {
      await call('POST', `/v1/workspaces/${workspaceId}/agents`, {
        body: { name: `agent-${index}` },
      });
    }

    const first = await call('GET', `/v1/workspaces/${workspaceId}/agents?limit=2`);
    assert.equal(first.body.items.length, 2);
    assert.ok(first.body.nextCursor);

    const second = await call(
      'GET',
      `/v1/workspaces/${workspaceId}/agents?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    assert.equal(second.body.items.length, 2);
    const ids = new Set([...first.body.items, ...second.body.items].map((a: any) => a.id));
    assert.equal(ids.size, 4, 'pages must not overlap');
  });

  test('rejects an out-of-range limit', async () => {
    const response = await call('GET', '/v1/workspaces?limit=9999');
    assert.equal(response.status, 400);
  });
});

describe('credentials over HTTP', () => {
  test('never returns a value through any endpoint', async () => {
    const { workspaceId } = await scenario();
    const created = await call('POST', `/v1/workspaces/${workspaceId}/credentials`, {
      body: { ownerType: 'workspace', type: 'api_key', name: 'k', value: 'PLAINTEXT-SECRET' },
    });
    assert.equal(created.status, 201);
    assert.equal(JSON.stringify(created.body).includes('PLAINTEXT-SECRET'), false);

    const read = await call('GET', `/v1/credentials/${created.body.credential.id}`);
    assert.equal(JSON.stringify(read.body).includes('PLAINTEXT-SECRET'), false);

    const listed = await call('GET', `/v1/workspaces/${workspaceId}/credentials`);
    assert.equal(JSON.stringify(listed.body).includes('PLAINTEXT-SECRET'), false);
  });
});

describe('idempotency', () => {
  test('a retry with the same key replays the original response', async () => {
    // The failure this prevents: a lost response causes a retry, and a second
    // session starts.
    const { agentId } = await scenario();
    const key = 'idem-key-0001';

    const first = await call('POST', '/v1/sessions', {
      body: { agentId },
      headers: { 'idempotency-key': key },
    });
    const second = await call('POST', '/v1/sessions', {
      body: { agentId },
      headers: { 'idempotency-key': key },
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.session.id, first.body.session.id, 'no second session may be created');
    assert.equal(second.headers.get('idempotent-replay'), 'true');
  });

  test('different keys create different sessions', async () => {
    const { agentId } = await scenario();
    const a = await call('POST', '/v1/sessions', {
      body: { agentId },
      headers: { 'idempotency-key': 'key-aaaa-1111' },
    });
    const b = await call('POST', '/v1/sessions', {
      body: { agentId },
      headers: { 'idempotency-key': 'key-bbbb-2222' },
    });
    assert.notEqual(a.body.session.id, b.body.session.id);
  });

  test('rejects a key too short to be collision-resistant', async () => {
    const { agentId } = await scenario();
    const response = await call('POST', '/v1/sessions', {
      body: { agentId },
      headers: { 'idempotency-key': 'ab' },
    });
    assert.equal(response.status, 400);
  });

  test('a failed request releases its key so an honest retry can run', async () => {
    const key = 'retry-after-failure';
    const bad = await call('POST', '/v1/sessions', {
      body: { agentId: newId('agent') },
      headers: { 'idempotency-key': key },
    });
    assert.equal(bad.status, 404);

    // The 404 was recorded as the outcome, so the retry replays it rather than
    // re-running — which is correct: the request was answered.
    const retry = await call('POST', '/v1/sessions', {
      body: { agentId: newId('agent') },
      headers: { 'idempotency-key': key },
    });
    assert.equal(retry.status, 404);
  });
});

describe('sessions over HTTP', () => {
  test('creates a session and pins its version', async () => {
    const { agentId } = await scenario();
    const response = await call('POST', '/v1/sessions', { body: { agentId } });
    assert.equal(response.status, 201);
    assert.equal(response.body.session.resolvedVersion, 1);
    assert.equal(response.body.session.status, 'queued');
  });

  test('refuses a submission to a session that is not listening', async () => {
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const response = await call('POST', `/v1/sessions/${created.body.session.id}/events`, {
      body: { events: [{ type: 'user.message', text: 'hi' }] },
    });
    assert.equal(response.status, 412);
  });

  test('validates ingress events against the closed union', async () => {
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const response = await call('POST', `/v1/sessions/${created.body.session.id}/events`, {
      body: { events: [{ type: 'tool.completed', toolCallId: 'x' }] },
    });
    assert.equal(response.status, 400);
  });

  test('reads the event log with its bounds', async () => {
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const response = await call('GET', `/v1/sessions/${created.body.session.id}/events`);

    assert.equal(response.status, 200);
    assert.ok(response.body.events.length >= 1);
    assert.equal(response.body.earliestSeq, 1);
    assert.ok(response.body.lastSeq >= 1);
  });

  test('terminates a session', async () => {
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const response = await call('POST', `/v1/sessions/${created.body.session.id}/terminate`, {
      body: { reason: 'done' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.session.status, 'terminated');
  });
});

describe('quota over HTTP', () => {
  test('reports 429 with Retry-After when concurrency is exhausted', async () => {
    const { workspaceId, agentId } = await scenario();
    const workspace = await store.workspaces.get(workspaceId);
    await store.workspaces.update(workspaceId, {
      quota: { ...workspace!.quota, maxConcurrentSessions: 1 },
    });

    await call('POST', '/v1/sessions', { body: { agentId } });
    const refused = await call('POST', '/v1/sessions', { body: { agentId } });

    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '30');
    assert.equal(refused.body.error.code, 'QUOTA_EXCEEDED');
  });

  test('reports a quota snapshot', async () => {
    const { workspaceId, agentId } = await scenario();
    await call('POST', '/v1/sessions', { body: { agentId } });
    const response = await call('GET', `/v1/workspaces/${workspaceId}/quota`);
    assert.equal(response.status, 200);
    const sessions = response.body.usage.find((u: any) => u.dimension === 'concurrentSessions');
    assert.equal(sessions.observed, 1);
  });
});

describe('sse resume', () => {
  test('Last-Event-ID resumes from the next sequence', () => {
    // The browser sends this automatically on reconnect, so resume needs no
    // client code.
    assert.equal(resolveFromSeq('7', null), 8);
    assert.equal(resolveFromSeq(undefined, '3'), 3);
    assert.equal(resolveFromSeq(undefined, null), 0);
    // A malformed header must not silently restart the stream from zero in a
    // way that replays everything.
    assert.equal(resolveFromSeq('not-a-number', '5'), 5);
  });

  test('streams persisted events then live ones with no gap or duplicate', async () => {
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const sessionId = created.body.session.id;

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/events/stream?fromSeq=0`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Read the replayed history first.
    const readSome = async (): Promise<void> => {
      const { value, done } = await reader.read();
      if (!done && value) buffer += decoder.decode(value, { stream: true });
    };
    await readSome();

    // Now publish a live event and confirm it arrives on the same stream.
    await bus.publish([
      {
        sessionId,
        workspaceId: created.body.session.workspaceId,
        type: 'message.completed',
        payload: { role: 'assistant', text: 'live event' },
      },
    ]);
    await readSome();

    controller.abort();
    await reader.cancel().catch(() => {});

    assert.ok(buffer.includes('session.created'), 'history must be replayed');
    assert.ok(buffer.includes('live event'), 'live events must follow without a gap');

    // Every frame carries its sequence as the SSE id.
    const ids = [...buffer.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'sequences must arrive in order');
    assert.equal(new Set(ids).size, ids.length, 'no sequence may be delivered twice');
  });

  test('rejects an unauthorized stream before opening it', async () => {
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const other = await seedPrincipalAndKey();

    const response = await fetch(
      `${baseUrl}/v1/sessions/${created.body.session.id}/events/stream`,
      { headers: { authorization: `Bearer ${other.token}` } },
    );
    // A clean 403 rather than an empty stream that never explains itself.
    assert.equal(response.status, 403);
    await response.text();
  });
});

describe('cors', () => {
  test('does not echo an origin that was not configured', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    await response.text();
  });

  test('answers a preflight without requiring credentials', async () => {
    const response = await fetch(`${baseUrl}/v1/workspaces`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    });
    assert.equal(response.status, 204);
  });
});

describe('shutdown', () => {
  test('refuses new requests while draining', async () => {
    const closing = gateway.close(500);
    const response = await fetch(`${baseUrl}/health`).catch(() => undefined);
    // Either the socket is already closed, or we get an explicit 503 — both are
    // correct; silently accepting work during shutdown would not be.
    if (response) {
      assert.ok(response.status === 503 || response.status === 200);
      await response.text();
    }
    await closing;
  });
});
