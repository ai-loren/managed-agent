/**
 * The free-only guard over a persisted catalogue.
 *
 * A file database keeps catalogue rows across restarts. A deployment that once
 * ran with paid models allowed, then turned that off to stop spending, must not
 * keep calling the paid rows it catalogued back then: free-only has to hold for
 * what is already in the catalogue, not only for what config adds at startup.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, nullLogger, systemClock } from '@ma/core';
import type { Model } from '@ma/contracts';

import type { ServerConfig } from '../src/config.ts';
import { paidModelGuard } from '../src/model-provider.ts';
import { buildPlatform } from '../src/platform.ts';

function config(allowPaid: boolean, provider: 'openrouter' | 'none' = 'openrouter'): ServerConfig {
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
    model: provider === 'openrouter'
      ? { provider, apiKey: 'sk-test', models: [], tools: true, allowPaid }
      : { provider, models: [], tools: true, allowPaid },
  };
}

function row(id: string, provider: string, inputMicros: number): Model {
  return {
    id,
    provider,
    model: id,
    displayName: id,
    enabled: true,
    contextWindowTokens: 100_000,
    maxOutputTokens: 4096,
    compactThresholdTokens: 75_000,
    capabilities: { tools: true, vision: false, reasoningEffort: [], promptCaching: false },
    pricing: { inputMicrosPerMillion: inputMicros, outputMicrosPerMillion: inputMicros, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 },
    securityLevel: '',
    allowedWorkspaceIds: [],
  };
}

describe('paidModelGuard', () => {
  test('in free-only mode it retires OpenRouter rows that are not free', () => {
    const guard = paidModelGuard(config(false));
    assert.ok(guard);
    assert.match(guard(row('openai/gpt-4o', 'openrouter', 2_500_000)) ?? '', /ALLOW_PAID/);
    assert.ok(guard(row('vendor/x:free', 'openrouter', 1)), 'a :free id with a price is not free either');
    assert.ok(guard(row('google/lyria-3-pro-preview', 'openrouter', 0)), 'zero-priced but not a :free variant');
    assert.equal(guard(row('vendor/x:free', 'openrouter', 0)), undefined);
    assert.equal(guard(row('internal/model', 'acme', 9)), undefined, "another provider's rows are not this guard's business");
  });

  test('there is nothing to guard when paid models are allowed or no provider is wired', () => {
    assert.equal(paidModelGuard(config(true)), undefined);
    assert.equal(paidModelGuard(config(false, 'none')), undefined);
  });
});

describe('startup over a persisted catalogue', () => {
  test('free-only startup switches off paid rows a previous run catalogued', async () => {
    const cfg = config(false);
    const guard = paidModelGuard(cfg);
    const platform = buildPlatform({ config: cfg, logger: nullLogger, clock: systemClock, ...(guard ? { retireModel: guard } : {}) });
    await platform.store.models.upsert(row('openai/gpt-4o', 'openrouter', 2_500_000));
    await platform.store.models.upsert(row('vendor/x:free', 'openrouter', 0));
    await platform.start();
    try {
      assert.equal((await platform.store.models.get('openai/gpt-4o'))?.enabled, false, 'the paid row no longer serves calls');
      assert.equal((await platform.store.models.get('vendor/x:free'))?.enabled, true);
    } finally {
      await platform.stop();
    }
  });
});
