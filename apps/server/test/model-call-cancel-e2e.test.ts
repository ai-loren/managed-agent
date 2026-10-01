/**
 * Model-call cancellation over real HTTP.
 *
 * The bridge can only cancel an upstream call if the completions route hands it
 * the request's abort signal; a unit test of the bridge cannot see whether the
 * route does. This drives the real server: a sandbox's completion request is
 * dropped mid-call, and the upstream call must be cancelled with it rather than
 * left running against a caller that is gone.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, newId, nullLogger, systemClock } from '@ma/core';
import type { Model } from '@ma/contracts';
import type { ModelProvider } from '@ma/gateway';

import { buildPlatform, type Platform } from '../src/platform.ts';
import type { ServerConfig } from '../src/config.ts';

const MODEL: Model = {
  id: 'test/model',
  provider: 'test',
  model: 'model',
  displayName: 'Test',
  enabled: true,
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  compactThresholdTokens: 80_000,
  capabilities: { tools: false, vision: false, reasoningEffort: [], promptCaching: false },
  pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 },
  securityLevel: '',
  allowedWorkspaceIds: [],
};

function testConfig(): ServerConfig {
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
  };
}

let platform: Platform;
let baseUrl: string;
let upstreamSignal: AbortSignal | undefined;
let markCalled = (): void => {};
const called = new Promise<void>((resolve) => {
  markCalled = resolve;
});

const hungProvider: ModelProvider = {
  complete: (request) => {
    upstreamSignal = request.signal;
    markCalled();
    return new Promise(() => {});
  },
};

before(async () => {
  platform = buildPlatform({
    config: testConfig(),
    logger: nullLogger,
    clock: systemClock,
    models: hungProvider,
    modelCatalogue: [MODEL],
  });
  const address = await platform.start();
  baseUrl = `http://${address.host}:${address.port}`;
});

after(async () => {
  await platform.stop();
});

describe('model call cancellation', () => {
  test('a sandbox that drops its completion request cancels the upstream call', async () => {
    const now = systemClock.now();
    const principal = await platform.store.principals.create({
      id: newId('principal', now),
      type: 'user',
      subject: 'cancel-e2e',
      displayName: 'Admin',
      email: '',
      isAdmin: true,
      disabled: false,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'bootstrap',
    });
    const context = { principal };
    const workspace = await platform.services.workspaces.create(context, { name: 'Cancel', slug: 'cancel-e2e' });
    const agent = await platform.services.agents.create(context, {
      workspaceId: workspace.id,
      name: 'Hung',
      spec: { model: { modelId: 'test/model' }, systemPrompt: 'p' },
    });
    const session = await platform.services.sessions.create(context, { agentId: agent.id });
    const runtimeToken = `rt-${newId('event')}`;
    platform.runtime.bind(runtimeToken, session.id, newId('sandbox'));

    const sandboxSide = new AbortController();
    const request = fetch(`${baseUrl}/runtime/v1/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: sandboxSide.signal,
    }).catch((error: unknown) => error);

    await called;
    assert.ok(upstreamSignal, 'the bridge hands the provider a signal');
    assert.equal(upstreamSignal.aborted, false, 'the call is live while the sandbox waits');

    const cancelled = new Promise<void>((resolve) => {
      upstreamSignal!.addEventListener('abort', () => resolve(), { once: true });
    });
    sandboxSide.abort();
    await request;
    await Promise.race([
      cancelled,
      systemClock.sleep(5_000).then(() => {
        throw new Error('the upstream call was still running 5s after the sandbox dropped its request');
      }),
    ]);
    assert.equal(upstreamSignal.aborted, true);
  });
});
