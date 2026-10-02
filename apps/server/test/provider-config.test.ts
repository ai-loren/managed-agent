/**
 * Native provider configuration, and the catalogue it produces.
 *
 * The catalogue is what the gateway's allowlist, failover order and cost cap
 * read, so the rules here are about money and routing: no model without its
 * price, no id that two providers both claim, and a row whose model left the
 * configuration retired rather than left serving at its old price.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryKeyProvider, MaError, systemClock } from '@ma/core';
import type { Model } from '@ma/contracts';

import type { ServerConfig } from '../src/config.ts';
import { buildModelWiring, catalogueGuard } from '../src/model-provider.ts';
import { loadNativeProviders, parseNativeModels } from '../src/provider-config.ts';
import { FAKE_ANTHROPIC_KEY, FAKE_AWS, FAKE_AZURE_KEY, FAKE_VERTEX, ProviderFakes } from './support/provider-fakes.ts';

function envOf(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => values[name];
}

function refusal(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(MaError.is(error), `expected an MaError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  };
}

describe('model lists', () => {
  test('an entry names the model and its price; the id defaults to provider/model', () => {
    assert.deepEqual(parseNativeModels('anthropic', 'MA_ANTHROPIC_MODELS', 'claude-sonnet-4-5@3/15/0.3/3.75, fast=claude-haiku-4-5@1/5@100000/2048'), [
      {
        id: 'anthropic/claude-sonnet-4-5',
        model: 'claude-sonnet-4-5',
        pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindowTokens: 200_000,
        maxOutputTokens: 8_192,
      },
      {
        id: 'fast',
        model: 'claude-haiku-4-5',
        pricing: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
        contextWindowTokens: 100_000,
        maxOutputTokens: 2_048,
      },
    ]);
  });

  test('a model id with colons (a Bedrock version) keeps them', () => {
    const [model] = parseNativeModels('bedrock', 'MA_BEDROCK_MODELS', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0@3/15');
    assert.equal(model?.model, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    assert.equal(model?.id, 'bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  });

  test('a model without its price is refused, because the cost cap could not see it', () => {
    assert.throws(() => parseNativeModels('anthropic', 'MA_ANTHROPIC_MODELS', 'claude-sonnet-4-5'), refusal(/MA_ANTHROPIC_MODELS: "claude-sonnet-4-5" has no price.*daily cost cap/));
  });

  for (const [entry, pattern] of [
    ['m@3', /must be input\/output or input\/output\/cacheRead\/cacheWrite/],
    ['m@3/x', /the output price in "m@3\/x" must be a non-negative number; got "x"/],
    ['m@-1/2', /the input price .* must be a non-negative number; got "-1"/],
    ['m@1/2/3', /must be input\/output or input\/output\/cacheRead\/cacheWrite/],
    ['m@1/2@500/10', /contextTokens\/maxOutputTokens/],
    ['@1/2', /must name the provider's model/],
    ['m@1/2@1000/10@x', /has no price/],
  ] as const) {
    test(`"${entry}" is refused with how to write it`, () => {
      assert.throws(() => parseNativeModels('vertex', 'MA_VERTEX_MODELS', entry), refusal(pattern));
    });
  }

  test('a free model is written as a zero price, explicitly', () => {
    const [model] = parseNativeModels('azure-openai', 'MA_AZURE_OPENAI_MODELS', 'local@0/0');
    assert.deepEqual(model?.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('which providers are on', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ma-provider-config-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('a provider is on when its model list is set, with what it needs from the environment', () => {
    const keyFile = join(dir, 'anthropic.key');
    writeFileSync(keyFile, 'sk-ant-from-file\n');
    const warnings: string[] = [];
    const config = loadNativeProviders(
      envOf({
        MA_ANTHROPIC_MODELS: 'claude-sonnet-4-5@3/15',
        MA_ANTHROPIC_API_KEY_FILE: keyFile,
        MA_AZURE_OPENAI_MODELS: 'gpt4o-prod@2.5/10/1.25/0',
        MA_AZURE_OPENAI_API_KEY: 'azure-key',
        MA_AZURE_OPENAI_ENDPOINT: 'https://res.openai.azure.com',
        MA_BEDROCK_MODELS: 'amazon.nova-pro-v1:0@0.8/3.2',
        AWS_REGION: 'eu-central-1',
        MA_VERTEX_MODELS: 'gemini-2.5-pro@1.25/10',
        MA_VERTEX_PROJECT: 'acme',
      }),
      [],
      warnings,
    );
    assert.equal(config.anthropic?.apiKey, 'sk-ant-from-file');
    assert.equal(config.azureOpenai?.apiVersion, '2024-10-21');
    assert.equal(config.bedrock?.region, 'eu-central-1');
    assert.equal(config.vertex?.location, 'us-central1');
    assert.deepEqual(warnings, []);
  });

  for (const [env, pattern] of [
    [{ MA_ANTHROPIC_MODELS: 'm@1/1' }, /MA_ANTHROPIC_API_KEY \(or MA_ANTHROPIC_API_KEY_FILE\) is required/],
    [{ MA_AZURE_OPENAI_MODELS: 'm@1/1', MA_AZURE_OPENAI_API_KEY: 'k' }, /MA_AZURE_OPENAI_ENDPOINT is required.*resource URL/],
    [{ MA_BEDROCK_MODELS: 'm@1/1' }, /MA_BEDROCK_REGION \(or AWS_REGION\) is required.*regional/],
    [{ MA_VERTEX_MODELS: 'm@1/1' }, /MA_VERTEX_PROJECT is required/],
  ] as const) {
    test(`${Object.keys(env)[0]} without what it needs fails at startup, naming it`, () => {
      assert.throws(() => loadNativeProviders(envOf(env), [], []), refusal(pattern));
    });
  }

  test('a key with no model list catalogues nothing, and says so', () => {
    const warnings: string[] = [];
    assert.deepEqual(loadNativeProviders(envOf({ MA_ANTHROPIC_API_KEY: 'k' }), [], warnings), {});
    assert.match(warnings[0] ?? '', /MA_ANTHROPIC_MODELS is not, so no Anthropic model is catalogued/);
  });

  test('two providers cannot claim one catalogue id, OpenRouter included', () => {
    const env = envOf({
      MA_ANTHROPIC_MODELS: 'shared=claude-sonnet-4-5@3/15',
      MA_ANTHROPIC_API_KEY: 'k',
      MA_VERTEX_MODELS: 'shared=gemini-2.5-pro@1/2',
      MA_VERTEX_PROJECT: 'p',
    });
    assert.throws(() => loadNativeProviders(env, [], []), refusal(/"shared" is listed in both MA_ANTHROPIC_MODELS and MA_VERTEX_MODELS/));
    assert.throws(
      () => loadNativeProviders(envOf({ MA_ANTHROPIC_MODELS: 'vendor/x:free=claude@1/1', MA_ANTHROPIC_API_KEY: 'k' }), ['vendor/x:free'], []),
      refusal(/in both MA_OPENROUTER_MODELS and MA_ANTHROPIC_MODELS/),
    );
  });
});

function serverConfig(providers: ServerConfig['providers'], openRouter = false): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: ':memory:',
    logLevel: 'error',
    controlPlaneUrl: 'http://127.0.0.1:0',
    corsOrigins: [],
    encryptionKeys: InMemoryKeyProvider.generate(),
    sandbox: { driver: 'local', leaseSeconds: 60, prewarmPerPool: 0, dialTimeoutMs: 30_000 },
    scheduler: { enabled: false, tickMs: 1000, batchSize: 5, auditRetentionDays: 0 },
    rateLimit: { ip: { limit: 10_000, windowMs: 60_000 }, principal: { limit: 10_000, windowMs: 60_000 } },
    modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
    artifacts: { root: ':memory:', maxMb: 25, retentionDays: 0 },
    trustForwardedFor: false,
    model: openRouter
      ? { provider: 'openrouter', apiKey: 'sk-or', models: ['vendor/x:free'], tools: true, allowPaid: false }
      : { provider: 'none', models: [], tools: true, allowPaid: false },
    ...(providers ? { providers } : {}),
  };
}

describe('wiring', () => {
  let fakes: ProviderFakes;
  let dir: string;
  before(async () => {
    fakes = new ProviderFakes();
    await fakes.start();
    fakes.models.anthropic.add('claude-sonnet-4-5');
    fakes.models.azure.add('gpt4o-prod');
    fakes.models.bedrock.add('amazon.nova-pro-v1:0');
    fakes.models.vertex.add('gemini-2.5-pro');
    dir = mkdtempSync(join(tmpdir(), 'ma-wiring-'));
  });
  after(async () => {
    await fakes.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function natives(): NonNullable<ServerConfig['providers']> {
    return {
      anthropic: { apiKey: FAKE_ANTHROPIC_KEY, baseUrl: fakes.origin, models: parseNativeModels('anthropic', 'v', 'claude-sonnet-4-5@3/15/0.3/3.75') },
      azureOpenai: { endpoint: fakes.origin, apiKey: FAKE_AZURE_KEY, apiVersion: '2024-10-21', models: parseNativeModels('azure-openai', 'v', 'gpt4o-prod@2.5/10/1.25/0') },
      bedrock: { region: FAKE_AWS.region, endpoint: fakes.origin, models: parseNativeModels('bedrock', 'v', 'amazon.nova-pro-v1:0@0.8/3.2') },
      vertex: {
        project: FAKE_VERTEX.project,
        location: FAKE_VERTEX.location,
        endpoint: fakes.origin,
        credentialsFile: fakes.writeServiceAccount(dir),
        models: parseNativeModels('vertex', 'v', 'gemini-2.5-pro@1.25/10/0.31/0'),
      },
    };
  }

  test('every native model is catalogued at its price in micro-dollars, and each id reaches its own provider', async () => {
    const wiring = await buildModelWiring(serverConfig(natives()), undefined, undefined, {
      env: { AWS_ACCESS_KEY_ID: FAKE_AWS.accessKeyId, AWS_SECRET_ACCESS_KEY: FAKE_AWS.secretAccessKey },
      clock: systemClock,
    });
    assert.ok(wiring);
    const byId = new Map(wiring.catalogue.map((row) => [row.id, row]));
    assert.deepEqual([...byId.keys()], ['anthropic/claude-sonnet-4-5', 'azure/gpt4o-prod', 'bedrock/amazon.nova-pro-v1:0', 'vertex/gemini-2.5-pro']);
    assert.deepEqual(byId.get('anthropic/claude-sonnet-4-5')?.pricing, {
      inputMicrosPerMillion: 3_000_000,
      outputMicrosPerMillion: 15_000_000,
      cacheReadMicrosPerMillion: 300_000,
      cacheWriteMicrosPerMillion: 3_750_000,
    });
    assert.equal(byId.get('bedrock/amazon.nova-pro-v1:0')?.provider, 'bedrock');
    assert.equal(byId.get('vertex/gemini-2.5-pro')?.contextWindowTokens, 1_048_576);
    assert.equal(byId.get('vertex/gemini-2.5-pro')?.compactThresholdTokens, 786_432);

    for (const id of byId.keys()) {
      const result = await wiring.models.complete({ modelId: id, messages: [{ role: 'user', content: `to ${id}` }], tools: [] });
      assert.equal(result.text, `echo: to ${id}`);
    }
    assert.deepEqual(
      fakes.calls.map((call) => `${call.provider}:${call.model}`),
      ['anthropic:claude-sonnet-4-5', 'azure:gpt4o-prod', 'bedrock:amazon.nova-pro-v1:0', 'vertex:gemini-2.5-pro'],
    );
  });

  test('with OpenRouter beside them, an id no native provider lists goes to OpenRouter', async () => {
    const wiring = await buildModelWiring(serverConfig({ anthropic: natives().anthropic! }, true), undefined, undefined, { clock: systemClock });
    assert.deepEqual(wiring?.catalogue.map((row) => row.id), ['vendor/x:free', 'anthropic/claude-sonnet-4-5']);
  });

  test('nothing configured is no wiring at all', async () => {
    assert.equal(await buildModelWiring(serverConfig(undefined)), undefined);
  });

  test("a native row whose model left the configuration is retired; a configured one is not; OpenRouter rows keep their own rule", () => {
    const guard = catalogueGuard(serverConfig({ anthropic: natives().anthropic! }, true))!;
    const row = (id: string, provider: string, paid = false): Model => ({
      id,
      provider,
      model: id,
      displayName: id,
      enabled: true,
      contextWindowTokens: 100_000,
      maxOutputTokens: 1000,
      compactThresholdTokens: 75_000,
      capabilities: { tools: true, vision: false, reasoningEffort: [], promptCaching: false },
      pricing: { inputMicrosPerMillion: paid ? 1 : 0, outputMicrosPerMillion: paid ? 1 : 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 },
      securityLevel: '',
      allowedWorkspaceIds: [],
    });
    assert.equal(guard(row('anthropic/claude-sonnet-4-5', 'anthropic', true)), undefined);
    assert.match(guard(row('anthropic/claude-opus-old', 'anthropic', true)) ?? '', /MA_ANTHROPIC_MODELS\) no longer includes it/);
    assert.match(guard(row('azure/gone', 'azure-openai', true)) ?? '', /MA_AZURE_OPENAI_MODELS/);
    assert.equal(guard(row('vendor/x:free', 'openrouter')), undefined);
    assert.match(guard(row('vendor/paid', 'openrouter', true)) ?? '', /paid models are not allowed/);
    assert.equal(guard(row('stub/echo', 'stub')), undefined, 'a row an embedder put there is not judged');
  });
});
