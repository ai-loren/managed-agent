/**
 * Store tests.
 *
 * These run against the real SQLite driver, not a mock — the whole reason the
 * reference implementation is embedded is so the test suite exercises actual
 * SQL, actual transactions and actual constraint violations.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MaError, newId } from '@ma/core';
import type { Agent, Artifact, Receipt, Sandbox, Session, SessionEvent, Workspace } from '@ma/contracts';

import { createMemoryStore, type SqliteStore } from '../src/index.ts';

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
      eventRetentionDays: 90,
    },
    systemPrompt: '',
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

  test('reuses a sandbox once its holders have finished', async () => {
    // The sequential-reuse case the pool is meant for: the previous holder has
    // terminated, so the environment is genuinely idle and can be handed on.
    // (A holder id with no session row at all — e.g. a synthetic prewarm id —
    // is likewise treated as non-live.)
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
    assert.deepEqual(claimed?.sessionIds, [past.id, next.id]);
  });

  test('a prewarmed sandbox with no live holder is claimable', async () => {
    // Prewarm seeds a synthetic holder id that has no session row; it must count
    // as non-live so a real session can adopt the warm sandbox.
    const { workspace } = await seed();
    await store.sandboxes.create(
      makeSandbox(workspace.id, { poolKey: 'pool-warm', sessionIds: ['prewarm-pool-warm-0'] }),
    );

    const claimed = await store.sandboxes.claimFromPool('pool-warm', 'sn_real', NOW);
    assert.ok(claimed, 'a prewarmed sandbox is adopted on first claim');
    assert.deepEqual(claimed?.sessionIds, ['prewarm-pool-warm-0', 'sn_real']);
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

  test('surfaces working receipts whose lease lapsed, for zombie promotion', async () => {
    const { workspace, agent } = await seed();
    const connector = await makeConnector(workspace.id, agent.id);
    await store.receipts.createIfAbsent(makeReceipt(connector.id, workspace.id, 'evt-1'));
    await store.receipts.claimNext(NOW, NOW + 1000);

    assert.equal((await store.receipts.findExpiredLeases(NOW + 500, 10)).length, 0);
    assert.equal((await store.receipts.findExpiredLeases(NOW + 2000, 10)).length, 1);
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
    await store.idempotency.complete('k1', 'scope', 201, '{"id":"sn_1"}', NOW + 100);

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

  test('release frees an incomplete key but leaves a completed one', async () => {
    await store.idempotency.reserve('k1', 'scope', NOW, 60_000);
    await store.idempotency.release('k1', 'scope');
    assert.equal((await store.idempotency.reserve('k1', 'scope', NOW, 60_000)).reserved, true);

    await store.idempotency.complete('k1', 'scope', 200, 'body', NOW);
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
        maxStorageMb: 1024, maxAgents: 100, eventRetentionDays: 90,
      },
      systemPrompt: '', metadata: {}, createdAt: NOW, updatedAt: NOW, createdBy: 'test',
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
