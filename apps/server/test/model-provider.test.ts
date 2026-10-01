/**
 * Model wiring tests.
 *
 * The catalogue the server starts with decides what a completion costs in the
 * platform's own accounting, and the daily cost cap reads nothing else. A paid
 * model catalogued at a price of zero is spend the cap cannot see, so these pin
 * the rule: a free model is catalogued free, a paid one only at its real price.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, type Logger } from '@ma/core';
import type { Model } from '@ma/contracts';

import type { ServerConfig } from '../src/config.ts';
import { buildModelWiring, type ModelPricer } from '../src/model-provider.ts';

function config(models: string[], allowPaid: boolean): ServerConfig {
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
    model: { provider: 'openrouter', apiKey: 'sk-test', models, tools: true, allowPaid },
  };
}

function pricedRow(id: string, input: number, output: number): Model {
  return {
    id,
    provider: 'openrouter',
    model: id,
    displayName: id,
    enabled: true,
    contextWindowTokens: 100_000,
    maxOutputTokens: 4096,
    compactThresholdTokens: 75_000,
    capabilities: { tools: true, vision: false, reasoningEffort: [], promptCaching: false },
    pricing: { inputMicrosPerMillion: input, outputMicrosPerMillion: output, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 },
    securityLevel: '',
    allowedWorkspaceIds: [],
  };
}

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string, fields?: Record<string, unknown>) => {
      warnings.push(`${message} ${JSON.stringify(fields ?? {})}`);
    },
    error: () => {},
    child: () => logger,
  } as unknown as Logger;
  return { logger, warnings };
}

describe('buildModelWiring', () => {
  test('catalogues free models at zero without asking the provider for prices', async () => {
    let asked = 0;
    const pricer: ModelPricer = {
      pricedModelsFor: () => {
        asked++;
        return Promise.resolve(new Map());
      },
    };
    const wiring = await buildModelWiring(config(['a/b:free', 'c/d:free'], false), undefined, pricer);
    assert.deepEqual(wiring?.catalogue.map((m) => m.id), ['a/b:free', 'c/d:free']);
    assert.ok(wiring?.catalogue.every((m) => m.pricing.inputMicrosPerMillion === 0 && m.pricing.outputMicrosPerMillion === 0));
    assert.equal(asked, 0, 'free-only startup needs no network');
  });

  test('catalogues an allowed paid model at its real price, so the cost cap sees its spend', async () => {
    const pricer: ModelPricer = {
      pricedModelsFor: (ids) => Promise.resolve(new Map(ids.map((id) => [id, pricedRow(id, 1_000_000, 2_000_000)]))),
    };
    const wiring = await buildModelWiring(config(['a/b:free', 'vendor/paid'], true), undefined, pricer);
    assert.deepEqual(wiring?.catalogue.map((m) => m.id), ['a/b:free', 'vendor/paid'], 'configured order is kept');
    const paid = wiring?.catalogue.find((m) => m.id === 'vendor/paid');
    assert.equal(paid?.pricing.inputMicrosPerMillion, 1_000_000);
    assert.equal(paid?.pricing.outputMicrosPerMillion, 2_000_000);
  });

  test('leaves out a paid model the provider cannot price, and says why', async () => {
    const { logger, warnings } = recordingLogger();
    const pricer: ModelPricer = {
      pricedModelsFor: () => Promise.resolve(new Map([['vendor/paid', { refused: "it charges by 'request'" }]])),
    };
    const wiring = await buildModelWiring(config(['a/b:free', 'vendor/paid'], true), logger, pricer);
    assert.deepEqual(wiring?.catalogue.map((m) => m.id), ['a/b:free']);
    assert.ok(warnings.some((w) => w.includes('vendor/paid') && w.includes("charges by 'request'")));
  });

  test('leaves out every paid model when prices cannot be fetched, keeping the free ones', async () => {
    const { logger, warnings } = recordingLogger();
    const pricer: ModelPricer = { pricedModelsFor: () => Promise.reject(new Error('catalogue unavailable')) };
    const wiring = await buildModelWiring(config(['vendor/paid', 'a/b:free'], true), logger, pricer);
    assert.deepEqual(wiring?.catalogue.map((m) => m.id), ['a/b:free']);
    assert.ok(warnings.some((w) => w.includes('vendor/paid')));
  });

  test('never catalogues a paid model when paid models are not allowed', async () => {
    const { logger } = recordingLogger();
    const pricer: ModelPricer = {
      pricedModelsFor: (ids) => Promise.resolve(new Map(ids.map((id) => [id, pricedRow(id, 1, 1)]))),
    };
    const wiring = await buildModelWiring(config(['vendor/paid', 'a/b:free'], false), logger, pricer);
    assert.deepEqual(wiring?.catalogue.map((m) => m.id), ['a/b:free']);
  });
});
