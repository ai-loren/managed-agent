/**
 * Knowledge-base durability across a restart.
 *
 * The whole point of the fix this guards: a document ingested by one process
 * must still be retrievable by the next one. It exercises real durability, so it
 * uses a file-backed database and a real artifacts root on disk — a `:memory:`
 * database is per-connection and an in-memory blob store dies with the process,
 * neither of which would prove anything about a restart.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryKeyProvider, hashToken, newId, nullLogger, randomToken, systemClock } from '@ma/core';

import { buildPlatform, type Platform } from '../src/platform.ts';
import type { ServerConfig } from '../src/config.ts';

let dir: string;
let dbPath: string;
let artifactsRoot: string;
// A shared key provider so the second platform can decrypt what the first wrote.
const encryptionKeys = InMemoryKeyProvider.generate();

function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: dbPath,
    logLevel: 'error',
    controlPlaneUrl: 'http://127.0.0.1:0',
    corsOrigins: [],
    encryptionKeys,
    sandbox: { driver: 'local', leaseSeconds: 60, prewarmPerPool: 0 },
    scheduler: { enabled: false, tickMs: 1000, batchSize: 5, auditRetentionDays: 0 },
    rateLimit: { limit: 10_000, windowMs: 60_000 },
    modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
    artifacts: { root: artifactsRoot, maxMb: 25, retentionDays: 0 },
    trustForwardedFor: false,
  };
}

async function call(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ma-knowledge-durability-'));
  dbPath = join(dir, 'platform.db');
  artifactsRoot = join(dir, 'artifacts');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('knowledge base survives a platform restart', () => {
  test('a document ingested by one process is retrievable by the next', async () => {
    // --- Process 1: bootstrap, upload a document, ingest it, stop. ---
    const first = buildPlatform({ config: testConfig(), logger: nullLogger, clock: systemClock });
    const now = systemClock.now();
    const token = randomToken(32);
    const principal = await first.store.principals.create({
      id: newId('principal', now),
      type: 'user',
      subject: 'knowledge-admin',
      displayName: 'Admin',
      email: '',
      isAdmin: true,
      disabled: false,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'bootstrap',
    });
    await first.store.apiKeys.create({
      id: newId('apiKey', now),
      principalId: principal.id,
      name: 'knowledge',
      prefix: token.slice(0, 8),
      tokenHash: hashToken(token),
      scopes: ['ma:*'],
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });

    const address1 = await first.start();
    const baseUrl1 = `http://${address1.host}:${address1.port}`;

    const workspace = await call(baseUrl1, token, 'POST', '/v1/workspaces', {
      name: 'Knowledge',
      slug: 'knowledge-team',
    });
    assert.equal(workspace.status, 201);
    const workspaceId = workspace.body.workspace.id;

    const dataset = await call(baseUrl1, token, 'POST', `/v1/workspaces/${workspaceId}/datasets`, {
      name: 'Runbooks',
    });
    assert.equal(dataset.status, 201);
    const datasetId = dataset.body.dataset.id;

    const created = await call(baseUrl1, token, 'POST', `/v1/datasets/${datasetId}/documents`, {
      name: 'runbook.md',
      content: 'How to restart the payment service safely after a failover.',
    });
    assert.equal(created.status, 202);

    // Drain ingestion so the document reaches `ready` and its bytes are persisted.
    while (await first.services.ingestion.processNext()) {
      /* keep going until nothing is pending */
    }
    // Sanity: it is searchable in the process that ingested it.
    const live = await first.services.retrieval.search([datasetId], 'restart payment service');
    assert.equal(live.length, 1, 'searchable in the ingesting process');

    await first.stop();

    // --- Process 2: a brand-new platform on the SAME database and artifacts
    // root, with a fresh in-memory index. Without the fix its index would be
    // empty and the search below would return nothing. ---
    const second = buildPlatform({ config: testConfig(), logger: nullLogger, clock: systemClock });
    const address2 = await second.start();
    const baseUrl2 = `http://${address2.host}:${address2.port}`;

    try {
      const afterRestart = await second.services.retrieval.search(
        [datasetId],
        'restart payment service',
      );
      assert.equal(afterRestart.length, 1, 'the document is still retrievable after a restart');
      assert.ok(
        afterRestart[0]!.text.includes('payment service'),
        'and it is the right document',
      );

      // The document row is still ready (it was before), and retrieval works via
      // the HTTP surface's dataset listing too — the row and its index agree.
      const listed = await call(baseUrl2, token, 'GET', `/v1/datasets/${datasetId}/documents`);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.items[0]?.status, 'ready');
    } finally {
      await second.stop();
    }
  });
});
