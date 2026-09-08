/**
 * Agent core tests.
 *
 * The property under test is the one that was missing for most of this
 * project's life: a session created through the API runs an actual agent turn
 * in an actual sandbox, and its events reach the log.
 *
 * `AgentHarness` was built, thoroughly unit-tested, and had no production
 * caller — nothing started a process that used it. Every test below therefore
 * drives the real platform rather than constructing a harness directly, because
 * constructing one directly is exactly what hid the gap.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, newId } from '@ma/core';
import type { Model } from '@ma/contracts';
import { buildPlatform, type Platform } from '@ma/server';

const PORT = 8189;

/** A model that echoes, so a turn has something deterministic to complete on. */
const stubProvider = {
  complete: (request: { messages: { content: string }[] }) => {
    const last = request.messages[request.messages.length - 1];
    return Promise.resolve({
      text: `echo: ${String(last?.content ?? '').slice(0, 40)}`,
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  },
};

const stubModel: Model = {
  id: 'stub/echo',
  provider: 'stub',
  model: 'echo',
  displayName: 'Echo',
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
};

let platform: Platform;
let auth: never;
let sessionId: string;

before(async () => {
  platform = buildPlatform({
    config: {
      host: '127.0.0.1',
      port: PORT,
      databaseUrl: ':memory:',
      logLevel: 'error',
      controlPlaneUrl: `http://127.0.0.1:${PORT}`,
      corsOrigins: [],
      encryptionKeys: InMemoryKeyProvider.generate(),
      sandbox: { driver: 'local', leaseSeconds: 120, prewarmPerPool: 0 },
      scheduler: { enabled: true, tickMs: 300, batchSize: 10 },
      rateLimit: { limit: 10_000, windowMs: 60_000 },
      trustForwardedFor: false,
      artifacts: { root: ':memory:', maxMb: 25, retentionDays: 0 },
    },
    models: stubProvider,
    modelCatalogue: [stubModel],
  });

  await platform.start();

  const principal = await platform.store.principals.create({
    id: newId('principal'),
    type: 'user',
    subject: 'core-test',
    displayName: 'Tester',
    email: '',
    isAdmin: true,
    disabled: false,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'system',
  });
  auth = { principal } as never;

  const workspace = await platform.services.workspaces.create(auth, {
    name: 'Core',
    slug: 'agent-core-test',
  });
  const agent = await platform.services.agents.create(auth, {
    workspaceId: workspace.id,
    name: 'Echo',
    spec: { systemPrompt: 'You echo.', model: { modelId: stubModel.id } },
  });
  const session = await platform.services.sessions.create(auth, { agentId: agent.id });
  sessionId = session.id;
});

after(async () => {
  await platform.stop();
});

/** Poll until `predicate` holds, or give up. Sandboxes start asynchronously. */
async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  attempts = 40,
): Promise<T> {
  let last = await read();
  for (let index = 0; index < attempts; index++) {
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await read();
  }
  return last;
}

describe('setup commands', () => {
  test('run before the first turn, in the sandbox', async () => {
    // `setupCommands` was typed, validated, used as pool-key material — and
    // executed by nothing. An agent that declared `npm ci` started work without
    // its dependencies and failed later, confusingly.
    const workspace = await platform.services.workspaces.create(auth, {
      name: 'Setup',
      slug: 'setup-commands',
    });
    const agent = await platform.services.agents.create(auth, {
      workspaceId: workspace.id,
      name: 'Prepared',
      spec: {
        systemPrompt: 'x',
        model: { modelId: stubModel.id },
        sandbox: {
          setupCommands: [
            { name: 'marker', command: 'echo prepared > setup-ran.txt', timeoutSeconds: 30 },
          ],
        },
      },
    });
    const session = await platform.services.sessions.create(auth, { agentId: agent.id });

    const ready = await eventually(
      () => platform.store.sessions.get(session.id),
      (value) => value?.status === 'ready' || value?.status === 'failed',
    );
    assert.equal(ready?.status, 'ready', `setup failed the session: ${JSON.stringify(ready?.error)}`);
  });

  test('a failing required command fails the session', async () => {
    // The schema promises this: a half-provisioned environment is worse than a
    // clear failure, because the agent runs and produces wrong work.
    const workspace = await platform.services.workspaces.create(auth, {
      name: 'Broken',
      slug: 'setup-broken',
    });
    const agent = await platform.services.agents.create(auth, {
      workspaceId: workspace.id,
      name: 'Doomed',
      spec: {
        systemPrompt: 'x',
        model: { modelId: stubModel.id },
        sandbox: {
          setupCommands: [{ name: 'doomed', command: 'exit 3', timeoutSeconds: 30 }],
        },
      },
    });
    const session = await platform.services.sessions.create(auth, { agentId: agent.id });

    const settled = await eventually(
      () => platform.store.sessions.get(session.id),
      (value) => value?.status === 'ready' || value?.status === 'failed',
    );
    assert.equal(settled?.status, 'failed', 'a required setup failure must fail the session');
  });

  test('an optional command that fails does not', async () => {
    const workspace = await platform.services.workspaces.create(auth, {
      name: 'Optional',
      slug: 'setup-optional',
    });
    const agent = await platform.services.agents.create(auth, {
      workspaceId: workspace.id,
      name: 'Tolerant',
      spec: {
        systemPrompt: 'x',
        model: { modelId: stubModel.id },
        sandbox: {
          setupCommands: [
            { name: 'best effort', command: 'exit 1', timeoutSeconds: 30, optional: true },
          ],
        },
      },
    });
    const session = await platform.services.sessions.create(auth, { agentId: agent.id });

    const ready = await eventually(
      () => platform.store.sessions.get(session.id),
      (value) => value?.status === 'ready' || value?.status === 'failed',
    );
    assert.equal(ready?.status, 'ready', 'an optional failure must not fail the session');
  });
});

describe('an agent turn, end to end', () => {
  test('a queued session provisions and reaches ready', async () => {
    const session = await eventually(
      () => platform.store.sessions.get(sessionId),
      (value) => value?.status === 'ready' || value?.status === 'failed',
    );
    assert.equal(session?.status, 'ready', `session ended ${session?.status}: ${JSON.stringify(session?.error)}`);
    assert.ok(session?.sandboxId, 'a ready session holds a sandbox');
  });

  test('a submitted prompt runs a turn and completes it', async () => {
    // The whole point. Before the agent core existed, this produced a
    // `message.completed` for the prompt and nothing else, forever: the sandbox
    // ran a bare `node` that never fetched its configuration.
    await platform.services.sessions.submit(auth, sessionId, {
      events: [{ type: 'user.message', text: 'hello agent' }],
    });

    const events = await eventually(
      () => platform.store.events.read(sessionId, {}),
      (all) => all.some((event) => event.type === 'turn.completed'),
    );
    const types = events.map((event) => event.type);

    assert.ok(types.includes('turn.started'), `no turn started: ${types.join(', ')}`);
    assert.ok(types.includes('model.requested'), 'the turn must call a model');
    assert.ok(types.includes('turn.completed'), `turn never completed: ${types.join(', ')}`);

    // And the agent's answer is on the log, not just its lifecycle.
    const answered = events.some(
      (event) =>
        event.type === 'message.completed' &&
        String((event.payload as { text?: string }).text ?? '').startsWith('echo:'),
    );
    assert.ok(answered, 'the model’s reply must reach the event log');
  });

  test('the turn’s tokens are billed exactly once', async () => {
    // Two paths record usage — the gateway on each completion, and
    // `turn.completed` for a sandbox holding its own model client. Both firing
    // for one call bills a workspace twice and exhausts its daily budget at
    // half the real spend.
    const session = await platform.store.sessions.get(sessionId);
    assert.equal(session?.usage.inputTokens, 12, 'the stub reports 12 input tokens for one call');
    assert.equal(session?.usage.outputTokens, 8);
  });
});
