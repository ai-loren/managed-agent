/**
 * Store tests.
 *
 * These run against the real SQLite driver, not a mock — the whole reason the
 * reference implementation is embedded is so the test suite exercises actual
 * SQL, actual transactions and actual constraint violations.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, newId } from '@ma/core';
import type { Agent, Artifact, Receipt, Sandbox, Session, SessionEvent, Workspace } from '@ma/contracts';

import {
  createMemoryStore,
  Database,
  openDatabase,
  MIGRATIONS,
  SqliteStore,
  TURNLESS_BILLED_TURN,
} from '../src/index.ts';

const NOW = 1_700_000_000_000;

let store: SqliteStore;

beforeEach(() => {
  store = createMemoryStore();
});

afterEach(async () => {
  await store.close();
});

// --- fixtures --------------------------------------------------------------

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: newId('workspace'),
    slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Test Workspace',
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
      eventRetentionDays: 90,
    },
    systemPrompt: '',
    version: 1,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'pr_test',
    ...overrides,
  };
}

function makeAgent(workspaceId: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id: newId('agent'),
    workspaceId,
    name: 'Test Agent',
    description: '',
    status: 'active',
    latestVersion: 0,
    labels: [],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'pr_test',
    ...overrides,
  };
}

function makeSession(workspaceId: string, agentId: string, overrides: Partial<Session> = {}): Session {
  return {
    id: newId('session'),
    workspaceId,
    agentId,
    resolvedVersion: 1,
    title: '',
    status: 'queued',
    origin: 'api',
    credentialIds: [],
    lastSeq: 0,
    turnCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 0,
    },
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'pr_test',
    ...overrides,
  };
}

function makeSandbox(workspaceId: string, overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: newId('sandbox'),
    workspaceId,
    provider: 'local',
    status: 'ready',
    endpoint: 'http://localhost:9000',
    spec: {} as Sandbox['spec'],
    poolKey: 'pool-a',
    sessionIds: [],
    leaseExpiresAt: NOW + 60_000,
    providerRef: '',
    runtimeTokenHash: '',
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'pr_test',
    ...overrides,
  };
}

function makeEvent(
  workspaceId: string,
  sessionId: string,
  overrides: Partial<Omit<SessionEvent, 'seq'>> = {},
): Omit<SessionEvent, 'seq'> {
  return {
    id: newId('event'),
    sessionId,
    workspaceId,
    ts: NOW,
    type: 'message.delta',
    payload: { text: 'hi' },
    ...overrides,
  } as Omit<SessionEvent, 'seq'>;
}

async function seed(): Promise<{ workspace: Workspace; agent: Agent }> {
  const workspace = await store.workspaces.create(makeWorkspace());
  const agent = await store.agents.create(makeAgent(workspace.id));
  return { workspace, agent };
}

// --- a busy database ---------------------------------------------------------

describe('a database another writer holds', () => {
  test('waiting out the busy timeout is a retryable unavailable error, on writes and on beginning a transaction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ma-busy-'));
    const holder = new Database({ location: join(dir, 'db.sqlite') });
    holder.exec('CREATE TABLE t (x INTEGER)');
    const waiter = new Database({ location: join(dir, 'db.sqlite'), busyTimeoutMs: 50 });
    holder.exec('BEGIN IMMEDIATE');
    try {
      const busy = (error: unknown): boolean => {
        assert.ok(MaError.is(error), `expected an MaError, got ${String(error)}`);
        assert.equal(error.code, 'STORE_BUSY');
        assert.equal(error.category, 'unavailable');
        assert.equal(error.retryable, true);
        assert.match(error.message, /nothing was changed\. Retry shortly/);
        return true;
      };
      assert.throws(() => waiter.run('INSERT INTO t (x) VALUES (1)'), busy);
      assert.throws(() => waiter.transaction(() => waiter.run('INSERT INTO t (x) VALUES (2)')), busy);
      assert.throws(() => waiter.begin(), busy);
    } finally {
      holder.exec('ROLLBACK');
      waiter.close();
      holder.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// --- migrations ------------------------------------------------------------

describe('migrations', () => {
  test('are idempotent', () => {
    assert.equal(store.database.migrate(), 0, 're-running applied migrations must be a no-op');
  });

  test('refuse to run when an applied migration was edited', () => {
    // Editing a shipped migration would leave environments silently divergent.
    const tampered = [
      { id: 1, name: 'initial_schema', statements: ['CREATE TABLE tampered (id TEXT)'] },
    ];
    assert.throws(() => store.database.migrate(tampered), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'CONFLICT');
      return true;
    });
  });

  test('a migration already recorded is not re-run (idempotent + inner re-check)', () => {
    // The target deployment shares one SQLite file across replicas. The runner
    // snapshots the applied-set before its loop, but two replicas booting together
    // both see an empty snapshot and both enter the loop for the same migration;
    // the DDL is raw (not IF NOT EXISTS), so the second would throw and crash the
    // replica. The fix re-checks inside the write transaction. This asserts the
    // observable behavior — re-running the same migration set is a clean no-op, the
    // raw CREATE TABLE (which would throw 'table already exists') is never re-run,
    // and nothing is double-counted. The true-simultaneity protection is the
    // single-writer lock serializing the transactions plus the inner re-read.
    const db = openDatabase({ location: ':memory:' });
    // A high id so it does not collide with the real migrations openDatabase()
    // already applied; raw CREATE TABLE (not IF NOT EXISTS) so a re-run would throw.
    const migration = { id: 9999, name: 'only', statements: ['CREATE TABLE thing (id TEXT)'] };
    const all = [...MIGRATIONS, migration];

    assert.equal(db.migrate(all), 1, 'the one new migration applies (the real ones are already applied)');
    assert.equal(db.migrate(all), 0, 'a second run re-applies nothing and does not throw');
    db.run('INSERT INTO thing (id) VALUES (?)', ['x']);
    assert.equal(db.all('SELECT id FROM thing').length, 1, 'the table exists exactly once and is usable');
    db.close();
  });
});

describe('hot-sweep query plans', () => {
  const planner = { skip: process.env.MA_TEST_POSTGRES_URL ? "SQLite's planner: Postgres has no INDEXED BY and plans from statistics" : false };
  // These queries run on every scheduler / retention tick against tables that
  // only ever grow (no hard-delete). A full scan here is unbounded cost, so each
  // must be driven by an index. `EXPLAIN QUERY PLAN` naming a bare `SCAN <table>`
  // (as opposed to `SCAN ... USING INDEX` or `SEARCH`) is the regression.
  const plan = (sql: string, params: unknown[] = []): string =>
    store.database
      .all(`EXPLAIN QUERY PLAN ${sql}`, params as never)
      .map((row) => String((row as { detail?: unknown }).detail ?? ''))
      .join('\n');

  const usesIndex = (detail: string, table: string): boolean =>
    // A plan is index-driven when it does not full-scan the table. SQLite prints
    // a plain `SCAN <table>` for a full scan and `SCAN <table> USING ... INDEX`
    // or `SEARCH <table> USING ... INDEX` when an index drives it.
    !new RegExp(`SCAN ${table}(?! USING)`).test(detail);

  test('findExpired is driven by idx_sessions_expiry, not a full scan', planner, () => {
    const detail = plan(
      `SELECT * FROM sessions INDEXED BY idx_sessions_expiry
        WHERE expires_at IS NOT NULL AND expires_at < ? AND ended_at IS NULL
          AND status NOT IN ('terminated', 'failed')
        ORDER BY expires_at LIMIT ?`,
      [1, 50],
    );
    assert.ok(usesIndex(detail, 'sessions'), `findExpired full-scans sessions:\n${detail}`);
    assert.ok(/idx_sessions_expiry/.test(detail), `expected idx_sessions_expiry:\n${detail}`);
  });

  test('findSessionsWithExpiredEvents is driven by idx_events_ts, not a full scan', planner, () => {
    const detail = plan(
      `SELECT session_id, MIN(ts) AS oldest FROM events INDEXED BY idx_events_ts
        WHERE ts < ? GROUP BY session_id HAVING oldest > ? ORDER BY oldest ASC LIMIT ?`,
      [1, 0, 50],
    );
    assert.ok(/idx_events_ts/.test(detail), `expected idx_events_ts:\n${detail}`);
    // Explicitly reject the PK-autoindex full scan the un-hinted query picks:
    // `SCAN events USING INDEX sqlite_autoindex_events_1` reads every row.
    assert.ok(
      !/sqlite_autoindex_events/.test(detail),
      `still full-scanning events via the PK autoindex:\n${detail}`,
    );
  });

  test('without the hint, the events sweep regresses to a full scan (why INDEXED BY is load-bearing)', planner, () => {
    // Documents the bug: with no ANALYZE (never run in production), the planner
    // ignores idx_events_ts and full-scans events via the primary-key autoindex.
    // This is the un-hinted query — it MUST show the regression, proving the hint
    // in the real method is doing real work.
    const detail = plan(
      `SELECT session_id, MIN(ts) AS oldest FROM events
        WHERE ts < ? GROUP BY session_id ORDER BY oldest ASC LIMIT ?`,
      [1, 50],
    );
    assert.ok(
      /SCAN events/.test(detail) && !/idx_events_ts/.test(detail),
      `expected the un-hinted query to full-scan (documents why the hint matters):\n${detail}`,
    );
  });

  test('findQueued is driven by idx_sessions_queued, not a full scan', planner, () => {
    const detail = plan(
      `SELECT * FROM sessions INDEXED BY idx_sessions_queued
        WHERE status = 'queued' AND archived_at IS NULL ORDER BY created_at LIMIT ?`,
      [50],
    );
    assert.ok(usesIndex(detail, 'sessions'), `findQueued full-scans sessions:\n${detail}`);
    assert.ok(/idx_sessions_queued/.test(detail), `expected idx_sessions_queued:\n${detail}`);
  });

  test('findUpgradable confines its scan via idx_sessions_upgradable', planner, () => {
    const detail = plan(
      `SELECT s.* FROM sessions s INDEXED BY idx_sessions_upgradable
         JOIN agents a ON a.id = s.agent_id
        WHERE s.status IN ('ready', 'idle')
          AND a.production_version IS NOT NULL
          AND s.resolved_version < a.production_version
        ORDER BY s.updated_at LIMIT ?`,
      [50],
    );
    // The sessions side must not be a full scan (the join drives agents by PK).
    assert.ok(usesIndex(detail, 'sessions'), `findUpgradable full-scans sessions:\n${detail}`);
    assert.ok(/idx_sessions_upgradable/.test(detail), `expected idx_sessions_upgradable:\n${detail}`);
  });

  test('findPending is driven by idx_documents_pending, not a full scan', planner, () => {
    // Runs up to five times per scheduler tick; the only other documents index is
    // dataset_id-leading, so a status-only scan would otherwise full-scan.
    const detail = plan(
      `SELECT * FROM documents INDEXED BY idx_documents_pending
        WHERE status = 'pending' ORDER BY created_at LIMIT ?`,
      [1],
    );
    assert.ok(usesIndex(detail, 'documents'), `findPending full-scans documents:\n${detail}`);
    assert.ok(/idx_documents_pending/.test(detail), `expected idx_documents_pending:\n${detail}`);
  });

  test('findFailed is driven by idx_documents_failed, not a full scan', planner, () => {
    // The reprocess sweep runs every tick; without a partial `failed` index it
    // full-scanned the ever-growing documents table (the only other index is
    // dataset_id-leading). Migration 18 adds the index; the method forces it.
    const detail = plan(
      `SELECT * FROM documents INDEXED BY idx_documents_failed
        WHERE status = 'failed' ORDER BY updated_at LIMIT ?`,
      [1],
    );
    assert.ok(usesIndex(detail, 'documents'), `findFailed full-scans documents:\n${detail}`);
    assert.ok(/idx_documents_failed/.test(detail), `expected idx_documents_failed:\n${detail}`);
  });

  test('findStaleProcessing is driven by idx_documents_processing, not a full scan', planner, () => {
    // The stuck-worker recovery sweep runs every tick with the same full-scan
    // hazard. The partial `processing` index serves both the updated_at range
    // filter and the ORDER BY.
    const detail = plan(
      `SELECT * FROM documents INDEXED BY idx_documents_processing
        WHERE status = 'processing' AND updated_at < ? ORDER BY updated_at LIMIT ?`,
      [1, 1],
    );
    assert.ok(usesIndex(detail, 'documents'), `findStaleProcessing full-scans documents:\n${detail}`);
    assert.ok(/idx_documents_processing/.test(detail), `expected idx_documents_processing:\n${detail}`);
  });

  test('the hot sweep methods run and return correct rows (the INDEXED BY hints resolve)', async () => {
    // Drives the *real* repository methods, not hand-copied SQL. A method whose
    // INDEXED BY names an index that migrations did not create throws
    // "no such index" here — so this fails loudly if a hint and a migration ever
    // drift apart, and confirms the forced index still returns the right rows.
    const now = 1_700_000_000_000;
    const ws = await store.workspaces.create(makeWorkspace({ slug: 'sweep' }));
    const agent = await store.agents.create(
      makeAgent(ws.id, { latestVersion: 2, productionVersion: 2 }),
    );

    const queued = await store.sessions.create(
      makeSession(ws.id, agent.id, { status: 'queued', createdAt: now - 10 }),
    );
    const expired = await store.sessions.create(
      makeSession(ws.id, agent.id, { status: 'ready', expiresAt: now - 1 }),
    );
    const upgradable = await store.sessions.create(
      makeSession(ws.id, agent.id, { status: 'ready', resolvedVersion: 1 }),
    );
    // Two terminated sessions must both be excluded from expired: one with
    // ended_at set (the engine's normal case — excluded by the index predicate)
    // and one without (excluded by the residual status filter, the defensive
    // half that survives a terminal row that never recorded an ended_at).
    const terminatedWithEnded = await store.sessions.create(
      makeSession(ws.id, agent.id, { status: 'terminated', expiresAt: now - 1, endedAt: now - 1 }),
    );
    const terminatedNoEnded = await store.sessions.create(
      makeSession(ws.id, agent.id, { status: 'failed', expiresAt: now - 1 }),
    );

    const queuedRows = await store.sessions.findQueued(50);
    assert.ok(queuedRows.some((s) => s.id === queued.id), 'findQueued returns the queued session');

    const expiredRows = await store.sessions.findExpired(now, 50);
    const expiredIds = new Set(expiredRows.map((s) => s.id));
    assert.ok(expiredIds.has(expired.id), 'findExpired returns the expired session');
    assert.ok(
      !expiredIds.has(terminatedWithEnded.id),
      'findExpired excludes a terminated session (ended_at set)',
    );
    assert.ok(
      !expiredIds.has(terminatedNoEnded.id),
      'findExpired excludes a terminal session even without ended_at (residual status filter)',
    );

    const upgradableRows = await store.sessions.findUpgradable(50);
    assert.ok(
      upgradableRows.some((s) => s.id === upgradable.id),
      'findUpgradable returns the behind-version session',
    );
  });

  test('findPending runs and returns pending documents (idx_documents_pending resolves)', async () => {
    const now = 1_700_000_000_000;
    const ws = await store.workspaces.create(makeWorkspace({ slug: 'docs' }));
    const dataset = await store.datasets.create({
      id: newId('dataset'),
      workspaceId: ws.id,
      name: 'D',
      description: '',
      status: 'active',
      documentCount: 0,
      chunkCount: 0,
      sizeBytes: 0,
      embeddingModel: '',
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'sys',
    } as never);

    const mkDoc = (status: string): never =>
      ({
        id: newId('document'),
        datasetId: dataset.id,
        workspaceId: ws.id,
        name: `doc-${status}`,
        source: 'inline',
        sourceRef: '',
        contentType: 'text/plain',
        sizeBytes: 0,
        digest: '',
        status,
        syncRule: 'manual',
        chunkCount: 0,
        metadata: {},
        createdAt: now,
        updatedAt: now,
        createdBy: 'sys',
      }) as never;

    const pending = await store.documents.create(mkDoc('pending'));
    await store.documents.create(mkDoc('ready'));

    const rows = await store.documents.findPending(10);
    assert.ok(rows.some((d) => d.id === (pending as { id: string }).id), 'returns the pending document');
    assert.ok(!rows.some((d) => d.status !== 'pending'), 'returns only pending documents');

    // Drive the two recovery sweeps too, so a hint that names an index migration
    // 18 did not create throws "no such index" here rather than in production.
    const failed = await store.documents.create(mkDoc('failed'));
    const failedRows = await store.documents.findFailed(10);
    assert.ok(failedRows.some((d) => d.id === (failed as { id: string }).id), 'findFailed returns the failed document');
    assert.ok(!failedRows.some((d) => d.status !== 'failed'), 'findFailed returns only failed documents');

    const processing = await store.documents.create(mkDoc('processing'));
    // updated_at == now; stale cutoff strictly greater so the row qualifies.
    const staleRows = await store.documents.findStaleProcessing(now + 1, 10);
    assert.ok(
      staleRows.some((d) => d.id === (processing as { id: string }).id),
      'findStaleProcessing returns the stuck processing document',
    );
    assert.ok(!staleRows.some((d) => d.status !== 'processing'), 'findStaleProcessing returns only processing documents');
  });
});

// --- crud ------------------------------------------------------------------

describe('workspace repository', () => {
  test('round-trips a workspace with its nested quota intact', async () => {
    const created = await store.workspaces.create(makeWorkspace({ name: 'Platform' }));
    const found = await store.workspaces.get(created.id);
    assert.equal(found?.name, 'Platform');
    assert.equal(found?.quota.maxConcurrentSessions, 20);
  });

  test('enforces slug uniqueness as a conflict, not an internal error', async () => {
    await store.workspaces.create(makeWorkspace({ slug: 'taken' }));
    await assert.rejects(
      async () => store.workspaces.create(makeWorkspace({ slug: 'taken' })),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.status, 409);
        return true;
      },
    );
  });

  test('patches only the fields supplied', async () => {
    const created = await store.workspaces.create(makeWorkspace({ name: 'Before', description: 'keep' }));
    const updated = await store.workspaces.update(created.id, { name: 'After' });
    assert.equal(updated.name, 'After');
    assert.equal(updated.description, 'keep', 'an omitted field must not be cleared');
  });

  test('reports NOT_FOUND when updating a missing row', async () => {
    await assert.rejects(async () => store.workspaces.update(newId('workspace'), { name: 'x' }), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.status, 404);
      return true;
    });
  });

  test('hides archived workspaces unless asked', async () => {
    const live = await store.workspaces.create(makeWorkspace());
    const gone = await store.workspaces.create(makeWorkspace({ status: 'archived' }));
    const visible = await store.workspaces.list({});
    assert.deepEqual(visible.items.map((w) => w.id), [live.id]);
    const all = await store.workspaces.list({ includeArchived: true });
    assert.equal(all.items.length, 2);
    assert.ok(all.items.some((w) => w.id === gone.id));
  });

  test('every update bumps the optimistic-concurrency version', async () => {
    // The version backs the If-Match precondition on member updates; it must
    // advance on EVERY workspace write (name, quota, members, archive, SSO
    // reconcile all funnel through patch), or an If-Match token would stay valid
    // across a concurrent change on another field and the precondition would be
    // defeated. Callers never set version themselves — the shared patch path bumps.
    const created = await store.workspaces.create(makeWorkspace({ name: 'v', version: 1 }));
    assert.equal(created.version, 1, 'a fresh workspace starts at version 1');

    const afterName = await store.workspaces.update(created.id, { name: 'renamed' });
    assert.equal(afterName.version, 2, 'a name change bumps the version');

    const afterQuota = await store.workspaces.update(created.id, {
      quota: { ...created.quota, maxAgents: 7 },
    });
    assert.equal(afterQuota.version, 3, 'a quota change bumps it again');

    const afterMembers = await store.workspaces.update(created.id, {
      members: [{ principalId: 'pr_x', role: 'owner', addedAt: NOW }],
    });
    assert.equal(afterMembers.version, 4, 'a members change bumps it again');
  });

  test('an empty patch does not bump the version', async () => {
    // A no-op patch writes nothing, so the version must not advance — a version
    // only moves on a real change, or an If-Match token would be invalidated by a
    // caller that changed nothing.
    const created = await store.workspaces.create(makeWorkspace({ version: 1 }));
    const unchanged = await store.workspaces.update(created.id, {});
    assert.equal(unchanged.version, 1, 'an empty patch leaves the version untouched');
  });
});

describe('schema-defaulted columns', () => {
  test('a row written before a quota field existed reads its default', async () => {
    // `fromRow` used to CAST the quota JSON rather than parse it, so a key
    // absent from the stored blob came back `undefined`. That is worse than it
    // sounds: `count >= undefined` is false, so an absent *limit* read as
    // unlimited rather than as its default, and adding any new quota field
    // would have silently un-enforced it for every existing workspace.
    const id = newId('workspace');
    store.database.run(
      `INSERT INTO workspaces
         (id, slug, name, description, status, members, quota, system_prompt, metadata,
          created_at, updated_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        'legacy',
        'Legacy',
        '',
        'active',
        '[]',
        // As an older version of the schema would have written it.
        JSON.stringify({ maxConcurrentSessions: 20 }),
        '',
        '{}',
        NOW,
        NOW,
        'pr_test',
      ],
    );

    const workspace = await store.workspaces.get(id);
    assert.equal(workspace?.quota.maxConcurrentSessions, 20, 'a stored value wins');
    assert.equal(workspace?.quota.maxSandboxes, 20, 'an absent one takes its default');
    assert.equal(workspace?.quota.maxStorageMb, 10_240);
    assert.equal(workspace?.quota.eventRetentionDays, 90);
  });

  test('a session row with partial usage reads zeroes, not undefined', async () => {
    // Token accounting sums these; `undefined` propagates NaN into a quota
    // decision, which then compares false and admits.
    const { workspace, agent } = await seed();
    const id = newId('session');
    store.database.run(
      `INSERT INTO sessions
         (id, workspace_id, agent_id, resolved_version, title, status, origin,
          credential_ids, last_seq, turn_count, usage, metadata,
          created_at, updated_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        workspace.id,
        agent.id,
        1,
        '',
        'queued',
        'api',
        '[]',
        0,
        0,
        JSON.stringify({ inputTokens: 5 }),
        '{}',
        NOW,
        NOW,
        'pr_test',
      ],
    );

    const session = await store.sessions.get(id);
    assert.equal(session?.usage.inputTokens, 5);
    assert.equal(session?.usage.outputTokens, 0, 'absent counters are zero, not undefined');
    assert.equal(session?.usage.costMicros, 0);
    assert.ok(
      Number.isFinite(
        session!.usage.inputTokens + session!.usage.outputTokens + session!.usage.costMicros,
      ),
      'summing usage must not produce NaN',
    );
  });
});

describe('pagination', () => {
  test('walks every row exactly once with no duplicates or gaps', async () => {
    const { workspace } = await seed();
    const ids = new Set<string>();
    for (let index = 0; index < 25; index++) {
      const agent = await store.agents.create(makeAgent(workspace.id, { name: `agent-${index}` }));
      ids.add(agent.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.agents.list({
        workspaceId: workspace.id,
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor;
    } while (cursor);

    // 26 = the 25 above plus the one from seed().
    assert.equal(seen.length, 26);
    assert.equal(new Set(seen).size, 26, 'no row may appear twice');
  });

  test('does not emit a cursor on the final page', async () => {
    const { workspace } = await seed();
    const page = await store.agents.list({ workspaceId: workspace.id, limit: 50 });
    assert.equal(page.nextCursor, undefined);
  });
});

// --- version concurrency ---------------------------------------------------

describe('agent version concurrency', () => {
  test('compare-and-set lets exactly one of two racing bumps win', async () => {
    const { agent } = await seed();
    await store.agents.bumpVersion(agent.id, 0, 1, NOW);

    // Both callers read version 1 and try to claim 2; one must lose.
    await assert.rejects(async () => store.agents.bumpVersion(agent.id, 0, 2, NOW), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'CONFLICT');
      assert.equal((error.details as { actual: number }).actual, 1);
      return true;
    });

    const current = await store.agents.get(agent.id);
    assert.equal(current?.latestVersion, 1);
  });

  test('rejects a duplicate version number', async () => {
    const { agent } = await seed();
    const version = {
      agentId: agent.id,
      version: 1,
      changeSummary: '',
      systemPrompt: 'x',
      createdAt: NOW,
      createdBy: 'pr_test',
    } as never;
    await store.agentVersions.create(version);
    await assert.rejects(async () => store.agentVersions.create(version), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.status, 409);
      return true;
    });
  });

  test('stores the full spec and reads it back unchanged', async () => {
    const { agent } = await seed();
    await store.agentVersions.create({
      agentId: agent.id,
      version: 1,
      changeSummary: 'initial',
      systemPrompt: 'be helpful',
      model: { modelId: 'anthropic/claude-sonnet-5', fallbackModelIds: [] },
      tools: { mode: 'strict', allow: ['Read'], deny: [], allowedCommands: [], deniedCommands: [] },
      skills: [{ name: 'review', source: 'registry', digest: 'a'.repeat(64), version: '' }],
      createdAt: NOW,
      createdBy: 'pr_test',
    } as never);

    const found = await store.agentVersions.get(agent.id, 1);
    assert.equal(found?.systemPrompt, 'be helpful');
    assert.equal(found?.model.modelId, 'anthropic/claude-sonnet-5');
    assert.equal(found?.tools.mode, 'strict');
    assert.equal(found?.skills[0]?.digest, 'a'.repeat(64));
    assert.equal(found?.changeSummary, 'initial');
  });

  test('latest returns the highest version, not the newest row', async () => {
    const { agent } = await seed();
    for (const version of [1, 3, 2]) {
      await store.agentVersions.create({
        agentId: agent.id,
        version,
        createdAt: NOW + version,
        createdBy: 'pr_test',
      } as never);
    }
    assert.equal((await store.agentVersions.latest(agent.id))?.version, 3);
  });

  test('finds the default version of each live agent that keeps warm sandboxes', async () => {
    const version = (agentId: string, number: number, prewarm: number) =>
      store.agentVersions.create({
        agentId,
        version: number,
        sandbox: { allowReuse: prewarm > 0, prewarm },
        createdAt: NOW,
        createdBy: 'pr_test',
      } as never);

    const workspace = await store.workspaces.create(makeWorkspace());
    const pinned = await store.agents.create(makeAgent(workspace.id, { latestVersion: 2, productionVersion: 1 }));
    await version(pinned.id, 1, 2);
    await version(pinned.id, 2, 0);
    const latest = await store.agents.create(makeAgent(workspace.id, { latestVersion: 2 }));
    await version(latest.id, 1, 0);
    await version(latest.id, 2, 3);
    const cold = await store.agents.create(makeAgent(workspace.id, { latestVersion: 1 }));
    await version(cold.id, 1, 0);
    const archived = await store.agents.create(makeAgent(workspace.id, { latestVersion: 1, status: 'archived' }));
    await version(archived.id, 1, 2);
    const closed = await store.workspaces.create(makeWorkspace({ status: 'archived' }));
    const elsewhere = await store.agents.create(makeAgent(closed.id, { latestVersion: 1 }));
    await version(elsewhere.id, 1, 2);

    const found = await store.agentVersions.findPrewarmed(10);
    const byAgent = Object.fromEntries(found.map((f) => [f.version.agentId, f]));
    assert.deepEqual(Object.keys(byAgent).sort(), [latest.id, pinned.id].sort());
    assert.equal(byAgent[pinned.id]!.version.version, 1, 'the production pin wins over latest');
    assert.equal(byAgent[latest.id]!.version.sandbox.prewarm, 3);
    assert.equal(byAgent[pinned.id]!.workspaceId, workspace.id);
  });

  test('pages through every agent that keeps warm sandboxes, after a cursor', async () => {
    const workspace = await store.workspaces.create(makeWorkspace());
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const agent = await store.agents.create(makeAgent(workspace.id, { latestVersion: 1 }));
      await store.agentVersions.create({ agentId: agent.id, version: 1, sandbox: { allowReuse: true, prewarm: 1 }, createdAt: NOW, createdBy: 'pr_test' } as never);
      ids.push(agent.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const found = await store.agentVersions.findPrewarmed(2, cursor);
      seen.push(...found.map((f) => f.version.agentId));
      cursor = found.at(-1)?.version.agentId;
    }
    assert.deepEqual(seen, [...ids].sort());
  });
});

describe('warm sandbox pools', () => {
  const warmRow = (workspaceId: string, overrides: Partial<Sandbox> = {}) =>
    makeSandbox(workspaceId, { status: 'pending', sessionIds: ['prewarm-pool-a-0' as never], ...overrides });

  test('a warm row goes in while its pool is short and the workspace has room, and not otherwise', async () => {
    const { workspace } = await seed();
    await store.sandboxes.create(makeSandbox(workspace.id, { idleSince: NOW }));
    await store.sandboxes.create(warmRow(workspace.id));
    await store.sandboxes.create(makeSandbox(workspace.id, { poolKey: 'pool-b', sessionIds: ['sn_held' as never] }));

    assert.equal(await store.sandboxes.createWarmWithinLimits(warmRow(workspace.id), 10, 2, 'prewarm-'), 'pool-full');
    const added = await store.sandboxes.createWarmWithinLimits(warmRow(workspace.id), 10, 3, 'prewarm-');
    assert.notEqual(typeof added, 'string');
    assert.equal(await store.sandboxes.createWarmWithinLimits(warmRow(workspace.id), 4, 9, 'prewarm-'), 'workspace-full');
  });

  test('held sandboxes are counted, idle warm ones are not, and a declaration marks only live rows of its pool', async () => {
    const { workspace } = await seed();
    const idle = await store.sandboxes.create(makeSandbox(workspace.id, { idleSince: NOW }));
    const pending = await store.sandboxes.create(warmRow(workspace.id));
    const held = await store.sandboxes.create(makeSandbox(workspace.id, { sessionIds: ['sn_held' as never] }));
    const released = await store.sandboxes.create(makeSandbox(workspace.id, { status: 'released' }));
    const otherPool = await store.sandboxes.create(makeSandbox(workspace.id, { poolKey: 'pool-b', idleSince: NOW }));
    assert.equal(await store.sandboxes.countHeld(workspace.id), 2);

    assert.equal(await store.sandboxes.declareWarm(workspace.id, 'pool-a', 2, NOW + 5), 3);
    for (const sandbox of [idle, pending, held]) {
      const read = await store.sandboxes.get(sandbox.id);
      assert.deepEqual([read?.warmDeclaredAt, read?.warmDepth], [NOW + 5, 2]);
    }
    for (const sandbox of [released, otherPool]) assert.equal((await store.sandboxes.get(sandbox.id))?.warmDeclaredAt, undefined);
  });
});

// --- event log -------------------------------------------------------------

describe('event log', () => {
  test('assigns gap-free sequences starting at 1', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));

    const first = await store.events.append(session.id, [
      makeEvent(workspace.id, session.id),
      makeEvent(workspace.id, session.id),
    ]);
    const second = await store.events.append(session.id, [makeEvent(workspace.id, session.id)]);

    assert.deepEqual([...first, ...second].map((e) => e.seq), [1, 2, 3]);
  });

  test('keeps sequences independent per session', async () => {
    const { workspace, agent } = await seed();
    const a = await store.sessions.create(makeSession(workspace.id, agent.id));
    const b = await store.sessions.create(makeSession(workspace.id, agent.id));

    await store.events.append(a.id, [makeEvent(workspace.id, a.id)]);
    const bEvents = await store.events.append(b.id, [makeEvent(workspace.id, b.id)]);
    assert.equal(bEvents[0]?.seq, 1, 'a second session starts its own sequence at 1');
  });

  test('updates the session cursor so a reader can resume without a scan', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(session.id, [
      makeEvent(workspace.id, session.id),
      makeEvent(workspace.id, session.id),
    ]);
    assert.equal((await store.sessions.get(session.id))?.lastSeq, 2);
  });

  test('reads an exact range: fromSeq inclusive, toSeq exclusive', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(
      session.id,
      Array.from({ length: 5 }, () => makeEvent(workspace.id, session.id)),
    );

    const range = await store.events.read(session.id, { fromSeq: 2, toSeq: 4 });
    assert.deepEqual(range.map((e) => e.seq), [2, 3], 'toSeq must be exclusive');
  });

  test('resumes from a cursor without replaying or skipping', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(
      session.id,
      Array.from({ length: 10 }, () => makeEvent(workspace.id, session.id)),
    );

    const firstBatch = await store.events.read(session.id, { fromSeq: 0, limit: 4 });
    const lastSeen = firstBatch[firstBatch.length - 1]!.seq;
    const resumed = await store.events.read(session.id, { fromSeq: lastSeen + 1 });

    assert.deepEqual(firstBatch.map((e) => e.seq), [1, 2, 3, 4]);
    assert.deepEqual(resumed.map((e) => e.seq), [5, 6, 7, 8, 9, 10]);
  });

  test('filters by exact type and by namespace prefix', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(session.id, [
      makeEvent(workspace.id, session.id, { type: 'tool.started', payload: { toolCallId: 'c1' } }),
      makeEvent(workspace.id, session.id, { type: 'tool.completed', payload: { toolCallId: 'c1', durationMs: 1 } }),
      makeEvent(workspace.id, session.id, { type: 'message.delta', payload: { text: 'x' } }),
    ]);

    const tools = await store.events.read(session.id, { types: ['tool.'] });
    assert.equal(tools.length, 2);
    const exact = await store.events.read(session.id, { types: ['message.delta'] });
    assert.equal(exact.length, 1);
  });

  test('preserves payloads and optional fields across a round trip', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(session.id, [
      makeEvent(workspace.id, session.id, {
        type: 'tool.completed',
        turn: 3,
        itemId: 'item-9',
        payload: { toolCallId: 'call_1', durationMs: 42, resultPreview: 'ok', truncated: false },
      }),
    ]);

    const [event] = await store.events.read(session.id, {});
    assert.equal(event?.turn, 3);
    assert.equal(event?.itemId, 'item-9');
    assert.deepEqual(event?.payload, {
      toolCallId: 'call_1',
      durationMs: 42,
      resultPreview: 'ok',
      truncated: false,
    });
  });

  test('prunes from the head and reports the new earliest sequence', async () => {
    // Retention must truncate the head, never leave holes in the middle: a
    // lagging consumer can restart from `earliestSeq`, but cannot recover a gap.
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(
      session.id,
      Array.from({ length: 10 }, () => makeEvent(workspace.id, session.id)),
    );

    assert.equal(await store.events.prune(session.id, 6), 5);
    assert.equal(await store.events.earliestSeq(session.id), 6);
    assert.equal(await store.events.lastSeq(session.id), 10);
    const remaining = await store.events.read(session.id, {});
    assert.deepEqual(remaining.map((e) => e.seq), [6, 7, 8, 9, 10]);
  });

  test('never reissues a sequence after the log is fully pruned', async () => {
    // `append` derived the next seq from MAX(seq) over surviving rows, so once
    // retention removed every event, MAX was NULL and numbering restarted at 1
    // — reissuing sequences that had already been served. An SSE client
    // resuming from `Last-Event-ID: 5` then silently skipped the new 1..5
    // forever, because the bridge drops anything at or below the last sequence
    // it sent. A live session simply stopped receiving events.
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));

    const first = await store.events.append(
      session.id,
      Array.from({ length: 5 }, () => makeEvent(workspace.id, session.id)),
    );
    assert.deepEqual(first.map((e) => e.seq), [1, 2, 3, 4, 5]);

    // Retention takes the lot.
    assert.equal(await store.events.prune(session.id, 6), 5);
    assert.deepEqual(await store.events.read(session.id, {}), [], 'the log is empty');

    const next = await store.events.append(
      session.id,
      Array.from({ length: 2 }, () => makeEvent(workspace.id, session.id)),
    );
    assert.deepEqual(
      next.map((e) => e.seq),
      [6, 7],
      'sequences must continue past the pruned range, not restart',
    );
  });

  test('reports zero for an empty log rather than failing', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    assert.equal(await store.events.lastSeq(session.id), 0);
    assert.equal(await store.events.earliestSeq(session.id), 0);
  });

  test('appending nothing is a no-op', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    assert.deepEqual(await store.events.append(session.id, []), []);
    assert.equal(await store.events.lastSeq(session.id), 0);
  });

  test('searches payload content case-insensitively', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(session.id, [
      makeEvent(workspace.id, session.id, { payload: { text: 'Authentication FAILED for user' } }),
      makeEvent(workspace.id, session.id, { payload: { text: 'all good here' } }),
      makeEvent(workspace.id, session.id, { payload: { text: 'retry authentication' } }),
    ]);

    const hits = await store.events.read(session.id, { q: 'authentication' });
    assert.deepEqual(hits.map((e) => e.seq), [1, 3], 'matches both, case-insensitively');
  });

  test('treats a LIKE wildcard in the query as a literal', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(session.id, [
      makeEvent(workspace.id, session.id, { payload: { text: 'cpu at 50% now' } }),
      makeEvent(workspace.id, session.id, { payload: { text: 'cpu at 50X now' } }),
    ]);

    const percent = await store.events.read(session.id, { q: '50%' });
    assert.deepEqual(percent.map((e) => e.seq), [1], 'a literal % must not wildcard-match 50X');
  });

  test('treats a LIKE underscore in the query as a literal', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(session.id, [
      makeEvent(workspace.id, session.id, { payload: { text: 'call a_b now' } }),
      makeEvent(workspace.id, session.id, { payload: { text: 'call axb now' } }),
    ]);

    const under = await store.events.read(session.id, { q: 'a_b' });
    assert.deepEqual(under.map((e) => e.seq), [1], 'a literal _ must not wildcard-match axb');
  });

  test('windows by timestamp while keeping seq order', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(session.id, [
      makeEvent(workspace.id, session.id, { ts: 1000 }),
      makeEvent(workspace.id, session.id, { ts: 2000 }),
      makeEvent(workspace.id, session.id, { ts: 3000 }),
      makeEvent(workspace.id, session.id, { ts: 4000 }),
    ]);

    const window = await store.events.read(session.id, { fromTs: 2000, toTs: 4000 });
    assert.deepEqual(window.map((e) => e.seq), [2, 3], 'fromTs inclusive, toTs exclusive, seq-ordered');
  });

  test('combines content search with the other filters', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(session.id, [
      makeEvent(workspace.id, session.id, { type: 'tool.completed', turn: 1, payload: { text: 'boom' } }),
      makeEvent(workspace.id, session.id, { type: 'message.delta', turn: 1, payload: { text: 'boom' } }),
      makeEvent(workspace.id, session.id, { type: 'tool.completed', turn: 2, payload: { text: 'boom' } }),
    ]);

    const hits = await store.events.read(session.id, { q: 'boom', types: ['tool.'], turn: 1 });
    assert.deepEqual(hits.map((e) => e.seq), [1], 'q AND types AND turn all narrow together');
  });

  test('never matches an event in another session', async () => {
    const { workspace, agent } = await seed();
    const a = await store.sessions.create(makeSession(workspace.id, agent.id));
    const b = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(a.id, [makeEvent(workspace.id, a.id, { payload: { text: 'secret-token-xyz' } })]);

    const hits = await store.events.read(b.id, { q: 'secret-token-xyz' });
    assert.deepEqual(hits, [], 'content search is always scoped to its own session');
  });

});

describe('event search', () => {
  async function sessionWith(payloads: Record<string, unknown>[]): Promise<string> {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(
      session.id,
      payloads.map((payload) =>
        makeEvent(workspace.id, session.id, { payload } as Partial<Omit<SessionEvent, 'seq'>>),
      ),
    );
    return session.id;
  }
  const seqs = (events: readonly SessionEvent[]): number[] => events.map((e) => e.seq);

  test('matches values, not field names', async () => {
    const id = await sessionWith([{ text: 'hello', toolName: 'bash' }, { text: 'the word text is here' }]);
    assert.deepEqual(seqs(await store.events.read(id, { q: 'text' })), [2]);
    assert.deepEqual(await store.events.read(id, { q: 'toolname' }), []);
    assert.deepEqual(seqs(await store.events.read(id, { q: 'bash' })), [1]);
  });

  test('matches text as it was written, not as JSON escapes it', async () => {
    const id = await sessionWith([{ text: 'she said "stop"\nthen left' }]);
    assert.deepEqual(seqs(await store.events.read(id, { q: 'said "stop"' })), [1]);
    assert.deepEqual(seqs(await store.events.read(id, { q: '"stop"\nthen' })), [1]);
    assert.deepEqual(await store.events.read(id, { q: 'stop\\"' }), [], 'the escape is not part of the value');
  });

  test('folds case beyond ASCII', async () => {
    const id = await sessionWith([{ text: 'ÜBER die Brücke' }]);
    assert.deepEqual(seqs(await store.events.read(id, { q: 'über' })), [1]);
    assert.deepEqual(seqs(await store.events.read(id, { q: 'BRÜCKE' })), [1]);
  });

  test('matches numbers in the payload', async () => {
    const id = await sessionWith([{ toolName: 'bash', exitCode: 127 }, { toolName: 'bash', exitCode: 0 }]);
    assert.deepEqual(seqs(await store.events.read(id, { q: '127' })), [1]);
  });

  test('a query never matches across two values, only within one', async () => {
    const id = await sessionWith([{ a: 'foo', b: 'bar' }, { text: 'line one\nline two' }, { text: 'left\u001fright' }]);
    assert.deepEqual(await store.events.read(id, { q: 'foo\nbar' }), []);
    assert.deepEqual(await store.events.read(id, { q: 'foo\u001fbar' }), []);
    assert.deepEqual(seqs(await store.events.read(id, { q: 'one\nline' })), [2]);
    assert.deepEqual(seqs(await store.events.read(id, { q: 'left right' })), [3], 'a separator inside a value is not one');
  });

  test('a filter that lets little through is searched in steps of events read, not of matches', async () => {
    const id = await sessionWith(Array.from({ length: 50 }, () => ({ text: 'routine' })));
    const result = await store.events.search(id, { q: 'needle', types: ['tool.'], searchChunk: 10, searchScanCap: 20 });
    assert.deepEqual(result.events, []);
    assert.equal(result.scanned, 20, 'the cap counts events read, as it does unfiltered');
    assert.equal(result.truncated, true);
    assert.equal(result.resumeSeq, 21);
  });

  test('a filtered read gives other work a turn between windows of the log', async () => {
    const id = await sessionWith(Array.from({ length: 2_500 }, () => ({ text: 'routine' })));
    let turned = false;
    const reading = store.events.read(id, { types: ['tool.'], limit: 10 });
    setImmediate(() => {
      turned = true;
    });
    assert.deepEqual(await reading, []);
    assert.equal(turned, true, 'the event loop turned while the log was read');

    const unfiltered = await store.events.read(id, { limit: 3, order: 'desc' });
    assert.deepEqual(seqs(unfiltered), [2500, 2499, 2498]);
  });

  test('search text an older format wrote is rewritten to the current one', async () => {
    const id = await sessionWith([{ text: 'ÜBERWEISUNG' }, { text: 'routine' }]);
    // As the SQL backfill left it: ASCII folded only, joined with a newline.
    store.database.run(`UPDATE event_search SET text = 'Überweisung', version = 1 WHERE session_id = ? AND seq = 1`, [id]);
    assert.deepEqual(await store.events.read(id, { q: 'überweisung' }), []);

    assert.equal(await store.events.reindexSearch(10), 1);
    assert.deepEqual(seqs(await store.events.read(id, { q: 'überweisung' })), [1]);
    assert.equal(await store.events.reindexSearch(10), 0, 'nothing left to rewrite');
  });

  test('a search that stops at its cap says where to resume, and resuming finds the rest', async () => {
    const id = await sessionWith([
      { text: 'ancient-marker' },
      { text: 'noise' },
      { text: 'noise' },
      { text: 'noise' },
      { text: 'noise' },
    ]);

    const first = await store.events.search(id, { q: 'ancient-marker', order: 'desc', searchScanCap: 3 });
    assert.deepEqual(first.events, []);
    assert.equal(first.scanned, 3);
    assert.equal(first.truncated, true);
    assert.equal(first.resumeSeq, 3, 'seqs 5, 4, 3 were examined; continue below 3');

    const rest = await store.events.search(id, {
      q: 'ancient-marker',
      order: 'desc',
      toSeq: first.resumeSeq!,
      searchScanCap: 3,
    });
    assert.deepEqual(seqs(rest.events), [1]);
    assert.equal(rest.scanned, 2);
    assert.equal(rest.truncated, false);
    assert.equal(rest.resumeSeq, undefined);

    const up = await store.events.search(id, { q: 'noise', order: 'asc', searchScanCap: 2 });
    assert.deepEqual(seqs(up.events), [2]);
    assert.equal(up.truncated, true);
    assert.equal(up.resumeSeq, 3, 'seqs 1 and 2 were examined; continue from 3');
    const upRest = await store.events.search(id, { q: 'noise', order: 'asc', fromSeq: up.resumeSeq!, searchScanCap: 2 });
    assert.deepEqual(seqs(upRest.events), [3, 4]);
    assert.equal(upRest.resumeSeq, 5);
  });

  test('a search whose cap lands exactly on the end of the log is not truncated', async () => {
    const id = await sessionWith([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    const all = await store.events.search(id, { q: 'zzz', order: 'desc', searchScanCap: 3 });
    assert.equal(all.scanned, 3);
    assert.equal(all.truncated, false);
    assert.equal(all.resumeSeq, undefined);
  });

  test('a search that fills its limit is not truncated: the caller pages as for any read', async () => {
    const id = await sessionWith([{ text: 'noise' }, { text: 'noise' }, { text: 'noise' }]);
    const page = await store.events.search(id, { q: 'noise', order: 'desc', limit: 1 });
    assert.deepEqual(seqs(page.events), [3]);
    assert.equal(page.truncated, false);
  });

  test('one request reaches well past the 5,000 most recent events', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.events.append(session.id, [makeEvent(workspace.id, session.id, { payload: { text: 'needle-old' } })]);
    await store.events.append(
      session.id,
      Array.from({ length: 6000 }, () => makeEvent(workspace.id, session.id, { payload: { text: 'hay' } })),
    );
    const found = await store.events.search(session.id, { q: 'needle-old', order: 'desc' });
    assert.deepEqual(seqs(found.events), [1]);
    assert.equal(found.truncated, false);
  });

  test('a long search lets the event loop run between chunks', async () => {
    const id = await sessionWith(Array.from({ length: 20 }, () => ({ text: 'hay' })));
    let turns = 0;
    let done = false;
    const spin = (): void => {
      turns++;
      if (!done) setImmediate(spin);
    };
    setImmediate(spin);
    try {
      await store.events.search(id, { q: 'needle', searchChunk: 2 });
    } finally {
      done = true;
    }
    assert.ok(turns >= 5, `the loop turned ${turns} times during a 10-chunk search`);
  });

  test('searches past the concurrency limit wait their turn, and past the queue are refused', async () => {
    const id = await sessionWith([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.events.search(id, { q: 'b', searchChunk: 1 })),
    );
    const done = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(done.length, 18, 'two run and sixteen wait');
    for (const result of done) assert.deepEqual(seqs(result.value.events), [2]);
    assert.equal(refused.length, 2);
    for (const result of refused) {
      const error = result.reason as MaError;
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'SEARCH_BUSY');
      assert.equal(error.category, 'quota');
      assert.ok((error.retryAfterSeconds ?? 0) > 0);
    }
    const after = await store.events.search(id, { q: 'c' });
    assert.deepEqual(seqs(after.events), [3], 'every slot was given back');
  });

  test('a finished search passes its slot to one that was waiting, so newcomers still queue', async () => {
    const id = await sessionWith([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    const running = Array.from({ length: 18 }, () => store.events.search(id, { q: 'b', searchChunk: 1 }));
    await running[0];
    const joined = store.events.search(id, { q: 'b', searchChunk: 1 });
    await assert.rejects(
      store.events.search(id, { q: 'b', searchChunk: 1 }),
      (error: unknown) => MaError.is(error) && error.code === 'SEARCH_BUSY',
      'two still run and sixteen wait, so the next one is refused',
    );
    await Promise.all([...running, joined]);
  });

  test('an aborted search stops and gives its slot back', async () => {
    const id = await sessionWith(Array.from({ length: 10 }, () => ({ text: 'hay' })));
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map((c) => store.events.search(id, { q: 'x', searchChunk: 1, signal: c.signal }));
    for (const c of controllers) c.abort(new Error('the client went away'));
    for (const p of pending) await assert.rejects(p, /the client went away/);
    const results = await Promise.allSettled(
      Array.from({ length: 18 }, () => store.events.search(id, { q: 'hay', searchChunk: 5, limit: 1 })),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 18);
  });

  test('retention and session deletion take an event’s search text with it', async () => {
    const id = await sessionWith([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
    await store.events.prune(id, 3);
    const left = store.database.all('SELECT seq FROM event_search WHERE session_id = ?', [id]);
    assert.deepEqual(left.map((row) => Number(row.seq)), [3]);
    await store.events.deleteForSession(id);
    assert.equal(store.database.all('SELECT seq FROM event_search WHERE session_id = ?', [id]).length, 0);
  });

  test('events written before the upgrade are searchable by value after it', async () => {
    const db = new Database({ location: ':memory:' });
    db.migrate(MIGRATIONS.filter((migration) => migration.id < 23));
    const insert = (seq: number, payload: string): void =>
      void db.run(
        `INSERT INTO events (session_id, seq, id, workspace_id, ts, type, turn, item_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['sn_legacy', seq, `ev_${seq}`, 'ws_legacy', NOW, 'message.completed', null, null, payload],
      );
    insert(1, JSON.stringify({ text: 'Legacy "quoted" Marker', tokens: 42 }));
    insert(2, JSON.stringify({ text: 'other' }));
    insert(3, 'not json at all');
    db.migrate();
    const upgraded = new SqliteStore(db);

    assert.deepEqual(seqs(await upgraded.events.read('sn_legacy', { q: 'legacy "quoted" marker' })), [1]);
    assert.deepEqual(seqs(await upgraded.events.read('sn_legacy', { q: '42' })), [1]);
    assert.deepEqual(await upgraded.events.read('sn_legacy', { q: 'tokens' }), [], 'keys are not values');
    assert.deepEqual(
      db.all('SELECT text FROM event_search WHERE session_id = ? AND seq = 3', ['sn_legacy']).map((row) => row.text),
      ['not json at all'],
      'a payload that is not JSON does not stop the upgrade; it is searched as written',
    );
    db.close();
  });
});

// --- session transitions ---------------------------------------------------

describe('session status transitions', () => {
  test('compare-and-set applies only when the status still matches', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));

    const moved = await store.sessions.compareAndSetStatus(session.id, 'queued', 'provisioning', {
      updatedAt: NOW + 1,
    });
    assert.equal(moved?.status, 'provisioning');

    // A second worker still believing it is `queued` must not clobber this.
    const stale = await store.sessions.compareAndSetStatus(session.id, 'queued', 'failed', {});
    assert.equal(stale, undefined, 'losing the race returns undefined, not an error');
    assert.equal((await store.sessions.get(session.id))?.status, 'provisioning');
  });

  test('applies the accompanying patch atomically with the status', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    const sandboxId = newId('sandbox');

    const updated = await store.sessions.compareAndSetStatus(session.id, 'queued', 'ready', {
      sandboxId,
      startedAt: NOW + 5,
    });
    assert.equal(updated?.status, 'ready');
    assert.equal(updated?.sandboxId, sandboxId);
    assert.equal(updated?.startedAt, NOW + 5);
  });

  test('a session rebind slot has one holder at a time, until released or expired', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    const other = await store.sessions.create(makeSession(workspace.id, agent.id));

    assert.equal(await store.sessions.claimRebind(session.id, 'upgrade', NOW + 1_000, NOW), true);
    assert.equal(await store.sessions.claimRebind(session.id, 'model-change', NOW + 1_000, NOW + 10), false);
    assert.equal(await store.sessions.claimRebind(other.id, 'model-change', NOW + 1_000, NOW + 10), true, 'per session');

    await store.sessions.releaseRebind(session.id, 'model-change');
    assert.equal(
      await store.sessions.claimRebind(session.id, 'model-change', NOW + 1_000, NOW + 20),
      false,
      'only the holder releases it',
    );
    await store.sessions.releaseRebind(session.id, 'upgrade');
    assert.equal(await store.sessions.claimRebind(session.id, 'model-change', NOW + 1_000, NOW + 30), true);

    assert.equal(await store.sessions.claimRebind(session.id, 'late', NOW + 2_000, NOW + 999), false);
    assert.equal(await store.sessions.claimRebind(session.id, 'late', NOW + 2_000, NOW + 1_000), true, 'a dead holder expires');
    await store.sessions.releaseRebind(session.id, 'model-change');
    assert.equal(await store.sessions.claimRebind(session.id, 'third', NOW + 3_000, NOW + 1_001), false, 'the expired holder no longer releases it');
  });

  test('finds expired sessions but ignores those already finished', async () => {
    const { workspace, agent } = await seed();
    await store.sessions.create(makeSession(workspace.id, agent.id, { expiresAt: NOW - 1, status: 'idle' }));
    await store.sessions.create(
      makeSession(workspace.id, agent.id, { expiresAt: NOW - 1, status: 'terminated' }),
    );
    await store.sessions.create(makeSession(workspace.id, agent.id, { expiresAt: NOW + 10_000 }));

    const expired = await store.sessions.findExpired(NOW, 10);
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.status, 'idle');
  });

  test('counts only sessions that still hold resources', async () => {
    const { workspace, agent } = await seed();
    await store.sessions.create(makeSession(workspace.id, agent.id, { status: 'running' }));
    await store.sessions.create(makeSession(workspace.id, agent.id, { status: 'idle' }));
    await store.sessions.create(makeSession(workspace.id, agent.id, { status: 'terminated' }));
    await store.sessions.create(makeSession(workspace.id, agent.id, { status: 'failed' }));
    assert.equal(await store.sessions.countActive(workspace.id), 2);
  });

  test('finds the live session holding a sandbox, ignoring terminal holders', async () => {
    const { workspace, agent } = await seed();
    const holder = await store.sessions.create(
      makeSession(workspace.id, agent.id, { status: 'ready', sandboxId: 'sb_live' }),
    );
    // A distractor: a finished session that once held the same sandbox id must
    // not shadow the live holder (or resurrect after the id is reused).
    await store.sessions.create(
      makeSession(workspace.id, agent.id, { status: 'terminated', sandboxId: 'sb_live' }),
    );

    const found = await store.sessions.getBySandboxId('sb_live');
    assert.equal(found?.id, holder.id, 'returns the non-terminal holder');
    assert.equal(await store.sessions.getBySandboxId('sb_absent'), undefined);
  });

  test('finds a sandbox holder regardless of how many sessions exist', async () => {
    // The recovery query must not depend on a scan window: the holder is created
    // last, so an ordered page would surface it only after every earlier row.
    const { workspace, agent } = await seed();
    for (let index = 0; index < 60; index++) {
      await store.sessions.create(makeSession(workspace.id, agent.id, { status: 'ready' }));
    }
    const holder = await store.sessions.create(
      makeSession(workspace.id, agent.id, { status: 'ready', sandboxId: 'sb_deep' }),
    );
    const found = await store.sessions.getBySandboxId('sb_deep');
    assert.equal(found?.id, holder.id);
  });
});

// --- sandbox pool ----------------------------------------------------------

describe('sandbox pool', () => {
  test('does not hand a sandbox to a second session while a live one still holds it', async () => {
    // The reuse-misrouting bug: a warm sandbox whose holder is a *live* session
    // was handed to a second session too. Because one agent-core process is
    // bound to one session for its life, the second session's turns were then
    // reported under the first. A sandbox is only reusable once its holders are
    // all finished; while a live session holds it, the second claimant must get
    // nothing (and provision its own).
    const { workspace, agent } = await seed();
    const holder = await store.sessions.create(
      makeSession(workspace.id, agent.id, { status: 'ready' }),
    );
    await store.sandboxes.create(
      makeSandbox(workspace.id, { poolKey: 'pool-x', sessionIds: [holder.id] }),
    );

    const claimed = await store.sandboxes.claimFromPool('pool-x', 'sn_second', NOW);
    assert.equal(claimed, undefined, 'a sandbox with a live holder must not be reused');
  });

  test('reuses a sandbox once its holders have finished, replacing the dead holder', async () => {
    // The sequential-reuse case the pool is meant for: the previous holder has
    // terminated, so the environment is genuinely idle and can be handed on. The
    // claim REPLACES the finished holder rather than accreting it — leaving a dead
    // id behind kept the sandbox from ever looking holderless again (see the
    // prewarm test below for why that mattered).
    const { workspace, agent } = await seed();
    const past = await store.sessions.create(
      makeSession(workspace.id, agent.id, { status: 'terminated' }),
    );
    const next = await store.sessions.create(makeSession(workspace.id, agent.id));
    await store.sandboxes.create(
      makeSandbox(workspace.id, { poolKey: 'pool-x', sessionIds: [past.id] }),
    );

    const claimed = await store.sandboxes.claimFromPool('pool-x', next.id, NOW);
    assert.ok(claimed, 'a sandbox whose holders have all finished is reusable');
    assert.deepEqual(claimed?.sessionIds, [next.id], 'the finished holder is replaced, not accreted');
  });

  test('a prewarmed sandbox is claimable and drops its synthetic holder', async () => {
    // Prewarm seeds a synthetic holder id that has no session row; it must count
    // as non-live so a real session can adopt the warm sandbox — AND it must be
    // cleared on claim. Leaving `prewarm-*` in the list meant that on release the
    // holder set was never empty, so the sandbox was never marked idle and escaped
    // both the idle and max-lifetime reapers: immortal after its first reuse.
    const { workspace } = await seed();
    await store.sandboxes.create(
      makeSandbox(workspace.id, { poolKey: 'pool-warm', sessionIds: ['prewarm-pool-warm-0'] }),
    );

    const claimed = await store.sandboxes.claimFromPool('pool-warm', 'sn_real', NOW);
    assert.ok(claimed, 'a prewarmed sandbox is adopted on first claim');
    assert.deepEqual(
      claimed?.sessionIds,
      ['sn_real'],
      'the synthetic prewarm holder must be dropped, not carried alongside the real session',
    );
  });

  test('never hands out a sandbox from a different pool', async () => {
    const { workspace } = await seed();
    await store.sandboxes.create(makeSandbox(workspace.id, { poolKey: 'pool-a' }));
    // The pool key encodes image, resources, network and credentials: a
    // mismatch means sharing would breach isolation.
    assert.equal(await store.sandboxes.claimFromPool('pool-b', 'sn_1', NOW), undefined);
  });

  test('never hands out an expired or non-ready sandbox', async () => {
    const { workspace } = await seed();
    await store.sandboxes.create(
      makeSandbox(workspace.id, { poolKey: 'expired', leaseExpiresAt: NOW - 1 }),
    );
    await store.sandboxes.create(makeSandbox(workspace.id, { poolKey: 'draining', status: 'draining' }));

    assert.equal(await store.sandboxes.claimFromPool('expired', 'sn_1', NOW), undefined);
    assert.equal(await store.sandboxes.claimFromPool('draining', 'sn_1', NOW), undefined);
  });

  test('never hands out a sandbox past its max-lifetime ceiling, even with a valid lease', async () => {
    // A warm sandbox heartbeats continuously and so renews its own lease forever,
    // so an unexpired lease says nothing about age: it can cross its hard
    // `maxLifetimeSeconds` ceiling while still `ready`. Handing it to a fresh
    // session would rebind it only to have its next heartbeat refused mid-turn
    // (the broker enforces the same ceiling), forcing a recovery instead of a
    // clean cold start. claimFromPool must pass it over — every sibling path (the
    // heartbeat refusal, both reapers) already enforces this ceiling.
    const { workspace } = await seed();
    const aged = makeSandbox(workspace.id, {
      poolKey: 'pool-aged',
      // Lease is valid (far in the future), but the sandbox was created longer
      // ago than its lifetime ceiling allows.
      leaseExpiresAt: NOW + 60_000,
      createdAt: NOW - 3_600_000, // an hour ago
      spec: { maxLifetimeSeconds: 60 } as Sandbox['spec'], // ceiling: 1 minute
    });
    await store.sandboxes.create(aged);

    assert.equal(
      await store.sandboxes.claimFromPool('pool-aged', 'sn_1', NOW),
      undefined,
      'a ready, unexpired-lease sandbox past its lifetime ceiling is not handed out',
    );

    // A fresh sandbox in the same pool, within its ceiling, is still claimable —
    // the guard rejects only the aged one, not the pool.
    const fresh = makeSandbox(workspace.id, {
      poolKey: 'pool-aged',
      createdAt: NOW,
      spec: { maxLifetimeSeconds: 60 } as Sandbox['spec'],
    });
    await store.sandboxes.create(fresh);
    const claimed = await store.sandboxes.claimFromPool('pool-aged', 'sn_2', NOW);
    assert.equal(claimed?.id, fresh.id, 'the within-lifetime sandbox is claimed instead');
  });

  test('renewing a reaped sandbox fails so the runtime learns to stop', async () => {
    const { workspace } = await seed();
    const sandbox = await store.sandboxes.create(makeSandbox(workspace.id, { status: 'lost' }));
    assert.equal(await store.sandboxes.renewLease(sandbox.id, NOW + 60_000, NOW), undefined);
  });

  test('renews an active lease and records the heartbeat', async () => {
    const { workspace } = await seed();
    const sandbox = await store.sandboxes.create(makeSandbox(workspace.id));
    const renewed = await store.sandboxes.renewLease(sandbox.id, NOW + 120_000, NOW + 10);
    assert.equal(renewed?.leaseExpiresAt, NOW + 120_000);
    assert.equal(renewed?.lastHeartbeatAt, NOW + 10);
  });

  test('finds lapsed leases for the reaper', async () => {
    const { workspace } = await seed();
    await store.sandboxes.create(makeSandbox(workspace.id, { leaseExpiresAt: NOW - 1000 }));
    await store.sandboxes.create(makeSandbox(workspace.id, { leaseExpiresAt: NOW + 1000 }));
    await store.sandboxes.create(
      makeSandbox(workspace.id, { leaseExpiresAt: NOW - 1000, status: 'released' }),
    );

    const expired = await store.sandboxes.findExpiredLeases(NOW, 10);
    assert.equal(expired.length, 1, 'a released sandbox is not a lapsed lease');
  });

  test('drainIfIdle drains a ready sandbox whose idle marker is unchanged', async () => {
    const { workspace } = await seed();
    const sandbox = await store.sandboxes.create(
      makeSandbox(workspace.id, { idleSince: NOW - 5_000 }),
    );

    const drained = await store.sandboxes.drainIfIdle(sandbox.id, NOW - 5_000, NOW);
    assert.ok(drained, 'a sandbox still idle at the observed marker is drainable');
    assert.equal(drained?.status, 'draining');
  });

  test('drainIfIdle refuses once a claim has moved the idle marker', async () => {
    // The reap-race guard: `claimFromPool` clears `idle_since` when it adopts a
    // warm sandbox. A reaper that read the pre-claim `idleSince` must NOT drain
    // the sandbox a live session just took. The CAS on `idle_since` makes the
    // stale-marker drain a no-op.
    const { workspace } = await seed();
    const sandbox = await store.sandboxes.create(
      makeSandbox(workspace.id, { poolKey: 'pool-race', idleSince: NOW - 5_000 }),
    );

    const claimed = await store.sandboxes.claimFromPool('pool-race', 'sn_live', NOW);
    assert.ok(claimed, 'a live session claims the idle sandbox first');
    assert.equal(claimed?.idleSince, undefined, 'claiming clears the idle marker');

    const drained = await store.sandboxes.drainIfIdle(sandbox.id, NOW - 5_000, NOW);
    assert.equal(drained, undefined, 'the stale idle marker no longer matches, so no drain');
    const after = await store.sandboxes.get(sandbox.id);
    assert.equal(after?.status, 'ready', 'the claimed sandbox is left intact for its holder');
  });

  test('drainIfIdle refuses a sandbox that is no longer ready', async () => {
    const { workspace } = await seed();
    const sandbox = await store.sandboxes.create(
      makeSandbox(workspace.id, { status: 'draining', idleSince: NOW - 5_000 }),
    );
    const drained = await store.sandboxes.drainIfIdle(sandbox.id, NOW - 5_000, NOW);
    assert.equal(drained, undefined, 'a sandbox already leaving the pool is not re-drained');
  });

  test('releaseHolder rewrites the holder set when it is unchanged from the snapshot', async () => {
    const { workspace, agent } = await seed();
    const holder = await store.sessions.create(
      makeSession(workspace.id, agent.id, { status: 'terminated' }),
    );
    const sandbox = await store.sandboxes.create(
      makeSandbox(workspace.id, { poolKey: 'pool-rel', sessionIds: [holder.id] }),
    );

    const kept = await store.sandboxes.releaseHolder(
      sandbox.id,
      [holder.id],
      { sessionIds: [], idleSince: NOW },
      NOW,
    );
    assert.ok(kept, 'the CAS matches the observed holder set and applies');
    assert.deepEqual(kept?.sessionIds, [], 'the holder set was rewritten');
    assert.equal(kept?.idleSince, NOW, 'and the idle marker set');
  });

  test('releaseHolder refuses once a claim has changed the holder set (no lost update)', async () => {
    // The release/claim race: Broker.release reads a sandbox (observing its
    // holder set), then writes the new set in a separate transaction. On the
    // orphan-release path the releasing session is already terminal, so
    // claimFromPool's live-holder guard does not serialize against release; a
    // claim on another replica can adopt the sandbox in between. A blind write
    // would clobber that claim — orphaning the row while the claiming session
    // believes it holds the sandbox (its runtime calls fail auth and the idle
    // reaper destroys its live environment). The CAS on session_ids makes the
    // stale write a no-op.
    const { workspace, agent } = await seed();
    const gone = await store.sessions.create(
      makeSession(workspace.id, agent.id, { status: 'terminated' }),
    );
    const next = await store.sessions.create(makeSession(workspace.id, agent.id));
    const sandbox = await store.sandboxes.create(
      makeSandbox(workspace.id, { poolKey: 'pool-relrace', sessionIds: [gone.id] }),
    );

    // release read the sandbox with sessionIds=[gone.id] (its snapshot). Before it
    // writes, a concurrent claim adopts the sandbox for the new session.
    const claimed = await store.sandboxes.claimFromPool('pool-relrace', next.id, NOW);
    assert.deepEqual(claimed?.sessionIds, [next.id], 'the claim adopted the sandbox');

    // release now writes against its stale snapshot — the CAS must refuse.
    const released = await store.sandboxes.releaseHolder(
      sandbox.id,
      [gone.id],
      { sessionIds: [], idleSince: NOW },
      NOW,
    );
    assert.equal(released, undefined, 'the stale holder set no longer matches, so the write is a no-op');
    const after = await store.sandboxes.get(sandbox.id);
    assert.deepEqual(after?.sessionIds, [next.id], "the claiming session's hold is intact");
    assert.equal(after?.idleSince, undefined, 'and the sandbox is not marked idle');
  });

  const lostError = {
    code: 'SANDBOX_UNREACHABLE',
    message: 'lease expired and the sandbox is gone',
    details: {},
    occurredAt: NOW,
    retryable: true,
  };

  test('markLostIfLeaseUnchanged marks lost when the lease is the observed value', async () => {
    const { workspace } = await seed();
    const sandbox = await store.sandboxes.create(makeSandbox(workspace.id, { leaseExpiresAt: NOW }));
    const marked = await store.sandboxes.markLostIfLeaseUnchanged(sandbox.id, NOW, lostError, NOW + 10);
    assert.equal(marked?.status, 'lost', 'an unrenewed expired lease is marked lost');
    assert.equal(marked?.error?.code, 'SANDBOX_UNREACHABLE');
  });

  test('markLostIfLeaseUnchanged refuses once a heartbeat renewed the lease', async () => {
    const { workspace } = await seed();
    // The reaper observed lease_expires_at = NOW; a heartbeat then renewed it.
    const sandbox = await store.sandboxes.create(makeSandbox(workspace.id, { leaseExpiresAt: NOW }));
    await store.sandboxes.renewLease(sandbox.id, NOW + 120_000, NOW + 5);

    const marked = await store.sandboxes.markLostIfLeaseUnchanged(sandbox.id, NOW, lostError, NOW + 10);
    assert.equal(marked, undefined, 'a renewed lease means a heartbeat won — do not mark lost');
    const after = await store.sandboxes.get(sandbox.id);
    assert.equal(after?.status, 'ready', 'the live sandbox stays ready');
    assert.equal(after?.leaseExpiresAt, NOW + 120_000, 'its renewed lease is intact');
  });

  test('markLostIfLeaseUnchanged refuses a sandbox already released or lost', async () => {
    const { workspace } = await seed();
    const sandbox = await store.sandboxes.create(
      makeSandbox(workspace.id, { status: 'released', leaseExpiresAt: NOW }),
    );
    const marked = await store.sandboxes.markLostIfLeaseUnchanged(sandbox.id, NOW, lostError, NOW + 10);
    assert.equal(marked, undefined, 'a terminal sandbox is not re-marked lost');
  });

  test('listLiveProviderRefs returns every live ref, not just the first page', async () => {
    // The orphan-reaper destroys every backend resource NOT in this set, so it
    // must be the COMPLETE live set. A paged list() clamps to 50; with more live
    // sandboxes than that, the refs past the cap would be omitted and the reaper
    // would destroy those live sandboxes. Seed more than the page cap and assert
    // all of them come back, plus that terminal/ref-less rows are excluded.
    const { workspace } = await seed();
    const liveRefs = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const ref = `ctr-${String(i).padStart(3, '0')}`;
      liveRefs.add(ref);
      await store.sandboxes.create(
        makeSandbox(workspace.id, { poolKey: `p-${i}`, providerRef: ref, status: i % 2 ? 'ready' : 'draining' }),
      );
    }
    // A terminal sandbox and a ref-less one must NOT appear.
    await store.sandboxes.create(makeSandbox(workspace.id, { providerRef: 'ctr-terminal', status: 'lost' }));
    await store.sandboxes.create(makeSandbox(workspace.id, { providerRef: '', status: 'ready' }));

    const refs = await store.sandboxes.listLiveProviderRefs();
    assert.equal(refs.length, 60, `expected all 60 live refs, got ${refs.length}`);
    assert.deepEqual(new Set(refs), liveRefs, 'every live ref is present, and only live ones');
    assert.ok(!refs.includes('ctr-terminal'), 'a terminal sandbox ref is excluded');
    assert.ok(!refs.includes(''), 'an empty ref is excluded');
  });
});

// --- receipts --------------------------------------------------------------

describe('receipt idempotency', () => {
  async function makeConnector(workspaceId: string, agentId: string) {
    return store.connectors.create({
      id: newId('connector'),
      workspaceId,
      type: 'webhook',
      name: 'hook',
      description: '',
      status: 'active',
      agentId,
      externalKey: `key-${Math.random().toString(36).slice(2, 8)}`,
      sessionPolicy: 'new_per_event',
      config: {},
      ownerPrincipalId: 'pr_test',
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: 'pr_test',
    });
  }

  function makeReceipt(connectorId: string, workspaceId: string, externalEventId: string): Receipt {
    return {
      id: newId('receipt'),
      connectorId,
      workspaceId,
      externalEventId,
      status: 'pending',
      attempt: 0,
      maxAttempts: 5,
      payloadSummary: '',
      responseContext: {},
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: 'connector',
    };
  }

  test('a retried delivery returns the original receipt instead of starting a second run', async () => {
    const { workspace, agent } = await seed();
    const connector = await makeConnector(workspace.id, agent.id);

    const first = await store.receipts.createIfAbsent(makeReceipt(connector.id, workspace.id, 'evt-1'));
    const retry = await store.receipts.createIfAbsent(makeReceipt(connector.id, workspace.id, 'evt-1'));

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.receipt.id, first.receipt.id);
  });

  test('scopes deduplication to the connector', async () => {
    const { workspace, agent } = await seed();
    const a = await makeConnector(workspace.id, agent.id);
    const b = await makeConnector(workspace.id, agent.id);

    const one = await store.receipts.createIfAbsent(makeReceipt(a.id, workspace.id, 'shared-id'));
    const two = await store.receipts.createIfAbsent(makeReceipt(b.id, workspace.id, 'shared-id'));
    assert.equal(one.created, true);
    assert.equal(two.created, true, 'the same event id on another connector is a distinct delivery');
  });

  test('claims a due receipt once and increments its attempt', async () => {
    const { workspace, agent } = await seed();
    const connector = await makeConnector(workspace.id, agent.id);
    await store.receipts.createIfAbsent(makeReceipt(connector.id, workspace.id, 'evt-1'));

    const claimed = await store.receipts.claimNext(NOW, NOW + 30_000);
    assert.equal(claimed?.status, 'working');
    assert.equal(claimed?.attempt, 1);
    assert.equal(claimed?.leaseExpiresAt, NOW + 30_000);

    // A second worker must find nothing: the receipt is no longer pending.
    assert.equal(await store.receipts.claimNext(NOW, NOW + 30_000), undefined);
  });

  test('does not claim a receipt whose backoff has not elapsed', async () => {
    const { workspace, agent } = await seed();
    const connector = await makeConnector(workspace.id, agent.id);
    const { receipt } = await store.receipts.createIfAbsent(
      makeReceipt(connector.id, workspace.id, 'evt-1'),
    );
    await store.receipts.update(receipt.id, { nextAttemptAt: NOW + 60_000 });

    assert.equal(await store.receipts.claimNext(NOW, NOW + 30_000), undefined);
    assert.ok(await store.receipts.claimNext(NOW + 60_000, NOW + 90_000));
  });

  test('receipts that arrived in the same millisecond are claimed in the order they arrived', async () => {
    const { workspace, agent } = await seed();
    const connector = await makeConnector(workspace.id, agent.id);
    const ids = ['rc_c', 'rc_a', 'rc_b'];
    for (const id of ids) {
      await store.receipts.createIfAbsent({ ...makeReceipt(connector.id, workspace.id, id), id });
    }

    const order: string[] = [];
    for (let claimed = await store.receipts.claimNext(NOW, NOW + 1000); claimed; claimed = await store.receipts.claimNext(NOW, NOW + 1000)) {
      order.push(claimed.id);
    }
    assert.deepEqual(order, ids);
  });

  describe('hasEarlierOpen', () => {
    async function receiptsOf(
      specs: Array<{ id: string; createdAt: number; status?: Receipt['status']; bindingId?: string; connectorId?: string }>,
    ): Promise<{ connectorId: string }> {
      const { workspace, agent } = await seed();
      const connector = await makeConnector(workspace.id, agent.id);
      for (const spec of specs) {
        await store.receipts.createIfAbsent({
          ...makeReceipt(spec.connectorId ?? connector.id, workspace.id, spec.id),
          id: spec.id,
          createdAt: spec.createdAt,
          status: spec.status ?? 'pending',
          ...(spec.bindingId !== undefined ? { bindingId: spec.bindingId } : {}),
        });
      }
      return { connectorId: connector.id };
    }

    test('an older receipt of the conversation still pending or working holds this one back', async () => {
      for (const status of ['pending', 'working'] as const) {
        const { connectorId } = await receiptsOf([
          { id: `rc_old_${status}`, createdAt: NOW, status },
          { id: `rc_new_${status}`, createdAt: NOW + 1 },
        ]);
        assert.equal(
          await store.receipts.hasEarlierOpen({ id: `rc_new_${status}`, connectorId, createdAt: NOW + 1 }),
          true,
          `an older ${status} receipt`,
        );
      }
    });

    test('an older receipt that finished, one that came later, and the receipt itself do not', async () => {
      const { connectorId } = await receiptsOf([
        { id: 'rc_done', createdAt: NOW, status: 'succeeded' },
        { id: 'rc_failed', createdAt: NOW, status: 'failed' },
        { id: 'rc_zombie', createdAt: NOW, status: 'zombie' },
        { id: 'rc_this', createdAt: NOW + 1, status: 'working' },
        { id: 'rc_later', createdAt: NOW + 2 },
      ]);
      assert.equal(await store.receipts.hasEarlierOpen({ id: 'rc_this', connectorId, createdAt: NOW + 1 }), false);
    });

    test('of two that arrived in the same millisecond, the first inserted is the earlier', async () => {
      const { connectorId } = await receiptsOf([
        { id: 'rc_b', createdAt: NOW },
        { id: 'rc_a', createdAt: NOW },
      ]);
      assert.equal(await store.receipts.hasEarlierOpen({ id: 'rc_a', connectorId, createdAt: NOW }), true);
      assert.equal(await store.receipts.hasEarlierOpen({ id: 'rc_b', connectorId, createdAt: NOW }), false);
    });

    test('another connector, or another binding when one is given, is another conversation', async () => {
      const { connectorId } = await receiptsOf([
        { id: 'rc_scope_a', createdAt: NOW, bindingId: 'bd_a' },
        { id: 'rc_scope_b', createdAt: NOW + 1, bindingId: 'bd_b' },
      ]);
      const other = await receiptsOf([{ id: 'rc_elsewhere', createdAt: NOW - 5 }]);
      assert.notEqual(other.connectorId, connectorId);

      assert.equal(await store.receipts.hasEarlierOpen({ id: 'rc_scope_a', connectorId, createdAt: NOW }), false);
      assert.equal(
        await store.receipts.hasEarlierOpen({ id: 'rc_scope_b', connectorId, createdAt: NOW + 1, bindingId: 'bd_b' }),
        false,
      );
      assert.equal(
        await store.receipts.hasEarlierOpen({ id: 'rc_scope_b', connectorId, createdAt: NOW + 1, bindingId: 'bd_a' }),
        true,
      );
      // Without a binding the conversation is the whole connector.
      assert.equal(await store.receipts.hasEarlierOpen({ id: 'rc_scope_b', connectorId, createdAt: NOW + 1 }), true);
    });
  });

  test('surfaces working receipts whose lease lapsed, for zombie promotion', async () => {
    const { workspace, agent } = await seed();
    const connector = await makeConnector(workspace.id, agent.id);
    await store.receipts.createIfAbsent(makeReceipt(connector.id, workspace.id, 'evt-1'));
    await store.receipts.claimNext(NOW, NOW + 1000);

    assert.equal((await store.receipts.findExpiredLeases(NOW + 500, 10)).length, 0);
    assert.equal((await store.receipts.findExpiredLeases(NOW + 2000, 10)).length, 1);
  });

  test('renewLease extends a working receipt and rescues it from the reaper', async () => {
    const { workspace, agent } = await seed();
    const connector = await makeConnector(workspace.id, agent.id);
    await store.receipts.createIfAbsent(makeReceipt(connector.id, workspace.id, 'evt-1'));
    const claimed = (await store.receipts.claimNext(NOW, NOW + 1000))!;

    // Before renewal, the lease has lapsed and the reaper would collect it.
    assert.equal((await store.receipts.findExpiredLeases(NOW + 2000, 10)).length, 1);

    // A live worker heartbeats: the lease is pushed out, so the same reaper pass
    // now finds nothing to zombie — the still-running delivery is protected.
    const renewed = await store.receipts.renewLease(claimed.id, NOW + 5000, NOW + 1500);
    assert.equal(renewed?.status, 'working');
    assert.equal(renewed?.leaseExpiresAt, NOW + 5000);
    assert.equal((await store.receipts.findExpiredLeases(NOW + 2000, 10)).length, 0);
  });

  test('renewLease refuses a receipt that already left working', async () => {
    const { workspace, agent } = await seed();
    const connector = await makeConnector(workspace.id, agent.id);
    await store.receipts.createIfAbsent(makeReceipt(connector.id, workspace.id, 'evt-1'));
    const claimed = (await store.receipts.claimNext(NOW, NOW + 1000))!;

    // The lease lapsed and the reaper promoted it to zombie (terminal).
    await store.receipts.compareAndSetStatus(claimed.id, 'working', {
      status: 'zombie',
      completedAt: NOW + 2000,
      updatedAt: NOW + 2000,
    });

    // A heartbeat arriving late must not resurrect the terminal receipt, and the
    // `undefined` return is the worker's cue that it lost its claim and must stop.
    assert.equal(await store.receipts.renewLease(claimed.id, NOW + 9000, NOW + 3000), undefined);
    assert.equal((await store.receipts.get(claimed.id))?.status, 'zombie');
    assert.equal(
      (await store.receipts.get(claimed.id))?.leaseExpiresAt,
      NOW + 1000,
      'a refused renewal must not push the lease out',
    );
  });
});

// --- credentials -----------------------------------------------------------

describe('credential repository', () => {
  test('never returns ciphertext through a normal read', async () => {
    const { workspace } = await seed();
    const credential = {
      id: newId('credential'),
      workspaceId: workspace.id,
      ownerType: 'workspace' as const,
      ownerId: workspace.id,
      type: 'api_key' as const,
      name: 'token',
      description: '',
      status: 'active' as const,
      keyVersion: 'v1',
      valueKeys: [],
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: 'pr_test',
    };
    await store.credentials.create(credential, 'SEALED-CIPHERTEXT');

    const read = await store.credentials.get(credential.id);
    assert.ok(read);
    assert.equal(JSON.stringify(read).includes('SEALED-CIPHERTEXT'), false);

    // Only the dedicated accessor returns it.
    assert.equal(await store.credentials.getSealed(credential.id), 'SEALED-CIPHERTEXT');
  });
});

// --- idempotency -----------------------------------------------------------

describe('idempotency keys', () => {
  test('the first caller reserves and the second is told to wait', async () => {
    const first = await store.idempotency.reserve('k1', 'POST /sessions', NOW, 60_000);
    assert.equal(first.reserved, true);

    const second = await store.idempotency.reserve('k1', 'POST /sessions', NOW, 60_000);
    assert.equal(second.reserved, false);
    assert.ok(!second.reserved && second.record.statusCode === undefined, 'still in flight');
  });

  test('a completed key replays the original response', async () => {
    await store.idempotency.reserve('k1', 'scope', NOW, 60_000);
    await store.idempotency.complete('k1', 'scope', 201, '{"id":"sn_1"}', NOW + 100, 60_000);

    const retry = await store.idempotency.reserve('k1', 'scope', NOW + 200, 60_000);
    assert.ok(!retry.reserved);
    assert.equal(retry.record.statusCode, 201);
    assert.equal(retry.record.response, '{"id":"sn_1"}');
  });

  test('an expired reservation is reclaimed rather than blocking forever', async () => {
    await store.idempotency.reserve('k1', 'scope', NOW, 1000);
    const later = await store.idempotency.reserve('k1', 'scope', NOW + 5000, 1000);
    assert.equal(later.reserved, true, 'a crashed request must not poison its key permanently');
  });

  test('an abandoned reservation self-heals after its short in-flight lease, not the retention TTL', async () => {
    // The in-flight lease and the completed-record retention window are distinct.
    // A reservation abandoned by a hard crash between reserve and complete must be
    // reclaimable once the SHORT lease lapses — not held for the full (much longer)
    // retention TTL, which would brick the key with a misleading "in flight" 409.
    const lease = 5 * 60 * 1000; // 5 min
    const retention = 24 * 60 * 60 * 1000; // 24h
    await store.idempotency.reserve('k1', 'scope', NOW, lease);
    // Just after the lease lapses — far short of the retention window.
    const afterLease = await store.idempotency.reserve('k1', 'scope', NOW + lease + 1, retention);
    assert.equal(
      afterLease.reserved,
      true,
      'an abandoned reservation must be reclaimable once its short lease lapses',
    );
  });

  test('a live reservation still gets a 409 within its lease', async () => {
    const lease = 5 * 60 * 1000;
    await store.idempotency.reserve('k1', 'scope', NOW, lease);
    const during = await store.idempotency.reserve('k1', 'scope', NOW + lease - 1, lease);
    assert.equal(during.reserved, false, 'a genuinely in-flight request must still be told to wait');
    assert.ok(!during.reserved && during.record.statusCode === undefined, 'still in flight');
  });

  test('completing extends the expiry to the full retention window', async () => {
    // reserve gives only the short lease; without complete pushing the expiry out,
    // a completed record would stop replaying the moment the lease lapsed. It must
    // survive — and replay — for the whole retention window.
    const lease = 5 * 60 * 1000;
    const retention = 24 * 60 * 60 * 1000;
    await store.idempotency.reserve('k1', 'scope', NOW, lease);
    await store.idempotency.complete('k1', 'scope', 201, '{"id":"sn_1"}', NOW, retention, undefined);

    // Long after the in-flight lease would have lapsed, the completed record still replays.
    const retry = await store.idempotency.reserve('k1', 'scope', NOW + lease + 1, lease);
    assert.ok(!retry.reserved, 'a completed record must outlive the in-flight lease');
    assert.equal(retry.record.statusCode, 201);
    assert.equal(retry.record.response, '{"id":"sn_1"}');
  });

  test('release frees an incomplete key but leaves a completed one', async () => {
    await store.idempotency.reserve('k1', 'scope', NOW, 60_000);
    await store.idempotency.release('k1', 'scope');
    assert.equal((await store.idempotency.reserve('k1', 'scope', NOW, 60_000)).reserved, true);

    await store.idempotency.complete('k1', 'scope', 200, 'body', NOW, 60_000);
    await store.idempotency.release('k1', 'scope');
    const still = await store.idempotency.reserve('k1', 'scope', NOW, 60_000);
    assert.equal(still.reserved, false, 'a completed result must survive release');
  });

  test('separates keys by scope', async () => {
    await store.idempotency.reserve('same-key', 'POST /a', NOW, 60_000);
    const other = await store.idempotency.reserve('same-key', 'POST /b', NOW, 60_000);
    assert.equal(other.reserved, true);
  });
});

// --- transactions ----------------------------------------------------------

describe('transactions', () => {
  test('roll back every write when the callback throws', async () => {
    const { workspace } = await seed();
    await assert.rejects(
      store.transaction((tx) => {
        void tx.agents.create(makeAgent(workspace.id, { name: 'doomed' }));
        throw new Error('boom');
      }),
    );

    const agents = await store.agents.list({ workspaceId: workspace.id });
    assert.equal(agents.items.some((a) => a.name === 'doomed'), false);
  });

  test('commit every write when the callback succeeds', async () => {
    const { workspace } = await seed();
    const created = await store.transaction((tx) => {
      const agent = makeAgent(workspace.id, { name: 'kept' });
      void tx.agents.create(agent);
      void tx.agents.bumpVersion(agent.id, 0, 1, NOW);
      return agent;
    });
    assert.equal((await store.agents.get(created.id))?.latestVersion, 1);
  });

  test('a nested transaction reports its failure synchronously', async () => {
    // The parent callback is synchronous and cannot await, so a nested failure
    // delivered as a rejected promise would be invisible to it: the savepoint
    // rolls back while the parent carries on believing the inner unit of work
    // succeeded, and the rejection surfaces later as an unhandled one.
    const { workspace } = await seed();

    await store.transaction((tx) => {
      let caught: unknown;
      try {
        void tx.transaction(() => {
          throw new Error('inner fails');
        });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error, 'a nested failure must throw, not reject');
      assert.equal((caught as Error).message, 'inner fails');
      return undefined;
    });
  });

  test('never holds the connection in a transaction across an await', async () => {
    // The root cause of two bugs, asserted directly as an invariant rather than
    // through a race that is now impossible to stage.
    //
    // The old implementation took an async callback and held BEGIN IMMEDIATE
    // open across its await points. Because SQLite gives us one connection and
    // a transaction is connection-scoped, *any* write issued during that window
    // — including from an unrelated task that never used a transaction — landed
    // inside it and was destroyed by its ROLLBACK. The same window deadlocked
    // nested calls.
    //
    // A synchronous callback removes the window rather than guarding it, so the
    // test is: at no point visible to another task is a transaction open.
    const { workspace } = await seed();

    const pending = store.transaction((tx) => tx.agents.create(makeAgent(workspace.id, { name: 'atomic' })));

    // Control is back here while `pending` is unsettled. On the old code the
    // connection was mid-transaction at this instant, and a write from any
    // other task would have joined it.
    assert.equal(
      store.database.inTransaction,
      false,
      'the connection must not be inside a transaction once control returns to the caller',
    );

    const bystander = await store.agents.create(makeAgent(workspace.id, { name: 'innocent-bystander' }));
    await pending;

    // Both survive: the bystander was never captured, so nothing could have
    // rolled it back.
    assert.equal((await store.agents.get(bystander.id))?.name, 'innocent-bystander');
    const agents = await store.agents.list({ workspaceId: workspace.id });
    assert.ok(agents.items.some((a) => a.name === 'atomic'));
  });

  test('a nested transaction joins the outer one instead of deadlocking', async () => {
    // Previously this hung forever with no timeout: the nested call was chained
    // onto the queue behind the outer transaction, which was waiting on it.
    const { workspace } = await seed();

    const agent = await store.transaction((tx) => {
      const outer = makeAgent(workspace.id, { name: 'outer' });
      void tx.agents.create(outer);
      // Joins rather than opening a second transaction on the same connection.
      void tx.transaction((inner) => inner.agents.create(makeAgent(workspace.id, { name: 'inner' })));
      return outer;
    });

    assert.equal((await store.agents.get(agent.id))?.name, 'outer');
    const agents = await store.agents.list({ workspaceId: workspace.id });
    assert.ok(agents.items.some((a) => a.name === 'inner'), 'the nested write commits with the outer');
  });

  test('a nested failure rolls back to the savepoint, not the whole transaction', async () => {
    const { workspace } = await seed();

    const agent = await store.transaction((tx) => {
      const outer = makeAgent(workspace.id, { name: 'survivor' });
      void tx.agents.create(outer);
      try {
        void tx.transaction((inner) => {
          void inner.agents.create(makeAgent(workspace.id, { name: 'nested-doomed' }));
          throw new Error('inner fails');
        });
      } catch {
        // Swallowed on purpose: the outer unit of work continues. This is
        // catchable only because a nested call throws rather than rejecting.
      }
      return outer;
    });

    const agents = await store.agents.list({ workspaceId: workspace.id });
    assert.ok(agents.items.some((a) => a.name === 'survivor'));
    assert.equal(agents.items.some((a) => a.name === 'nested-doomed'), false);
  });

  test('a failed transaction does not block the next one', async () => {
    const { workspace } = await seed();
    await assert.rejects(
      store.transaction(() => {
        throw new Error('first fails');
      }),
    );
    const agent = await store.transaction((tx) => {
      const next = makeAgent(workspace.id, { name: 'after' });
      void tx.agents.create(next);
      return next;
    });
    assert.equal((await store.agents.get(agent.id))?.name, 'after');
  });

  test('a transaction whose COMMIT fails still leaves the connection usable', async () => {
    // The depth-counter bug: the success path decremented #transactionDepth
    // BEFORE issuing COMMIT, so a throwing COMMIT fell into the catch and
    // decremented a second time — leaving the depth two below entry. The next
    // transaction then issued BEGIN on top of a still-open transaction (or skipped
    // its rollback), wedging the connection. Force a real COMMIT failure with a
    // deferred foreign key: the violating row passes at insert time and the check
    // fires at COMMIT.
    const db = openDatabase({ location: ':memory:' });
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED
      );
    `);

    // A transaction that inserts a child pointing at a non-existent parent: the
    // deferred FK check fails at COMMIT, so `transaction()` must throw AND unwind
    // its depth correctly.
    assert.throws(() =>
      db.transaction(() => {
        db.run('INSERT INTO child (id, parent_id) VALUES (1, 999)');
      }),
    );

    // The connection is not wedged: a fresh transaction commits normally.
    assert.equal(db.inTransaction, false, 'no transaction is left dangling after the failed COMMIT');
    db.transaction(() => {
      db.run('INSERT INTO parent (id) VALUES (1)');
    });
    assert.equal(db.get('SELECT COUNT(*) AS n FROM parent')?.n, 1, 'the next transaction works');
  });
});

// --- artifacts ---------------------------------------------------------------

describe('artifact repository', () => {
  async function seedSession(): Promise<{ workspaceId: string; sessionId: string }> {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    return { workspaceId: workspace.id, sessionId: session.id };
  }

  function makeArtifact(
    workspaceId: string,
    sessionId: string,
    overrides: Partial<Artifact> = {},
  ): Artifact {
    return {
      id: newId('artifact'),
      workspaceId,
      sessionId,
      path: 'report.md',
      contentType: 'text/plain',
      sizeBytes: 100,
      digest: 'a'.repeat(64),
      status: 'available',
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: sessionId,
      ...overrides,
    };
  }

  test('the same bytes at the same path is one artifact', async () => {
    // An upload retried after a dropped connection must not charge storage
    // twice or leave two rows naming identical content.
    const { workspaceId, sessionId } = await seedSession();

    const first = await store.artifacts.createIfAbsent(makeArtifact(workspaceId, sessionId));
    const retry = await store.artifacts.createIfAbsent(makeArtifact(workspaceId, sessionId));

    assert.equal(first.created, true);
    assert.equal(retry.created, false, 'a retry must not create a second row');
    assert.equal(retry.artifact.id, first.artifact.id);
    assert.equal(await store.artifacts.totalBytes(workspaceId), 100, 'charged once');
  });

  test('the same path with different bytes is a new artifact', async () => {
    // The counterpart: an agent rewriting a report is producing a new version,
    // not retrying. Deduplicating on path alone would silently discard it.
    const { workspaceId, sessionId } = await seedSession();

    await store.artifacts.createIfAbsent(makeArtifact(workspaceId, sessionId));
    const second = await store.artifacts.createIfAbsent(
      makeArtifact(workspaceId, sessionId, { digest: 'b'.repeat(64) }),
    );

    assert.equal(second.created, true);
    assert.equal(await store.artifacts.totalBytes(workspaceId), 200);
  });

  test('uploads cannot exceed the storage limit', async () => {
    // Ten uploads against a limit that fits three.
    //
    // Honest note on what this does and does not prove: the repository is
    // synchronous, so these do not actually interleave on this driver, and the
    // test passes with or without the surrounding transaction. It pins the
    // *limit* behaviour, not the atomicity. The atomicity matters for a driver
    // with real async I/O, and is asserted structurally instead — the count and
    // the insert are inside one `db.transaction`, which `store.transaction`'s
    // synchronous-callback contract makes uninterruptible.
    const { workspaceId, sessionId } = await seedSession();
    const limit = 1000;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        store.artifacts.createWithinStorageLimit(
          makeArtifact(workspaceId, sessionId, {
            path: `chunk-${index}.bin`,
            digest: String(index).padStart(64, '0'),
            sizeBytes: 300,
          }),
          limit,
        ),
      ),
    );

    const accepted = results.filter(Boolean).length;
    assert.equal(accepted, 3, `accepted ${accepted} uploads against a limit fitting 3`);
    assert.ok(
      (await store.artifacts.totalBytes(workspaceId)) <= limit,
      'stored bytes must never exceed the limit',
    );
  });

  test('a retry of stored content is not refused for exceeding the limit', async () => {
    // A duplicate adds no bytes, so refusing it would fail an upload that costs
    // nothing — and the agent would reasonably retry again.
    const { workspaceId, sessionId } = await seedSession();
    const artifact = makeArtifact(workspaceId, sessionId, { sizeBytes: 900 });

    const first = await store.artifacts.createWithinStorageLimit(artifact, 1000);
    assert.equal(first?.created, true);

    // The workspace is now at 900 of 1000; a fresh 900-byte upload would fail.
    const retry = await store.artifacts.createWithinStorageLimit(artifact, 1000);
    assert.equal(retry?.created, false, 'the retry returns the original row');
    assert.equal(retry?.artifact.id, first?.artifact.id);
  });

  test('counts live references to a blob, scoped to the workspace', async () => {
    // Purging bytes must not orphan a row that still names them, and one
    // tenant's deletion must never consult another's reference count.
    const { workspaceId, sessionId } = await seedSession();
    const digest = 'c'.repeat(64);

    await store.artifacts.createIfAbsent(makeArtifact(workspaceId, sessionId, { digest }));
    await store.artifacts.createIfAbsent(
      makeArtifact(workspaceId, sessionId, { path: 'copy.md', digest }),
    );
    assert.equal(await store.artifacts.countByDigest(workspaceId, digest), 2);

    const other = await seedSession();
    assert.equal(
      await store.artifacts.countByDigest(other.workspaceId, digest),
      0,
      'another workspace must not see these references',
    );
  });

  test('a purged artifact keeps its row but stops being charged', async () => {
    // `expired` and `purged` differ on purpose: the row outlives the bytes, so
    // "this session produced a report" stays answerable after the report is
    // gone.
    const { workspaceId, sessionId } = await seedSession();
    const created = await store.artifacts.createIfAbsent(makeArtifact(workspaceId, sessionId));

    await store.artifacts.update(created.artifact.id, {
      status: 'purged',
      purgedAt: NOW + 1000,
      updatedAt: NOW + 1000,
    });

    assert.equal(await store.artifacts.totalBytes(workspaceId), 0, 'purged bytes are not charged');
    const row = await store.artifacts.get(created.artifact.id);
    assert.equal(row?.status, 'purged');
    assert.equal(row?.sizeBytes, 100, 'the record of what existed survives');
  });

  test('finds artifacts past retention that have not been purged', async () => {
    const { workspaceId, sessionId } = await seedSession();
    await store.artifacts.createIfAbsent(
      makeArtifact(workspaceId, sessionId, { path: 'old.md', expiresAt: NOW - 1 }),
    );
    await store.artifacts.createIfAbsent(
      makeArtifact(workspaceId, sessionId, { path: 'live.md', digest: 'd'.repeat(64) }),
    );

    const expired = await store.artifacts.findExpired(NOW, 10);
    assert.deepEqual(expired.map((a) => a.path), ['old.md']);
  });
});

// --- cascade ---------------------------------------------------------------

describe('daily usage counter', () => {
  const DAY = Date.UTC(2026, 0, 15);
  const NEXT_DAY = Date.UTC(2026, 0, 16);

  test('addTokens accumulates tokens and cost across calls for a (workspace, day)', async () => {
    const { workspace } = await seed();
    assert.equal(await store.usage.tokensToday(workspace.id, DAY), 0, 'absent reads as 0');
    assert.equal(await store.usage.costToday(workspace.id, DAY), 0, 'absent cost reads as 0');
    await store.usage.addTokens(workspace.id, DAY, 100, 40, 1200);
    await store.usage.addTokens(workspace.id, DAY, 10, 5, 300);
    assert.equal(
      await store.usage.tokensToday(workspace.id, DAY),
      155,
      'input + output summed across both calls',
    );
    assert.equal(
      await store.usage.costToday(workspace.id, DAY),
      1500,
      'cost summed across both calls',
    );
  });

  test('counters are isolated per day and per workspace', async () => {
    const { workspace } = await seed();
    const other = await store.workspaces.create({
      id: newId('workspace'), slug: 'other-usage', name: 'Other', description: '', status: 'active',
      members: [], quota: {
        maxConcurrentSessions: 20, maxSandboxes: 20, maxTokensPerDay: 1_000_000, maxCostMicrosPerDay: 0,
        maxStorageMb: 1024, maxAgents: 100, maxKnowledgeChunks: 100_000, eventRetentionDays: 90,
      },
      systemPrompt: '', version: 1, metadata: {}, createdAt: NOW, updatedAt: NOW, createdBy: 'test',
    });

    await store.usage.addTokens(workspace.id, DAY, 100, 0, 50);
    await store.usage.addTokens(workspace.id, NEXT_DAY, 7, 0, 3);
    await store.usage.addTokens(other.id, DAY, 500, 0, 200);

    assert.equal(await store.usage.tokensToday(workspace.id, DAY), 100);
    assert.equal(await store.usage.costToday(workspace.id, DAY), 50);
    assert.equal(await store.usage.tokensToday(workspace.id, NEXT_DAY), 7, 'a different day is separate');
    assert.equal(await store.usage.tokensToday(other.id, DAY), 500, 'a different workspace is separate');
    assert.equal(await store.usage.costToday(other.id, DAY), 200, 'cost is per-workspace too');
  });

  test('the counter cascades away with its workspace', async () => {
    const { workspace } = await seed();
    await store.usage.addTokens(workspace.id, DAY, 100, 0, 40);
    await store.workspaces.delete(workspace.id);
    assert.equal(await store.usage.tokensToday(workspace.id, DAY), 0, 'ON DELETE CASCADE removed it');
    assert.equal(await store.usage.costToday(workspace.id, DAY), 0, 'cost cascaded too');
  });

  test('usageBetween returns the in-range days, ordered, per workspace', async () => {
    const { workspace } = await seed();
    const D1 = Date.UTC(2026, 0, 10);
    const D2 = Date.UTC(2026, 0, 11);
    const D3 = Date.UTC(2026, 0, 12);
    await store.usage.addTokens(workspace.id, D3, 30, 3, 300); // out of order on purpose
    await store.usage.addTokens(workspace.id, D1, 10, 1, 100);
    await store.usage.addTokens(workspace.id, D2, 20, 2, 200);

    const between = await store.usage.usageBetween(workspace.id, D1, D2);
    assert.deepEqual(
      between.map((d) => d.utcDay),
      [D1, D2],
      'inclusive range, ascending, excludes D3',
    );
    assert.deepEqual(between[0], { utcDay: D1, inputTokens: 10, outputTokens: 1, costMicros: 100 });
    assert.deepEqual(between[1], { utcDay: D2, inputTokens: 20, outputTokens: 2, costMicros: 200 });

    // An empty range and a foreign workspace both read as [].
    assert.deepEqual(await store.usage.usageBetween(workspace.id, D1 - 5 * 86_400_000, D1 - 86_400_000), []);
    assert.deepEqual(await store.usage.usageBetween('ws_01ARZ3NDEKTSV4RRFFQ69G5FAV', D1, D3), []);
  });
});

describe('billed-turn markers', () => {
  const SBX = 'sb_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const SBX2 = 'sb_01ARZ3NDEKTSV4RRFFQ69G5FB0';

  async function seedSession(): Promise<string> {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    return session.id;
  }

  test('mark then consume reports the marker existed, and consuming again does not', async () => {
    const sessionId = await seedSession();
    store.billedTurns.mark(sessionId, SBX, 1, NOW);
    assert.equal(store.billedTurns.consume(sessionId, SBX, 1), true, 'the marker existed');
    assert.equal(store.billedTurns.consume(sessionId, SBX, 1), false, 'consume removed it — gone the second time');
  });

  test('mark is idempotent: a multi-call tool loop marks a turn once', async () => {
    const sessionId = await seedSession();
    store.billedTurns.mark(sessionId, SBX, 2, NOW);
    store.billedTurns.mark(sessionId, SBX, 2, NOW + 5); // a later /completions in the same turn
    store.billedTurns.mark(sessionId, SBX, 2, NOW + 9);
    // One row, and one consume drains it — a single turn is billed/deduped once.
    assert.equal(store.billedTurns.consume(sessionId, SBX, 2), true);
    assert.equal(store.billedTurns.consume(sessionId, SBX, 2), false, 'only one marker despite three marks');
  });

  test('consuming an absent marker reports false without error', async () => {
    const sessionId = await seedSession();
    assert.equal(store.billedTurns.consume(sessionId, SBX, 99), false);
  });

  test('the turn-less sentinel (-1) is a distinct marker from real turns', async () => {
    const sessionId = await seedSession();
    store.billedTurns.mark(sessionId, SBX, TURNLESS_BILLED_TURN, NOW);
    store.billedTurns.mark(sessionId, SBX, 0, NOW); // turn 0 is a real turn, must not collide
    assert.equal(store.billedTurns.consume(sessionId, SBX, 0), true, 'real turn 0 is its own marker');
    assert.equal(
      store.billedTurns.consume(sessionId, SBX, TURNLESS_BILLED_TURN),
      true,
      'the -1 sentinel survived consuming turn 0 — they do not alias',
    );
  });

  test('markers are scoped per session', async () => {
    const a = await seedSession();
    const b = await seedSession();
    store.billedTurns.mark(a, SBX, 1, NOW);
    assert.equal(store.billedTurns.consume(b, SBX, 1), false, 'session B has no marker for turn 1');
    assert.equal(store.billedTurns.consume(a, SBX, 1), true, 'session A still does');
  });

  test('markers are scoped per sandbox generation — a fresh sandbox does not inherit them', async () => {
    // The correctness invariant behind keying by sandbox: a session re-queued onto
    // a NEW sandbox (recovery/upgrade) resets its turn counter, so the old
    // generation's turn-N marker must not dedup the new generation's turn N.
    const sessionId = await seedSession();
    store.billedTurns.mark(sessionId, SBX, 1, NOW); // old generation billed turn 1 via proxy
    assert.equal(
      store.billedTurns.consume(sessionId, SBX2, 1),
      false,
      'the new sandbox generation has no marker for turn 1 — its report bills',
    );
    assert.equal(store.billedTurns.consume(sessionId, SBX, 1), true, 'the old generation marker is still its own');
  });

  test('clearSession drops every marker for a session across generations, and nobody else', async () => {
    const a = await seedSession();
    const b = await seedSession();
    store.billedTurns.mark(a, SBX, 1, NOW);
    store.billedTurns.mark(a, SBX2, 2, NOW); // a second generation of the same session
    store.billedTurns.mark(a, SBX, TURNLESS_BILLED_TURN, NOW);
    store.billedTurns.mark(b, SBX, 1, NOW);

    store.billedTurns.clearSession(a);
    assert.equal(store.billedTurns.consume(a, SBX, 1), false, 'A gen-1 turn 1 cleared');
    assert.equal(store.billedTurns.consume(a, SBX2, 2), false, 'A gen-2 turn 2 cleared');
    assert.equal(store.billedTurns.consume(a, SBX, TURNLESS_BILLED_TURN), false, 'A sentinel cleared');
    assert.equal(store.billedTurns.consume(b, SBX, 1), true, "B's marker untouched");
  });

  test('prune drops markers older than the cutoff, keeps newer ones', async () => {
    const sessionId = await seedSession();
    store.billedTurns.mark(sessionId, SBX, 1, 1000); // old
    store.billedTurns.mark(sessionId, SBX, 2, 5000); // newer
    const dropped = await store.billedTurns.prune(3000);
    assert.equal(dropped, 1, 'only the pre-cutoff marker is pruned');
    assert.equal(store.billedTurns.consume(sessionId, SBX, 1), false, 'the stale marker was pruned');
    assert.equal(store.billedTurns.consume(sessionId, SBX, 2), true, 'the fresh marker survives');
  });

  test('markers cascade away with the session row', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));
    store.billedTurns.mark(session.id, SBX, 1, NOW);
    await store.sessions.delete(session.id);
    assert.equal(
      store.database.get('SELECT 1 FROM billed_turns WHERE session_id = ?', [session.id]),
      undefined,
      'ON DELETE CASCADE removed the marker with its session',
    );
  });
});

describe('dataset repository', () => {
  const mkDataset = (workspaceId: string, chunkCount: number, overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      id: newId('dataset'),
      workspaceId,
      name: 'D',
      description: '',
      status: 'active',
      documentCount: 0,
      chunkCount,
      sizeBytes: 0,
      embeddingModel: '',
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: 'sys',
      ...overrides,
    }) as never;

  test('knowledgeChunksForWorkspace sums chunkCount across a workspace, isolated from others', async () => {
    // The chunk-quota basis: the sum of every live dataset's indexed-chunk rollup,
    // scoped to one workspace. It must not leak another workspace's chunks, and it
    // must exclude archived datasets (which hold no live index chunks).
    const a = await store.workspaces.create(makeWorkspace({ slug: 'chunks-a' }));
    const b = await store.workspaces.create(makeWorkspace({ slug: 'chunks-b' }));
    await store.datasets.create(mkDataset(a.id, 3));
    await store.datasets.create(mkDataset(a.id, 5));
    await store.datasets.create(mkDataset(a.id, 7, { status: 'archived' }));
    await store.datasets.create(mkDataset(b.id, 100));

    assert.equal(
      await store.datasets.knowledgeChunksForWorkspace(a.id),
      8,
      'sums the two live datasets (3 + 5), excludes the archived one and workspace B',
    );
    assert.equal(await store.datasets.knowledgeChunksForWorkspace(b.id), 100);
    assert.equal(
      await store.datasets.knowledgeChunksForWorkspace(newId('workspace')),
      0,
      'a workspace with no datasets reads 0, not undefined',
    );
  });

  test('applyRollupDeltaSync composes with a concurrent decrement instead of clobbering it', async () => {
    // The raise-sites (ingest re-sync, document create) must not read the row and
    // then write an absolute value: a concurrent delete's decrement committing in
    // the await window is silently clobbered by the stale-based write, and since
    // chunkCount is the maxKnowledgeChunks quota basis, that under-count lets the
    // corpus index past the cap. This asserts the interleave that the old
    // get()-then-update(absolute) pattern gets wrong.
    const ws = await store.workspaces.create(makeWorkspace({ slug: 'rollup-race' }));
    const dataset = await store.datasets.create(mkDataset(ws.id, 100, { documentCount: 10, sizeBytes: 1000 }));

    // 1. The ingest worker reads the dataset (chunkCount 100) — a stale snapshot it
    //    will base its absolute write on.
    const staleRead = (await store.datasets.get(dataset.id))!;

    // 2. During the ingest's await window, a concurrent deleteDocument commits its
    //    atomic decrement: one document, 20 chunks, 200 bytes gone.
    await store.transaction((tx) => {
      tx.datasets.applyDocumentRemovalSync(dataset.id, 20, 200, NOW + 1);
    });

    // 3. The ingest now applies its own change. Expressed as a signed delta
    //    (this doc grew from 30 to 50 chunks, +20) it composes with the decrement;
    //    the OLD absolute write `staleRead.chunkCount - 30 + 50 = 120` would have
    //    clobbered the delete, leaving 120 instead of the true 100.
    await store.transaction((tx) => {
      tx.datasets.applyRollupDeltaSync(dataset.id, { chunkCount: -30 + 50, sizeBytes: -300 + 500 }, NOW + 2);
    });

    const final = (await store.datasets.get(dataset.id))!;
    // True live sum: 100 - 20 (delete) - 30 + 50 (re-sync) = 100. The clobbering
    // absolute write would read 120 here.
    assert.equal(final.chunkCount, 100, 'delta composes with the decrement; the decrement is not lost');
    assert.equal(final.sizeBytes, 1000 - 200 - 300 + 500, 'sizeBytes delta composes too');
    assert.equal(final.documentCount, 9, 'the delete decremented documentCount; the re-sync did not touch it');
  });

  test('applyRollupDeltaSync clamps each column at zero', async () => {
    // Pre-existing count drift (or a double-applied removal) must never drive a
    // rollup negative — MAX(0, col + delta), exactly as applyDocumentRemovalSync.
    const ws = await store.workspaces.create(makeWorkspace({ slug: 'rollup-clamp' }));
    const dataset = await store.datasets.create(mkDataset(ws.id, 5, { documentCount: 1, sizeBytes: 50 }));

    await store.transaction((tx) => {
      tx.datasets.applyRollupDeltaSync(dataset.id, { documentCount: -10, chunkCount: -10, sizeBytes: -100 }, NOW + 1);
    });

    const final = (await store.datasets.get(dataset.id))!;
    assert.equal(final.chunkCount, 0, 'chunkCount clamped at 0, not negative');
    assert.equal(final.documentCount, 0, 'documentCount clamped at 0');
    assert.equal(final.sizeBytes, 0, 'sizeBytes clamped at 0');
  });

  test('a delete landing between the ingest row-update and its rollup delta composes to the true sum', async () => {
    // The subtle interleave: process() writes the document row (chunkCount = new),
    // then applies the rollup delta (new - old) in a separate transaction. If a
    // deleteDocument for the SAME document commits in between, it decrements the
    // rollup by the row's chunkCount (already `new`). The ingest delta then adds
    // `new - old`. Net over both: -new + (new - old) = -old — exactly "remove this
    // document's prior contribution", the true state after a re-sync-then-delete.
    // The old absolute write would have over-counted by `new` here.
    const ws = await store.workspaces.create(makeWorkspace({ slug: 'rollup-phantom' }));
    const dataset = await store.datasets.create(mkDataset(ws.id, 100, { documentCount: 10, sizeBytes: 1000 }));
    const oldChunks = 30, newChunks = 50, oldBytes = 300, newBytes = 500;

    // Delete commits its atomic decrement (the row already reflects `newChunks`).
    await store.transaction((tx) => {
      tx.datasets.applyDocumentRemovalSync(dataset.id, newChunks, newBytes, NOW + 1);
    });
    // Ingest's rollup delta lands afterward.
    await store.transaction((tx) => {
      tx.datasets.applyRollupDeltaSync(
        dataset.id,
        { chunkCount: newChunks - oldChunks, sizeBytes: newBytes - oldBytes },
        NOW + 2,
      );
    });

    const final = (await store.datasets.get(dataset.id))!;
    // 100 - 50 (delete of new) + (50 - 30) (ingest delta) = 70 = 100 - oldChunks.
    assert.equal(final.chunkCount, 100 - oldChunks, 'net is exactly -oldChunks, the pre-sync contribution');
    assert.equal(final.sizeBytes, 1000 - oldBytes, 'sizeBytes composes to -oldBytes');
    assert.equal(final.documentCount, 9, 'the delete dropped documentCount by one');
  });
});

describe('referential integrity', () => {
  test('deleting a workspace removes its agents and sessions', async () => {
    const { workspace, agent } = await seed();
    const session = await store.sessions.create(makeSession(workspace.id, agent.id));

    await store.workspaces.delete(workspace.id);

    assert.equal(await store.agents.get(agent.id), undefined);
    assert.equal(await store.sessions.get(session.id), undefined);
  });

  test('deleting an agent removes its versions', async () => {
    const { agent } = await seed();
    await store.agentVersions.create({
      agentId: agent.id,
      version: 1,
      createdAt: NOW,
      createdBy: 'pr_test',
    } as never);

    await store.agents.delete(agent.id);
    assert.equal(await store.agentVersions.get(agent.id, 1), undefined);
  });

  test('deleting a connector removes its bindings and receipts', async () => {
    // The connector DELETE route relies on this DB-level cascade rather than a
    // manual multi-repo delete: `bindings.connector_id` and
    // `receipts.connector_id` are both `ON DELETE CASCADE`, with foreign keys
    // enforced. If the FK or the pragma regressed, deleting a connector would
    // strand orphaned children — this guards that.
    const { workspace, agent } = await seed();
    const connector = await store.connectors.create({
      id: newId('connector'),
      workspaceId: workspace.id,
      type: 'webhook',
      name: 'hook',
      description: '',
      status: 'active',
      agentId: agent.id,
      externalKey: `key-${Math.random().toString(36).slice(2, 8)}`,
      sessionPolicy: 'new_per_event',
      config: {},
      ownerPrincipalId: 'pr_test',
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: 'pr_test',
    });
    const binding = await store.bindings.create({
      id: newId('binding'),
      connectorId: connector.id,
      workspaceId: workspace.id,
      scopeType: 'channel',
      scopeKeyHash: 'a'.repeat(64),
      scopeLabel: '',
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: 'pr_test',
    });
    const { receipt } = await store.receipts.createIfAbsent({
      id: newId('receipt'),
      connectorId: connector.id,
      workspaceId: workspace.id,
      externalEventId: 'evt-1',
      status: 'pending',
      attempt: 0,
      maxAttempts: 5,
      payloadSummary: '',
      responseContext: {},
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: 'connector',
    });

    await store.connectors.delete(connector.id);

    assert.equal(await store.connectors.get(connector.id), undefined);
    assert.equal(await store.bindings.get(binding.id), undefined, 'the binding cascaded');
    assert.equal(await store.receipts.get(receipt.id), undefined, 'the receipt cascaded');
  });
});
