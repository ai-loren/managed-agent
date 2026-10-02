/**
 * The native providers against wire-faithful stand-ins.
 *
 * Each stand-in refuses a request the way its real service does, so a tool-use
 * round trip that passes here has the conversation shape the service accepts:
 * roles alternating, results answering the turn before, tools declared when
 * tool blocks are present, schemas Gemini can read. The rest is what the
 * gateway's retry and failover rely on: every failure classified, usage
 * reported the way the gateway prices it.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, systemClock, TestClock } from '@ma/core';
import type { AwsCredentialProvider } from '@ma/connectors';
import type { ModelProvider } from '@ma/gateway';

import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { AzureOpenAIProvider } from '../src/providers/azure-openai.ts';
import { BedrockProvider } from '../src/providers/bedrock.ts';
import { RoutingProvider } from '../src/providers/router.ts';
import { uniqueCallId } from '../src/providers/shared.ts';
import { geminiSchema, googleCredentials, VertexProvider, type GoogleAccessTokens } from '../src/providers/vertex.ts';
import {
  FAKE_ADC,
  FAKE_ANTHROPIC_KEY,
  FAKE_AWS,
  FAKE_AZURE_KEY,
  FAKE_USAGE,
  FAKE_VERTEX,
  ProviderFakes,
  type FakeProvider,
} from './support/provider-fakes.ts';

let fakes: ProviderFakes;
let dir: string;
let vertexTokens: GoogleAccessTokens;

const WRITE_TOOL = {
  name: 'write_file',
  description: 'Write a file',
  parameters: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'where', format: 'uri' },
      content: { type: ['string', 'null'] },
      mode: { type: 'string', enum: ['create', 'append'], default: 'create' },
    },
    required: ['path', 'content', 'missing'],
  },
};
const NO_ARGS_TOOL = { name: 'list_directory', description: 'List', parameters: { type: 'object', properties: {} } };
const PROMPT = 'CALL write_file {"path":"a.txt","content":"hi"}';

function awsCredentials(sequence: { accessKeyId: string; secretAccessKey: string }[]): AwsCredentialProvider & { invalidations: number } {
  let index = 0;
  const provider = {
    describe: 'test credentials',
    invalidations: 0,
    get: () => Promise.resolve(sequence[Math.min(index, sequence.length - 1)]!),
    invalidate: () => {
      provider.invalidations++;
      index++;
    },
  };
  return provider;
}

function providers(): Record<FakeProvider, { provider: ModelProvider; model: string }> {
  return {
    anthropic: { provider: new AnthropicProvider({ apiKey: FAKE_ANTHROPIC_KEY, baseUrl: fakes.origin }), model: 'claude-sonnet-4-5' },
    azure: { provider: new AzureOpenAIProvider({ endpoint: fakes.origin, apiKey: FAKE_AZURE_KEY, apiVersion: '2024-10-21' }), model: 'gpt4o-prod' },
    bedrock: {
      provider: new BedrockProvider({ region: FAKE_AWS.region, credentials: awsCredentials([FAKE_AWS]), clock: systemClock, endpoint: fakes.origin }),
      model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    },
    vertex: {
      provider: new VertexProvider({ project: FAKE_VERTEX.project, location: FAKE_VERTEX.location, tokens: vertexTokens, endpoint: fakes.origin }),
      model: 'gemini-2.5-pro',
    },
  };
}

function isError(code: RegExp, retryable: boolean) {
  return (error: unknown) => {
    assert.ok(MaError.is(error), `expected an MaError, got ${String(error)}`);
    assert.match(error.code, code);
    assert.equal(error.retryable, retryable, `${error.code} retryable`);
    return true;
  };
}

before(async () => {
  fakes = new ProviderFakes();
  await fakes.start();
  fakes.models.anthropic.add('claude-sonnet-4-5');
  fakes.models.azure.add('gpt4o-prod');
  fakes.models.bedrock.add('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  fakes.models.vertex.add('gemini-2.5-pro');
  dir = mkdtempSync(join(tmpdir(), 'ma-providers-'));
  vertexTokens = await googleCredentials({ env: {}, clock: systemClock, credentialsFile: fakes.writeServiceAccount(dir) });
});

after(async () => {
  await fakes.stop();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fakes.calls.length = 0;
  fakes.failures.length = 0;
});

for (const name of ['anthropic', 'azure', 'bedrock', 'vertex'] as const) {
  describe(`${name}`, () => {
    test('a tool-use round trip: the call comes back, its result goes in, the answer quotes it', async () => {
      const { provider, model } = providers()[name];
      const system = { role: 'system', content: 'You are careful.' };
      const first = await provider.complete({ modelId: model, messages: [system, { role: 'user', content: PROMPT }], tools: [WRITE_TOOL, NO_ARGS_TOOL], maxOutputTokens: 512 });
      assert.equal(first.stopReason, 'tool_use');
      assert.equal(first.toolCalls?.length, 1);
      const call = first.toolCalls![0]!;
      assert.equal(call.name, 'write_file');
      assert.deepEqual(call.arguments, { path: 'a.txt', content: 'hi' });
      assert.ok(call.id.length > 0 && call.id.length <= 128);

      const second = await provider.complete({
        modelId: model,
        messages: [
          system,
          { role: 'user', content: PROMPT },
          { role: 'assistant', content: '', toolCalls: [call] },
          { role: 'tool', content: 'Wrote 2 bytes to a.txt', toolCallId: call.id },
        ],
        tools: [WRITE_TOOL, NO_ARGS_TOOL],
        temperature: 0.7,
      });
      assert.equal(second.text, 'RESULT: Wrote 2 bytes to a.txt');
      assert.equal(second.stopReason, 'end_turn');
      assert.equal(second.toolCalls, undefined);
      assert.deepEqual(fakes.calls.map((entry) => entry.status), [200, 200], 'both requests were accepted as sent');
      assert.deepEqual(fakes.calls[0]!.tools, ['write_file', 'list_directory']);
    });

    test('usage is reported as the gateway prices it: cached input apart from fresh input', async () => {
      const { provider, model } = providers()[name];
      const result = await provider.complete({ modelId: model, messages: [{ role: 'user', content: 'hello' }], tools: [] });
      assert.equal(result.text, 'echo: hello');
      const cacheWrite = name === 'anthropic' || name === 'bedrock' ? FAKE_USAGE.cacheWrite : 0;
      assert.deepEqual(result.usage, { inputTokens: FAKE_USAGE.input, outputTokens: FAKE_USAGE.output, cacheReadTokens: FAKE_USAGE.cacheRead, cacheWriteTokens: cacheWrite });
    });

    test('two calls in one turn: both results answer that turn together', async () => {
      const { provider, model } = providers()[name];
      const calls = [
        { id: 'call_a', name: 'write_file', arguments: { path: 'a', content: '1' } },
        { id: 'call_b', name: 'list_directory', arguments: {} },
      ];
      const result = await provider.complete({
        modelId: model,
        messages: [
          { role: 'user', content: PROMPT },
          { role: 'assistant', content: 'Doing both.', toolCalls: calls },
          { role: 'tool', content: 'first done', toolCallId: 'call_a' },
          { role: 'tool', content: 'second done', toolCallId: 'call_b' },
          { role: 'user', content: 'and then?' },
        ],
        tools: [WRITE_TOOL, NO_ARGS_TOOL],
      });
      assert.equal(fakes.calls[0]!.status, 200);
      assert.equal(result.text, 'RESULT: first done | second done');
    });

    test('a request offering no tools still carries a history of tool calls the service accepts', async () => {
      const { provider, model } = providers()[name];
      const call = { id: 'call_x', name: 'write_file', arguments: { path: 'a', content: '1' } };
      await provider.complete({
        modelId: model,
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: [call] },
          { role: 'tool', content: 'done', toolCallId: 'call_x' },
        ],
        tools: [],
      });
      assert.equal(fakes.calls[0]!.status, 200);
    });

    test('a rate limit and an outage are retryable, so the gateway retries and fails over', async () => {
      const { provider, model } = providers()[name];
      fakes.fail(name, 429);
      await assert.rejects(provider.complete({ modelId: model, messages: [{ role: 'user', content: 'x' }], tools: [] }), isError(/_RATE_LIMITED$/, true));
      fakes.fail(name, 503);
      await assert.rejects(provider.complete({ modelId: model, messages: [{ role: 'user', content: 'x' }], tools: [] }), isError(/_UNAVAILABLE$/, true));
    });

    test('a model the service does not have is a non-retryable refusal', async () => {
      const { provider } = providers()[name];
      await assert.rejects(provider.complete({ modelId: 'no-such-model', messages: [{ role: 'user', content: 'x' }], tools: [] }), isError(/_MODEL_NOT_FOUND$/, false));
    });

    test('an unreachable endpoint is a retryable transport failure that names the provider', async () => {
      const unreachable: Record<FakeProvider, ModelProvider> = {
        anthropic: new AnthropicProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9' }),
        azure: new AzureOpenAIProvider({ endpoint: 'http://127.0.0.1:9', apiKey: 'k', apiVersion: 'v' }),
        bedrock: new BedrockProvider({ region: FAKE_AWS.region, credentials: awsCredentials([FAKE_AWS]), clock: systemClock, endpoint: 'http://127.0.0.1:9' }),
        vertex: new VertexProvider({ project: 'p', location: 'l', tokens: vertexTokens, endpoint: 'http://127.0.0.1:9' }),
      };
      await assert.rejects(unreachable[name].complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }), (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.match(error.code, /_UNREACHABLE$/);
        assert.equal(error.retryable, true);
        assert.match(error.message, /did not return a complete response/);
        return true;
      });
    });

    test("the caller's abort passes through as the caller's reason", async () => {
      const { provider, model } = providers()[name];
      const abort = new AbortController();
      const reason = new MaError({ code: 'MODEL_CALL_TIMEOUT', category: 'timeout', message: 'too slow', retryable: true });
      abort.abort(reason);
      await assert.rejects(provider.complete({ modelId: model, messages: [{ role: 'user', content: 'x' }], tools: [], signal: abort.signal }), (error) => error === reason);

      // A bare abort: the reason is the platform's AbortError, not a provider failure to retry.
      const bare = new AbortController();
      bare.abort();
      await assert.rejects(provider.complete({ modelId: model, messages: [{ role: 'user', content: 'x' }], tools: [], signal: bare.signal }), (error) => error === bare.signal.reason);
    });
  });
}

describe('provider specifics', () => {
  test('anthropic: a wrong key is a non-retryable authentication failure', async () => {
    const provider = new AnthropicProvider({ apiKey: 'wrong', baseUrl: fakes.origin });
    await assert.rejects(provider.complete({ modelId: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'x' }], tools: [] }), isError(/^ANTHROPIC_UNAUTHENTICATED$/, false));
  });

  test('anthropic: overloaded (529) is retryable', async () => {
    fakes.fail('anthropic', 529);
    const { provider, model } = providers().anthropic;
    await assert.rejects(provider.complete({ modelId: model, messages: [{ role: 'user', content: 'x' }], tools: [] }), isError(/^ANTHROPIC_UNAVAILABLE$/, true));
  });

  test('anthropic: the system prompt is a top-level field and max_tokens is always sent', async () => {
    const { provider, model } = providers().anthropic;
    await provider.complete({ modelId: model, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'x' }], tools: [] });
    const body = fakes.calls[0]!.body as { system?: string; max_tokens?: number; messages: { role: string }[] };
    assert.equal(body.system, 'Be brief.');
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.messages.map((message) => message.role), ['user']);
  });

  test('azure: the deployment is the path, the version a query parameter, the key a header', async () => {
    const provider = new AzureOpenAIProvider({ endpoint: fakes.origin, apiKey: 'wrong', apiVersion: '2024-10-21' });
    await assert.rejects(provider.complete({ modelId: 'gpt4o-prod', messages: [{ role: 'user', content: 'x' }], tools: [] }), isError(/^AZURE_OPENAI_UNAUTHENTICATED$/, false));
  });

  test('bedrock: a stale signing key is dropped and the call signed again, once', async () => {
    const credentials = awsCredentials([{ accessKeyId: FAKE_AWS.accessKeyId, secretAccessKey: 'rotated-away' }, FAKE_AWS]);
    const provider = new BedrockProvider({ region: FAKE_AWS.region, credentials, clock: systemClock, endpoint: fakes.origin });
    const result = await provider.complete({ modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', messages: [{ role: 'user', content: 'x' }], tools: [] });
    assert.equal(result.text, 'echo: x');
    assert.equal(credentials.invalidations, 1);

    const hopeless = awsCredentials([{ accessKeyId: FAKE_AWS.accessKeyId, secretAccessKey: 'wrong' }]);
    const refused = new BedrockProvider({ region: FAKE_AWS.region, credentials: hopeless, clock: systemClock, endpoint: fakes.origin });
    await assert.rejects(refused.complete({ modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', messages: [{ role: 'user', content: 'x' }], tools: [] }), isError(/^BEDROCK_FORBIDDEN$/, false));
    assert.equal(hopeless.invalidations, 1, 'signed again once, not forever');
  });

  test('bedrock: a request signed for another region is refused', async () => {
    const provider = new BedrockProvider({ region: 'eu-west-1', credentials: awsCredentials([FAKE_AWS]), clock: systemClock, endpoint: fakes.origin });
    await assert.rejects(provider.complete({ modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', messages: [{ role: 'user', content: 'x' }], tools: [] }), isError(/^BEDROCK_FORBIDDEN$/, false));
  });

  test('bedrock: a signature made at the wrong time is refused', async () => {
    const provider = new BedrockProvider({ region: FAKE_AWS.region, credentials: awsCredentials([FAKE_AWS]), clock: new TestClock(1_000_000_000_000), endpoint: fakes.origin });
    await assert.rejects(provider.complete({ modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', messages: [{ role: 'user', content: 'x' }], tools: [] }), isError(/^BEDROCK_FORBIDDEN$/, false));
  });

  test('vertex: one token serves many calls, and a revoked one is replaced once', async () => {
    let fetches = 0;
    const counting: typeof fetch = (input, init) => {
      if (String(input).endsWith('/token')) fetches++;
      return fetch(input, init);
    };
    const tokens = await googleCredentials({ env: {}, clock: systemClock, credentialsFile: fakes.writeServiceAccount(dir), fetch: counting });
    const provider = new VertexProvider({ project: FAKE_VERTEX.project, location: FAKE_VERTEX.location, tokens, endpoint: fakes.origin });
    await provider.complete({ modelId: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'one' }], tools: [] });
    await provider.complete({ modelId: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'two' }], tools: [] });
    assert.equal(fetches, 1);
  });

  test('vertex: a tool result names the function it answers', async () => {
    const { provider, model } = providers().vertex;
    await provider.complete({
      modelId: model,
      messages: [
        { role: 'user', content: PROMPT },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'write_file', arguments: {} }] },
        { role: 'tool', content: 'ok', toolCallId: 'call_1' },
      ],
      tools: [WRITE_TOOL],
    });
    const body = fakes.calls[0]!.body as { contents: { role: string; parts: { functionResponse?: { name: string } }[] }[] };
    assert.deepEqual(body.contents.map((content) => content.role), ['user', 'model', 'user']);
    assert.equal(body.contents[2]!.parts[0]!.functionResponse?.name, 'write_file');
  });

  describe('vertex: where the platform finds its Google identity', () => {
    async function callsWith(tokens: GoogleAccessTokens): Promise<string> {
      const provider = new VertexProvider({ project: FAKE_VERTEX.project, location: FAKE_VERTEX.location, tokens, endpoint: fakes.origin });
      return (await provider.complete({ modelId: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'who am i' }], tools: [] })).text;
    }

    test("gcloud's application-default user credentials are exchanged with their refresh token", async () => {
      const home = mkdtempSync(join(dir, 'home-'));
      mkdirSync(join(home, '.config', 'gcloud'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'gcloud', 'application_default_credentials.json'),
        JSON.stringify({ type: 'authorized_user', ...FAKE_ADC, token_uri: `${fakes.origin}/token` }),
      );
      const tokens = await googleCredentials({ env: { HOME: home }, clock: systemClock });
      assert.equal(tokens.describe, 'the application-default user credentials');
      assert.equal(await callsWith(tokens), 'echo: who am i');

      writeFileSync(
        join(home, '.config', 'gcloud', 'application_default_credentials.json'),
        JSON.stringify({ type: 'authorized_user', ...FAKE_ADC, refresh_token: 'revoked', token_uri: `${fakes.origin}/token` }),
      );
      const revoked = await googleCredentials({ env: { HOME: home }, clock: systemClock });
      await assert.rejects(revoked.get(), (error: unknown) => MaError.is(error) && error.code === 'GOOGLE_CREDENTIALS_REFUSED' && /expired or revoked/.test(error.message));
    });

    test('GOOGLE_APPLICATION_CREDENTIALS names the key when no file is configured, ahead of the ADC file', async () => {
      const home = mkdtempSync(join(dir, 'home-'));
      mkdirSync(join(home, '.config', 'gcloud'), { recursive: true });
      writeFileSync(join(home, '.config', 'gcloud', 'application_default_credentials.json'), JSON.stringify({ type: 'authorized_user', ...FAKE_ADC }));
      const tokens = await googleCredentials({ env: { HOME: home, GOOGLE_APPLICATION_CREDENTIALS: fakes.writeServiceAccount(dir) }, clock: systemClock });
      assert.equal(tokens.describe, `service account ${FAKE_VERTEX.email}`);
      assert.equal(await callsWith(tokens), 'echo: who am i');
    });

    test('with no credentials file at all, the metadata server issues the token, asked with its header', async () => {
      const tokens = await googleCredentials({
        env: { HOME: mkdtempSync(join(dir, 'home-')), GCE_METADATA_HOST: new URL(fakes.origin).host },
        clock: systemClock,
      });
      assert.equal(tokens.describe, "the platform's GCE service account");
      assert.equal(await callsWith(tokens), 'echo: who am i');
    });
  });

  test('vertex: a credentials file that cannot be read fails at startup with what to do', async () => {
    await assert.rejects(googleCredentials({ env: {}, clock: systemClock, credentialsFile: join(dir, 'missing.json') }), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'GOOGLE_CREDENTIALS_UNREADABLE');
      assert.match(error.message, /mount a service account key/);
      return true;
    });
  });

  test('vertex: a JWT grant the token endpoint refuses is a credentials error, not a retry', async () => {
    const forged = await googleCredentials({ env: {}, clock: new TestClock(1_000_000_000_000), credentialsFile: fakes.writeServiceAccount(dir) });
    await assert.rejects(forged.get(), (error: unknown) => MaError.is(error) && error.code === 'GOOGLE_CREDENTIALS_REFUSED' && !error.retryable);
  });

  test("a provider's call id is kept when usable, and replaced when missing, too long or already in the conversation", () => {
    const seen = new Set(['call_1']);
    assert.equal(uniqueCallId('call_2', seen), 'call_2');
    assert.ok(seen.has('call_2'), 'remembered, so the next response cannot reuse it');
    for (const offered of ['call_1', 'call_2', 'x'.repeat(129), '', undefined, 42]) {
      const id = uniqueCallId(offered, seen);
      assert.notEqual(id, offered);
      assert.match(id, /^call_[0-9a-f]{32}$/);
    }
  });

  test('gemini schemas keep what Gemini reads and drop what it refuses', () => {
    assert.deepEqual(geminiSchema(WRITE_TOOL.parameters), {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'where' },
        content: { type: 'STRING', nullable: true },
        mode: { type: 'STRING', enum: ['create', 'append'] },
      },
      required: ['path', 'content'],
    });
  });
});

describe('routing', () => {
  const answering = (label: string): ModelProvider & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      complete: (request) => {
        asked.push(request.modelId);
        return Promise.resolve({ text: label, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      },
    };
  };

  test("each catalogue id goes to its provider under that provider's own model name", async () => {
    const anthropic = answering('anthropic');
    const bedrock = answering('bedrock');
    const router = new RoutingProvider({
      routes: new Map([
        ['anthropic/claude', { provider: anthropic, providerName: 'anthropic', nativeModel: 'claude-sonnet-4-5' }],
        ['bedrock/claude', { provider: bedrock, providerName: 'bedrock', nativeModel: 'us.anthropic.claude-v1:0' }],
      ]),
    });
    assert.equal((await router.complete({ modelId: 'bedrock/claude', messages: [], tools: [] })).text, 'bedrock');
    assert.equal((await router.complete({ modelId: 'anthropic/claude', messages: [], tools: [] })).text, 'anthropic');
    assert.deepEqual(bedrock.asked, ['us.anthropic.claude-v1:0']);
    assert.deepEqual(anthropic.asked, ['claude-sonnet-4-5']);
  });

  test('an id with no route goes to the fallback unchanged, or is refused by name when there is none', async () => {
    const openRouter = answering('openrouter');
    const routes = new Map([['anthropic/claude', { provider: answering('a'), providerName: 'anthropic', nativeModel: 'c' }]]);
    assert.equal((await new RoutingProvider({ routes, fallback: openRouter }).complete({ modelId: 'vendor/x:free', messages: [], tools: [] })).text, 'openrouter');
    assert.deepEqual(openRouter.asked, ['vendor/x:free']);
    await assert.rejects(new RoutingProvider({ routes }).complete({ modelId: 'vendor/x:free', messages: [], tools: [] }), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'MODEL_NOT_ROUTED');
      assert.match(error.message, /routes anthropic\/claude/);
      return true;
    });
  });
});
