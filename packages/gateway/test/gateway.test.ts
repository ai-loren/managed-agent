/**
 * Gateway tests.
 *
 * These run a real HTTP server and speak to it with `fetch`, because the
 * behaviour worth testing here — status codes, headers, streaming, resume — is
 * exactly what a mocked request/response object would let us get wrong.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

import { InMemoryKeyProvider, MaError, TestClock, newId, nullLogger, randomToken, hashToken } from '@ma/core';
import type { Principal } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';
import {
  AgentService,
  ArtifactService,
  MemoryBlobStore,
  MemoryService,
  TemplateService,
  PreviewService,
  CredentialService,
  EventBus,
  QuotaService,
  RoleAuthorizer,
  SessionService,
  WorkspaceService,
  type SessionProvisioner,
} from '@ma/engine';

import {
  Gateway,
  Router,
  SseBridge,
  idempotencyMiddleware,
  normalizeRateLimit,
  rateLimitMiddleware,
  resolveFromSeq,
  type GatewayOptions,
  type RequestContext,
} from '../src/index.ts';

const START = 1_700_000_000_000;

let store: SqliteStore;
let clock: TestClock;
let bus: EventBus;
let gateway: Gateway;
let artifacts: ArtifactService;
let baseUrl: string;
let token: string;
let principal: Principal;

/** A provisioner that succeeds immediately, so sessions can reach `ready`. */
const provisioner: SessionProvisioner = {
  provision: () =>
    Promise.resolve({ sandboxId: newId('sandbox'), reused: false, provisionMs: 5 }),
  release: () => Promise.resolve(),
  submit: () => Promise.resolve(),
  rebind: () => Promise.resolve('ok' as const),
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
  artifacts = new ArtifactService({ ...deps, quota, blobs: new MemoryBlobStore() });

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
    artifacts,
    memories: new MemoryService({ ...deps, quota }),
    templates: new TemplateService({ ...deps, quota }),
    previews: new PreviewService({ clock, keys: InMemoryKeyProvider.generate(), previewOrigin: 'https://artifacts.test', consoleOrigin: 'https://console.test' }),
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

/**
 * Send a raw HTTP/1.1 request over a TCP socket and return the full response
 * text. Needed for tests that must set a header `fetch` refuses to send (a
 * malformed `Host`), and to prove the server answers rather than hanging.
 */
function rawRequest(host: string, port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host, () => {
      socket.write(request);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    // A hung connection is the failure we are testing for: bound the wait so the
    // assertion reports "no response" instead of the test itself timing out.
    socket.setTimeout(4000, () => {
      socket.destroy();
      resolve(data);
    });
  });
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

  test('match reports malformed percent-encoding as a validation error, not a raw URIError', () => {
    const router = new Router();
    router.get('/v1/agents/:agentId', () => Promise.resolve({ status: 200 }));

    // `%zz` is not a valid percent-escape; `decodeURIComponent` throws URIError.
    // The router must translate that into a structured, catchable MaError so the
    // server answers 400 rather than letting a raw URIError escape as an
    // unhandled rejection that kills the process.
    try {
      router.match('GET', '/v1/agents/%zz');
      assert.fail('expected match to throw for malformed percent-encoding');
    } catch (error) {
      assert.ok(MaError.is(error), `expected an MaError, got ${String(error)}`);
      assert.equal((error as MaError).status, 400);
    }
  });

  test('a malformed percent-escape in a wildcard segment is a validation error too', () => {
    const router = new Router();
    router.get('/preview/*rest', () => Promise.resolve({ status: 200 }));

    try {
      router.match('GET', '/preview/%e0%a4%a');
      assert.fail('expected match to throw for a malformed wildcard segment');
    } catch (error) {
      assert.ok(MaError.is(error), `expected an MaError, got ${String(error)}`);
      assert.equal((error as MaError).status, 400);
    }
  });

  test('a malformed percent-escape in the path does not crash the server (400, not process death)', async () => {
    // Unauthenticated, single crafted request. Before the fix, `match()` runs
    // `decodeURIComponent` outside any try/catch in `handle()`, so the URIError
    // rejects the discarded `void this.handle(...)` promise -> unhandled
    // rejection -> Node kills the whole gateway process. The test process shares
    // that fate, so a regression here takes the suite down with it.
    const response = await fetch(`${baseUrl}/v1/agents/%zz`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as any;
    assert.equal(body.error.category, 'validation');

    // And the server is still alive and serving afterward.
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    await health.text();
  });

  test('a malformed percent-escape is rejected before authentication runs', async () => {
    // No credentials at all: the crash vector must be closed for anonymous
    // callers, and answering 400 (not 401) is fine — the request never names a
    // real resource. The point is that it does not take the process down.
    const response = await fetch(`${baseUrl}/v1/agents/%zz`, { method: 'GET' });
    assert.ok(
      response.status === 400 || response.status === 401,
      `expected 400/401, got ${response.status}`,
    );
    await response.text();
  });

  test('a malformed Host header does not crash or hang the server', async () => {
    // The twin of the %zz crash: `new URL(req.url, \`http://${host}\`)` used to
    // build its base from the attacker-controlled Host header, so `Host: foo bar`
    // threw ERR_INVALID_URL before any try/catch -> unhandled rejection. With
    // requestTimeout=0 the downgraded symptom is a hung socket, so this test
    // sends a raw request and asserts a bounded, well-formed HTTP response.
    const address = new URL(baseUrl);
    const raw = await rawRequest(
      address.hostname,
      Number(address.port),
      `GET /v1/agents/x HTTP/1.1\r\nHost: foo bar\r\nConnection: close\r\n\r\n`,
    );
    // A real HTTP status line, not a dropped/hung connection.
    assert.match(raw, /^HTTP\/1\.1 \d{3}/, `expected an HTTP response, got: ${raw.slice(0, 80)}`);
    const status = Number(raw.slice(9, 12));
    assert.ok(status >= 400 && status < 500, `expected a 4xx, got ${status}`);

    // The server is still alive afterward.
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    await health.text();
  });

  test('other malformed Host headers are handled, not fatal', async () => {
    const address = new URL(baseUrl);
    for (const host of ['[', 'h%', 'h:notaport']) {
      const raw = await rawRequest(
        address.hostname,
        Number(address.port),
        `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      );
      assert.match(
        raw,
        /^HTTP\/1\.1 \d{3}/,
        `Host: ${host} produced no HTTP response: ${raw.slice(0, 80)}`,
      );
    }
    // Still serving.
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    await health.text();
  });

  test('an absolute-form request target with a broken authority is a 400, not a crash', async () => {
    // RFC 7230 5.3.2 absolute-form: a client may put a full URL on the request
    // line. Node's parser accepts it into req.url verbatim, and because it is
    // already absolute `new URL(target, base)` ignores the fixed base and parses
    // the target's own (broken) authority -> ERR_INVALID_URL. The preamble
    // try/catch must turn that into a clean 400 rather than an escaped throw.
    const address = new URL(baseUrl);
    for (const target of ['http://[/p', 'http://h%/p', 'http:///', 'http://h:99999999/p']) {
      const raw = await rawRequest(
        address.hostname,
        Number(address.port),
        `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );
      const status = Number(raw.slice(9, 12));
      assert.ok(
        status >= 400 && status < 500,
        `target ${target} expected a 4xx, got: ${raw.slice(0, 80)}`,
      );
    }
    // Server survived every one.
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    await health.text();
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

  test('a synchronous failure of the best-effort lastUsedAt stamp does not fail the request', async () => {
    // The stamp is best-effort, but node:sqlite is synchronous: `apiKeys.update`
    // runs its UPDATE as the argument is evaluated, so a synchronous throw
    // (SQLITE_BUSY under write-lock contention, or a not-found on a delete race)
    // would escape before `.catch` attaches and 500 an otherwise-valid request.
    // Make the stamp throw synchronously and confirm auth still succeeds.
    const originalUpdate = store.apiKeys.update.bind(store.apiKeys);
    store.apiKeys.update = (id, patch) => {
      if ((patch as { lastUsedAt?: number }).lastUsedAt !== undefined) {
        throw new Error('database is locked'); // synchronous, like a busy SQLITE
      }
      return originalUpdate(id, patch);
    };
    try {
      const response = await call('GET', '/v1/workspaces');
      assert.equal(
        response.status,
        200,
        'a valid key still authenticates even when the usage stamp throws synchronously',
      );
    } finally {
      store.apiKeys.update = originalUpdate;
    }
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

describe('audit query over HTTP', () => {
  // Seed a workspace and three audit entries by different principals/resources,
  // then confirm the route actually scopes by the advertised filters. Before the
  // fix the route threaded only `action`, so a principalId/resourceId search
  // silently returned the whole workspace trail.
  async function seedAudit(): Promise<{ workspaceId: string }> {
    const { workspaceId } = await scenario();
    const now = START + 1000;
    const entries = [
      { principalId: 'pr_alice', action: 'agent.read', resourceId: 'ag_00000000000000000000000001', at: now },
      { principalId: 'pr_bob', action: 'agent.update', resourceId: 'ag_00000000000000000000000002', at: now + 10 },
      { principalId: 'pr_alice', action: 'credential.read', resourceId: 'cr_00000000000000000000000003', at: now + 20 },
    ];
    for (const e of entries) {
      await store.audit.append({
        id: newId('auditEntry'),
        workspaceId,
        principalId: e.principalId,
        action: e.action,
        resourceKind: e.action.split('.')[0]!,
        resourceId: e.resourceId,
        outcome: 'allowed',
        reason: '',
        requestId: '',
        sourceIp: '',
        details: {},
        at: e.at,
      });
    }
    return { workspaceId };
  }

  test('scopes the audit trail by principalId', async () => {
    const { workspaceId } = await seedAudit();
    const res = await call('GET', `/v1/workspaces/${workspaceId}/audit?principalId=pr_alice`);
    assert.equal(res.status, 200);
    const items = res.body.items as { principalId: string }[];
    assert.ok(items.length >= 2, 'both of Alice’s entries are returned');
    assert.ok(
      items.every((e) => e.principalId === 'pr_alice'),
      'only Alice’s entries are returned, not the whole workspace trail',
    );
  });

  test('scopes the audit trail by resourceId', async () => {
    const { workspaceId } = await seedAudit();
    const res = await call(
      'GET',
      `/v1/workspaces/${workspaceId}/audit?resourceId=cr_00000000000000000000000003`,
    );
    assert.equal(res.status, 200);
    const items = res.body.items as { resourceId: string }[];
    assert.equal(items.length, 1, 'exactly the one matching resource');
    assert.equal(items[0]!.resourceId, 'cr_00000000000000000000000003');
  });

  test('rejects a malformed time-range filter rather than dropping it', async () => {
    const { workspaceId } = await seedAudit();
    const res = await call('GET', `/v1/workspaces/${workspaceId}/audit?after=notanumber`);
    assert.equal(res.status, 400, 'a bad filter is a client error, not a silently-widened search');
  });

  test('audit/verify consults the key scopes, not just isAdmin', async () => {
    // /v1/audit/verify is a platform-admin integrity check, but isAdmin alone is
    // not the whole gate: an admin may authenticate with a NARROWED key, and the
    // scope∩role intersection must still hold — a key minted away from audit must
    // not read where the hash chain broke. Seed one admin principal with two keys:
    // a full-scope key passes; a narrowed key is denied.
    const now = clock.now();
    const adminPrincipal = await store.principals.create({
      id: newId('principal'),
      type: 'user',
      subject: `admin-${Math.random().toString(36).slice(2, 8)}`,
      displayName: 'Admin',
      email: '',
      isAdmin: true,
      disabled: false,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'system',
    });
    const mintKey = async (scopes: string[]): Promise<string> => {
      const raw = randomToken(32);
      await store.apiKeys.create({
        id: newId('apiKey'),
        principalId: adminPrincipal.id,
        name: `k-${scopes.join(',')}`,
        prefix: raw.slice(0, 8),
        tokenHash: hashToken(raw),
        scopes,
        createdAt: now,
        updatedAt: now,
        createdBy: adminPrincipal.id,
      });
      return raw;
    };
    const fullKey = await mintKey(['ma:*']);
    const narrowedKey = await mintKey(['ma:session:write']);

    const full = await call('GET', '/v1/audit/verify', {
      auth: false,
      headers: { authorization: `Bearer ${fullKey}` },
    });
    assert.equal(full.status, 200, 'a full-scope admin key may verify the chain');

    const narrowed = await call('GET', '/v1/audit/verify', {
      auth: false,
      headers: { authorization: `Bearer ${narrowedKey}` },
    });
    assert.equal(
      narrowed.status,
      403,
      'a narrowed admin key (no audit scope) cannot verify the chain — scopes are enforced',
    );
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

  test('refuses a key reused for a different request body', async () => {
    // A key identifies one *request*. Reusing it for a different body used to
    // replay the first request's response — a 200 describing a resource the
    // caller never asked for, with nothing at all to signal the mistake. The
    // caller then proceeds against the wrong id.
    const { agentId, workspaceId } = await scenario();
    const key = 'reused-key-0001';

    const first = await call('POST', `/v1/workspaces/${workspaceId}/agents`, {
      body: { name: 'First Agent' },
      headers: { 'idempotency-key': key },
    });
    assert.equal(first.status, 201);

    const second = await call('POST', `/v1/workspaces/${workspaceId}/agents`, {
      body: { name: 'A Completely Different Agent' },
      headers: { 'idempotency-key': key },
    });

    assert.equal(second.status, 409, 'a mismatched body must not silently replay');
    assert.equal(second.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    // The message has to say what to do, or the caller just retries the same
    // request and gets the same error.
    assert.match(second.body.error.message, /use a new key/i);

    void agentId;
  });

  test('a retry with an identical body still replays, byte for byte', async () => {
    // The counterpart. A body fingerprint that was too strict — sensitive to
    // key order, whitespace, or a re-serialisation — would break the retry
    // path that idempotency exists to serve, which is the worse failure.
    const { agentId } = await scenario();
    const key = 'identical-body-01';

    const first = await call('POST', '/v1/sessions', {
      body: { agentId, title: 'nightly run' },
      headers: { 'idempotency-key': key },
    });
    const second = await call('POST', '/v1/sessions', {
      body: { agentId, title: 'nightly run' },
      headers: { 'idempotency-key': key },
    });

    assert.equal(second.status, 201);
    assert.equal(second.body.session.id, first.body.session.id);
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

  test('an unauthenticated request is not tracked and always runs the handler', async () => {
    // Idempotency is scoped by principal. A public/unauth path (SCIM, runtime,
    // ingress, auth) reaches this middleware with no `context.auth`, so there is
    // no principal to scope the record to. Tracking it would (a) let an
    // unauthenticated caller persist unbounded durable 24h-TTL rows — one per
    // distinct key, a storage-amplification DoS — and (b) collapse every
    // anonymous caller into one shared keyspace whose replay branch returns a
    // stored response WITHOUT re-running the handler's own authorization, so a
    // key+body match could serve one caller's answer to another. The middleware
    // must skip straight to the handler and touch the store not at all.
    let reserveCalls = 0;
    const original = store.idempotency.reserve.bind(store.idempotency);
    store.idempotency.reserve = ((...args: Parameters<typeof original>) => {
      reserveCalls++;
      return original(...args);
    }) as typeof original;

    try {
      const middleware = idempotencyMiddleware({ store, clock });
      let handlerRan = 0;
      const context = {
        method: 'POST',
        path: '/scim/v2/Users',
        params: {},
        query: new URLSearchParams(),
        headers: { 'idempotency-key': 'unauth-key-000001' },
        body: undefined,
        rawBody: Buffer.from('{"userName":"x"}', 'utf8'),
        requestId: 'ev_test',
        // No `auth` — this is exactly the state a public path is dispatched in.
      } as unknown as RequestContext;

      const result = await middleware(context, () => {
        handlerRan++;
        return Promise.resolve({ status: 201, body: { ok: true } });
      });

      assert.equal(handlerRan, 1, 'the handler must run for an untracked request');
      assert.equal(result?.status, 201);
      assert.equal(
        reserveCalls,
        0,
        'an unauthenticated request must persist no idempotency row',
      );
    } finally {
      store.idempotency.reserve = original;
    }
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

  test('searches the event log by payload content over HTTP', async () => {
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const sessionId = created.body.session.id;
    const wsId = created.body.session.workspaceId;
    await store.events.append(sessionId, [
      { id: newId('event'), sessionId, workspaceId: wsId, ts: 5000, type: 'message.completed', payload: { role: 'assistant', text: 'quota exceeded for tenant' } },
      { id: newId('event'), sessionId, workspaceId: wsId, ts: 6000, type: 'message.completed', payload: { role: 'assistant', text: 'all clear' } },
    ] as Parameters<typeof store.events.append>[1]);

    const hit = await call('GET', `/v1/sessions/${sessionId}/events?q=quota%20exceeded`);
    assert.equal(hit.status, 200);
    assert.equal(hit.body.events.length, 1, 'only the matching event is returned');
    assert.match(hit.body.events[0].payload.text, /quota exceeded/);
  });

  test('ignores a non-numeric time bound rather than passing NaN', async () => {
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    // fromTs=abc → NaN; must be dropped, not passed to the store (where NaN would
    // make `ts >= ?` false for every row and silently return nothing).
    const response = await call('GET', `/v1/sessions/${created.body.session.id}/events?fromTs=abc`);
    assert.equal(response.status, 200);
    assert.ok(response.body.events.length >= 1, 'a garbage fromTs is ignored, not applied as NaN');
  });

  test('a whitespace-only integer param is ignored, not coerced to 0', async () => {
    // Number(' ') is 0 (not NaN), so a whitespace `turn` used to filter to turn 0
    // — returning nothing for a normal session. A digits-only parse rejects it.
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const response = await call('GET', `/v1/sessions/${created.body.session.id}/events?turn=%20`);
    assert.equal(response.status, 200);
    assert.ok(
      response.body.events.length >= 1,
      'a whitespace turn must not silently filter to turn 0',
    );
  });

  test('honours toSeq, turn and order (previously dropped at the HTTP layer)', async () => {
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const sessionId = created.body.session.id;
    const wsId = created.body.session.workspaceId;
    await store.events.append(sessionId, [
      { id: newId('event'), sessionId, workspaceId: wsId, ts: 7000, type: 'turn.started', turn: 5, payload: { turn: 5, promptPreview: 'p' } },
    ] as Parameters<typeof store.events.append>[1]);

    const desc = await call('GET', `/v1/sessions/${sessionId}/events?order=desc&limit=1`);
    assert.equal(desc.status, 200);
    const highest = desc.body.lastSeq;
    assert.equal(desc.body.events[0].seq, highest, 'order=desc returns the newest first');

    const byTurn = await call('GET', `/v1/sessions/${sessionId}/events?turn=5`);
    assert.ok(byTurn.body.events.every((e: { turn?: number }) => e.turn === 5), 'turn filter applies');
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

  test('an empty Last-Event-ID does not skip the first event', () => {
    // `Number('')` is 0, and `Number.isInteger(0)` is true — so an empty header
    // resolved to "resume from 1" and the client silently never received event
    // 1. A browser sends an empty Last-Event-ID before it has received
    // anything, so the event lost was `session.created`, on exactly the
    // connection that most needed it.
    assert.equal(resolveFromSeq('', null), 0);
    assert.equal(resolveFromSeq('   ', null), 0);

    // Genuinely resuming from event 0 is still distinct: seq numbering starts
    // at 1, so "I have seen 0" means "send me everything from 1".
    assert.equal(resolveFromSeq('0', null), 1);
  });

  test('refuses cursor shapes this protocol never emits', () => {
    // Sequences are decimal integers. Accepting other numeric literals means a
    // caller can name a position no event will ever occupy, and the stream
    // sits silent while the client waits for a frame that cannot arrive.
    for (const bogus of ['0x10', '1e10', '1.5', '-1', '+5', 'Infinity', 'NaN']) {
      assert.equal(resolveFromSeq(bogus, null), 0, `${bogus} must not resolve to a position`);
    }

    // Past MAX_SAFE_INTEGER, `Number` silently lands on a nearby integer —
    // a cursor the client did not ask for.
    assert.equal(resolveFromSeq('9007199254740993', null), 0);
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

  test('bounds the hand-over buffer instead of growing it without limit', async () => {
    // The bus bounds each subscriber queue and drops with `stream.lagged`
    // rather than growing — "one slow SSE client must not be able to exhaust
    // the process's memory for everyone else". That bound did not reach the
    // bridge: while replaying, live events went into its own `pending` array,
    // filled from an `onEvent` that returns immediately, so the bus saw a fast
    // subscriber and handed over everything. 20,000 events published during one
    // replay produced a 20,000-entry buffer and no signal to anyone.
    const { agentId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const session = created.body.session;

    // A bridge whose replay is slow enough to observe, and a small cap so the
    // test does not have to publish twenty thousand events to prove the point.
    let bridge: SseBridge | undefined;
    const frames: string[] = [];
    const res = {
      write: (chunk: string) => {
        frames.push(chunk);
        return true;
      },
      end: () => {},
      on: () => {},
      writeHead: () => {},
    } as unknown as import('node:http').ServerResponse;

    // Hold replay open so the buffering window is real rather than a race the
    // test hopes to win. This is exactly the production shape: a long log being
    // read while the session is actively producing.
    let releaseReplay = (): void => {};
    const replayReached = new Promise<void>((resolve) => {
      let signalled = false;
      const held = new Promise<void>((release) => {
        releaseReplay = release;
      });
      // Intercept only `read` while every other method stays the real one with
      // the real `this` — store.events is a class instance whose methods read
      // private fields (#db). A spread copies no prototype methods at all, and a
      // plain prototype-delegating object makes the delegated method run with the
      // wrong `this`, which private fields reject. A bind-everything-but-read
      // proxy gives both: earliestSeq() and friends behave identically.
      const wrappedRead = async (...args: Parameters<typeof store.events.read>) => {
        if (!signalled) {
          signalled = true;
          resolve();
          await held;
        }
        return store.events.read(...args);
      };
      const slowEvents = new Proxy(store.events, {
        get(target, prop) {
          if (prop === 'read') return wrappedRead;
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as typeof store.events;
      const slowStore = Object.create(store) as typeof store;
      slowStore.events = slowEvents;

      bridge = new SseBridge({
        bus,
        store: slowStore,
        clock,
        logger: nullLogger,
        heartbeatMs: 1_000_000,
        replayBufferLimit: 5,
      });
    });

    const controller = new AbortController();
    const streaming = bridge!.stream(
      { sessionId: session.id, fromSeq: 1, signal: controller.signal },
      res,
    );

    await replayReached;

    // Publish far more than the cap while replay is genuinely in flight.
    await bus.publish(
      Array.from({ length: 50 }, (_unused, index) => ({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        type: 'message.delta' as const,
        payload: { text: `chunk ${index}` },
      })),
    );

    releaseReplay();
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await streaming;

    const text = frames.join('');
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));

    // The cap costs memory, not delivery. An event dropped from the hand-over
    // buffer is still in the log, and the replay loop is still reading — so it
    // arrives by that route instead. The properties that must survive are the
    // ones the whole resume design rests on.
    assert.equal(new Set(ids).size, ids.length, 'no sequence may be delivered twice');
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'sequences must stay ordered');
    assert.ok(ids.length > 5, 'the cap must not truncate what the client receives');

    // No gap: every sequence between the first and last delivered is present.
    const expected = Array.from({ length: ids.length }, (_unused, index) => ids[0]! + index);
    assert.deepEqual(ids, expected, 'a bounded buffer must not open a hole in the stream');

    // The client is told its buffer overflowed, and that notice carries no
    // `id:` — one that did would rewind a resuming browser onto a sequence it
    // had already seen, producing a duplicate from the frame warning about a
    // gap.
    assert.match(text, /event: stream\.lagged/, 'the client must learn it was capped');
    const laggedFrame = text.slice(text.indexOf('event: stream.lagged'));
    assert.ok(
      !/^id: /m.test(laggedFrame.split('\n\n')[0] ?? ''),
      'a lag notice is metadata about the stream, not a position in it',
    );
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

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  /** A context standing in for one unauthenticated request. */
  function request(forwardedFor: string, remoteAddress = '203.0.113.7'): RequestContext {
    return {
      method: 'GET',
      path: '/v1/workspaces',
      params: {},
      query: {},
      headers: { 'x-forwarded-for': forwardedFor },
      body: undefined,
      rawBody: Buffer.alloc(0),
      requestId: 'ev_test',
      raw: { req: { socket: { remoteAddress } }, res: {} },
    } as unknown as RequestContext;
  }

  const ok = (): Promise<undefined> => Promise.resolve(undefined);

  test('an unauthenticated caller cannot rotate a header to evade the limit', async () => {
    // `X-Forwarded-For` is set by the client unless a proxy overwrites it. The
    // limiter bucketed on it directly, so a fresh value per request meant a
    // fresh bucket per request: twelve requests against a limit of five
    // produced zero refusals. A caller could also pick someone else's address
    // and spend their budget.
    const limiter = rateLimitMiddleware({ clock, limit: 5, windowMs: 60_000 });

    let refused = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      // A different claimed address every time, one real socket.
      await limiter(request(`10.0.0.${attempt}`), ok).catch((error: unknown) => {
        assert.ok(MaError.is(error), 'refusal must be a typed error');
        assert.equal(error.code, 'RATE_LIMITED');
        refused++;
      });
    }

    assert.ok(refused > 0, 'rotating a self-declared header must not evade the limit');
    assert.equal(refused, 7, 'five allowed, the rest refused');
  });

  test('honours the forwarded address when a proxy is declared', async () => {
    // The counterpart: behind a real proxy every request shares one socket, so
    // ignoring the header would bucket the entire internet together and the
    // first busy client would lock everyone out.
    const limiter = rateLimitMiddleware({
      clock,
      limit: 5,
      windowMs: 60_000,
      trustForwardedFor: true,
    });

    let refused = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      await limiter(request(`10.0.0.${attempt}`), ok).catch(() => {
        refused++;
      });
    }

    assert.equal(refused, 0, 'distinct clients behind a trusted proxy get distinct buckets');
  });

  test('still limits a single caller behind a trusted proxy', async () => {
    const limiter = rateLimitMiddleware({
      clock,
      limit: 5,
      windowMs: 60_000,
      trustForwardedFor: true,
    });

    let refused = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      await limiter(request('10.0.0.99'), ok).catch(() => {
        refused++;
      });
    }

    assert.equal(refused, 7);
  });

  test('a spoofed leftmost X-Forwarded-For cannot evade the limit behind a trusted proxy', async () => {
    // A trusted proxy APPENDS the peer it saw, so `X-Forwarded-For: <spoof>` from
    // the client becomes `<spoof>, <real>`. Bucketing by the leftmost would let a
    // caller rotate the spoof and get a fresh budget each request (and forge the
    // audit sourceIp); bucketing by the rightmost — the address the one trusted
    // hop actually observed — pins them to a single bucket.
    const limiter = rateLimitMiddleware({
      clock,
      limit: 5,
      windowMs: 60_000,
      trustForwardedFor: true,
    });

    let refused = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      // A rotating spoof on the left, the SAME real appended address on the right.
      await limiter(request(`9.9.9.${attempt}, 10.0.0.42`), ok).catch(() => {
        refused++;
      });
    }
    assert.equal(refused, 7, 'the rightmost (real) address is the bucket; a rotating leftmost spoof does not evade');
  });

  test('two authenticated principals on one IP get independent budgets', async () => {
    // The headline bug: the limiter runs before auth, so context.auth is always
    // undefined and every authenticated caller is bucketed by IP. Two tenants
    // behind one NAT/proxy then share a bucket, and one exhausting it locks the
    // other out. With a per-principal tier after auth, each has its own budget.
    const second = await seedPrincipalAndKey();

    // A dedicated gateway with a tiny principal limit and a trusted proxy, so two
    // requests carrying the same forwarded address but different tokens are
    // distinguished only by principal.
    const deps = { store, clock, logger: nullLogger, authorizer: new RoleAuthorizer() };
    const q = new QuotaService(store, clock);
    const limited = new Gateway({
      store,
      clock,
      logger: nullLogger,
      quota: q,
      authorizer: new RoleAuthorizer(),
      workspaces: new WorkspaceService({ ...deps, quota: q }),
      agents: new AgentService({ ...deps, quota: q }),
      sessions: new SessionService({ ...deps, quota: q, bus, provisioner }),
      credentials: new CredentialService({ ...deps, quota: q, keys: InMemoryKeyProvider.generate() }),
      artifacts,
      memories: new MemoryService({ ...deps, quota: q }),
      templates: new TemplateService({ ...deps, quota: q }),
      previews: new PreviewService({ clock, keys: InMemoryKeyProvider.generate(), previewOrigin: 'https://artifacts.test', consoleOrigin: 'https://console.test' }),
      sse: new SseBridge({ bus, store, clock, logger: nullLogger, heartbeatMs: 50 }),
      version: '0.1.0-test',
      trustForwardedFor: true,
      rateLimit: { limit: 3, windowMs: 60_000 },
    });
    const address = await limited.listen(0);
    const url = `http://${address.host}:${address.port}`;
    const sharedIp = '198.51.100.42';

    try {
      // Principal A spends its whole budget from the shared IP.
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${url}/v1/workspaces`, {
          headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': sharedIp },
        });
        await res.text();
        assert.equal(res.status, 200, `A request ${attempt} should be allowed`);
      }
      // A's next request is refused — its own budget is spent.
      const aOver = await fetch(`${url}/v1/workspaces`, {
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': sharedIp },
      });
      await aOver.text();
      assert.equal(aOver.status, 429, 'A is over its per-principal budget');

      // Principal B, same IP, must still be served: its budget is its own.
      const bFirst = await fetch(`${url}/v1/workspaces`, {
        headers: { authorization: `Bearer ${second.token}`, 'x-forwarded-for': sharedIp },
      });
      await bFirst.text();
      assert.equal(
        bFirst.status,
        200,
        'B on the same IP must not be throttled by A — per-principal, not per-IP',
      );

      // The per-principal tier's numbers are the authoritative x-ratelimit-*:
      // B has spent 1 of 3, so 2 remain (not the coarse IP-shield figure).
      assert.equal(bFirst.headers.get('x-ratelimit-limit'), '3', 'headers show the principal tier');
      assert.equal(bFirst.headers.get('x-ratelimit-remaining'), '2');
    } finally {
      await limited.close(1000);
    }
  });

  test('the IP tier shields the auth lookup from an anonymous flood', async () => {
    // The IP tier runs before auth, so an unauthenticated flood is refused
    // *without* consulting the (DB-backed) api-key store — otherwise auth would be
    // the DoS surface. A tiny IP limit and a store that records lookups proves it.
    let keyLookups = 0;
    const countingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'apiKeys') {
          const apiKeys = Reflect.get(target, prop, receiver);
          return new Proxy(apiKeys, {
            get(kTarget, kProp, kRecv) {
              if (kProp === 'getByHash') {
                return (hash: string) => {
                  keyLookups++;
                  return Reflect.get(kTarget, kProp, kRecv).call(kTarget, hash);
                };
              }
              const v = Reflect.get(kTarget, kProp, kRecv);
              return typeof v === 'function' ? v.bind(kTarget) : v;
            },
          });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as typeof store;

    const deps = { store: countingStore, clock, logger: nullLogger, authorizer: new RoleAuthorizer() };
    const q = new QuotaService(countingStore, clock);
    const limited = new Gateway({
      store: countingStore,
      clock,
      logger: nullLogger,
      quota: q,
      authorizer: new RoleAuthorizer(),
      workspaces: new WorkspaceService({ ...deps, quota: q }),
      agents: new AgentService({ ...deps, quota: q }),
      sessions: new SessionService({ ...deps, quota: q, bus, provisioner }),
      credentials: new CredentialService({ ...deps, quota: q, keys: InMemoryKeyProvider.generate() }),
      artifacts,
      memories: new MemoryService({ ...deps, quota: q }),
      templates: new TemplateService({ ...deps, quota: q }),
      previews: new PreviewService({ clock, keys: InMemoryKeyProvider.generate(), previewOrigin: 'https://artifacts.test', consoleOrigin: 'https://console.test' }),
      sse: new SseBridge({ bus, store: countingStore, clock, logger: nullLogger, heartbeatMs: 50 }),
      version: '0.1.0-test',
      trustForwardedFor: true,
      rateLimit: { ip: { limit: 2, windowMs: 60_000 }, principal: { limit: 100, windowMs: 60_000 } },
    });
    const address = await limited.listen(0);
    const url = `http://${address.host}:${address.port}`;
    const floodIp = '203.0.113.200';

    try {
      let refused = 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await fetch(`${url}/v1/workspaces`, {
          // A bad token, so if auth ran it would reject — but the IP tier should
          // refuse first, before any key lookup.
          headers: { authorization: 'Bearer not-a-real-token', 'x-forwarded-for': floodIp },
        });
        await res.text();
        if (res.status === 429) refused++;
      }
      assert.ok(refused >= 4, 'the IP tier refuses the flood past its small limit');
      assert.ok(
        keyLookups <= 2,
        `auth must not be consulted for IP-refused requests (was ${keyLookups})`,
      );
    } finally {
      await limited.close(1000);
    }
  });

  /** Build a gateway with a specific rate-limit config, over the shared store. */
  function limitedGateway(rateLimit: GatewayOptions['rateLimit']): Gateway {
    const deps = { store, clock, logger: nullLogger, authorizer: new RoleAuthorizer() };
    const q = new QuotaService(store, clock);
    return new Gateway({
      store,
      clock,
      logger: nullLogger,
      quota: q,
      authorizer: new RoleAuthorizer(),
      workspaces: new WorkspaceService({ ...deps, quota: q }),
      agents: new AgentService({ ...deps, quota: q }),
      sessions: new SessionService({ ...deps, quota: q, bus, provisioner }),
      credentials: new CredentialService({ ...deps, quota: q, keys: InMemoryKeyProvider.generate() }),
      artifacts,
      memories: new MemoryService({ ...deps, quota: q }),
      templates: new TemplateService({ ...deps, quota: q }),
      previews: new PreviewService({ clock, keys: InMemoryKeyProvider.generate(), previewOrigin: 'https://artifacts.test', consoleOrigin: 'https://console.test' }),
      sse: new SseBridge({ bus, store, clock, logger: nullLogger, heartbeatMs: 50 }),
      version: '0.1.0-test',
      trustForwardedFor: true,
      rateLimit,
    });
  }

  test('a public path gets the IP tier headroom, not the lower principal limit', async () => {
    // Public/unauthenticated paths (health, runtime, ingress) have no principal,
    // so the principal tier must not re-limit them by IP at its lower budget — the
    // IP tier already governs them. Otherwise high-volume runtime traffic from a
    // shared-egress host is throttled at the principal limit and sessions break.
    const gw = limitedGateway({
      ip: { limit: 20, windowMs: 60_000 },
      principal: { limit: 3, windowMs: 60_000 },
    });
    const address = await gw.listen(0);
    const url = `http://${address.host}:${address.port}`;
    try {
      let refused = 0;
      // /health is public; fire well past the principal limit (3) but under IP (20).
      for (let attempt = 0; attempt < 10; attempt++) {
        const res = await fetch(`${url}/health`, { headers: { 'x-forwarded-for': '198.51.100.9' } });
        await res.text();
        if (res.status === 429) refused++;
      }
      assert.equal(refused, 0, 'a public path must ride the IP tier headroom, not the principal cap');
    } finally {
      await gw.close(1000);
    }
  });

  test('a legacy flat limit above the IP default is not silently capped', async () => {
    // The legacy flat {limit,windowMs} maps to the principal tier; it must not be
    // silently throttled below its stated limit by the default IP shield. A caller
    // who asked for 10000 must get an IP tier of at least 10000, not the 3000
    // default — otherwise concentrated single-IP traffic is capped at 3000.
    const high = normalizeRateLimit({ limit: 10_000, windowMs: 60_000 });
    assert.equal(high.principal.limit, 10_000, 'flat limit binds the principal tier');
    assert.ok(
      high.ip.limit >= 10_000,
      `the IP tier must not cap a legacy flat limit below its value (was ${high.ip.limit})`,
    );

    // A flat limit below the default IP shield keeps the coarser default shield.
    const low = normalizeRateLimit({ limit: 100, windowMs: 60_000 });
    assert.equal(low.principal.limit, 100);
    assert.ok(low.ip.limit >= 100, 'the IP shield is never below the principal limit');

    // The explicit two-tier shape is passed through unchanged.
    const explicit = normalizeRateLimit({
      ip: { limit: 42, windowMs: 1000 },
      principal: { limit: 7, windowMs: 2000 },
    });
    assert.deepEqual(explicit, {
      ip: { limit: 42, windowMs: 1000 },
      principal: { limit: 7, windowMs: 2000 },
    });
  });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe('artifact download', () => {
  /** Publish through the service, as the runtime bridge does. */
  async function publish(workspace: string, sessionId: string, path: string, content: string) {
    return artifacts.publish({
      workspaceId: workspace,
      sessionId,
      path,
      bytes: new TextEncoder().encode(content),
    });
  }

  test('serves agent-authored HTML as an inert attachment', async () => {
    // The headline risk: an agent writes a page that reads the console's token,
    // and a human opens it from the same origin the console is served from.
    // Four headers have to be right at once, so they are asserted together.
    const { agentId, workspaceId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const { artifact } = await publish(
      workspaceId,
      created.body.session.id,
      'report.html',
      '<script>fetch("/v1/workspaces")</script>',
    );

    const response = await fetch(`${baseUrl}/v1/artifacts/${artifact.id}/content`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/plain/,
      'the declared extension must not become the served type',
    );
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(await response.text(), '<script>fetch("/v1/workspaces")</script>');
  });

  test('an agent-chosen path cannot splice a response header', async () => {
    // `path` reaches a Content-Disposition filename. A CR there would end the
    // header and begin whatever the agent wrote next.
    const { agentId, workspaceId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const { artifact } = await publish(
      workspaceId,
      created.body.session.id,
      'out\r\nSet-Cookie: admin=1',
      'x',
    );

    const response = await fetch(`${baseUrl}/v1/artifacts/${artifact.id}/content`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null, 'no header may have been spliced');
    // The text survives, inert, inside the quoted filename — which is the
    // correct outcome: sanitising removes the control characters, not the
    // agent's ability to choose a silly name.
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="/);
  });

  test('refuses an unauthenticated download', async () => {
    const { agentId, workspaceId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const { artifact } = await publish(workspaceId, created.body.session.id, 'private.txt', 'secret');

    const response = await fetch(`${baseUrl}/v1/artifacts/${artifact.id}/content`);
    assert.equal(response.status, 401);
  });

  test('a member of another workspace cannot read an artifact', async () => {
    const { agentId, workspaceId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const { artifact } = await publish(workspaceId, created.body.session.id, 'private.txt', 'secret');

    const stranger = await seedPrincipalAndKey();
    const response = await fetch(`${baseUrl}/v1/artifacts/${artifact.id}/content`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
  });
});

describe('artifact preview', () => {
  async function publishHtml(workspaceId: string, sessionId: string): Promise<string> {
    const { artifact } = await artifacts.publish({
      workspaceId,
      sessionId,
      path: 'report.html',
      bytes: new TextEncoder().encode('<!DOCTYPE html><html><body><h1>Report</h1></body></html>'),
    });
    return artifact.id;
  }

  test('renders agent HTML on the preview path under a sandbox CSP', async () => {
    // The whole point: agent-authored HTML that would be stored XSS on the API
    // origin is rendered as a real page here — safe only because the response
    // carries a sandbox CSP and (in production) a separate origin.
    const { agentId, workspaceId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const artifactId = await publishHtml(workspaceId, created.body.session.id);

    // Mint a signed preview URL through the authenticated endpoint.
    const minted = await call('POST', `/v1/artifacts/${artifactId}/preview-token`);
    assert.equal(minted.status, 201);
    const previewUrl = new URL(minted.body.url);

    // The preview URL points at the configured separate origin.
    assert.equal(previewUrl.origin, 'https://artifacts.test');

    // Load it against this server (path + query only), with no bearer — the
    // signed token is the authorization.
    const response = await fetch(`${baseUrl}${previewUrl.pathname}${previewUrl.search}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /sandbox/);
    assert.match(csp, /frame-ancestors https:\/\/console\.test/);
    assert.equal(await response.text(), '<!DOCTYPE html><html><body><h1>Report</h1></body></html>');
  });

  test('a preview request with a bad token is rejected, no bytes served', async () => {
    const { agentId, workspaceId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const artifactId = await publishHtml(workspaceId, created.body.session.id);

    const response = await fetch(
      `${baseUrl}/preview/v1/${artifactId}?exp=99999999999999&nonce=x&sig=forged`,
    );
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.ok(!body.includes('<h1>Report'), 'no content leaks on a bad token');
  });

  test('minting a preview token needs download authorization', async () => {
    const { agentId, workspaceId } = await scenario();
    const created = await call('POST', '/v1/sessions', { body: { agentId } });
    const artifactId = await publishHtml(workspaceId, created.body.session.id);

    const stranger = await seedPrincipalAndKey();
    const response = await fetch(`${baseUrl}/v1/artifacts/${artifactId}/preview-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
  });
});

describe('agent templates over HTTP', () => {
  test('create, list, then instantiate an agent from a template', async () => {
    const ws = await call('POST', '/v1/workspaces', { body: { name: 'T', slug: 'tmpl' } });
    const workspaceId = ws.body.workspace.id;

    const created = await call('POST', `/v1/workspaces/${workspaceId}/templates`, {
      body: {
        name: 'Reviewer',
        category: 'coding',
        spec: {
          systemPrompt: 'You review {{language}} code',
          model: { modelId: 'test/model' },
        },
        variables: [
          { key: 'language', type: 'string', required: true },
        ],
      },
    });
    assert.equal(created.status, 201);
    const templateId = created.body.template.id;

    const listed = await call('GET', `/v1/workspaces/${workspaceId}/templates`);
    assert.ok(
      listed.body.items.some((template: { id: string }) => template.id === templateId),
      'the new template appears in the catalogue',
    );

    const instantiated = await call(
      'POST',
      `/v1/workspaces/${workspaceId}/templates/${templateId}/instantiate`,
      { body: { agentName: 'Rust Reviewer', variables: { language: 'Rust' } } },
    );
    assert.equal(instantiated.status, 201);
    assert.equal(instantiated.body.agent.name, 'Rust Reviewer');

    // The variable reached the created agent's resolved version.
    const agentId = instantiated.body.agent.id;
    const versions = await call('GET', `/v1/agents/${agentId}/versions/1`);
    assert.match(versions.body.version.systemPrompt, /review Rust code/);
  });

  test('a missing required variable is a 400, and creates no agent', async () => {
    const ws = await call('POST', '/v1/workspaces', { body: { name: 'T', slug: 'tmpl2' } });
    const workspaceId = ws.body.workspace.id;
    const created = await call('POST', `/v1/workspaces/${workspaceId}/templates`, {
      body: {
        name: 'Reviewer',
        spec: { systemPrompt: 'review {{language}}', model: { modelId: 'test/model' } },
        variables: [{ key: 'language', type: 'string', required: true }],
      },
    });

    const before = (await call('GET', `/v1/workspaces/${workspaceId}/agents`)).body.items.length;
    const failed = await call(
      'POST',
      `/v1/workspaces/${workspaceId}/templates/${created.body.template.id}/instantiate`,
      { body: { variables: {} } },
    );
    assert.equal(failed.status, 400);
    const after = (await call('GET', `/v1/workspaces/${workspaceId}/agents`)).body.items.length;
    assert.equal(after, before, 'a rejected instantiation leaves no agent behind');
  });
});
