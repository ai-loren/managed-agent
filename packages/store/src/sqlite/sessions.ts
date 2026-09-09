/**
 * Session and sandbox repositories.
 *
 * Two operations here are concurrency-critical and deserve the attention:
 *
 *  - `compareAndSetStatus` guards every session transition, so two workers
 *    cannot both believe they moved a session out of `provisioning`.
 *  - `claimFromPool` atomically hands one warm sandbox to exactly one session.
 *    Getting this wrong would let two sessions share an environment that was
 *    never meant to be shared — a correctness *and* isolation failure.
 */

import { usageSchema } from '@ma/contracts';
import type { ErrorInfo, Sandbox, SandboxStatus, Session, SessionStatus } from '@ma/contracts';

import type { Database } from '../database.ts';
import {
  readJson,
  readNumber,
  readSchemaJson,
  readOptionalJson,
  readOptionalNumber,
  readOptionalString,
  readString,
  writeJson,
  writeOptional,
  writeOptionalJson,
  type Row,
  type SqlValue,
} from '../mapping.ts';
import type {
  Page,
  SandboxFilter,
  SandboxRepository,
  SessionFilter,
  SessionRepository,
} from '../repository.ts';
import { CrudRepository, condition, inCondition, type Condition, type TableSpec } from './crud.ts';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const sessionSpec: TableSpec<Session> = {
  table: 'sessions',
  kind: 'Session',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    workspaceId: readString(row, 'workspace_id'),
    agentId: readString(row, 'agent_id'),
    resolvedVersion: readNumber(row, 'resolved_version'),
    title: readString(row, 'title'),
    status: readString(row, 'status') as SessionStatus,
    origin: readString(row, 'origin') as Session['origin'],
    ...(readOptionalString(row, 'sandbox_id') === undefined
      ? {}
      : { sandboxId: readOptionalString(row, 'sandbox_id')! }),
    credentialIds: readJson(row, 'credential_ids', []),
    lastSeq: readNumber(row, 'last_seq'),
    turnCount: readNumber(row, 'turn_count'),
    // Parsed so every counter is present: token accounting sums these, and
    // `undefined` would propagate NaN through a quota decision.
    usage: readSchemaJson(row, 'usage', usageSchema),
    ...optionalNumber('expiresAt', row, 'expires_at'),
    ...optionalNumber('startedAt', row, 'started_at'),
    ...optionalNumber('lastActivityAt', row, 'last_activity_at'),
    ...optionalNumber('endedAt', row, 'ended_at'),
    ...optionalNumber('archivedAt', row, 'archived_at'),
    ...(readOptionalJson<ErrorInfo>(row, 'error') === undefined
      ? {}
      : { error: readOptionalJson<ErrorInfo>(row, 'error')! }),
    metadata: readJson(row, 'metadata', {}),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (session) => ({
    id: session.id,
    workspace_id: session.workspaceId,
    agent_id: session.agentId,
    resolved_version: session.resolvedVersion,
    title: session.title,
    status: session.status,
    origin: session.origin,
    sandbox_id: writeOptional(session.sandboxId),
    credential_ids: writeJson(session.credentialIds),
    last_seq: session.lastSeq,
    turn_count: session.turnCount,
    usage: writeJson(session.usage),
    expires_at: writeOptional(session.expiresAt),
    started_at: writeOptional(session.startedAt),
    last_activity_at: writeOptional(session.lastActivityAt),
    ended_at: writeOptional(session.endedAt),
    archived_at: writeOptional(session.archivedAt),
    error: writeOptionalJson(session.error),
    metadata: writeJson(session.metadata),
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    created_by: session.createdBy,
  }),
  updateMapping: {
    title: { column: 'title' },
    status: { column: 'status' },
    sandboxId: { column: 'sandbox_id' },
    credentialIds: { column: 'credential_ids', encode: (value) => writeJson(value) },
    lastSeq: { column: 'last_seq' },
    turnCount: { column: 'turn_count' },
    usage: { column: 'usage', encode: (value) => writeJson(value) },
    expiresAt: { column: 'expires_at' },
    startedAt: { column: 'started_at' },
    lastActivityAt: { column: 'last_activity_at' },
    endedAt: { column: 'ended_at' },
    archivedAt: { column: 'archived_at' },
    error: { column: 'error', encode: (value) => writeOptionalJson(value) },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    updatedAt: { column: 'updated_at' },
  },
};

/** Spread helper: include an optional numeric field only when it is present. */
function optionalNumber(field: string, row: Row, column: string): Record<string, number> {
  const value = readOptionalNumber(row, column);
  return value === undefined ? {} : { [field]: value };
}

export class SqliteSessionRepository extends CrudRepository<Session> implements SessionRepository {
  constructor(db: Database) {
    super(db, sessionSpec);
  }

  create(session: Session): Promise<Session> {
    return Promise.resolve(this.insert(session));
  }

  createWithinLimit(session: Session, limit: number): Promise<Session | undefined> {
    // One synchronous transaction, so the count and the insert cannot be
    // separated by an await. That separation was the bug: the service counted,
    // then awaited a version lookup and credential resolution before
    // inserting, so ten concurrent callers all read the same pre-insert count
    // and a limit of 3 admitted all ten.
    const created = this.db.transaction(() => {
      const active = this.count([
        condition('workspace_id = ?', session.workspaceId),
        condition("status NOT IN ('terminated', 'failed')"),
      ]);
      if (active >= limit) return undefined;
      return this.insert(session);
    });
    return Promise.resolve(created);
  }

  get(id: string): Promise<Session | undefined> {
    return Promise.resolve(this.findById(id));
  }

  update(id: string, patch: Partial<Session>): Promise<Session> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: SessionFilter): Promise<Page<Session>> {
    const conditions: Condition[] = [];
    if (filter.workspaceId) conditions.push(condition('workspace_id = ?', filter.workspaceId));
    if (filter.agentId) conditions.push(condition('agent_id = ?', filter.agentId));
    if (filter.resolvedVersion !== undefined) {
      conditions.push(condition('resolved_version = ?', filter.resolvedVersion));
    }
    const statuses = inCondition('status', filter.statuses ?? []);
    if (statuses) conditions.push(statuses);
    if (!filter.includeArchived) conditions.push(condition('archived_at IS NULL'));
    if (filter.createdAfter !== undefined) {
      conditions.push(condition('created_at >= ?', filter.createdAfter));
    }
    if (filter.createdBefore !== undefined) {
      conditions.push(condition('created_at < ?', filter.createdBefore));
    }
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  /**
   * Move a session between statuses only if it is still where the caller
   * believes it is.
   *
   * Returns `undefined` rather than throwing when the row moved: losing this
   * race is normal (a reaper and a worker can both act on the same session),
   * and the caller's correct response is to re-read and reconsider, not to
   * treat it as an error.
   */
  compareAndSetStatus(
    id: string,
    expected: SessionStatus,
    next: SessionStatus,
    patch: Partial<Session>,
  ): Promise<Session | undefined> {
    const result = this.db.transaction(() => {
      const assignments: string[] = ['status = ?'];
      const values: SqlValue[] = [next];

      for (const [field, spec] of Object.entries(sessionSpec.updateMapping)) {
        if (field === 'status' || !Object.hasOwn(patch, field)) continue;
        const raw = (patch as Record<string, unknown>)[field];
        assignments.push(`${spec.column} = ?`);
        values.push(spec.encode ? spec.encode(raw) : ((raw ?? null) as SqlValue));
      }

      const changed = this.db.run(
        `UPDATE sessions SET ${assignments.join(', ')} WHERE id = ? AND status = ?`,
        [...values, id, expected],
      );
      return changed.changes > 0;
    });

    return Promise.resolve(result ? this.findById(id) : undefined);
  }

  countActive(workspaceId: string): Promise<number> {
    return Promise.resolve(
      this.count([
        condition('workspace_id = ?', workspaceId),
        condition("status NOT IN ('terminated', 'failed')"),
      ]),
    );
  }

  findQueued(limit: number): Promise<Session[]> {
    return Promise.resolve(
      this.findMany([condition("status = 'queued'"), condition('archived_at IS NULL')], {
        orderBy: 'created_at',
        limit,
      }),
    );
  }

  findRecovering(now: number, graceMs: number, limit: number): Promise<Session[]> {
    return Promise.resolve(
      this.findMany(
        [
          condition("status = 'provisioning'"),
          condition('sandbox_id IS NULL'),
          // Older than the grace window, so a session a moment into a real
          // `start()` provision — briefly `provisioning` with no sandbox yet —
          // is not snatched out from under it.
          condition('updated_at <= ?', now - graceMs),
          condition('archived_at IS NULL'),
        ],
        { orderBy: 'updated_at', limit },
      ),
    );
  }

  findExpired(now: number, limit: number): Promise<Session[]> {
    return Promise.resolve(
      this.findMany(
        [
          condition('expires_at IS NOT NULL'),
          condition('expires_at < ?', now),
          // `terminating` is included deliberately. It is not a terminal state —
          // it is the state a session sits in *while* being shut down — so
          // excluding it meant a session whose shutdown died halfway (a crashed
          // control plane, a release that threw) stayed there forever, holding
          // its quota slot, and the "every session reaches a terminal state"
          // guarantee was false for exactly the cases that needed it.
          condition("status NOT IN ('terminated', 'failed')"),
        ],
        { orderBy: 'expires_at', limit },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const sandboxSpec: TableSpec<Sandbox> = {
  table: 'sandboxes',
  kind: 'Sandbox',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    workspaceId: readString(row, 'workspace_id'),
    provider: readString(row, 'provider'),
    status: readString(row, 'status') as SandboxStatus,
    endpoint: readString(row, 'endpoint'),
    spec: readJson(row, 'spec', {} as Sandbox['spec']),
    poolKey: readString(row, 'pool_key'),
    sessionIds: readJson(row, 'session_ids', []),
    leaseExpiresAt: readNumber(row, 'lease_expires_at'),
    ...optionalNumber('lastHeartbeatAt', row, 'last_heartbeat_at'),
    ...optionalNumber('releasedAt', row, 'released_at'),
    ...(readOptionalJson<ErrorInfo>(row, 'error') === undefined
      ? {}
      : { error: readOptionalJson<ErrorInfo>(row, 'error')! }),
    providerRef: readString(row, 'provider_ref'),
    runtimeTokenHash: readString(row, 'runtime_token_hash'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (sandbox) => ({
    id: sandbox.id,
    workspace_id: sandbox.workspaceId,
    provider: sandbox.provider,
    status: sandbox.status,
    endpoint: sandbox.endpoint,
    spec: writeJson(sandbox.spec),
    pool_key: sandbox.poolKey,
    session_ids: writeJson(sandbox.sessionIds),
    lease_expires_at: sandbox.leaseExpiresAt,
    last_heartbeat_at: writeOptional(sandbox.lastHeartbeatAt),
    released_at: writeOptional(sandbox.releasedAt),
    error: writeOptionalJson(sandbox.error),
    provider_ref: sandbox.providerRef,
    runtime_token_hash: sandbox.runtimeTokenHash,
    created_at: sandbox.createdAt,
    updated_at: sandbox.updatedAt,
    created_by: sandbox.createdBy,
  }),
  updateMapping: {
    status: { column: 'status' },
    endpoint: { column: 'endpoint' },
    spec: { column: 'spec', encode: (value) => writeJson(value) },
    sessionIds: { column: 'session_ids', encode: (value) => writeJson(value) },
    leaseExpiresAt: { column: 'lease_expires_at' },
    lastHeartbeatAt: { column: 'last_heartbeat_at' },
    releasedAt: { column: 'released_at' },
    error: { column: 'error', encode: (value) => writeOptionalJson(value) },
    providerRef: { column: 'provider_ref' },
    runtimeTokenHash: { column: 'runtime_token_hash' },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteSandboxRepository extends CrudRepository<Sandbox> implements SandboxRepository {
  constructor(db: Database) {
    super(db, sandboxSpec);
  }

  create(sandbox: Sandbox): Promise<Sandbox> {
    return Promise.resolve(this.insert(sandbox));
  }

  createWithinLimit(sandbox: Sandbox, limit: number): Promise<Sandbox | undefined> {
    // Count and insert together; see SqliteSessionRepository.createWithinLimit.
    const created = this.db.transaction(() => {
      const active = this.count([
        condition('workspace_id = ?', sandbox.workspaceId),
        condition("status IN ('pending', 'ready', 'draining')"),
      ]);
      if (active >= limit) return undefined;
      return this.insert(sandbox);
    });
    return Promise.resolve(created);
  }

  get(id: string): Promise<Sandbox | undefined> {
    return Promise.resolve(this.findById(id));
  }

  update(id: string, patch: Partial<Sandbox>): Promise<Sandbox> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: SandboxFilter): Promise<Page<Sandbox>> {
    const conditions: Condition[] = [];
    if (filter.workspaceId) conditions.push(condition('workspace_id = ?', filter.workspaceId));
    if (filter.poolKey) conditions.push(condition('pool_key = ?', filter.poolKey));
    const statuses = inCondition('status', filter.statuses ?? []);
    if (statuses) conditions.push(statuses);
    if (filter.leaseExpiredBefore !== undefined) {
      conditions.push(condition('lease_expires_at < ?', filter.leaseExpiredBefore));
    }
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  /**
   * Hand one warm sandbox to one session, atomically.
   *
   * The whole select-then-bind runs inside a transaction under SQLite's write
   * lock, so two sessions racing for the last warm sandbox cannot both succeed.
   * A sandbox is only eligible when it is `ready`, its lease has not lapsed, and
   * its pool key matches — the pool key encodes image, resources, network policy
   * and credential set, which is exactly the tuple that must be identical for
   * sharing to be safe.
   */
  claimFromPool(poolKey: string, sessionId: string, now: number): Promise<Sandbox | undefined> {
    const claimed = this.db.transaction(() => {
      const row = this.db.get(
        `SELECT * FROM sandboxes
          WHERE pool_key = ? AND status = 'ready' AND lease_expires_at > ?
          ORDER BY last_heartbeat_at DESC LIMIT 1`,
        [poolKey, now],
      );
      if (!row) return undefined;

      const sandbox = sandboxSpec.fromRow(row);
      const sessionIds = [...sandbox.sessionIds, sessionId];
      this.db.run('UPDATE sandboxes SET session_ids = ?, updated_at = ? WHERE id = ?', [
        writeJson(sessionIds),
        now,
        sandbox.id,
      ]);
      return { ...sandbox, sessionIds, updatedAt: now };
    });

    return Promise.resolve(claimed);
  }

  /**
   * Extend a lease. Returns `undefined` if the sandbox was already reaped —
   * the runtime's cue that it must stop, rather than keep working in an
   * environment the control plane has written off.
   */
  renewLease(id: string, leaseExpiresAt: number, at: number): Promise<Sandbox | undefined> {
    const result = this.db.run(
      `UPDATE sandboxes SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'ready')`,
      [leaseExpiresAt, at, at, id],
    );
    return Promise.resolve(result.changes > 0 ? this.findById(id) : undefined);
  }

  findExpiredLeases(now: number, limit: number): Promise<Sandbox[]> {
    return Promise.resolve(
      this.findMany(
        [condition("status IN ('pending', 'ready', 'draining')"), condition('lease_expires_at < ?', now)],
        { orderBy: 'lease_expires_at', limit },
      ),
    );
  }

  countActive(workspaceId: string): Promise<number> {
    return Promise.resolve(
      this.count([
        condition('workspace_id = ?', workspaceId),
        condition("status IN ('pending', 'ready', 'draining')"),
      ]),
    );
  }

  getByRuntimeTokenHash(tokenHash: string): Promise<Sandbox | undefined> {
    // An empty hash is the column default for rows that predate the token, so
    // it must never match — otherwise an empty bearer token would authenticate
    // as whichever of them the index returned first.
    if (tokenHash.length === 0) return Promise.resolve(undefined);
    return Promise.resolve(this.findOne([condition('runtime_token_hash = ?', tokenHash)]));
  }
}
