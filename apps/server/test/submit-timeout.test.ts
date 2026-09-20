/**
 * The control plane must not hang on a wedged sandbox.
 *
 * `provisioner.submit` dials the sandbox's agent-core over HTTP. A sandbox that
 * accepts the TCP connection but never sends a response would, without a bounded
 * dial, block the awaiting caller forever — and because connector deliveries run
 * on a strictly serial loop, one wedged sandbox would stall every later delivery
 * on the replica. The lease heartbeat's `maxDeliverySeconds` backstop only reaps
 * the receipt row; it cannot cancel an in-flight fetch. So the dial itself must be
 * bounded, and the abort must surface as a *retryable* failure so the delivery
 * requeues rather than failing permanently.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';

import { InMemoryKeyProvider, MaError, hashToken, newId, nullLogger, randomToken, systemClock } from '@ma/core';

import { buildPlatform, type Platform } from '../src/platform.ts';
import type { ServerConfig } from '../src/config.ts';

/** A short dial timeout, so the wedged-sandbox case resolves in well under a second. */
const DIAL_TIMEOUT_MS = 300;

function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: ':memory:',
    logLevel: 'error',
    controlPlaneUrl: 'http://127.0.0.1:0',
    corsOrigins: [],
    encryptionKeys: InMemoryKeyProvider.generate(),
    sandbox: { driver: 'local', leaseSeconds: 60, prewarmPerPool: 0, dialTimeoutMs: DIAL_TIMEOUT_MS },
    scheduler: { enabled: false, tickMs: 1000, batchSize: 5, auditRetentionDays: 0 },
    rateLimit: { ip: { limit: 10_000, windowMs: 60_000 }, principal: { limit: 10_000, windowMs: 60_000 } },
    modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
    artifacts: { root: ':memory:', maxMb: 25, retentionDays: 0 },
    trustForwardedFor: false,
  };
}

describe('sandbox submit dial timeout', () => {
  let platform: Platform;
  let hung: Server;
  let hungPort: number;
  const openSockets: Socket[] = [];

  before(async () => {
    platform = buildPlatform({ config: testConfig(), logger: nullLogger, clock: systemClock });

    // A server that accepts the connection and then does nothing — the wedged
    // sandbox: it never writes HTTP response headers, so a fetch without a
    // timeout would await it forever.
    hung = createServer((socket) => {
      openSockets.push(socket);
      // Deliberately never respond.
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const address = hung.address();
    hungPort = typeof address === 'object' && address ? address.port : 0;
  });

  after(async () => {
    for (const socket of openSockets) socket.destroy();
    await new Promise<void>((resolve) => hung.close(() => resolve()));
    await platform.store.close();
  });

  test('a wedged sandbox aborts the submit dial as a retryable failure', async () => {
    const now = systemClock.now();
    const principal = await platform.store.principals.create({
      id: newId('principal', now),
      type: 'user',
      subject: 'submit-timeout',
      displayName: 'Tester',
      email: '',
      isAdmin: true,
      disabled: false,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'bootstrap',
    });
    const context = { principal };

    const workspace = await platform.services.workspaces.create(context, {
      name: 'Wedged',
      slug: 'wedged-team',
    });
    const agent = await platform.services.agents.create(context, {
      workspaceId: workspace.id,
      name: 'Stuck',
      spec: { model: { modelId: 'test/model' } },
    });
    const session = await platform.services.sessions.create(context, { agentId: agent.id });

    // Seed a `ready` session bound to a sandbox whose endpoint is the hung
    // server, exactly as a live provision would leave it — but the environment
    // never answers.
    const sandboxId = newId('sandbox');
    await platform.store.sandboxes.create({
      id: sandboxId,
      workspaceId: workspace.id,
      provider: 'local',
      status: 'ready',
      endpoint: `http://127.0.0.1:${hungPort}`,
      spec: {} as never,
      poolKey: 'wedged-pool',
      sessionIds: [session.id],
      leaseExpiresAt: now + 60_000,
      providerRef: 'wedged-' + sandboxId,
      runtimeTokenHash: hashToken(randomToken(32)),
      createdAt: now,
      updatedAt: now,
      createdBy: session.id,
    });
    await platform.store.sessions.compareAndSetStatus(session.id, 'queued', 'ready', {
      sandboxId,
    });

    // The submit must abort on the dial timeout and surface a *retryable* error
    // (so the delivery pipeline requeues), rather than hanging until the test's
    // own timeout. Bound the assertion well above the dial timeout but far below
    // any accidental 30s default, so a regression (no timeout) fails loudly.
    const startedAt = systemClock.monotonic();
    await assert.rejects(
      platform.services.sessions.submit(context, session.id, {
        events: [{ type: 'user.message', text: 'anyone home?' }],
      }),
      (error: unknown) => MaError.is(error) && error.retryable,
      'a wedged submit must reject with a retryable error, not hang',
    );
    const elapsed = systemClock.monotonic() - startedAt;
    assert.ok(
      elapsed < 5_000,
      `the submit must abort near the ${DIAL_TIMEOUT_MS}ms dial timeout, not hang (took ${Math.round(elapsed)}ms)`,
    );
  });
});
