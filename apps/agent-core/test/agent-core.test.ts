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

import { InMemoryKeyProvider, newId, nullLogger } from '@ma/core';
import type { Model } from '@ma/contracts';
import { buildPlatform, type Platform } from '@ma/server';
import { buildCommandRuntime } from '../src/main.ts';

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
      rateLimit: { ip: { limit: 10_000, windowMs: 60_000 }, principal: { limit: 10_000, windowMs: 60_000 } },
      modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
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
        rateLimit: { ip: { limit: 10_000, windowMs: 60_000 }, principal: { limit: 10_000, windowMs: 60_000 } },
        modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
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

  test('agent-core serves /healthz — the path the k8s readiness probe hits', async () => {
    // The k8s driver points a readinessProbe at GET /healthz. If agent-core does
    // not answer it, pod.ready is permanently false: the pod never goes Ready,
    // health() reports it 'unreachable', and every lease hiccup reaps a live pod.
    // The k8s-driver test asserts the probe path is /healthz; this asserts the
    // core actually serves it, so the two cannot drift apart.
    const session = await eventually(
      () => platform.store.sessions.get(sessionId),
      (value) => value?.status === 'ready' || value?.status === 'failed',
    );
    assert.equal(session?.status, 'ready', `session ended ${session?.status}`);
    const sandbox = await platform.store.sandboxes.get(session!.sandboxId!);
    assert.ok(sandbox?.endpoint, 'a ready sandbox has an endpoint');

    const response = await fetch(`${sandbox!.endpoint}/healthz`);
    assert.equal(response.status, 200, 'the readiness probe path must return 200');
    const body = (await response.json()) as { status?: string };
    assert.equal(body.status, 'ok');
  });

  test('/submit and /rebind reject an unauthenticated caller', async () => {
    // Binding all interfaces (container/k8s) makes these endpoints reachable by
    // co-located sandboxes and cluster pods. They act on the session, so
    // reachability must not equal control — a caller without the runtime-token
    // hash gets 401, never a turn. Otherwise a peer pod could inject a prompt
    // that runs with this session's tools, credentials and identity.
    const session = await eventually(
      () => platform.store.sessions.get(sessionId),
      (value) => value?.status === 'ready' || value?.status === 'failed',
    );
    assert.equal(session?.status, 'ready', `session ended ${session?.status}`);
    const sandbox = await platform.store.sandboxes.get(session!.sandboxId!);
    const endpoint = sandbox!.endpoint;

    // No credential at all.
    const noAuth = await fetch(`${endpoint}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ text: 'injected' }] }),
    });
    assert.equal(noAuth.status, 401, '/submit without a credential must be refused');
    await noAuth.text();

    // A wrong credential (a plausible-looking but incorrect token).
    const wrongAuth = await fetch(`${endpoint}/rebind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-hash' },
      body: JSON.stringify({ sessionId: session!.id }),
    });
    assert.equal(wrongAuth.status, 401, '/rebind with a wrong credential must be refused');
    await wrongAuth.text();

    // The correct credential is the runtime-token hash, which the control plane
    // holds on the sandbox record. With it, the call authenticates — it passes
    // the auth gate and is handled on its merits. Use an empty-prompt body so it
    // stops at the 400 "no prompt" check rather than starting a real turn that
    // would leave this shared session busy for the following tests; the point is
    // only that it is NOT rejected as 401.
    const goodAuth = await fetch(`${endpoint}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sandbox!.runtimeTokenHash}`,
      },
      body: JSON.stringify({ events: [] }),
    });
    assert.notEqual(goodAuth.status, 401, 'the correct runtime-token hash must authenticate');
    assert.equal(goodAuth.status, 400, 'an authenticated empty submit is a 400, not a started turn');
    await goodAuth.text();
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

describe('sequential sandbox reuse', () => {
  test('a second session reuses the warm sandbox, rebinds, and keeps contexts separate', async () => {
    // The whole rebind-capable-core feature, end to end against the real local
    // driver: one agent-core process serves two sessions in turn, and the second
    // must start with a clean context and have its work attributed to itself —
    // never leak the first session's conversation or file its events under the
    // first. This is the reuse outage bug's inverse, proven live.
    const workspace = await platform.services.workspaces.create(auth, {
      name: 'Reuse',
      slug: 'sequential-reuse',
    });
    const agent = await platform.services.agents.create(auth, {
      workspaceId: workspace.id,
      name: 'Warm',
      // Opt in to reuse; same pool key across both sessions (same spec + no creds).
      spec: {
        systemPrompt: 'You echo.',
        model: { modelId: stubModel.id },
        sandbox: { allowReuse: true },
      },
    });

    // Session 1: run a turn, then terminate so its sandbox is kept warm.
    const first = await platform.services.sessions.create(auth, { agentId: agent.id });
    await eventually(
      () => platform.store.sessions.get(first.id),
      (value) => value?.status === 'ready' || value?.status === 'failed',
    );
    await platform.services.sessions.submit(auth, first.id, {
      events: [{ type: 'user.message', text: 'first conversation secret' }],
    });
    await eventually(
      () => platform.store.events.read(first.id, {}),
      (all) => all.some((event) => event.type === 'turn.completed'),
    );
    const firstSandboxId = (await platform.store.sessions.get(first.id))?.sandboxId;
    assert.ok(firstSandboxId, 'the first session held a sandbox');

    await platform.services.sessions.terminate(auth, first.id, 'done');

    // Session 2: same pool key. It should claim the warm sandbox and rebind it.
    const second = await platform.services.sessions.create(auth, { agentId: agent.id });
    const ready = await eventually(
      () => platform.store.sessions.get(second.id),
      (value) => value?.status === 'ready' || value?.status === 'failed',
    );
    assert.equal(ready?.status, 'ready', `second session failed: ${JSON.stringify(ready?.error)}`);
    assert.equal(
      ready?.sandboxId,
      firstSandboxId,
      'the second session reused the first session’s warm sandbox',
    );

    // Run a turn on session 2 and confirm it completes, attributed to session 2.
    await platform.services.sessions.submit(auth, second.id, {
      events: [{ type: 'user.message', text: 'second conversation' }],
    });
    const secondEvents = await eventually(
      () => platform.store.events.read(second.id, {}),
      (all) => all.some((event) => event.type === 'turn.completed'),
    );
    assert.ok(
      secondEvents.some((event) => event.type === 'turn.completed'),
      'the reused sandbox ran the second session’s turn',
    );

    // The leak check: the model echoes the messages it is shown. If the first
    // session's context had leaked across the rebind, the echo would carry the
    // first conversation's text. It must only reflect the second.
    const echoed = secondEvents.find(
      (event) =>
        event.type === 'message.completed' &&
        String((event.payload as { text?: string }).text ?? '').startsWith('echo:'),
    );
    const echoText = String((echoed?.payload as { text?: string })?.text ?? '');
    assert.ok(echoText.length > 0, 'the second session produced an answer');
    assert.ok(
      !echoText.includes('first conversation secret'),
      `the first session's context leaked into the second: ${echoText}`,
    );

    // Attribution: the second session's turn events are on its own log, and the
    // terminated first session received nothing new after it ended.
    const firstAfter = await platform.store.events.read(first.id, {});
    const firstTurnCount = firstAfter.filter((event) => event.type === 'turn.completed').length;
    assert.equal(firstTurnCount, 1, 'the first session has only its own single completed turn');
  });
});

describe('prewarming', () => {
  test('a used pool is kept warm and the next session boots into it', async () => {
    // Reactive prewarm: after a session in an allowReuse pool releases, the pool
    // is topped up to prewarmPerPool, and a prewarmed sandbox boots idle
    // (session-less) against a synthetic holder — the case that failed with
    // `notFound('Session')` before agent-core learned to boot unbound.
    const prewarmPlatform = buildPlatform({
      config: {
        host: '127.0.0.1',
        port: 8231,
        databaseUrl: ':memory:',
        logLevel: 'error',
        controlPlaneUrl: 'http://127.0.0.1:8231',
        corsOrigins: [],
        encryptionKeys: InMemoryKeyProvider.generate(),
        sandbox: { driver: 'local', leaseSeconds: 120, prewarmPerPool: 1 },
        scheduler: { enabled: true, tickMs: 300, batchSize: 10, auditRetentionDays: 0 },
        rateLimit: { ip: { limit: 10_000, windowMs: 60_000 }, principal: { limit: 10_000, windowMs: 60_000 } },
        modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
        trustForwardedFor: false,
        artifacts: { root: ':memory:', maxMb: 25, retentionDays: 0 },
      },
      models: stubProvider,
      modelCatalogue: [stubModel],
    });
    await prewarmPlatform.start();
    try {
      const principal = await prewarmPlatform.store.principals.create({
        id: newId('principal'), type: 'user', subject: 'prewarm', displayName: 'PW', email: '',
        isAdmin: true, disabled: false, metadata: {}, createdAt: 1, updatedAt: 1, createdBy: 'system',
      });
      const pwAuth = { principal } as never;
      const workspace = await prewarmPlatform.services.workspaces.create(pwAuth, {
        name: 'PW', slug: 'prewarm',
      });
      const agent = await prewarmPlatform.services.agents.create(pwAuth, {
        workspaceId: workspace.id,
        name: 'Warm',
        spec: { systemPrompt: 'You echo.', model: { modelId: stubModel.id }, sandbox: { allowReuse: true } },
      });

      // First session establishes the pool, then terminates → reactive prewarm.
      const first = await prewarmPlatform.services.sessions.create(pwAuth, { agentId: agent.id });
      await eventually(
        () => prewarmPlatform.store.sessions.get(first.id),
        (value) => value?.status === 'ready' || value?.status === 'failed',
      );
      await prewarmPlatform.services.sessions.terminate(pwAuth, first.id, 'done');

      // A warm holderless sandbox should appear for the pool (either the kept-warm
      // released one or a freshly prewarmed one), booted and ready.
      const warm = await eventually(
        () => prewarmPlatform.store.sandboxes.list({ workspaceId: workspace.id, statuses: ['ready'] }),
        (page) => page.items.some((s) => s.sessionIds.length === 0 && s.idleSince !== undefined),
      );
      assert.ok(
        warm.items.some((s) => s.sessionIds.length === 0),
        'a warm holderless sandbox is available for reuse',
      );

      // A second session reuses a warm sandbox and runs a turn correctly.
      const second = await prewarmPlatform.services.sessions.create(pwAuth, { agentId: agent.id });
      const ready = await eventually(
        () => prewarmPlatform.store.sessions.get(second.id),
        (value) => value?.status === 'ready' || value?.status === 'failed',
      );
      assert.equal(ready?.status, 'ready', `second session failed: ${JSON.stringify(ready?.error)}`);
      await prewarmPlatform.services.sessions.submit(pwAuth, second.id, {
        events: [{ type: 'user.message', text: 'hi warm' }],
      });
      const events = await eventually(
        () => prewarmPlatform.store.events.read(second.id, {}),
        (all) => all.some((event) => event.type === 'turn.completed'),
      );
      assert.ok(
        events.some((event) => event.type === 'turn.completed'),
        'the reused/prewarmed sandbox ran the second session’s turn',
      );
    } finally {
      await prewarmPlatform.stop();
    }
  });
});

describe('command runtime', () => {
  test('a non-built-in runtime drives a turn entirely over the bridge protocol', async () => {
    // The multi-runtime property: an agent version can declare a command runtime,
    // and the sandbox runs that process instead of the built-in harness. The
    // child speaks only the public /runtime/v1/* protocol — it fetches its model
    // from /bootstrap, calls /completions, and posts its own turn/message events.
    // The reference runtime in examples/runtimes/echo-runtime.mjs is the fixture.
    const { fileURLToPath } = await import('node:url');
    const { join, dirname } = await import('node:path');
    const runtimePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'examples',
      'runtimes',
      'echo-runtime.mjs',
    );

    const cmdPlatform = buildPlatform({
      config: {
        host: '127.0.0.1',
        port: 8241,
        databaseUrl: ':memory:',
        logLevel: 'error',
        controlPlaneUrl: 'http://127.0.0.1:8241',
        corsOrigins: [],
        encryptionKeys: InMemoryKeyProvider.generate(),
        sandbox: { driver: 'local', leaseSeconds: 120, prewarmPerPool: 0 },
        scheduler: { enabled: true, tickMs: 300, batchSize: 10, auditRetentionDays: 0 },
        rateLimit: { ip: { limit: 10_000, windowMs: 60_000 }, principal: { limit: 10_000, windowMs: 60_000 } },
        modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
        trustForwardedFor: false,
        artifacts: { root: ':memory:', maxMb: 25, retentionDays: 0 },
      },
      models: stubProvider,
      modelCatalogue: [stubModel],
    });
    await cmdPlatform.start();
    try {
      const principal = await cmdPlatform.store.principals.create({
        id: newId('principal'), type: 'user', subject: 'cmd', displayName: 'Cmd', email: '',
        isAdmin: true, disabled: false, metadata: {}, createdAt: 1, updatedAt: 1, createdBy: 'system',
      });
      const cmdAuth = { principal } as never;
      const workspace = await cmdPlatform.services.workspaces.create(cmdAuth, {
        name: 'Cmd', slug: 'command-runtime',
      });
      const agent = await cmdPlatform.services.agents.create(cmdAuth, {
        workspaceId: workspace.id,
        name: 'Custom',
        spec: {
          systemPrompt: 'You echo.',
          model: { modelId: stubModel.id },
          runtime: { type: 'command', command: process.execPath, args: [runtimePath] },
        },
      });
      const session = await cmdPlatform.services.sessions.create(cmdAuth, { agentId: agent.id });
      const ready = await eventually(
        () => cmdPlatform.store.sessions.get(session.id),
        (value) => value?.status === 'ready' || value?.status === 'failed',
      );
      assert.equal(ready?.status, 'ready', `session failed: ${JSON.stringify(ready?.error)}`);

      await cmdPlatform.services.sessions.submit(cmdAuth, session.id, {
        events: [{ type: 'user.message', text: 'over the bridge' }],
      });

      const events = await eventually(
        () => cmdPlatform.store.events.read(session.id, {}),
        (all) => all.some((event) => event.type === 'turn.completed'),
      );
      const types = events.map((event) => event.type);
      // Every one of these was emitted by the child process through /events —
      // proving a foreign runtime can drive a full turn on the public protocol.
      assert.ok(types.includes('turn.started'), `child never started a turn: ${types.join(', ')}`);
      assert.ok(types.includes('turn.completed'), `child never completed a turn: ${types.join(', ')}`);
      const answered = events.some(
        (event) =>
          event.type === 'message.completed' &&
          String((event.payload as { text?: string }).text ?? '').startsWith('echo:'),
      );
      assert.ok(answered, 'the model reply the child fetched via /completions reached the log');
      // Distinguishes the command runtime from the built-in harness: the harness
      // emits `model.requested` on every model call, the echo runtime does not.
      // Its absence proves the built-in loop did not run this turn — the child did.
      assert.ok(
        !types.includes('model.requested'),
        'the built-in harness ran instead of the command runtime',
      );
    } finally {
      await cmdPlatform.stop();
    }
  });

  test('a hung command-runtime turn is killed at its deadline, not left running forever', async () => {
    // Without a deadline, a command runtime whose process hangs (an infinite
    // loop, a stuck read, a wait on input that never comes) leaves runTurn
    // unresolved forever — the session stays `running` and its sandbox is
    // occupied until the lease reaper. The turn deadline (boot.turnTimeoutSeconds)
    // must SIGKILL the process and resolve the turn.
    const boot = {
      sessionId: 'sn_hang',
      systemPrompt: '',
      model: { modelId: 'test/model', fallbackModelIds: [] },
      tools: { mode: 'strict', allow: [], deny: [], allowedCommands: [], deniedCommands: [] },
      context: { compactThresholdTokens: 100_000, compactTargetTokens: 40_000, keepRecentTurns: 3, snapshotEveryTurns: 0 },
      // A process that never exits on its own.
      runtime: { type: 'command', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      subAgents: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      maxTurnsPerSession: 100,
      turnTimeoutSeconds: 1,
      setupCommands: [],
      fileCredentials: [],
      datasetIds: [],
    };
    const config = {
      host: '127.0.0.1',
      port: 0,
      workspaceId: 'ws_hang',
      controlPlaneUrl: 'http://127.0.0.1:1',
      token: 'tok',
    };

    const runtime = await buildCommandRuntime(boot as never, config as never, nullLogger);
    try {
      const started = Date.now();
      // If the deadline is not enforced this never resolves and the test times out.
      await runtime.runTurn('do something that hangs');
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 10_000, `the turn must end near its 1s deadline, took ${elapsed}ms`);
      assert.equal(runtime.running, false, 'the session must not be left running after a killed turn');
    } finally {
      await runtime.close();
    }
  });
});
