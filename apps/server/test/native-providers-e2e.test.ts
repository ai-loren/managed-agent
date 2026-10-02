/**
 * The native providers, through a real server process.
 *
 * The server is configured for Anthropic, Azure OpenAI, Bedrock and Vertex AI
 * at once, each pointed at a wire-faithful stand-in, and every session runs in
 * a real agent-core. A tool-using turn on each provider must complete with the
 * call made and its result quoted, billed from that model's catalogue price; a
 * version whose primary is down must fail over to a fallback on another vendor
 * — and come back to the primary with the fallback's tool call in its history;
 * and a provider that keeps failing must be skipped by the circuit breaker.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newId } from '@ma/core';
import type { SessionEvent } from '@ma/contracts';

import { EchoModel, LiveServer, waitFor } from './support/live-server.ts';
import { ProviderFakes, type FakeProvider } from './support/provider-fakes.ts';

const MODELS = {
  anthropic: { id: 'anthropic/claude-sonnet-4-5', native: 'claude-sonnet-4-5', spec: 'claude-sonnet-4-5@3/15/0.3/3.75', costPerCall: 6278 },
  azure: { id: 'azure/gpt4o-prod', native: 'gpt4o-prod', spec: 'gpt4o-prod@2.5/10/1.25/0', costPerCall: 4875 },
  bedrock: {
    id: 'bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    native: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    spec: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0@3/15/0.3/3.75',
    costPerCall: 6278,
  },
  vertex: { id: 'vertex/gemini-2.5-pro', native: 'gemini-2.5-pro', spec: 'gemini-2.5-pro@1.25/10/0.31/0', costPerCall: 3343 },
} as const satisfies Record<FakeProvider, unknown>;

let fakes: ProviderFakes;
let echo: EchoModel;
let server: LiveServer;
let dir: string;
let workspaceId = '';

function serverLog(): string {
  return server.log
    .split('\n')
    .filter((line) => !/"method":"GET","path":"\/v1\/(sessions|workspaces)\//.test(line))
    .join('\n');
}

async function events(sessionId: string, types?: string[]): Promise<SessionEvent[]> {
  return (await server.client.readEvents(sessionId, { limit: 500, ...(types ? { types } : {}) })).events;
}

/**
 * Every `model.*` event of a type. Each completed call appears twice — the
 * gateway's record and the sandbox's own report of it — so assertions here are
 * about what every record says, and counts come from the stand-in and the bill.
 */
function modelEvents<T>(log: SessionEvent[], type: 'model.completed' | 'model.failed'): T[] {
  return log.filter((event) => event.type === type).map((event) => event.payload as T);
}

/** A session on a fresh agent with this model chain, a turn run to its answer, and the session's events. */
async function runTurn(name: string, modelId: string, fallbackModelIds: string[], prompt: string): Promise<{ sessionId: string; answer: string; log: SessionEvent[] }> {
  const { agent } = await server.client.createAgent(workspaceId, {
    name,
    spec: { systemPrompt: 'Use the tools you are asked to.', model: { modelId, fallbackModelIds }, tools: { mode: 'auto' } },
  });
  const { session } = await server.client.createSession({ agentId: agent.id });
  await waitFor('the session to be ready', async () => (await server.client.getSession(session.id)).session.status === 'ready', 90_000, serverLog);
  await server.client.prompt(session.id, prompt);
  let answer = '';
  await waitFor(
    'the turn to end',
    async () => {
      const ended = await events(session.id, ['turn.completed', 'turn.failed']);
      if (ended.length === 0) return false;
      const completed = await events(session.id, ['message.completed']);
      answer = String((completed.at(-1)?.payload as { text?: string } | undefined)?.text ?? '');
      return true;
    },
    90_000,
    serverLog,
  );
  return { sessionId: session.id, answer, log: await events(session.id) };
}

describe('native model providers on a real server', () => {
  before(async () => {
    fakes = new ProviderFakes();
    await fakes.start();
    for (const [provider, model] of Object.entries(MODELS) as [FakeProvider, (typeof MODELS)[FakeProvider]][]) fakes.models[provider].add(model.native);
    fakes.models.azure.add('gpt4o-restricted');
    echo = new EchoModel();
    await echo.start();
    dir = mkdtempSync(join(tmpdir(), 'ma-native-e2e-'));
    server = new LiveServer(echo, {
      ...fakes.env(dir, {
        anthropic: MODELS.anthropic.spec,
        azure: `${MODELS.azure.spec},gpt4o-restricted@2.5/10`,
        bedrock: MODELS.bedrock.spec,
        vertex: MODELS.vertex.spec,
      }),
      // Reserved for a workspace that is not the test's.
      MA_MODEL_WORKSPACES: `azure/gpt4o-restricted=${newId('workspace')}`,
      MA_MODEL_RETRY_ATTEMPTS: '2',
      MA_MODEL_RETRY_BASE_MS: '10',
      MA_MODEL_RETRY_MAX_MS: '50',
      // A failure counts once per model call, however many attempts it took.
      MA_MODEL_BREAKER_THRESHOLD: '2',
      MA_MODEL_BREAKER_RESET_MS: '600000',
    });
    await server.start();
    const { workspace } = await server.client.createWorkspace({ name: 'Native', slug: 'native-e2e' });
    workspaceId = workspace.id;
  });

  after(async () => {
    await server?.dispose();
    await echo?.stop();
    await fakes?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the catalogue lists every native model with its provider and its price', async () => {
    const { models } = await server.client.listModels(workspaceId);
    for (const model of Object.values(MODELS)) {
      const row = models.find((entry) => entry.id === model.id);
      assert.ok(row, `${model.id} is catalogued`);
      assert.equal(row.model, model.native);
      assert.ok(row.pricing.inputMicrosPerMillion > 0, 'a paid model carries its price');
    }
    assert.equal(models.find((entry) => entry.id === MODELS.vertex.id)?.provider, 'vertex');
  });

  for (const provider of ['anthropic', 'azure', 'bedrock', 'vertex'] as const) {
    test(`${provider}: a tool-using turn completes, billed from the catalogue price`, async () => {
      const before = fakes.callsTo(provider).length;
      const { sessionId, answer, log } = await runTurn(`On ${provider}`, MODELS[provider].id, [], `CALL write_file {"path":"from-${provider}.txt","content":"hello ${provider}"}`);
      assert.equal(answer, `RESULT: Wrote ${`hello ${provider}`.length} bytes to from-${provider}.txt`, serverLog().slice(-3000));
      assert.ok(log.some((event) => event.type === 'tool.completed'), 'the tool ran in the sandbox');

      const calls = fakes.callsTo(provider).slice(before);
      assert.deepEqual(calls.map((call) => call.status), [200, 200], 'two calls, both accepted as sent');
      assert.deepEqual(calls[0]!.tools.includes('write_file'), true);

      const completions = modelEvents<{ modelId: string; usage: { costMicros: number } }>(log, 'model.completed');
      assert.ok(completions.length >= 2);
      for (const entry of completions) {
        assert.equal(entry.modelId, MODELS[provider].id);
        assert.equal(entry.usage.costMicros, MODELS[provider].costPerCall, 'priced from the catalogue row');
      }
      const { session } = await server.client.getSession(sessionId);
      assert.equal(session.usage.costMicros, 2 * MODELS[provider].costPerCall, 'two calls, each billed once');
      assert.equal(session.usage.cacheReadTokens, 600);
    });
  }

  test('a primary that is down fails over to another vendor, and the primary later reads that vendor’s tool call', async () => {
    // Both attempts at the first call fail; the second call finds Anthropic back.
    fakes.fail('anthropic', 529, 2);
    const vertexBefore = fakes.callsTo('vertex').length;
    const { sessionId, answer, log } = await runTurn('Failing over', MODELS.anthropic.id, [MODELS.vertex.id], 'CALL write_file {"path":"failover.txt","content":"across vendors"}');
    assert.equal(answer, 'RESULT: Wrote 14 bytes to failover.txt', serverLog().slice(-3000));
    assert.equal(fakes.callsTo('vertex').length - vertexBefore, 1, 'the fallback answered one call');

    const completions = modelEvents<{ modelId: string; fallbackFrom?: string; usage: { costMicros: number } }>(log, 'model.completed');
    assert.deepEqual(
      completions.filter((entry) => entry.fallbackFrom).map((entry) => [entry.modelId, entry.fallbackFrom]),
      [[MODELS.vertex.id, MODELS.anthropic.id]],
      'the failover is on the record',
    );
    for (const entry of completions) {
      const price = entry.modelId === MODELS.vertex.id ? MODELS.vertex.costPerCall : MODELS.anthropic.costPerCall;
      assert.equal(entry.usage.costMicros, price, `${entry.modelId} billed at its own price`);
    }
    const { session } = await server.client.getSession(sessionId);
    assert.equal(session.usage.costMicros, MODELS.vertex.costPerCall + MODELS.anthropic.costPerCall);
    const failures = modelEvents<{ modelId: string; error: { code: string; retryable: boolean } }>(log, 'model.failed');
    assert.deepEqual(failures.map((entry) => [entry.modelId, entry.error.code, entry.error.retryable]), [
      [MODELS.anthropic.id, 'ANTHROPIC_UNAVAILABLE', true],
      [MODELS.anthropic.id, 'ANTHROPIC_UNAVAILABLE', true],
    ]);
    const last = fakes.callsTo('anthropic').at(-1)!;
    assert.equal(last.status, 200, 'Anthropic accepted a history holding the call Gemini made');
    assert.deepEqual(last.turns.flatMap((turn) => turn.toolCalls.map((call) => call.name)), ['write_file']);
  });

  test("a model reserved for another workspace is neither offered nor called from this one", async () => {
    const { models } = await server.client.listModels(workspaceId);
    assert.ok(!models.some((entry) => entry.id === 'azure/gpt4o-restricted'), 'not in this workspace’s catalogue');
    const before = fakes.callsTo('azure').length;
    const { log } = await runTurn('Reserved', 'azure/gpt4o-restricted', [], 'hello');
    // Refused at the gateway before any provider is called, so the record is the
    // sandbox's report of the 403 it was answered with.
    const failures = modelEvents<{ modelId: string; error: { message: string; retryable: boolean } }>(log, 'model.failed');
    const refused = failures.filter((entry) => entry.modelId === 'azure/gpt4o-restricted');
    assert.equal(refused.length, 1);
    assert.match(refused[0]!.error.message, /answered 403: .*Not permitted to use model on azure\/gpt4o-restricted/);
    assert.equal(refused[0]!.error.retryable, false);
    assert.ok(log.some((event) => event.type === 'turn.failed'), 'the turn ends refused, not answered');
    assert.equal(fakes.callsTo('azure').length, before, 'the provider was never asked');
  });

  test('a provider that keeps failing is skipped by the circuit breaker, without another call to it', async () => {
    fakes.fail('bedrock', 503, 1000);
    const first = await runTurn('Breaking', MODELS.bedrock.id, [MODELS.azure.id], 'CALL write_file {"path":"breaker.txt","content":"one"}');
    assert.equal(first.answer, 'RESULT: Wrote 3 bytes to breaker.txt', serverLog().slice(-3000));
    const triedBedrock = fakes.callsTo('bedrock').length;
    assert.ok(await server.metric('ma_model_breaker_state', { model: MODELS.bedrock.id }) > 0, 'the breaker opened');

    const second = await runTurn('Broken', MODELS.bedrock.id, [MODELS.azure.id], 'CALL write_file {"path":"skipped.txt","content":"two"}');
    assert.equal(second.answer, 'RESULT: Wrote 3 bytes to skipped.txt');
    assert.equal(fakes.callsTo('bedrock').length, triedBedrock, 'an open breaker sends nothing to the provider');
    assert.ok(await server.metric('ma_model_breaker_skips_total', { model: MODELS.bedrock.id }) >= 2);
    fakes.failures.length = 0;
  });
});
