/**
 * A full agent turn, end to end.
 *
 * Every other test proves a part behaves. This one proves the parts add up to a
 * working agent: a session starts, the harness calls a model, the model asks for
 * a tool, the tool runs against a real filesystem, the result goes back, and the
 * whole run is reconstructable from the event log afterwards.
 *
 * The model is scripted rather than real. Everything else — the permission
 * engine, the tools, the event log, usage accounting — is the production code
 * path.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryKeyProvider, newId, nullLogger, systemClock } from '@ma/core';
import type { AgentVersion, Session, Usage } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';
import {
  AgentService,
  CredentialService,
  EventBus,
  KeywordIndex,
  QuotaService,
  RetrievalService,
  RoleAuthorizer,
  SessionService,
  WorkspaceService,
  type AuthContext,
  type SessionProvisioner,
} from '@ma/engine';
import {
  AgentHarness,
  ToolRegistry,
  builtinTools,
  createRetrievalTool,
  type HarnessEvents,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
} from '@ma/runtime';

const ZERO: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 0,
};

let store: SqliteStore;
let bus: EventBus;
let workDir: string;
let context: AuthContext;
let session: Session;
let version: AgentVersion;

const provisioner: SessionProvisioner = {
  provision: () => Promise.resolve({ sandboxId: newId('sandbox'), reused: false, provisionMs: 1 }),
  release: () => Promise.resolve(),
  submit: () => Promise.resolve(),
};

/** A model that replays scripted turns and records what it was asked. */
class ScriptedModel implements ModelClient {
  requests: ModelRequest[] = [];
  readonly #script: ModelChunk[][];

  constructor(script: ModelChunk[][]) {
    this.#script = script;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    this.requests.push(request);
    const chunks = this.#script.shift() ?? [{ type: 'done', stopReason: 'end_turn', usage: ZERO }];
    for (const chunk of chunks) {
      await Promise.resolve();
      yield chunk;
    }
  }
}

/**
 * Forwards harness events onto the session's durable log.
 *
 * This is the wiring the sandbox's runtime does in production, over the runtime
 * bridge. Here it is direct, because the point is that the *log* ends up
 * correct, not which transport carried it.
 */
function eventSink(sessionId: string, workspaceId: string): HarnessEvents {
  const publish = (type: string, payload: unknown, turn?: number, itemId?: string): void => {
    void bus.publish([
      {
        sessionId,
        workspaceId,
        type: type as never,
        payload,
        ...(turn === undefined ? {} : { turn }),
        ...(itemId === undefined ? {} : { itemId }),
      },
    ]);
  };

  return {
    turnStarted: (turn, promptPreview) => publish('turn.started', { turn, promptPreview }, turn),
    turnCompleted: (turn, reason, durationMs, usage) =>
      publish('turn.completed', { turn, reason, durationMs, usage }, turn),
    turnFailed: (turn, error) =>
      publish('turn.failed', { turn, error: { code: error.code, message: error.message, details: {}, occurredAt: 0, retryable: false } }, turn),
    messageDelta: (itemId, text) => publish('message.delta', { text }, undefined, itemId),
    messageCompleted: (itemId, text) =>
      publish('message.completed', { role: 'assistant', text }, undefined, itemId),
    thinkingDelta: (itemId, text) => publish('thinking.delta', { text }, undefined, itemId),
    thinkingCompleted: (itemId, text) => publish('thinking.completed', { text }, undefined, itemId),
    toolRequested: (call) =>
      publish('tool.requested', { toolCallId: call.id, toolName: call.name, input: call.arguments }),
    toolApproved: (toolCallId, rule, reason) =>
      publish('tool.approved', { toolCallId, decision: { decision: 'allow', rule, reason } }),
    toolDenied: (toolCallId, rule, reason) =>
      publish('tool.denied', { toolCallId, decision: { decision: 'deny', rule, reason } }),
    toolStarted: (toolCallId) => publish('tool.started', { toolCallId }),
    toolOutput: (toolCallId, chunk, stream) => publish('tool.output', { toolCallId, chunk, stream }),
    toolCompleted: (toolCallId, durationMs, preview, truncated) =>
      publish('tool.completed', { toolCallId, durationMs, resultPreview: preview, truncated }),
    toolFailed: (toolCallId, error) =>
      publish('tool.failed', { toolCallId, error: { code: error.code, message: error.message, details: {}, occurredAt: 0, retryable: false } }),
    modelRequested: (modelId, inputTokens) => publish('model.requested', { modelId, inputTokens }),
    modelCompleted: (modelId, durationMs, usage, stopReason) =>
      publish('model.completed', { modelId, durationMs, usage, stopReason }),
    modelFailed: (modelId, error) =>
      publish('model.failed', { modelId, error: { code: error.code, message: error.message, details: {}, occurredAt: 0, retryable: false } }),
    contextCompacted: (before, after, turnsSummarized, strategy) =>
      publish('context.compacted', { beforeTokens: before, afterTokens: after, turnsSummarized, strategy }),
    contextSnapshot: (digest, tokens, turn) => publish('context.snapshot', { digest, tokens, turn }),
  };
}

beforeEach(async () => {
  store = createMemoryStore();
  bus = new EventBus(store, systemClock, nullLogger);
  workDir = await mkdtemp(join(tmpdir(), 'ma-agent-run-'));

  const principal = await store.principals.create({
    id: newId('principal'),
    type: 'user',
    subject: 'agent-run',
    displayName: 'Runner',
    email: '',
    isAdmin: false,
    disabled: false,
    metadata: {},
    createdAt: systemClock.now(),
    updatedAt: systemClock.now(),
    createdBy: 'system',
  });
  context = { principal };

  const quota = new QuotaService(store, systemClock);
  const deps = { store, clock: systemClock, quota, logger: nullLogger, authorizer: new RoleAuthorizer() };
  const workspaces = new WorkspaceService(deps);
  const agents = new AgentService(deps);
  const sessions = new SessionService({ ...deps, bus, provisioner });
  void new CredentialService({ ...deps, keys: InMemoryKeyProvider.generate() });

  const workspace = await workspaces.create(context, { name: 'Runs', slug: 'agent-runs' });
  const agent = await agents.create(context, {
    workspaceId: workspace.id,
    name: 'File Assistant',
    spec: {
      model: { modelId: 'test/model' },
      systemPrompt: 'You help with files.',
      // Deliberately narrow: the run below must succeed within it, and the
      // denial test must fail against it.
      tools: { mode: 'strict', allow: ['read_file', 'write_file', 'search_knowledge'] },
    },
  });

  session = await sessions.create(context, { agentId: agent.id });
  version = (await store.agentVersions.get(agent.id, 1))!;
});

afterEach(async () => {
  bus.closeAll();
  await store.close();
  await rm(workDir, { recursive: true, force: true });
});

function harnessFor(model: ModelClient, tools: ToolRegistry): AgentHarness {
  return new AgentHarness({
    sessionId: session.id,
    workspaceId: session.workspaceId,
    version,
    model,
    tools,
    events: eventSink(session.id, session.workspaceId),
    clock: systemClock,
    workDir,
    logger: nullLogger,
  });
}

describe('a complete agent run', () => {
  test('writes a file the model asked for and records the whole run', async () => {
    const model = new ScriptedModel([
      // Turn 1: the model decides to write a file.
      [
        { type: 'thinking', text: 'The user wants a note saved.' },
        {
          type: 'tool_call',
          call: {
            id: 'call_1',
            name: 'write_file',
            arguments: { path: 'notes/summary.md', content: '# Summary\n\nAll clear.' },
          },
        },
        { type: 'done', stopReason: 'tool_use', usage: { ...ZERO, inputTokens: 120, outputTokens: 40 } },
      ],
      // Turn 2: having seen the result, it answers.
      [
        { type: 'text', text: 'I saved the summary to notes/summary.md.' },
        { type: 'done', stopReason: 'end_turn', usage: { ...ZERO, inputTokens: 200, outputTokens: 30 } },
      ],
    ]);

    const harness = harnessFor(model, new ToolRegistry().registerAll(builtinTools()));
    const result = await harness.runTurn('Save a summary note for me.');

    assert.equal(result.reason, 'completed');
    assert.equal(result.iterations, 2);
    assert.equal(result.text, 'I saved the summary to notes/summary.md.');

    // The file genuinely exists on disk — this is the real tool, not a stub.
    const written = await readFile(join(workDir, 'notes/summary.md'), 'utf8');
    assert.equal(written, '# Summary\n\nAll clear.');

    // Usage is summed across both model calls.
    assert.equal(result.usage.inputTokens, 320);
    assert.equal(result.usage.outputTokens, 70);

    // And the run is reconstructable from the log alone.
    await new Promise((resolve) => setImmediate(resolve));
    const events = await store.events.read(session.id, { limit: 200 });
    const types = events.map((event) => event.type);

    assert.ok(types.includes('turn.started'));
    assert.ok(types.includes('tool.requested'));
    assert.ok(types.includes('tool.completed'));
    assert.ok(types.includes('turn.completed'));

    // "Which tool did it run, with what arguments" is answerable.
    const requested = events.find((event) => event.type === 'tool.requested');
    const payload = requested!.payload as { toolName: string; input: Record<string, unknown> };
    assert.equal(payload.toolName, 'write_file');
    assert.equal(payload.input.path, 'notes/summary.md');
  });

  test('refuses a tool outside the policy and tells the model why', async () => {
    // `bash` is not in this version's allowlist.
    const model = new ScriptedModel([
      [
        {
          type: 'tool_call',
          call: { id: 'call_1', name: 'bash', arguments: { command: 'rm -rf /' } },
        },
        { type: 'done', stopReason: 'tool_use', usage: ZERO },
      ],
      [
        { type: 'text', text: 'I cannot run that; I will use a permitted tool instead.' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);

    const harness = harnessFor(model, new ToolRegistry().registerAll(builtinTools()));
    const result = await harness.runTurn('Delete everything.');

    assert.equal(result.reason, 'completed', 'a denial is not a turn failure');

    // The model was told, in its own conversation, why it was refused.
    const followUp = model.requests[1]!;
    const toolMessage = followUp.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage?.content.includes('Permission denied'));

    await new Promise((resolve) => setImmediate(resolve));
    const events = await store.events.read(session.id, { types: ['tool.denied'] });
    assert.equal(events.length, 1, 'the refusal is on the audit trail');

    // And the tool was never even advertised, so the model should not have
    // reached for it in the first place.
    assert.equal(
      model.requests[0]!.tools.some((tool) => tool.name === 'bash'),
      false,
    );
  });

  test('consults a knowledge base when the model asks for one', async () => {
    const index = new KeywordIndex();
    await index.add([
      {
        datasetId: 'ds_runbooks',
        documentId: 'dc_1',
        index: 0,
        text: 'To restart the payment service, run systemctl restart payments.',
        source: 'runbook.md',
      },
    ]);

    const retrieval = new RetrievalService({ index });
    const tools = new ToolRegistry()
      .registerAll(builtinTools())
      .register(createRetrievalTool({ retrieval, datasetIds: ['ds_runbooks'] }));

    const model = new ScriptedModel([
      [
        {
          type: 'tool_call',
          call: {
            id: 'call_1',
            name: 'search_knowledge',
            arguments: { query: 'restart payment service' },
          },
        },
        { type: 'done', stopReason: 'tool_use', usage: ZERO },
      ],
      [
        { type: 'text', text: 'Run: systemctl restart payments' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);

    const harness = harnessFor(model, tools);
    const result = await harness.runTurn('How do I restart the payment service?');

    assert.equal(result.reason, 'completed');

    // The retrieved text reached the model, with its citation.
    const followUp = model.requests[1]!;
    const toolMessage = followUp.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage?.content.includes('systemctl restart payments'));
    assert.ok(toolMessage?.content.includes('runbook.md'), 'the agent can attribute the claim');
  });

  test('reports a tool failure to the model without collapsing the turn', async () => {
    const model = new ScriptedModel([
      [
        {
          type: 'tool_call',
          call: { id: 'call_1', name: 'read_file', arguments: { path: 'does-not-exist.txt' } },
        },
        { type: 'done', stopReason: 'tool_use', usage: ZERO },
      ],
      [
        { type: 'text', text: 'That file does not exist. Shall I create it?' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);

    const harness = harnessFor(model, new ToolRegistry().registerAll(builtinTools()));
    const result = await harness.runTurn('Read the missing file.');

    assert.equal(result.reason, 'completed');
    const toolMessage = model.requests[1]!.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage?.content.includes('Tool failed'));
  });

  test('a second turn continues the same conversation', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'Noted: the project is called Atlas.' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
      [
        { type: 'text', text: 'The project is Atlas.' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);

    const harness = harnessFor(model, new ToolRegistry());
    await harness.runTurn('The project is called Atlas.');
    await harness.runTurn('What is the project called?');

    // The second request carries the first exchange, which is the difference
    // between a session and two unrelated calls.
    const second = model.requests[1]!;
    const transcript = second.messages.map((message) => message.content).join('\n');
    assert.ok(transcript.includes('The project is called Atlas.'));
    assert.ok(transcript.includes('Noted: the project is called Atlas.'));
    assert.equal(harness.turnCount, 2);
  });

  test('a snapshot restores enough to resume after a lost sandbox', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'Remembering that.' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
      [
        { type: 'text', text: 'You told me about Atlas.' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);

    const first = harnessFor(model, new ToolRegistry());
    await first.runTurn('The project is Atlas.');
    const snapshot = first.snapshot();

    // A new sandbox picks up where the old one stopped.
    const resumed = new AgentHarness(
      {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        version,
        model,
        tools: new ToolRegistry(),
        events: eventSink(session.id, session.workspaceId),
        clock: systemClock,
        workDir,
        logger: nullLogger,
      },
      snapshot,
    );

    await resumed.runTurn('What did I tell you?');
    const transcript = model.requests[1]!.messages.map((message) => message.content).join('\n');
    assert.ok(
      transcript.includes('The project is Atlas.'),
      'the user’s work survives losing the sandbox',
    );
  });
});
