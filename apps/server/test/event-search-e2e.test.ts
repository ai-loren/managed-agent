/**
 * Event-log search against a real server process.
 *
 * The database is left at the schema from before the search index existed,
 * with a history already logged, so the server's own boot runs the upgrade
 * that backfills it. Everything after that goes over HTTP: value-only
 * matching on the backfilled rows, a search that stops at its per-request cap
 * and resumes, and a flood of searches that must neither stall the event loop
 * for everyone else nor queue without end.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashToken, newId, randomToken } from '@ma/core';
import { Database, MIGRATIONS, SqliteStore } from '@ma/store';

const SERVER = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const NOW = 1_700_000_000_000;
/** More than one search request examines (100,000), so the oldest event needs a second request. */
const LOGGED = 120_000;
const FILLER = 'routine tool output line with nothing of interest in it, padded to look like a real log entry';

let dir: string;
let server: ChildProcess;
/** The server's stderr, for the message of a failed assertion. */
let serverLog = '';
let baseUrl: string;
let token: string;
let sessionId: string;

async function seedLegacyDatabase(path: string): Promise<void> {
  const db = new Database({ location: path });
  // Every migration but the one that introduced search text, so the store can
  // still write today's rows while the events predate the index.
  db.migrate(MIGRATIONS.filter((migration) => migration.id !== 23));
  const store = new SqliteStore(db);

  token = randomToken(32);
  const principal = await store.principals.create({
    id: newId('principal', NOW),
    type: 'user',
    subject: 'search-e2e-admin',
    displayName: 'Admin',
    email: '',
    isAdmin: true,
    disabled: false,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'bootstrap',
  });
  await store.apiKeys.create({
    id: newId('apiKey', NOW),
    principalId: principal.id,
    name: 'e2e',
    prefix: token.slice(0, 8),
    tokenHash: hashToken(token),
    scopes: ['ma:*'],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: principal.id,
  });
  const workspace = await store.workspaces.create({
    id: newId('workspace', NOW),
    slug: 'search-e2e',
    name: 'Search e2e',
    description: '',
    status: 'active',
    members: [],
    quota: {
      maxConcurrentSessions: 20,
      maxSandboxes: 20,
      maxTokensPerDay: 1_000_000,
      maxCostMicrosPerDay: 0,
      maxStorageMb: 1024,
      maxAgents: 100,
      maxKnowledgeChunks: 100_000,
      eventRetentionDays: 3650,
    },
    systemPrompt: '',
    version: 1,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: principal.id,
  });
  const agent = await store.agents.create({
    id: newId('agent', NOW),
    workspaceId: workspace.id,
    name: 'Searcher',
    description: '',
    status: 'active',
    latestVersion: 0,
    labels: [],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: principal.id,
  });
  const session = await store.sessions.create({
    id: newId('session', NOW),
    workspaceId: workspace.id,
    agentId: agent.id,
    resolvedVersion: 1,
    title: '',
    status: 'terminated',
    origin: 'api',
    credentialIds: [],
    lastSeq: 0,
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: principal.id,
  });
  sessionId = session.id;

  // Written the way the previous release wrote them: the events table only.
  db.transaction(() => {
    for (let seq = 1; seq <= LOGGED; seq++) {
      const payload =
        seq === 1
          ? { role: 'assistant', text: 'the needle-ancient "quoted" answer' }
          : { role: 'assistant', text: `${FILLER} #${seq}`, tokens: seq * 1000 + 7 };
      db.run(
        `INSERT INTO events (session_id, seq, id, workspace_id, ts, type, turn, item_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, seq, `ev_${seq}`, workspace.id, NOW + seq, 'message.completed', 1, null, JSON.stringify(payload)],
      );
    }
    db.run('UPDATE sessions SET last_seq = ? WHERE id = ?', [LOGGED, sessionId]);
  });
  db.close();
}

function startServer(path: string): Promise<string> {
  server = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      MA_DATABASE: path,
      MA_HOST: '127.0.0.1',
      MA_PORT: '0',
      MA_SCHEDULER: 'off',
      MA_LOG_LEVEL: 'error',
      MA_ARTIFACT_ROOT: join(dir, 'artifacts'),
      MA_RATE_LIMIT: '100000',
      MA_RATE_LIMIT_IP: '100000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    server.stderr!.on('data', (chunk: Buffer) => {
      serverLog += chunk.toString();
      const match = /listening on (http:\/\/[^\s]+)/.exec(serverLog);
      if (match) resolve(match[1]!);
    });
    server.once('exit', (code) => reject(new Error(`the server exited (${code}) before listening:\n${serverLog}`)));
  });
}

async function get(path: string): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status >= 500) assert.fail(`GET ${path} answered ${response.status}; server log:\n${serverLog}`);
  return { status: response.status, headers: response.headers, body };
}

type SearchBody = {
  events: { seq: number; payload: { text?: string } }[];
  search: { scanned: number; truncated: boolean; resumeSeq?: number };
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ma-search-e2e-'));
  const path = join(dir, 'ma.db');
  await seedLegacyDatabase(path);
  baseUrl = await startServer(path);
});

after(() => {
  server?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('event-log search on a real server', () => {
  test('history logged before the upgrade is searchable by value once the server has booted', async () => {
    const page = (await get(`/v1/sessions/${sessionId}/events?order=desc&limit=5&q=${encodeURIComponent('needle-ancient "quoted"')}`)).body as SearchBody;
    assert.deepEqual(page.events, [], 'seq 1 lies past what one request examines');
    assert.equal(page.search.scanned, 100_000);
    assert.equal(page.search.truncated, true);
    assert.equal(page.search.resumeSeq, LOGGED - 100_000 + 1);

    const rest = (await get(
      `/v1/sessions/${sessionId}/events?order=desc&limit=5&toSeq=${page.search.resumeSeq}&q=${encodeURIComponent('needle-ancient "quoted"')}`,
    )).body as SearchBody;
    assert.deepEqual(rest.events.map((e) => e.seq), [1], 'the quote matches as written, not as JSON escapes it');
    assert.equal(rest.search.truncated, false);

    const key = (await get(`/v1/sessions/${sessionId}/events?order=asc&limit=5&toSeq=1000&q=role`)).body as SearchBody;
    assert.deepEqual(key.events, [], 'a field name is not a value');
    const number = (await get(`/v1/sessions/${sessionId}/events?order=desc&limit=5&q=119999007`)).body as SearchBody;
    assert.deepEqual(number.events.map((e) => e.seq), [119_999], 'a number in the payload is a value');
  });

  test('a flood of searches neither stalls other requests nor queues without end', async () => {
    let flooding = true;
    const latencies: number[] = [];
    const probe = (async () => {
      while (flooding) {
        const started = performance.now();
        const response = await fetch(`${baseUrl}/health`);
        await response.arrayBuffer();
        latencies.push(performance.now() - started);
      }
    })();

    const results = await Promise.all(
      Array.from({ length: 30 }, () => get(`/v1/sessions/${sessionId}/events?order=desc&q=nothing-matches-this`)),
    );
    flooding = false;
    await probe;

    const served = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 429);
    assert.equal(served.length + refused.length, 30, `unexpected statuses: ${results.map((r) => r.status).join(',')}`);
    assert.equal(served.length, 18, 'two run and sixteen wait');
    for (const result of served) {
      const body = result.body as SearchBody;
      assert.equal(body.search.scanned, 100_000);
      assert.equal(body.search.truncated, true);
    }
    for (const result of refused) {
      assert.equal((result.body.error as { code: string }).code, 'SEARCH_BUSY');
      assert.equal(result.headers.get('retry-after'), '1');
    }

    const worst = Math.max(...latencies);
    assert.ok(latencies.length >= 5, `the health probe ran ${latencies.length} times`);
    assert.ok(worst < 250, `the slowest health check took ${worst.toFixed(0)} ms while ${served.length} searches ran`);
  });
});
