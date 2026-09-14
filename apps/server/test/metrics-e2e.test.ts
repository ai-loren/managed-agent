/**
 * Metrics endpoint end-to-end test.
 *
 * Boots the whole platform with a metrics token, drives a couple of real
 * requests, and scrapes `/metrics` — proving the token gate, that RED counters
 * and the latency histogram actually move for real traffic, and that the
 * scrape-time session/sandbox gauges render. When no token is configured the
 * endpoint is off.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, nullLogger, systemClock } from '@ma/core';

import { buildPlatform, type Platform } from '../src/platform.ts';
import type { ServerConfig } from '../src/config.ts';

const METRICS_TOKEN = 'metrics-scrape-token-of-adequate-length';

function testConfig(withToken: boolean): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: ':memory:',
    logLevel: 'error',
    controlPlaneUrl: 'http://127.0.0.1:0',
    corsOrigins: [],
    encryptionKeys: InMemoryKeyProvider.generate(),
    sandbox: { driver: 'local', leaseSeconds: 60, prewarmPerPool: 0 },
    scheduler: { enabled: false, tickMs: 1000, batchSize: 5, auditRetentionDays: 0 },
    rateLimit: { limit: 10_000, windowMs: 60_000 },
    modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
    artifacts: { root: ':memory:', maxMb: 25, retentionDays: 0 },
    trustForwardedFor: false,
    ...(withToken ? { metrics: { token: METRICS_TOKEN } } : {}),
  };
}

describe('metrics endpoint', () => {
  let platform: Platform;
  let baseUrl: string;

  before(async () => {
    platform = buildPlatform({ config: testConfig(true), logger: nullLogger, clock: systemClock });
    const address = await platform.start();
    baseUrl = `http://${address.host}:${address.port}`;
  });

  after(async () => {
    await platform.stop();
  });

  async function scrape(token: string | undefined): Promise<{ status: number; body: string }> {
    const response = await fetch(`${baseUrl}/metrics`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.text() };
  }

  test('refuses a scrape with no token or a wrong token', async () => {
    assert.equal((await scrape(undefined)).status, 401);
    assert.equal((await scrape('wrong')).status, 401);
  });

  test('the metrics endpoint is not part of the tenant API (no principal needed)', async () => {
    // A valid scrape token alone works — no API key, no principal lookup.
    const ok = await scrape(METRICS_TOKEN);
    assert.equal(ok.status, 200);
  });

  test('records RED metrics for real traffic, labelled by route template', async () => {
    // Drive a request that will 401 (no auth) against a real API route, so the
    // metrics middleware records it under the route TEMPLATE, not the concrete id.
    await fetch(`${baseUrl}/health`); // a public 200
    await fetch(`${baseUrl}/v1/workspaces/ws_01ARZ3NDEKTSV4RRFFQ69G5FAV`); // 401, has a param

    const { status, body } = await scrape(METRICS_TOKEN);
    assert.equal(status, 200);

    // The counter exists and the health hit is counted.
    assert.match(body, /# TYPE http_requests_total counter/);
    assert.match(body, /http_requests_total\{[^}]*route="\/health"[^}]*status="200"\}/);

    // The workspace-by-id request is labelled by TEMPLATE (:workspaceId), never
    // the concrete id — the cardinality guarantee.
    assert.match(body, /route="\/v1\/workspaces\/:workspaceId"/);
    assert.doesNotMatch(body, /ws_01ARZ3NDEKTSV4RRFFQ69G5FAV/);

    // The latency histogram is present with buckets, sum and count.
    assert.match(body, /# TYPE http_request_duration_seconds histogram/);
    assert.match(body, /http_request_duration_seconds_bucket\{[^}]*le="\+Inf"[^}]*\}/);
    assert.match(body, /http_request_duration_seconds_count\{/);
  });

  test('renders scrape-time session and sandbox gauges', async () => {
    const { body } = await scrape(METRICS_TOKEN);
    // The collectors are registered and typed even with zero rows; a fresh store
    // may have no sessions, so assert the TYPE line (always emitted) is present.
    assert.match(body, /# TYPE ma_sessions gauge/);
    assert.match(body, /# TYPE ma_sandboxes gauge/);
    // Connector delivery receipts by status — the new collector.
    assert.match(body, /# TYPE ma_receipts gauge/);
  });

  test('the content type is the Prometheus text format', async () => {
    const response = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
  });
});

describe('metrics endpoint disabled', () => {
  test('returns 404 when no token is configured', async () => {
    const platform = buildPlatform({ config: testConfig(false), logger: nullLogger, clock: systemClock });
    const address = await platform.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/metrics`);
      assert.equal(response.status, 404);
    } finally {
      await platform.stop();
    }
  });
});
