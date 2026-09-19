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

import { InMemoryKeyProvider, newId, nullLogger, systemClock } from '@ma/core';
import type { Model } from '@ma/contracts';
import { buildPlatform, type Platform } from '@ma/server';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommandRuntime, ControlPlane, SessionSlot, materializeCredentialEnv, runSetupCommands, type Runtime } from '../src/main.ts';

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

  test('a request body destroyed mid-stream does not crash the agent-core process', async () => {
    // /submit and /rebind consume the request body as a stream, which can error
    // mid-read on an ordinary network fault (ECONNRESET, client abort). An
    // unlistened 'error' on the request emitter (submit) or a rejected async
    // iterator (rebind) would otherwise crash the whole single-session process.
    // Simulate it with a raw socket: declare a large Content-Length, send only a
    // few bytes, then destroy the socket. The server must survive — a subsequent
    // /healthz still answers 200.
    const { connect } = await import('node:net');
    const session = await eventually(
      () => platform.store.sessions.get(sessionId),
      (value) => value?.status === 'ready' || value?.status === 'failed',
    );
    const sandbox = await platform.store.sandboxes.get(session!.sandboxId!);
    const url = new URL(sandbox!.endpoint);
    const auth = `Bearer ${sandbox!.runtimeTokenHash}`;

    for (const path of ['/submit', '/rebind']) {
      await new Promise<void>((resolve) => {
        const socket = connect(Number(url.port), url.hostname, () => {
          // Content-Length says 10000, but we send far less, then destroy — the
          // server's body read never completes and the connection drops under it.
          socket.write(
            `POST ${path} HTTP/1.1\r\nHost: ${url.host}\r\nauthorization: ${auth}\r\n` +
              `content-type: application/json\r\ncontent-length: 10000\r\n\r\n{"events":[`,
          );
          setTimeout(() => { socket.destroy(); resolve(); }, 20);
        });
        socket.on('error', () => resolve()); // a reset on our side is fine
      });
    }

    // The process is still alive and serving: the readiness beacon answers.
    const health = await fetch(`${sandbox!.endpoint}/healthz`);
    assert.equal(health.status, 200, 'agent-core survived the aborted request bodies');
    await health.text();
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

    const runtime = await buildCommandRuntime(
      boot as never,
      config as never,
      nullLogger,
      new ControlPlane(config as never, nullLogger),
    );
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

  test('a command-runtime turn that dies posts turn.failed so the record is not left open', async () => {
    // A killed or crashed child cannot post its own terminal event, so the parent
    // must — otherwise the control-plane turn stays open (turn.started with no
    // matching terminal) and the session sits `running`, holding its sandbox,
    // until the lease reaper. Capture what the runtime POSTs to /runtime/v1/events
    // with a stub control plane, and drive a non-zero exit.
    const { createServer } = await import('node:http');
    const posted: { type: string; turn?: number }[] = [];
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/events') && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { events?: { type: string; turn?: number }[] };
            for (const e of parsed.events ?? []) posted.push(e);
          } catch {
            /* ignore */
          }
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const boot = {
      sessionId: 'sn_die',
      systemPrompt: '',
      model: { modelId: 'test/model', fallbackModelIds: [] },
      tools: { mode: 'strict', allow: [], deny: [], allowedCommands: [], deniedCommands: [] },
      context: { compactThresholdTokens: 100_000, compactTargetTokens: 40_000, keepRecentTurns: 3, snapshotEveryTurns: 0 },
      // Exits non-zero immediately without posting any events of its own.
      runtime: { type: 'command', command: process.execPath, args: ['-e', 'process.exit(7)'] },
      subAgents: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      maxTurnsPerSession: 100,
      turnTimeoutSeconds: 30,
      setupCommands: [],
      fileCredentials: [],
      datasetIds: [],
    };
    const config = {
      host: '127.0.0.1',
      port: 0,
      workspaceId: 'ws_die',
      controlPlaneUrl: `http://127.0.0.1:${port}`,
      token: 'tok',
    };

    const runtime = await buildCommandRuntime(
      boot as never,
      config as never,
      nullLogger,
      new ControlPlane(config as never, nullLogger),
    );
    try {
      await runtime.runTurn('do something that crashes');
      // Give the fire-and-forget POST a moment to land.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        posted.some((e) => e.type === 'turn.failed'),
        `a crashed turn must post turn.failed; got: ${posted.map((e) => e.type).join(', ')}`,
      );
      assert.equal(runtime.running, false, 'the session is no longer running');
    } finally {
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a command runtime that exits without reading a large prompt does not crash on EPIPE', async () => {
    // The child is spawned with a piped stdin and the prompt is written with
    // stdin.end(prompt). If the child exits before reading, the write raises EPIPE
    // as an 'error' event on the stdin STREAM — a separate emitter from the child
    // process, whose own 'error' listener only covers spawn failure. An unhandled
    // stream 'error' throws and crashes the whole agent-core process (every session
    // on it), not just the turn. A prompt larger than the OS pipe buffer (~64KB)
    // guarantees the write cannot be absorbed before the immediate exit, so the
    // EPIPE actually fires. The turn must still resolve cleanly (via the child's
    // close), and — critically — the process must survive.
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/events') && req.method === 'POST') {
        req.on('data', () => {});
        req.on('end', () => res.writeHead(204).end());
        return;
      }
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const boot = {
      sessionId: 'sn_epipe',
      systemPrompt: '',
      model: { modelId: 'test/model', fallbackModelIds: [] },
      tools: { mode: 'strict', allow: [], deny: [], allowedCommands: [], deniedCommands: [] },
      context: { compactThresholdTokens: 100_000, compactTargetTokens: 40_000, keepRecentTurns: 3, snapshotEveryTurns: 0 },
      // Exits immediately WITHOUT reading stdin — so a large write to its stdin
      // pipe has nowhere to go and raises EPIPE on the stream.
      runtime: { type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      subAgents: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      maxTurnsPerSession: 100,
      turnTimeoutSeconds: 30,
      setupCommands: [],
      fileCredentials: [],
      datasetIds: [],
    };
    const config = {
      host: '127.0.0.1',
      port: 0,
      workspaceId: 'ws_epipe',
      controlPlaneUrl: `http://127.0.0.1:${port}`,
      token: 'tok',
    };

    const runtime = await buildCommandRuntime(
      boot as never,
      config as never,
      nullLogger,
      new ControlPlane(config as never, nullLogger),
    );
    try {
      // A prompt well past the pipe buffer so the write cannot complete before exit.
      const hugePrompt = 'x'.repeat(1_000_000);
      // If stdin's EPIPE were unhandled this would crash the process rather than
      // resolve. The turn resolving at all is the assertion.
      await runtime.runTurn(hugePrompt);
      assert.equal(runtime.running, false, 'the session is not left running after the turn');
    } finally {
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a command runtime materializes non-file credentials for its setup commands', async () => {
    // The sibling of the built-in rebind-env fix: a prewarmed command-runtime
    // sandbox boots with an empty process.env, so its setup commands must receive
    // the agent's env_vars/MA_CRED_* materialized here — not silently run without
    // them. A required setup step that reads MA_CRED_FOO proves it: it succeeds
    // only if the credential was materialized and threaded. A stub control plane
    // answers the credential exchange.
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.url?.includes('/credentials/') && req.method === 'POST') {
        // The exchange endpoint returns the plaintext value.
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: 'the-secret' }));
        return;
      }
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const boot = {
      sessionId: 'sn_cred',
      systemPrompt: '',
      model: { modelId: 'test/model', fallbackModelIds: [] },
      tools: { mode: 'strict', allow: [], deny: [], allowedCommands: [], deniedCommands: [] },
      context: { compactThresholdTokens: 100_000, compactTargetTokens: 40_000, keepRecentTurns: 3, snapshotEveryTurns: 0 },
      runtime: { type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      subAgents: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      maxTurnsPerSession: 100,
      turnTimeoutSeconds: 30,
      // The api_key credential 'apikey' materializes as MA_CRED_APIKEY; the setup
      // step fails unless it is present.
      setupCommands: [
        { name: 'needs-cred', command: '[ "$MA_CRED_APIKEY" = "the-secret" ]', timeoutSeconds: 30, optional: false },
      ],
      fileCredentials: [],
      envCredentials: [{ id: 'c_key', name: 'apikey', type: 'api_key' }],
      datasetIds: [],
    };
    const config = {
      host: '127.0.0.1',
      port: 0,
      workspaceId: 'ws_cred',
      controlPlaneUrl: `http://127.0.0.1:${port}`,
      token: 'tok',
    };

    // If the credential were not materialized and threaded, the required setup
    // command would exit non-zero and buildCommandRuntime would throw. The build
    // sits INSIDE the try so a throw still closes the stub server in finally —
    // otherwise a fail-first (or any regression) leaves the server open and the
    // test process hangs to timeout instead of failing cleanly.
    let runtime: Awaited<ReturnType<typeof buildCommandRuntime>> | undefined;
    try {
      runtime = await buildCommandRuntime(
        boot as never,
        config as never,
        nullLogger,
        new ControlPlane(config as never, nullLogger),
      );
      assert.ok(runtime, 'the command runtime built — its credential-dependent setup command passed');
    } finally {
      await runtime?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('buildCommandRuntime removes its temp workDir when a required setup command fails', async () => {
    // A required (non-optional) setup command that exits non-zero throws
    // SANDBOX_SETUP_FAILED. The temp workDir's teardown otherwise lives only in the
    // returned runtime's close(), which a throw never reaches — so a failed
    // prewarm/boot leaked an mkdtemp'd tree for the process lifetime. Count the
    // command-runtime temp dirs before and after; the failed build must add none.
    const { readdir } = await import('node:fs/promises');
    const countCmdDirs = async (): Promise<number> => {
      const entries = await readdir(tmpdir());
      return entries.filter((name) => name.startsWith('ma-agent-cmd-')).length;
    };
    const before = await countCmdDirs();

    const boot = {
      sessionId: 'sn_leak',
      systemPrompt: '',
      model: { modelId: 'test/model', fallbackModelIds: [] },
      tools: { mode: 'strict', allow: [], deny: [], allowedCommands: [], deniedCommands: [] },
      context: { compactThresholdTokens: 100_000, compactTargetTokens: 40_000, keepRecentTurns: 3, snapshotEveryTurns: 0 },
      runtime: { type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      subAgents: [], skills: [], plugins: [], mcpServers: [],
      maxTurnsPerSession: 100,
      turnTimeoutSeconds: 30,
      // A required setup command that fails, so the build throws before returning.
      setupCommands: [{ name: 'doomed', command: 'exit 3', timeoutSeconds: 30, optional: false }],
      fileCredentials: [],
      envCredentials: [],
      datasetIds: [],
    };
    const config = { host: '127.0.0.1', port: 0, workspaceId: 'ws_leak', controlPlaneUrl: 'http://127.0.0.1:1', token: 'tok' };

    await assert.rejects(
      buildCommandRuntime(boot as never, config as never, nullLogger, new ControlPlane(config as never, nullLogger)),
      'a required setup command that fails must throw',
    );
    const after = await countCmdDirs();
    assert.equal(after, before, 'the failed build left no temp workDir behind');
  });
});

describe('SessionSlot: no submit runs during a rebind teardown', () => {
  // A fake runtime whose `running` we control and whose close()/runTurn we record.
  function fakeRuntime(id: string): Runtime & { closed: boolean; turns: string[]; running: boolean } {
    return {
      sessionId: id,
      running: false,
      closed: false,
      turns: [] as string[],
      runTurn(prompt: string) {
        this.turns.push(prompt);
        return Promise.resolve();
      },
      interrupt() {},
      close() {
        this.closed = true;
        return Promise.resolve();
      },
    };
  }

  test('takeForSubmit refuses while rebinding, even though the old runtime is not running', () => {
    // The regression: the previous session's `running` stays false across the
    // teardown (close() interrupts but does not flip it), so a submit that reads
    // the runtime directly would pass the running guard and run a turn on a
    // session being destroyed. The slot must refuse for the whole window.
    const a = fakeRuntime('sn_a');
    const slot = new SessionSlot(a);

    // Bound and idle: a submit is allowed.
    const before = slot.takeForSubmit();
    assert.ok('runtime' in before && before.runtime === a, 'idle bound session accepts a submit');

    // Begin the rebind (as handleRebind does before awaiting close()).
    const previous = slot.beginRebind();
    assert.equal(previous, a, 'beginRebind hands back the previous runtime to tear down');
    assert.equal(a.running, false, 'the previous runtime is NOT running (close only interrupts)');

    // The window: a concurrent submit must be refused, not run on `a`.
    const during = slot.takeForSubmit();
    assert.ok('refuse' in during && during.refuse === 'unbound', 'a submit during rebind is refused');
    assert.ok(slot.rebinding, 'the slot reports it is rebinding');

    // After the new session is installed, submits resume — on the new runtime.
    const b = fakeRuntime('sn_b');
    slot.finishRebind(b);
    const after = slot.takeForSubmit();
    assert.ok('runtime' in after && after.runtime === b, 'submits resume on the new session');
    assert.equal(slot.rebinding, false);
  });

  test('canRebind refuses a second rebind while one is already in flight', () => {
    // beginRebind sets #current=undefined and #rebinding=true, then buildSession
    // runs (skill install, credential exchange, MCP spawn, setup commands) — a long
    // window. The control-plane client puts a 30s timeout on POST /rebind and
    // retries; a second /rebind admitted during a slow build starts a second
    // concurrent buildSession whose beginRebind tears down nothing (#current is
    // already undefined) and whose finishRebind overwrites #current, leaking the
    // first runtime and duplicating setup side effects. canRebind must refuse for
    // the whole window (mirroring takeForSubmit's #rebinding guard), so the second
    // /rebind gets a 409 the client treats as busy.
    const a = fakeRuntime('sn_a');
    const slot = new SessionSlot(a);
    assert.equal(slot.canRebind(), true, 'an idle bound slot accepts a rebind');

    slot.beginRebind();
    assert.equal(
      slot.canRebind(),
      false,
      'a second rebind is refused while the first is still building (the slot is rebinding)',
    );

    // Once the build completes and the slot is reopened, a rebind is allowed again.
    const b = fakeRuntime('sn_b');
    slot.finishRebind(b);
    assert.equal(slot.canRebind(), true, 'rebinds resume after the in-flight one finishes');
  });

  test('a failed rebuild leaves the slot unbound, not pointing at the torn-down session', () => {
    const a = fakeRuntime('sn_a');
    const slot = new SessionSlot(a);
    slot.beginRebind();
    slot.finishRebind(undefined); // buildSession returned undefined / threw
    const decision = slot.takeForSubmit();
    assert.ok('refuse' in decision && decision.refuse === 'unbound', 'no session to submit to');
    assert.equal(slot.current, undefined, 'the slot does not resurrect the torn-down session');
  });

  test('a running turn blocks a rebind but not the running distinction', () => {
    const a = fakeRuntime('sn_a');
    a.running = true;
    const slot = new SessionSlot(a);
    assert.equal(slot.canRebind(), false, 'a rebind is refused while a turn runs');
    const decision = slot.takeForSubmit();
    assert.ok('refuse' in decision && decision.refuse === 'busy', 'a second submit is refused as busy');
  });
});

describe('materializeCredentialEnv: non-file credentials on bind', () => {
  // A prewarmed/rebound sandbox provisions with an empty environment (the session
  // and its creds are unknown when a prewarmed sandbox is born) and claim happens
  // via /rebind, which never re-runs the driver's provision(). So env_vars and
  // api_key/bearer credentials must be materialised here, on bind, through the
  // audited exchange — or an agent depending on them runs without its secret.
  const cred = (id: string, name: string, type: string): { id: string; name: string; type: string } => ({
    id,
    name,
    type,
  });

  test('injects env_vars (sanitized) and api_key/bearer as MA_CRED_*', async () => {
    const values: Record<string, string> = {
      c_env: JSON.stringify({ OPENAI_BASE: 'https://x', MA_SNEAK: 'nope' }),
      c_key: 'sk-secret',
      c_bear: 'bearer-secret',
    };
    const { env, credentialEnv } = await materializeCredentialEnv(
      [cred('c_env', 'openai', 'env_vars'), cred('c_key', 'stripe', 'api_key'), cred('c_bear', 'notion', 'bearer_token')],
      (id) => Promise.resolve(values[id]!),
      nullLogger,
    );

    // env_vars contents land in the untrusted env, past sanitizeEnv.
    assert.equal(env.OPENAI_BASE, 'https://x', 'a normal env_vars key is delivered');
    assert.equal(env.MA_SNEAK, undefined, 'a reserved MA_* key from an env_vars cred is stripped');
    // api_key / bearer land as trusted MA_CRED_<NAME>.
    assert.equal(credentialEnv.MA_CRED_STRIPE, 'sk-secret');
    assert.equal(credentialEnv.MA_CRED_NOTION, 'bearer-secret');
    // Trust separation: the platform-generated MA_CRED_* keys are NOT in the
    // untrusted (sanitized) env map.
    assert.equal(env.MA_CRED_STRIPE, undefined, 'MA_CRED_* stays out of the untrusted env');
  });

  test('a credential that fails to fetch or parse is skipped, not fatal', async () => {
    const { env, credentialEnv } = await materializeCredentialEnv(
      [
        cred('c_bad_json', 'broken', 'env_vars'),
        cred('c_throws', 'down', 'api_key'),
        cred('c_ok', 'good', 'api_key'),
      ],
      (id) => {
        if (id === 'c_throws') return Promise.reject(new Error('exchange failed'));
        if (id === 'c_bad_json') return Promise.resolve('not json');
        return Promise.resolve('ok-value');
      },
      nullLogger,
    );

    assert.deepEqual(env, {}, 'a malformed env_vars value contributes nothing');
    assert.equal(credentialEnv.MA_CRED_DOWN, undefined, 'a failed exchange is skipped');
    assert.equal(credentialEnv.MA_CRED_GOOD, 'ok-value', 'the healthy credential still lands');
  });

  test('a malformed env_vars value does not leak its plaintext into the error', async () => {
    // V8 SyntaxError embeds the first chars of the input; the parse must be caught
    // so a secret-shaped-but-invalid value never reaches a log or an error field.
    await assert.doesNotReject(
      materializeCredentialEnv(
        [cred('c', 'x', 'env_vars')],
        () => Promise.resolve('SUPERSECRET-not-json'),
        nullLogger,
      ),
    );
  });

  test('an env_vars value that is valid JSON but not an object is skipped, not fatal', async () => {
    // `JSON.parse('null')`/('123')/('"x"')/('[1,2]') all SUCCEED, so they pass the
    // SyntaxError try — but none is a {key:value} map. Before the shape guard,
    // Object.entries(null) threw a TypeError out of materializeCredentialEnv,
    // crashing buildSession → a member-authored value permanently DoS'd every
    // session granted it. Each must now be skipped like a parse failure, honoring
    // the documented "never fatal" contract, and the session must still boot.
    for (const bad of ['null', '123', 'true', '"just a string"', '[1,2,3]']) {
      const { env, credentialEnv } = await materializeCredentialEnv(
        [cred('c_bad', 'weird', 'env_vars'), cred('c_ok', 'good', 'api_key')],
        (id) => Promise.resolve(id === 'c_bad' ? bad : 'ok-value'),
        nullLogger,
      );
      assert.deepEqual(env, {}, `a non-object env_vars value (${bad}) contributes nothing`);
      assert.equal(credentialEnv.MA_CRED_GOOD, 'ok-value', 'the healthy credential still lands');
    }
  });
});

describe('runSetupCommands: rebind env parity', () => {
  // On a cold provision the driver bakes the agent's env (sanitized env_vars +
  // MA_CRED_*) into agent-core's process env, so setup commands inherit it. On a
  // rebind the driver never re-runs, so that env is passed explicitly here — a
  // rebound sandbox's setup commands must see the same environment a cold one did.
  test('a setup command sees the env passed to it (the rebind path)', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'ma-setup-env-'));
    try {
      // A required command that succeeds ONLY if it can read the threaded var, and
      // writes the value out so we can confirm it was the real secret, not a fluke.
      await runSetupCommands(
        [
          {
            name: 'needs-env',
            command: '[ "$MA_CRED_FOO" = "the-secret" ] && printf %s "$MA_CRED_FOO" > seen.txt',
            timeoutSeconds: 30,
            optional: false,
          },
        ],
        workDir,
        nullLogger,
        systemClock,
        { MA_CRED_FOO: 'the-secret' },
      );
      assert.equal(await readFile(join(workDir, 'seen.txt'), 'utf8'), 'the-secret', 'the setup command read the threaded env');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test('without the env, a setup command depending on it fails (proves the threading is load-bearing)', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'ma-setup-noenv-'));
    try {
      // No env passed (and MA_CRED_FOO is not in this process's env), so the
      // required command exits non-zero → runSetupCommands throws SANDBOX_SETUP_FAILED.
      await assert.rejects(
        runSetupCommands(
          [{ name: 'needs-env', command: '[ "$MA_CRED_FOO" = "the-secret" ]', timeoutSeconds: 30, optional: false }],
          workDir,
          nullLogger,
          systemClock,
        ),
        (error: unknown) => error instanceof Error && /SANDBOX_SETUP_FAILED|Setup command/.test(String(error)),
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

