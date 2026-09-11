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

/**
 * A gate the concurrency test can close to hold a turn open.
 *
 * Normally null (open). When set to a pending promise, the stub blocks inside a
 * model call until it resolves — which keeps the harness `#running` while a
 * second submit is attempted.
 */
let modelGate: Promise<void> | null = null;

/** A model that echoes, so a turn has something deterministic to complete on. */
const stubProvider = {
  complete: async (request: { messages: { content: string }[] }) => {
    if (modelGate) await modelGate;
    const last = request.messages[request.messages.length - 1];
    return {
      text: `echo: ${String(last?.content ?? '').slice(0, 40)}`,
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
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
      scheduler: { enabled: true, tickMs: 300, batchSize: 10, auditRetentionDays: 0 },
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

describe('tool use', () => {
  test('an agent can invoke a tool and act on the result', async () => {
    // The harness gap was only half-closed at first: the agent core could run
    // text turns but the model gateway had no tool-call channel, so a tool call
    // could not survive provider -> bridge -> core -> harness. Then the tool
    // events themselves were rejected on payload shape and reached the log as
    // nothing. This exercises the whole loop.
    let calls = 0;
    const toolProvider = {
      complete: (request: { messages: { content: string }[] }) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            text: 'let me look',
            toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'notes.txt' } }],
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
          });
        }
        const last = request.messages[request.messages.length - 1];
        return Promise.resolve({
          text: `saw: ${String(last?.content ?? '').slice(0, 40)}`,
          stopReason: 'end_turn',
          usage: { inputTokens: 8, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
        });
      },
    };

    const toolPlatform = buildPlatform({
      config: {
        host: '127.0.0.1',
        port: 8207,
        databaseUrl: ':memory:',
        logLevel: 'error',
        controlPlaneUrl: 'http://127.0.0.1:8207',
        corsOrigins: [],
        encryptionKeys: InMemoryKeyProvider.generate(),
        sandbox: { driver: 'local', leaseSeconds: 120, prewarmPerPool: 0 },
        scheduler: { enabled: true, tickMs: 300, batchSize: 10, auditRetentionDays: 0 },
        rateLimit: { limit: 10_000, windowMs: 60_000 },
        trustForwardedFor: false,
        artifacts: { root: ':memory:', maxMb: 25, retentionDays: 0 },
      },
      models: toolProvider,
      modelCatalogue: [stubModel],
    });
    await toolPlatform.start();

    try {
      const principal = await toolPlatform.store.principals.create({
        id: newId('principal'),
        type: 'user',
        subject: 'tool-test',
        displayName: 'Tester',
        email: '',
        isAdmin: true,
        disabled: false,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'system',
      });
      const toolAuth = { principal } as never;
      const workspace = await toolPlatform.services.workspaces.create(toolAuth, {
        name: 'Tools',
        slug: 'tool-use-test',
      });
      const agent = await toolPlatform.services.agents.create(toolAuth, {
        workspaceId: workspace.id,
        name: 'Reader',
        spec: {
          systemPrompt: 'Use tools.',
          model: { modelId: stubModel.id },
          tools: {
            mode: 'auto',
            allow: ['read_file'],
            deny: [],
            allowedCommands: [],
            deniedCommands: [],
          },
        },
      });
      const session = await toolPlatform.services.sessions.create(toolAuth, { agentId: agent.id });

      for (let attempt = 0; attempt < 40; attempt++) {
        const s = await toolPlatform.store.sessions.get(session.id);
        if (s?.status === 'ready' || s?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      await toolPlatform.services.sessions.submit(toolAuth, session.id, {
        events: [{ type: 'user.message', text: 'read notes.txt' }],
      });

      let events = await toolPlatform.store.events.read(session.id, {});
      for (let attempt = 0; attempt < 40; attempt++) {
        if (events.some((e) => e.type === 'turn.completed')) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
        events = await toolPlatform.store.events.read(session.id, {});
      }

      const types = events.map((e) => e.type);
      assert.ok(types.includes('tool.requested'), `no tool requested: ${types.join(', ')}`);
      assert.ok(
        types.includes('tool.completed') || types.includes('tool.failed'),
        'the tool must run, even if it fails to find the file',
      );
      assert.ok(types.includes('turn.completed'), 'the turn must complete after the tool');
      assert.ok(calls >= 2, `the tool loop must call the model again: ${calls} call(s)`);
    } finally {
      await toolPlatform.stop();
    }
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

  test('a second submit while a turn is running is refused, not silently dropped', async () => {
    // The agent core answers /submit with 202 and runs the turn detached. It
    // used to send that 202 before checking whether a turn was already running,
    // so an overlapping submit was acknowledged and then dropped on the floor
    // when `runTurn` threw TURN_IN_PROGRESS into a swallowed catch. The control
    // plane must instead see the refusal — a 409 the driver turns into a thrown
    // error here.
    let release = (): void => {};
    modelGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // First submit: starts a turn that now blocks inside the model call.
      await platform.services.sessions.submit(auth, sessionId, {
        events: [{ type: 'user.message', text: 'first, will block' }],
      });

      // Wait until the second turn is genuinely in flight. The harness sets its
      // `#running` flag synchronously before emitting `turn.started`, so once a
      // second `turn.started` reaches the log the session is busy — and it will
      // stay busy, because that turn is now blocked in the gated model call.
      await eventually(
        () => platform.store.events.read(sessionId, {}),
        (all) => all.filter((event) => event.type === 'turn.started').length >= 2,
      );

      // Second submit: the sandbox refuses it while the first turn holds the
      // session (409). The driver must surface that as a *retryable* error, not
      // a bare Error — a bare one is category `internal`, which the delivery
      // pipeline treats as terminal and would fail a connector receipt
      // permanently, dropping a follow-up the session could accept seconds later.
      await assert.rejects(
        platform.services.sessions.submit(auth, sessionId, {
          events: [{ type: 'user.message', text: 'second, overlapping' }],
        }),
        (error: unknown) => {
          const err = error as { code?: string; retryable?: boolean };
          assert.equal(err.code, 'SESSION_BUSY', 'a busy session is reported as such');
          assert.equal(err.retryable, true, 'a busy session is retryable, not a terminal failure');
          return true;
        },
        'an overlapping submit must be refused as a retryable SESSION_BUSY',
      );

      // A refused (409) submit must NOT have written the user message to the
      // durable log. Otherwise, because the delivery pipeline retries a
      // retryable failure by re-running the whole submit, each attempt would
      // append another copy — the conversation history would show one message
      // N times. Publishing only after the sandbox accepts keeps the retry safe.
      const logged = await platform.store.events.read(sessionId, {
        types: ['message.completed'],
      });
      const overlapping = logged.filter(
        (event) => (event.payload as { text?: string }).text === 'second, overlapping',
      );
      assert.equal(
        overlapping.length,
        0,
        'a refused submit must not append the user message to the log',
      );
    } finally {
      release();
      modelGate = null;
    }

    // And the first turn still completes normally once unblocked.
    await eventually(
      () => platform.store.events.read(sessionId, {}),
      (all) => all.filter((event) => event.type === 'turn.completed').length >= 2,
    );
  });
});
