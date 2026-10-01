/**
 * First-run bootstrap tests.
 *
 * The bootstrap token becomes a permanent `ma:*` API key of a platform admin,
 * stored in the database. `.env.demo.example` publishes one for the demo, and
 * the launcher used to load that file for the production server too — so a
 * fresh production database could be opened with a token anyone can read in
 * the repository.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, MaError, nullLogger, systemClock } from '@ma/core';

import { PUBLISHED_DEMO_TOKEN, ensureBootstrapAdmin } from '../src/bootstrap.ts';
import type { ServerConfig } from '../src/config.ts';
import { buildPlatform } from '../src/platform.ts';

function config(token: string | undefined): ServerConfig {
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
    ...(token === undefined ? {} : { bootstrap: { subject: 'admin', token } }),
  };
}

describe('ensureBootstrapAdmin', () => {
  test('refuses to mint an admin from the token published in the repository', async () => {
    const cfg = config(PUBLISHED_DEMO_TOKEN);
    const platform = buildPlatform({ config: cfg, logger: nullLogger, clock: systemClock });
    await assert.rejects(ensureBootstrapAdmin(platform, cfg, systemClock), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.match(error.message, /\.env\.demo\.example/, 'says where the token is published');
      assert.match(error.message, /MA_BOOTSTRAP_TOKEN_FILE|--token-file/, 'says what to do instead');
      return true;
    });
    assert.equal((await platform.store.principals.list({ limit: 1 })).items.length, 0, 'no admin was created');
  });

  test('the demo entry may use it, on purpose', async () => {
    const cfg = config(PUBLISHED_DEMO_TOKEN);
    const platform = buildPlatform({ config: cfg, logger: nullLogger, clock: systemClock });
    const created = await ensureBootstrapAdmin(platform, cfg, systemClock, { allowPublishedToken: true });
    assert.equal(created?.token, PUBLISHED_DEMO_TOKEN);
  });

  test('is not consulted once the store has principals', async () => {
    const cfg = config(PUBLISHED_DEMO_TOKEN);
    const platform = buildPlatform({ config: cfg, logger: nullLogger, clock: systemClock });
    await ensureBootstrapAdmin(platform, config(undefined), systemClock);
    assert.equal(await ensureBootstrapAdmin(platform, cfg, systemClock), undefined, 'a running deployment ignores it');
  });
});
