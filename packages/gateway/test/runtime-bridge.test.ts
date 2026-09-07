/**
 * Runtime bridge tests.
 *
 * This is the surface a compromised sandbox would attack, so the tests are
 * mostly about what it *cannot* do: write to another session, use a model it
 * was not granted, exchange a credential it does not hold, or keep working
 * after the control plane has closed its session.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, MaError, TestClock, newId, nullLogger } from '@ma/core';
import type { Principal, Session } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';
import {
  AgentService,
  CredentialService,
  EventBus,
  QuotaService,
  RoleAuthorizer,
  SessionService,
  WorkspaceService,
  type AuthContext,
  type SessionProvisioner,
} from '@ma/engine';

import { RuntimeBridge, type ModelProvider } from '../src/runtime-bridge.ts';

const START = 1_700_000_000_000;

let store: SqliteStore;
let clock: TestClock;
let bus: EventBus;
let bridge: RuntimeBridge;
let sessions: SessionService;
let credentials: CredentialService;
let context: AuthContext;
let workspaceId: string;
let agentId: string;
let session: Session;
let token: string;
let leaseAlive = true;

const model: ModelProvider = {
  complete: () =>
    Promise.resolve({
      text: 'the answer',
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
};

const provisioner: SessionProvisioner = {
  provision: () => Promise.resolve({ sandboxId: newId('sandbox'), reused: false, provisionMs: 1 }),
  release: () => Promise.resolve(),
  submit: () => Promise.resolve(),
};

beforeEach(async () => {
  store = createMemoryStore();
  clock = new TestClock(START);
  bus = new EventBus(store, clock, nullLogger);
  leaseAlive = true;

  const principal: Principal = await store.principals.create({
    id: newId('principal'),
    type: 'user',
    subject: 'runtime-test',
    displayName: 'Tester',
    email: '',
    isAdmin: false,
    disabled: false,
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'system',
  });
  context = { principal };

  const quota = new QuotaService(store, clock);
  const deps = { store, clock, quota, logger: nullLogger, authorizer: new RoleAuthorizer() };
  const workspaces = new WorkspaceService(deps);
  const agents = new AgentService(deps);
  sessions = new SessionService({ ...deps, bus, provisioner });
  credentials = new CredentialService({ ...deps, keys: InMemoryKeyProvider.generate() });

  const workspace = await workspaces.create(context, { name: 'Runtime', slug: 'runtime-test' });
  workspaceId = workspace.id;

  await store.models.upsert({
    id: 'test/model',
    provider: 'test',
    model: 'model',
    displayName: 'Test',
    enabled: true,
    contextWindowTokens: 100_000,
    maxOutputTokens: 4096,
    compactThresholdTokens: 80_000,
    capabilities: { tools: true, vision: false, reasoningEffort: [], promptCaching: false },
    pricing: {
      inputMicrosPerMillion: 3_000_000,
      outputMicrosPerMillion: 15_000_000,
      cacheReadMicrosPerMillion: 0,
      cacheWriteMicrosPerMillion: 0,
    },
    securityLevel: '',
    allowedWorkspaceIds: [],
  });
  await store.models.upsert({
    id: 'test/forbidden',
    provider: 'test',
    model: 'forbidden',
    displayName: 'Not granted',
    enabled: true,
    contextWindowTokens: 100_000,
    maxOutputTokens: 4096,
    compactThresholdTokens: 80_000,
    capabilities: { tools: true, vision: false, reasoningEffort: [], promptCaching: false },
    pricing: {
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      cacheReadMicrosPerMillion: 0,
      cacheWriteMicrosPerMillion: 0,
    },
    securityLevel: '',
    allowedWorkspaceIds: [],
  });

  const agent = await agents.create(context, {
    workspaceId,
    name: 'Runner',
    spec: { model: { modelId: 'test/model' }, systemPrompt: 'agent prompt' },
  });
  agentId = agent.id;

  session = await sessions.create(context, { agentId });

  bridge = new RuntimeBridge({
    store,
    clock,
    bus,
    sessions,
    credentials,
    models: model,
    logger: nullLogger,
    renewLease: () => Promise.resolve(leaseAlive),
  });

  token = 'runtime-token-abcdef';
  bridge.bind(token, session.id, newId('sandbox'));
});

afterEach(async () => {
  bus.closeAll();
  await store.close();
});

describe('authentication', () => {
  test('resolves a bound token to its session', async () => {
    const identity = await bridge.authenticate(token);
    assert.equal(identity.session.id, session.id);
  });

  test('rejects an absent or unknown token', async () => {
    await assert.rejects(bridge.authenticate(undefined), (error: unknown) =>
      MaError.is(error) && error.status === 401,
    );
    await assert.rejects(bridge.authenticate('not-a-real-token'), (error: unknown) =>
      MaError.is(error) && error.status === 401,
    );
  });

  test('rejects a token whose session has ended', async () => {
    // A sandbox that outlived its session must not keep writing to a log the
    // control plane considers closed.
    await sessions.terminate(context, session.id, 'done');
    await assert.rejects(bridge.authenticate(token), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'SESSION_CLOSED');
      return true;
    });
  });

  test('an unbound token stops working', async () => {
    bridge.unbind(token);
    await assert.rejects(bridge.authenticate(token));
  });
});

describe('event append', () => {
  test('writes to the caller’s own session', async () => {
    const identity = await bridge.authenticate(token);
    const result = await bridge.appendEvents(identity, {
      events: [{ type: 'message.completed', payload: { role: 'assistant', text: 'hello' } }],
    });

    assert.equal(result.accepted, 1);
    const events = await store.events.read(session.id, { types: ['message.completed'] });
    assert.equal(events.length, 1);
  });

  test('ignores a session id in the body', async () => {
    // The session comes from the token; otherwise a sandbox could forge another
    // agent's history.
    const other = await sessions.create(context, { agentId });
    const identity = await bridge.authenticate(token);

    await bridge.appendEvents(identity, {
      events: [
        {
          type: 'message.completed',
          sessionId: other.id,
          payload: { role: 'assistant', text: 'forged' },
        },
      ],
    });

    const theirs = await store.events.read(other.id, { types: ['message.completed'] });
    assert.equal(theirs.length, 0, 'a sandbox must not write to another session');
    const ours = await store.events.read(session.id, { types: ['message.completed'] });
    assert.equal(ours.length, 1);
  });

  test('refuses event types only the control plane may assert', async () => {
    // A sandbox claiming `session.terminated` would be asserting something it
    // cannot know, and a log that accepts such claims is not an audit trail.
    const identity = await bridge.authenticate(token);
    for (const type of ['session.terminated', 'audit.permission.decided', 'sandbox.bound']) {
      await assert.rejects(
        bridge.appendEvents(identity, { events: [{ type, payload: {} }] }),
        (error: unknown) => MaError.is(error) && error.status === 400,
        `${type} must be refused`,
      );
    }
  });

  test('folds reported usage into the session', async () => {
    const identity = await bridge.authenticate(token);
    await bridge.appendEvents(identity, {
      events: [
        {
          type: 'turn.completed',
          turn: 1,
          payload: {
            turn: 1,
            reason: 'completed',
            durationMs: 100,
            usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
          },
        },
      ],
    });

    const updated = await store.sessions.get(session.id);
    assert.equal(updated?.usage.inputTokens, 500, 'usage drives quota, so it must reach the row');
    assert.equal(updated?.usage.outputTokens, 200);
  });

  test('bounds a batch', async () => {
    const identity = await bridge.authenticate(token);
    const one = { type: 'message.delta', payload: { text: 'x' } };
    await assert.rejects(bridge.appendEvents(identity, { events: [] }));
    await assert.rejects(bridge.appendEvents(identity, { events: Array(101).fill(one) }));
  });
});

describe('heartbeat', () => {
  test('reports alive while the lease holds', async () => {
    const identity = await bridge.authenticate(token);
    const result = await bridge.heartbeat(identity);
    assert.equal(result.alive, true);
  });

  test('tells a reaped sandbox to stop', async () => {
    // Continuing in an environment the control plane has written off produces
    // events for a session that has moved on.
    leaseAlive = false;
    const identity = await bridge.authenticate(token);
    assert.equal((await bridge.heartbeat(identity)).alive, false);
  });
});

describe('credential exchange', () => {
  test('returns a value the session was granted', async () => {
    const credential = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'granted',
      value: 'the-secret',
    });
    const scoped = await sessions.create(context, {
      agentId,
      credentialIds: [credential.id],
    });
    bridge.bind('scoped-token-xyz', scoped.id, newId('sandbox'));

    const identity = await bridge.authenticate('scoped-token-xyz');
    const result = await bridge.exchangeCredential(identity, credential.id, 'calling an API');
    assert.equal(result.value, 'the-secret');
  });

  test('refuses a credential the session does not hold', async () => {
    const other = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'not granted',
      value: 'not-yours',
    });
    const identity = await bridge.authenticate(token);
    await assert.rejects(
      bridge.exchangeCredential(identity, other.id, 'trying'),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('audits the exchange without recording the value', async () => {
    const credential = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'audited',
      value: 'SENSITIVE',
    });
    const scoped = await sessions.create(context, { agentId, credentialIds: [credential.id] });
    bridge.bind('audit-token-xyz', scoped.id, newId('sandbox'));

    const identity = await bridge.authenticate('audit-token-xyz');
    await bridge.exchangeCredential(identity, credential.id, 'why it was needed');

    const entries = await store.audit.list({ resourceId: credential.id });
    const exchange = entries.items.find((entry) => entry.action === 'credential.exchange');
    assert.ok(exchange);
    assert.equal(exchange.reason, 'why it was needed');
    assert.equal(JSON.stringify(exchange).includes('SENSITIVE'), false);
  });
});

describe('model access', () => {
  test('calls the model its version declares', async () => {
    const identity = await bridge.authenticate(token);
    const result = (await bridge.complete(identity, {
      modelId: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
    })) as { text: string; usage: { costMicros: number } };

    assert.equal(result.text, 'the answer');
    // 100 input at 3/M plus 50 output at 15/M, in micro-units.
    assert.equal(result.usage.costMicros, 100 * 3 + 50 * 15);
  });

  test('refuses a model the session was not granted', async () => {
    // Otherwise a compromised agent could route work to a more expensive or
    // less restricted model than its version declares.
    const identity = await bridge.authenticate(token);
    await assert.rejects(
      bridge.complete(identity, {
        modelId: 'test/forbidden',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('refuses a model restricted to other workspaces', async () => {
    await store.models.upsert({
      id: 'test/model',
      provider: 'test',
      model: 'model',
      displayName: 'Test',
      enabled: true,
      contextWindowTokens: 100_000,
      maxOutputTokens: 4096,
      compactThresholdTokens: 80_000,
      capabilities: { tools: true, vision: false, reasoningEffort: [], promptCaching: false },
      pricing: {
        inputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
        cacheReadMicrosPerMillion: 0,
        cacheWriteMicrosPerMillion: 0,
      },
      securityLevel: '',
      allowedWorkspaceIds: ['ws_01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    });

    const identity = await bridge.authenticate(token);
    await assert.rejects(
      bridge.complete(identity, {
        modelId: 'test/model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('records usage and emits a model event', async () => {
    const identity = await bridge.authenticate(token);
    await bridge.complete(identity, {
      modelId: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const updated = await store.sessions.get(session.id);
    assert.equal(updated?.usage.inputTokens, 100);

    const events = await store.events.read(session.id, { types: ['model.completed'] });
    assert.equal(events.length, 1);
  });

  test('records a failure as an event rather than losing it', async () => {
    const failing = new RuntimeBridge({
      store,
      clock,
      bus,
      sessions,
      credentials,
      models: { complete: () => Promise.reject(new Error('provider is down')) },
      logger: nullLogger,
      renewLease: () => Promise.resolve(true),
    });
    failing.bind('failing-token-xyz', session.id, newId('sandbox'));

    const identity = await failing.authenticate('failing-token-xyz');
    await assert.rejects(
      failing.complete(identity, {
        modelId: 'test/model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    const events = await store.events.read(session.id, { types: ['model.failed'] });
    assert.equal(events.length, 1);
  });
});

describe('bootstrap', () => {
  test('returns the pinned configuration, not the agent’s latest', async () => {
    const identity = await bridge.authenticate(token);
    const config = (await bridge.bootstrap(identity)) as {
      systemPrompt: string;
      model: { modelId: string };
      credentialIds: string[];
    };

    assert.ok(config.systemPrompt.includes('agent prompt'));
    assert.equal(config.model.modelId, 'test/model');
  });

  test('prepends the workspace prompt so org policy cannot be dropped', async () => {
    await store.workspaces.update(workspaceId, { systemPrompt: 'ORG POLICY' });
    const identity = await bridge.authenticate(token);
    const config = (await bridge.bootstrap(identity)) as { systemPrompt: string };

    assert.ok(config.systemPrompt.startsWith('ORG POLICY'));
    assert.ok(config.systemPrompt.includes('agent prompt'));
  });

  test('hands out credential references, never values', async () => {
    const credential = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'referenced',
      value: 'NEVER-IN-BOOTSTRAP',
    });
    const scoped = await sessions.create(context, { agentId, credentialIds: [credential.id] });
    bridge.bind('boot-token-xyz', scoped.id, newId('sandbox'));

    const identity = await bridge.authenticate('boot-token-xyz');
    const config = await bridge.bootstrap(identity);

    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes('NEVER-IN-BOOTSTRAP'), false);
    assert.ok(serialized.includes(credential.id), 'the reference is enough');
  });
});
