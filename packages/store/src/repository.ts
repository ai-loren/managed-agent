/**
 * Repository interfaces.
 *
 * The engine depends on these, never on a database. Two reasons that actually
 * pay off rather than being architecture-astronomy:
 *
 *  1. Tests run against real behaviour with no external service, because the
 *     SQLite driver *is* the reference implementation, not a mock.
 *  2. The Postgres driver can be added without the engine noticing, which is
 *     the only way a "runs on a laptop, scales to a fleet" claim survives
 *     contact with reality.
 *
 * Note what these interfaces deliberately do not expose: no `query(sql)`, no
 * partial updates by arbitrary predicate, no cross-aggregate joins. Each method
 * is an operation the domain actually performs, which is what keeps the
 * implementations swappable.
 */

import type {
  Agent,
  AgentTemplate,
  Artifact,
  ArtifactStatus,
  Memory,
  MemoryScope,
  AgentVersion,
  ApiKey,
  AuditEntry,
  Binding,
  Connector,
  ConnectorStatus,
  Credential,
  Dataset,
  Document,
  ErrorInfo,
  EventType,
  Model,
  Principal,
  Receipt,
  ReceiptStatus,
  ResourceGrant,
  Sandbox,
  SandboxStatus,
  Session,
  SessionEvent,
  SessionStatus,
  Workspace,
} from '@ma/contracts';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Keyset pagination. The cursor is an opaque encoding of the last row's sort
 * key — never an offset, which would skip or repeat rows as data changes under
 * a paging client.
 */
export interface Page<T> {
  items: T[];
  /** Present only when more rows exist. */
  nextCursor?: string;
}

export interface PageRequest {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * A unit of work. `Store.transaction` runs the callback with a `Store` bound to
 * the transaction; nested calls join the outer transaction rather than opening
 * a second one, so a service composing two repository calls gets atomicity
 * without knowing whether its caller already started one.
 *
 * Synchronous by design, and this is load-bearing rather than a convenience.
 * A single-connection driver holds its transaction on the connection, so any
 * write issued during an `await` inside the callback — including one from an
 * unrelated task that knows nothing about the transaction — joins it and is
 * lost on rollback. Forbidding `await` removes the window entirely, and the
 * compiler enforces it at every call site.
 *
 * Repository methods return promises for interface conformance; on a
 * synchronous driver the work is already done when the promise is created, so
 * a callback can ignore the promise and still see its own writes.
 */
export type TransactionFn<T> = (tx: Store) => T;

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface WorkspaceFilter extends PageRequest {
  /** Restricts to workspaces this principal can see. Omit for admin listing. */
  principalId?: string;
  includeArchived?: boolean;
}

export interface AgentFilter extends PageRequest {
  workspaceId: string;
  includeArchived?: boolean;
  labels?: string[];
  nameContains?: string;
}

export interface SessionFilter extends PageRequest {
  workspaceId?: string;
  agentId?: string;
  statuses?: SessionStatus[];
  resolvedVersion?: number;
  /** Scope to the connector that created the session (isolation on reuse/reply). */
  connectorId?: string;
  includeArchived?: boolean;
  createdAfter?: number;
  createdBefore?: number;
}

export interface SandboxFilter extends PageRequest {
  workspaceId?: string;
  statuses?: SandboxStatus[];
  poolKey?: string;
  /** Sandboxes whose lease has lapsed — the reaper's query. */
  leaseExpiredBefore?: number;
}

export interface CredentialFilter extends PageRequest {
  workspaceId: string;
  ownerType?: string;
  ownerId?: string;
  type?: string;
  /** Credentials expiring before this instant — the rotation sweep. */
  expiringBefore?: number;
}

export interface ConnectorFilter extends PageRequest {
  workspaceId: string;
  type?: string;
  agentId?: string;
  status?: ConnectorStatus;
  includeArchived?: boolean;
}

export interface ReceiptFilter extends PageRequest {
  connectorId?: string;
  workspaceId?: string;
  bindingId?: string;
  sessionId?: string;
  statuses?: ReceiptStatus[];
  createdAfter?: number;
  createdBefore?: number;
}

export interface DatasetFilter extends PageRequest {
  workspaceId: string;
  includeArchived?: boolean;
}

export interface DocumentFilter extends PageRequest {
  datasetId: string;
  status?: string;
  keyword?: string;
}

export interface ArtifactFilter extends PageRequest {
  /** Tenancy scope; required, like every workspace-scoped filter here. */
  workspaceId: string;
  sessionId?: string;
  statuses?: ArtifactStatus[];
}

export interface MemoryFilter extends PageRequest {
  workspaceId: string;
  scope?: MemoryScope;
  /** Narrow to one agent's memories. */
  agentId?: string;
  /**
   * Narrow to workspace-scoped memories (`agent_id IS NULL`).
   *
   * Distinct from omitting `agentId`, which matches *every* scope. The memory
   * dedup key is `(workspace_id, agent_id, content_hash)` with NULL agent_id
   * treated as its own value, so a workspace memory and an agent memory with
   * identical text are different facts — and a duplicate check for a workspace
   * memory must look only at other workspace memories, not at every agent's.
   * Ignored when `agentId` is set.
   */
  agentIdIsNull?: boolean;
  /** Only those a human has allowed into the system prompt. */
  injectableOnly?: boolean;
}

export interface AgentTemplateFilter extends PageRequest {
  /**
   * The workspace whose catalogue is being read. A listing returns this
   * workspace's own templates *and* the platform's built-ins; the two are what a
   * user picks from. Omit to list built-ins only.
   */
  workspaceId?: string;
  /** Include the platform's built-in templates alongside the workspace's own. */
  includeBuiltins?: boolean;
  category?: string;
}

export interface AuditFilter extends PageRequest {
  workspaceId?: string;
  principalId?: string;
  action?: string;
  resourceId?: string;
  after?: number;
  before?: number;
}

/**
 * A due schedule and the fire time the query matched.
 *
 * Paired deliberately: the claim is a compare-and-set against `fireAt`, and
 * re-reading it separately reintroduces the race the CAS exists to prevent.
 */
export interface DueSchedule {
  connector: Connector;
  fireAt: number;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/**
 * Common shape. `update` takes a partial patch and returns the stored row, so
 * callers never have to read-modify-write and race with a concurrent writer.
 */
export interface WorkspaceRepository {
  create(workspace: Workspace): Promise<Workspace>;
  get(id: string): Promise<Workspace | undefined>;
  /**
   * Synchronous read by id, for a read-modify-write inside `Store.transaction`
   * that must re-read on the same connection without awaiting — e.g. an atomic
   * member-list update. Returns undefined if the row is gone.
   */
  findById(id: string): Workspace | undefined;
  getBySlug(slug: string): Promise<Workspace | undefined>;
  update(id: string, patch: Partial<Workspace>): Promise<Workspace>;
  list(filter: WorkspaceFilter): Promise<Page<Workspace>>;
  delete(id: string): Promise<void>;
}

export interface AgentRepository {
  create(agent: Agent): Promise<Agent>;
  /**
   * Insert only if the workspace holds fewer than `limit` non-archived agents.
   *
   * Atomic for the same reason as `SessionRepository.createWithinLimit`.
   */
  createWithinLimit(agent: Agent, limit: number): Promise<Agent | undefined>;
  get(id: string): Promise<Agent | undefined>;
  update(id: string, patch: Partial<Agent>): Promise<Agent>;
  list(filter: AgentFilter): Promise<Page<Agent>>;
  delete(id: string): Promise<void>;
  /**
   * Compare-and-set on `latestVersion`. Returns the new row, or throws
   * `CONFLICT` if `expected` no longer matches — this is how two concurrent
   * version creates are prevented from both claiming version N+1.
   */
  bumpVersion(id: string, expected: number, next: number, at: number): Promise<Agent>;
  countByWorkspace(workspaceId: string): Promise<number>;
}

export interface AgentVersionRepository {
  /** Versions are immutable, so there is no `update`. */
  create(version: AgentVersion): Promise<AgentVersion>;
  get(agentId: string, version: number): Promise<AgentVersion | undefined>;
  list(agentId: string, page: PageRequest): Promise<Page<AgentVersion>>;
  latest(agentId: string): Promise<AgentVersion | undefined>;
  deleteForAgent(agentId: string): Promise<void>;
}

export interface SessionRepository {
  create(session: Session): Promise<Session>;
  /**
   * Insert only if the workspace has fewer than `limit` active sessions.
   *
   * Returns `undefined` when the limit is already met. The count and the insert
   * have to happen together: `countActive()` followed by `create()` is
   * check-then-act, and every concurrent caller reads the same pre-insert count
   * — a cap of 3 admitted 10 parallel creates before this existed.
   */
  createWithinLimit(session: Session, limit: number): Promise<Session | undefined>;
  get(id: string): Promise<Session | undefined>;
  /**
   * Synchronous read by id, for use inside `Store.transaction` where a caller
   * must read committed-so-far state on the same connection without awaiting
   * (e.g. re-checking terminal status before folding usage). Returns undefined
   * if the row is gone.
   */
  findById(id: string): Session | undefined;
  update(id: string, patch: Partial<Session>): Promise<Session>;
  /**
   * Add usage deltas to a session's counters atomically (read-modify-write in one
   * call), returning the updated row or `undefined` if the session is gone.
   *
   * Unlike `update` with a caller-computed `usage`, this re-reads the current
   * counters at write time, so two concurrent recordings cannot lose each other's
   * increment the way a `get()`-then-`update(stale + delta)` from outside a
   * transaction can. Call it inside `Store.transaction` alongside the daily usage
   * counter so the two never drift.
   */
  addUsage(
    id: string,
    delta: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicros: number },
    updatedAt: number,
  ): Promise<Session | undefined>;
  list(filter: SessionFilter): Promise<Page<Session>>;
  /**
   * The active session currently holding a sandbox, by sandbox id, or undefined.
   *
   * A sandbox is held by at most one non-terminal session, so this is the direct
   * lookup sandbox-loss recovery needs — a `list(...).filter(...)` capped at a
   * page size silently misses the holder in a busy workspace.
   */
  getBySandboxId(sandboxId: string): Promise<Session | undefined>;
  delete(id: string): Promise<void>;
  /**
   * Status change guarded by the expected current status. Returns `undefined`
   * when the row moved underneath us, letting the caller re-read rather than
   * clobber a concurrent transition.
   */
  compareAndSetStatus(
    id: string,
    expected: SessionStatus,
    next: SessionStatus,
    patch: Partial<Session>,
  ): Promise<Session | undefined>;
  /**
   * Synchronous core of `compareAndSetStatus`, for composing into a larger
   * `store.transaction` so a status change and its transition event commit or
   * roll back together. Returns the updated row, or `undefined` if the CAS
   * matched nothing.
   */
  compareAndSetStatusSync(
    id: string,
    expected: SessionStatus,
    next: SessionStatus,
    patch: Partial<Session>,
  ): Session | undefined;
  /**
   * Roll `resolved_version` back to `fromVersion`, but only if it currently holds
   * `expectedVersion` — a compare-and-set on the version, independent of status.
   *
   * The upgrade sweep re-pins the version, rebinds, and on a `busy` rebind must
   * undo the re-pin. A status-guarded CAS is wrong there: a `turn.started` can
   * move the session `idle → running` during the rebind, so the rollback would
   * match nothing and leave `resolved_version` pinned to a version the sandbox is
   * not running — a permanent split-brain the level-triggered sweep can never
   * re-select. Guarding on the version instead rolls back regardless of status,
   * while `expectedVersion` still prevents clobbering a concurrent re-pin to a
   * newer version.
   */
  rollbackVersion(
    id: string,
    expectedVersion: number,
    fromVersion: number,
    at: number,
  ): Promise<Session | undefined>;
  countActive(workspaceId: string): Promise<number>;
  /** How many sessions are in each status, across all workspaces — for gauges. */
  countByStatus(): Promise<Record<string, number>>;
  /** Sessions past their logical expiry — the reaper's query. */
  findExpired(now: number, limit: number): Promise<Session[]>;
  /**
   * Sessions waiting to be provisioned, oldest first.
   *
   * The provisioning worker's queue. No atomic claim here: `start()` already
   * transitions out of `queued` with a compare-and-set, so two replicas reading
   * the same row produce one winner and one conflict, which the worker treats
   * as normal.
   */
  findQueued(limit: number): Promise<Session[]>;
  /** Idle/ready sessions behind their agent's production version, for hot upgrade. */
  findUpgradable(limit: number): Promise<Session[]>;
}

/**
 * The event log.
 *
 * `append` is the only writer, and it assigns `seq` under the same lock that
 * inserts the row. That is what makes the sequence gap-free, which is what makes
 * `fromSeq` resume exact.
 */
export interface EventRepository {
  /**
   * Append events to a session's log, assigning consecutive sequence numbers.
   * Returns the stored events with their assigned `seq`.
   */
  append(
    sessionId: string,
    events: readonly Omit<SessionEvent, 'seq'>[],
  ): Promise<SessionEvent[]>;
  /**
   * Synchronous core of `append`, for composing into a larger `store.transaction`
   * (e.g. a status change written atomically with its transition event). node's
   * sqlite is synchronous, so the write is complete when this returns.
   */
  appendSync(
    sessionId: string,
    events: readonly Omit<SessionEvent, 'seq'>[],
  ): SessionEvent[];
  /** Read a range. `fromSeq` is inclusive, `toSeq` exclusive. */
  read(
    sessionId: string,
    options: {
      fromSeq?: number;
      toSeq?: number;
      limit?: number;
      types?: string[];
      turn?: number;
      order?: 'asc' | 'desc';
      /** Case-insensitive substring over the serialized payload, session-scoped. */
      q?: string;
      /** Inclusive lower bound on `ts` (ms); a window, not a cursor. */
      fromTs?: number;
      /** Exclusive upper bound on `ts` (ms). */
      toTs?: number;
    },
  ): Promise<SessionEvent[]>;
  /** Highest assigned sequence, or 0 for an empty log. */
  lastSeq(sessionId: string): Promise<number>;
  /** Lowest retained sequence; a lagging consumer must resume from here. */
  earliestSeq(sessionId: string): Promise<number>;
  countByType(sessionId: string, type: EventType): Promise<number>;
  /** Retention: drop events below `beforeSeq`, returning how many went. */
  prune(sessionId: string, beforeSeq: number): Promise<number>;
  /**
   * The highest sequence older than `before`, or 0 when nothing is.
   *
   * Retention is expressed in days but `prune` takes a sequence, because the
   * log's invariant is that it truncates from the head and never leaves a hole.
   * This converts one to the other: prune everything at or below what this
   * returns and the remaining log is still gap-free.
   */
  seqBefore(sessionId: string, before: number): Promise<number>;
  /**
   * Sessions holding events older than `before`, oldest first.
   *
   * The retention sweep's work queue. Scanning every session each tick would
   * cost more than the pruning does on a deployment where most logs are
   * already inside their window. The cursor is a compound `(afterOldest,
   * afterSessionId)` keyset on the oldest-event timestamp paired with the unique
   * session id, so the sweep pages through candidates across ticks — including a
   * group of sessions that share the same oldest timestamp — rather than
   * re-examining the same not-yet-expired front, and without a strict `>` on the
   * non-unique timestamp stranding a tied group's tail.
   */
  findSessionsWithExpiredEvents(
    before: number,
    limit: number,
    afterOldest?: number,
    afterSessionId?: string,
  ): Promise<{ sessionId: string; oldest: number }[]>;
  deleteForSession(sessionId: string): Promise<void>;
}

export interface SandboxRepository {
  create(sandbox: Sandbox): Promise<Sandbox>;
  /**
   * Insert only if the workspace holds fewer than `limit` live sandboxes.
   *
   * Returns `undefined` when the limit is met. `maxSandboxes` was previously
   * consulted only at session admission and never where sandboxes are actually
   * created, so a workspace with a cap of 2 could provision as many as it had
   * sessions — the cap did not bind even serially.
   */
  createWithinLimit(sandbox: Sandbox, limit: number): Promise<Sandbox | undefined>;
  get(id: string): Promise<Sandbox | undefined>;
  update(id: string, patch: Partial<Sandbox>): Promise<Sandbox>;
  list(filter: SandboxFilter): Promise<Page<Sandbox>>;
  delete(id: string): Promise<void>;
  /**
   * Atomically claim one ready, unexpired sandbox matching `poolKey` and bind
   * it to `sessionId`. Atomicity is the point: two sessions racing for the same
   * warm sandbox must not both get it.
   */
  claimFromPool(poolKey: string, sessionId: string, now: number): Promise<Sandbox | undefined>;
  renewLease(id: string, leaseExpiresAt: number, at: number): Promise<Sandbox | undefined>;
  /**
   * Conditionally mark a warm sandbox `draining`, only if it is still `ready` and
   * its `idle_since` is unchanged from `expectedIdleSince`.
   *
   * The idle reaper's compare-and-set: `claimFromPool` clears `idle_since` when it
   * adopts a warm sandbox, so an unchanged value proves no session claimed it
   * between the reaper's `findIdle` read and this call. Returns the drained
   * sandbox, or `undefined` when a concurrent claim won the race (the reaper then
   * skips it rather than tearing down a sandbox a live session just took).
   */
  drainIfIdle(id: string, expectedIdleSince: number, at: number): Promise<Sandbox | undefined>;
  /**
   * Conditionally mark a sandbox `lost`, only if it is still in a live status and
   * its `lease_expires_at` is unchanged from `expectedLeaseExpiresAt`.
   *
   * The lease reaper's compare-and-set, mirroring `drainIfIdle` on the idle path.
   * `reapExpiredLeases` reads an expired sandbox, then `await`s a driver health
   * probe (a real event-loop yield) before deciding to reap it. A heartbeat that
   * lands during that probe calls `renewLease`, which advances `lease_expires_at`
   * and leaves the runtime executing — so marking it lost with a raw update by id
   * would destroy a sandbox that is provably alive again. Requiring the lease to
   * be unchanged proves no heartbeat renewed it in the window; `undefined` means a
   * heartbeat won the race and the reaper must leave the sandbox alone.
   */
  markLostIfLeaseUnchanged(
    id: string,
    expectedLeaseExpiresAt: number,
    error: ErrorInfo,
    at: number,
  ): Promise<Sandbox | undefined>;
  findExpiredLeases(now: number, limit: number): Promise<Sandbox[]>;
  /** Warm, holderless sandboxes (idle_since set), for the idle reaper. */
  findIdle(now: number, limit: number): Promise<Sandbox[]>;
  countActive(workspaceId: string): Promise<number>;
  /** How many sandboxes are in each status, across all workspaces — for gauges. */
  countByStatus(): Promise<Record<string, number>>;
  /**
   * Every live sandbox's provider ref (container id / pod name), across all
   * workspaces, for the statuses that still own a backend resource
   * (`pending`/`ready`/`draining`). Unpaged and unbounded ON PURPOSE: the startup
   * orphan-reaper destroys every labelled backend resource NOT in this set, so a
   * missed ref is a live sandbox wrongly destroyed. A paged `list()` (capped at
   * `DEFAULT_PAGE_LIMIT`) would silently omit refs past the cap. Projects only the
   * ref column, so it stays cheap even with many live sandboxes.
   */
  listLiveProviderRefs(): Promise<string[]>;
  /**
   * Resolve a sandbox by the hash of its runtime token.
   *
   * How a sandbox authenticates back to the control plane. Looked up by hash so
   * the token itself is never stored, and from the database rather than memory
   * so the binding survives a restart and works in a process that did not
   * provision the sandbox.
   */
  getByRuntimeTokenHash(tokenHash: string): Promise<Sandbox | undefined>;
}

export interface CredentialRepository {
  /** `sealed` is the ciphertext; plaintext never reaches this layer. */
  create(credential: Credential, sealed: string): Promise<Credential>;
  get(id: string): Promise<Credential | undefined>;
  /** The only path to ciphertext. Callers must be the runtime exchange. */
  getSealed(id: string): Promise<string | undefined>;
  update(id: string, patch: Partial<Credential>, sealed?: string): Promise<Credential>;
  list(filter: CredentialFilter): Promise<Page<Credential>>;
  delete(id: string): Promise<void>;
  markUsed(id: string, at: number): Promise<void>;
}

export interface ConnectorRepository {
  create(connector: Connector): Promise<Connector>;
  get(id: string): Promise<Connector | undefined>;
  /** Inbound requests arrive keyed by workspace + external key, not by id. */
  getByExternalKey(workspaceId: string, externalKey: string): Promise<Connector | undefined>;
  update(id: string, patch: Partial<Connector>): Promise<Connector>;
  list(filter: ConnectorFilter): Promise<Page<Connector>>;
  delete(id: string): Promise<void>;
  /**
   * Active schedules whose next fire time has arrived, each paired with the
   * `next_fire_at` the query matched on.
   *
   * The fire time is returned rather than left to be re-read because that
   * re-read was a race: a second replica read the value the first had already
   * advanced, then compare-and-set it to itself, which matches — so both
   * claimed the same tick. This value is the CAS input, so it has to come from
   * the same read that decided the row was due.
   */
  findDueSchedules(now: number, limit: number): Promise<DueSchedule[]>;
  /**
   * Advance a schedule's next fire time only if it still matches `expected`.
   *
   * This is what makes multiple scheduler replicas safe: for one due tick,
   * exactly one replica's update matches a row, and the rest see zero changes.
   */
  claimSchedule(id: string, expectedFireAt: number, nextFireAt: number, at: number): boolean;
  /** Set the next fire time unconditionally — used on activation and edit. */
  setNextFire(id: string, nextFireAt: number | undefined, at: number): void;
  /** The currently stored next fire time, if any. */
  nextFireAt(id: string): number | undefined;
}

export interface BindingRepository {
  create(binding: Binding): Promise<Binding>;
  get(id: string): Promise<Binding | undefined>;
  findByScope(connectorId: string, scopeKeyHash: string): Promise<Binding | undefined>;
  update(id: string, patch: Partial<Binding>): Promise<Binding>;
  listForConnector(connectorId: string, page: PageRequest): Promise<Page<Binding>>;
  delete(id: string): Promise<void>;
  // No `deleteForConnector`: `bindings.connector_id` is `ON DELETE CASCADE`, so
  // deleting a connector removes its bindings atomically at the DB level.
}

export interface ReceiptRepository {
  /**
   * Insert, or return the existing receipt for
   * `(connectorId, externalEventId)`. The dedupe that makes inbound delivery
   * idempotent: a source system retrying must not start a second agent run.
   */
  createIfAbsent(receipt: Receipt): Promise<{ receipt: Receipt; created: boolean }>;
  get(id: string): Promise<Receipt | undefined>;
  update(id: string, patch: Partial<Receipt>): Promise<Receipt>;
  list(filter: ReceiptFilter): Promise<Page<Receipt>>;
  /** Atomically take one due receipt and mark it `working` under a lease. */
  claimNext(now: number, leaseExpiresAt: number): Promise<Receipt | undefined>;
  /**
   * Patch a receipt only while it still holds `expected`.
   *
   * Returns `undefined` when the status moved underneath the caller. A worker
   * that outlived its lease was reaped to `zombie` in the meantime, and must
   * not be able to write its own outcome over that — a plain `update` let it
   * resurrect a terminal receipt back to `pending`, and the same external event
   * ran twice.
   */
  compareAndSetStatus(
    id: string,
    expected: ReceiptStatus,
    patch: Partial<Receipt>,
  ): Promise<Receipt | undefined>;
  /**
   * Extend a `working` receipt's lease. Returns `undefined` if the receipt is
   * no longer `working` — the worker's cue that it was already reaped to
   * `zombie` and must stop, mirroring the sandbox lease's stop-signal. Guarded
   * on `working` (not a raw update) so a heartbeat can never resurrect a
   * terminal receipt: a live worker whose delivery outran the initial lease
   * renews it here, so the reaper never zombies a delivery that is still
   * running, and the exactly-once guarantee holds without depending on the
   * initial lease exceeding the slowest possible turn.
   */
  renewLease(id: string, leaseExpiresAt: number, at: number): Promise<Receipt | undefined>;
  /** `working` receipts whose worker stopped heartbeating — become zombies. */
  findExpiredLeases(now: number, limit: number): Promise<Receipt[]>;
  // No `deleteForConnector`: `receipts.connector_id` is `ON DELETE CASCADE`, so
  // deleting a connector removes its receipts atomically at the DB level.
  /** How many receipts are in each status, across all connectors — for gauges. */
  countByStatus(): Promise<Record<string, number>>;
}

export interface ArtifactRepository {
  /**
   * Insert, or return the existing row for `(sessionId, path, digest)`.
   *
   * The same bytes at the same path is one artifact. An upload retried after a
   * dropped connection therefore returns the original row rather than charging
   * storage quota twice — the shape `receipts.createIfAbsent` already uses.
   */
  createIfAbsent(artifact: Artifact): Promise<{ artifact: Artifact; created: boolean }>;
  /**
   * Insert only if the workspace's stored bytes would stay within `limitBytes`.
   *
   * Returns `undefined` when the limit is met. Atomic for the same reason as
   * `SessionRepository.createWithinLimit`: summing then inserting is
   * check-then-act, and concurrent uploads would each read a pre-insert total.
   */
  createWithinStorageLimit(
    artifact: Artifact,
    limitBytes: number,
  ): Promise<{ artifact: Artifact; created: boolean } | undefined>;
  get(id: string): Promise<Artifact | undefined>;
  update(id: string, patch: Partial<Artifact>): Promise<Artifact>;
  list(filter: ArtifactFilter): Promise<Page<Artifact>>;
  delete(id: string): Promise<void>;
  /** Bytes currently stored by a workspace, for the quota snapshot. */
  totalBytes(workspaceId: string): Promise<number>;
  /** How many rows still reference a blob, so purging cannot orphan a live row. */
  countByDigest(workspaceId: string, digest: string): Promise<number>;
  /** Artifacts past their retention window and not yet purged. */
  findExpired(now: number, limit: number): Promise<Artifact[]>;
}

export interface MemoryRepository {
  /**
   * Insert, or return the existing memory with the same normalized content.
   *
   * Deduplication is the point: an agent re-learning a fact it already knows
   * must not accumulate a row per session, or its own recall budget fills with
   * copies of one sentence.
   */
  createIfAbsent(memory: Memory): Promise<{ memory: Memory; created: boolean }>;
  get(id: string): Promise<Memory | undefined>;
  update(id: string, patch: Partial<Memory>): Promise<Memory>;
  /**
   * Set `injectable` and its provenance.
   *
   * Not reachable through `update`: this is the only write that moves text
   * across the trust boundary into a system prompt, so it is a named operation
   * rather than one field in a patch a future caller might set by accident.
   */
  promoteInjectable(
    id: string,
    injectable: boolean,
    promotedBy: string | undefined,
    at: number,
  ): Promise<Memory>;
  list(filter: MemoryFilter): Promise<Page<Memory>>;
  delete(id: string): Promise<void>;
  /**
   * Memories visible to one agent: its own, plus the workspace's.
   *
   * `injectableOnly` is what separates the two trust positions — the
   * session-start injection asks for it, the `recall` tool does not.
   */
  findForAgent(
    workspaceId: string,
    agentId: string,
    options: { injectableOnly?: boolean; limit: number },
  ): Promise<Memory[]>;
  /** How many memories a scope holds, for the per-scope cap. */
  countForScope(workspaceId: string, agentId: string | undefined): Promise<number>;
  /** Oldest first, for eviction when a scope is full. */
  findOldest(workspaceId: string, agentId: string | undefined, limit: number): Promise<Memory[]>;
}

export interface DatasetRepository {
  create(dataset: Dataset): Promise<Dataset>;
  get(id: string): Promise<Dataset | undefined>;
  update(id: string, patch: Partial<Dataset>): Promise<Dataset>;
  list(filter: DatasetFilter): Promise<Page<Dataset>>;
  delete(id: string): Promise<void>;
  /**
   * Sum of `chunkCount` across a workspace's non-archived datasets — the
   * authoritative count of BM25-indexed chunks, for the `maxKnowledgeChunks`
   * quota. O(datasets), from the maintained rollup rather than a documents scan.
   */
  knowledgeChunksForWorkspace(workspaceId: string): Promise<number>;
  /**
   * Synchronous variant of {@link knowledgeChunksForWorkspace}, for the ingest
   * commit to re-read the workspace chunk total INSIDE its finalize transaction
   * (under BEGIN IMMEDIATE) and enforce `maxKnowledgeChunks` atomically with the
   * rollup increment — closing the read-then-act race that a plain async check
   * before the commit leaves open across concurrent ingests.
   */
  knowledgeChunksForWorkspaceSync(workspaceId: string): number;
  /**
   * Synchronous read by id, for use inside `Store.transaction` (a caller must
   * read committed-so-far state on the same connection without awaiting).
   */
  findById(id: string): Dataset | undefined;
  /**
   * Synchronous decrement of a dataset's rollup when one document is removed —
   * `documentCount` by 1, `chunkCount`/`sizeBytes` by the removed document's
   * amounts — clamped at 0 (pre-existing count drift must not go negative). For
   * use inside `Store.transaction` so it commits with the row delete.
   */
  applyDocumentRemovalSync(datasetId: string, chunkCount: number, sizeBytes: number, at: number): void;
  /**
   * Apply signed deltas to a dataset's rollup columns in one atomic SQL
   * statement, each clamped at 0 (`MAX(0, col + delta)`). The raise-sites
   * (ingest re-sync, document create) MUST use this rather than a
   * `get()`-then-`update(absolute)` pair: an absolute write computed from a stale
   * read clobbers a concurrent delete's decrement, and `chunkCount` is the basis
   * the `maxKnowledgeChunks` quota sums — a lost decrement over-counts (denies
   * capacity), a lost increment under-counts (lets the corpus index past the cap).
   * A single UPDATE reads-and-writes inside the engine, so it composes with any
   * concurrent mutation without a surrounding transaction.
   */
  applyRollupDeltaSync(
    datasetId: string,
    delta: { documentCount?: number; chunkCount?: number; sizeBytes?: number },
    at: number,
  ): void;
}

export interface DocumentRepository {
  create(document: Document): Promise<Document>;
  get(id: string): Promise<Document | undefined>;
  update(id: string, patch: Partial<Document>): Promise<Document>;
  list(filter: DocumentFilter): Promise<Page<Document>>;
  delete(id: string): Promise<void>;
  /**
   * Synchronous delete by id, for use inside `Store.transaction`. Returns whether
   * a row was actually removed, so the caller can gate a dependent rollup update
   * on this having deleted the row (a concurrent duplicate delete removes 0 rows
   * and must not decrement the count a second time).
   */
  removeSync(id: string): boolean;
  /**
   * Synchronous read by id, for use inside `Store.transaction` — so a caller can
   * read the row's authoritative fields on the same connection (e.g. a delete
   * deriving its rollup decrement from the chunk/size counts as they stand at
   * delete time, rather than from a copy read before the transaction opened).
   */
  findById(id: string): Document | undefined;
  /**
   * Atomically claim a `pending` document for ingestion: flip it to `processing`
   * and stamp `token` in a single `UPDATE … WHERE id=? AND status='pending'`,
   * returning whether THIS caller won. The `pending→processing` edge is the one
   * serialization point for ingestion — the pipeline re-read and unconditionally
   * flipped the row before, so two workers (two replicas, or a retry) both observed
   * `pending` and both ingested, each applying the chunk-rollup delta, permanently
   * double-counting the quota basis. The loser (0 rows changed) skips the document.
   * The stamped `token` lets the terminal write verify continued ownership (see
   * `finalizeIfOwnedSync`). Mirrors the receipt `claimNext` CAS.
   */
  claimForProcessing(id: string, token: string, at: number): boolean;
  /**
   * Apply a terminal ingestion write (`ready`/`failed` with counts) ONLY if this
   * worker still owns the `processing` row under its claim `token`, clearing the
   * token as part of the write. Returns whether it won. Composes inside
   * `Store.transaction` so the row write and its dataset-rollup delta commit
   * together — and both are skipped when ownership was lost (the stuck-processing
   * reaper requeued the row and another worker re-claimed it), so a worker slower
   * than the recovery window cannot double-commit the rollup.
   */
  finalizeIfOwnedSync(id: string, token: string, patch: Partial<Document>): boolean;
  /**
   * Requeue a stuck document to `pending` (clearing its ownership token) ONLY if
   * it is still `processing` AND still stale (`updated_at < staleBefore`).
   * `findStaleProcessing` applies the staleness filter at read time; re-asserting
   * it here closes a cross-replica TOCTOU where the owning worker completes and a
   * fresh worker re-claims the row (new `updated_at`) between the reaper's scan and
   * its write — a status-only predicate would clobber that freshly-claimed row.
   * Returns whether it requeued.
   */
  requeueIfProcessingSync(id: string, staleBefore: number, at: number): boolean;
  /**
   * Requeue a `failed` document to `pending` (writing `metadata`, which carries
   * the bumped `ingestAttempts`) ONLY if it is still `failed`. The status CAS is
   * the sibling of `claimForProcessing`/`requeueIfProcessingSync`: `reprocessFailed`
   * reads a capped list then updates per row with an await between, so a blind
   * update would let two overlapping sweeps (across replicas) both requeue the
   * same row — double-burning its attempt budget — or clobber a row another worker
   * already carried failed→ready back to `pending`. Returns whether it requeued.
   */
  requeueFailedSync(id: string, metadata: Record<string, unknown>, at: number): boolean;
  /**
   * Synchronous patch by id, for use inside `Store.transaction` so a document
   * row change commits atomically with a dependent change on the same connection
   * — e.g. marking a document `ready` in the same transaction that applies its
   * chunk/size delta to the dataset rollup, so the row and the rollup can never
   * diverge (one committing while the other is rolled back).
   */
  updateSync(id: string, patch: Partial<Document>): Document;
  deleteForDataset(datasetId: string): Promise<void>;
  /** Documents awaiting ingestion, oldest first. */
  findPending(limit: number): Promise<Document[]>;
  /**
   * Documents already ingested (`status: 'ready'`), across every dataset,
   * ordered by id. The startup index rebuild pages through these to repopulate
   * the in-memory search index from durable storage. `afterId` is an exclusive
   * keyset cursor on the id (a ULID, so id order tracks creation order); paging
   * on the unique id — rather than a possibly-tied timestamp — guarantees no row
   * is skipped or repeated across pages.
   */
  findReady(limit: number, afterId?: string): Promise<Document[]>;
  /**
   * Documents stuck in `processing` since before `staleBefore` — a worker was
   * killed mid-ingest (SIGKILL, OOM, deploy restart) and no longer owns the row.
   * A recovery sweep returns these to `pending` to be retried.
   */
  findStaleProcessing(staleBefore: number, limit: number): Promise<Document[]>;
  /**
   * Documents that ended `failed` and are still ACTIONABLE by the reprocess
   * sweep — oldest first. Permanently-dead rows are excluded at the query: a
   * non-retryable failure, and (when `maxAttempts` is given) one that already
   * burned its attempt budget. This matters because the sweep takes a capped
   * window: skipping dead rows in the caller would let them fill that window and
   * starve genuinely-transient failures. The retry-budget POLICY (`maxAttempts`)
   * stays with the caller; only its application to the selection is pushed down.
   */
  findFailed(limit: number, maxAttempts?: number): Promise<Document[]>;
}

export interface ModelRepository {
  upsert(model: Model): Promise<Model>;
  get(id: string): Promise<Model | undefined>;
  /** Enabled models visible to a workspace, honouring the allowlist. */
  list(workspaceId?: string): Promise<Model[]>;
  delete(id: string): Promise<void>;
}

export interface PrincipalRepository {
  create(principal: Principal): Promise<Principal>;
  get(id: string): Promise<Principal | undefined>;
  getBySubject(subject: string): Promise<Principal | undefined>;
  update(id: string, patch: Partial<Principal>): Promise<Principal>;
  /**
   * List principals, optionally restricted to those whose subject starts with
   * `subjectPrefix` (e.g. `oidc:okta:` for one SSO provider). The prefix scopes a
   * SCIM provider's paged scan to its own users so a large multi-provider
   * directory does not exhaust the scan budget on other providers.
   */
  list(page: PageRequest & { subjectPrefix?: string }): Promise<Page<Principal>>;
  delete(id: string): Promise<void>;
}

export interface ResourceGrantRepository {
  /** Insert, or update the role of an existing grant for the same (principal, resource). */
  upsert(grant: ResourceGrant): Promise<ResourceGrant>;
  /**
   * The principal's grant for one resource, or undefined. The hot path — read on
   * every resource-scoped authorization check — so it is a single index probe.
   */
  find(input: {
    workspaceId: string;
    principalId: string;
    resourceKind: string;
    resourceId: string;
  }): Promise<ResourceGrant | undefined>;
  /** Every grant in a workspace, for management and audit. */
  listForWorkspace(workspaceId: string): Promise<ResourceGrant[]>;
  /**
   * Remove one grant by id, scoped to its workspace. Returns whether a row
   * matched — `false` means the grant does not exist OR belongs to a different
   * workspace, which the caller treats as not-found rather than deleting across a
   * tenant boundary. The `workspaceId` predicate is the tenant check: without it a
   * `DELETE WHERE id = ?` would let an admin of one workspace revoke a grant
   * belonging to another whose id they happened to learn. Idempotent.
   */
  delete(id: string, workspaceId: string): Promise<boolean>;
  /**
   * Drop every resource grant a principal holds in one workspace, returning the
   * count removed. Called on member removal: a grant survives a role downgrade
   * (it documents intent), but full removal from the workspace must not leave a
   * non-member with resource-scoped access. `...Sync` is the in-transaction
   * variant so the grant cleanup commits with the member-list write.
   */
  deleteForPrincipalInWorkspace(workspaceId: string, principalId: string): Promise<number>;
  deleteForPrincipalInWorkspaceSync(workspaceId: string, principalId: string): number;
}

export interface ApiKeyRepository {
  create(key: ApiKey): Promise<ApiKey>;
  get(id: string): Promise<ApiKey | undefined>;
  /** Authentication path: look up by hash, never by the token itself. */
  getByHash(tokenHash: string): Promise<ApiKey | undefined>;
  listForPrincipal(principalId: string): Promise<ApiKey[]>;
  /**
   * Revoke every not-yet-revoked key a principal holds, in one operation, and
   * return how many were revoked. Used by SCIM offboarding: unlike a
   * `listForPrincipal` + per-key update loop, this is not bounded by the page
   * cap, so a principal with more than a page of live sessions is fully
   * revoked — a token that outlives an offboard is exactly what this prevents.
   */
  revokeAllForPrincipal(principalId: string, revokedAt: number): Promise<number>;
  update(id: string, patch: Partial<ApiKey>): Promise<ApiKey>;
  delete(id: string): Promise<void>;
}

export interface AgentTemplateRepository {
  create(template: AgentTemplate): Promise<AgentTemplate>;
  get(id: string): Promise<AgentTemplate | undefined>;
  update(id: string, patch: Partial<AgentTemplate>): Promise<AgentTemplate>;
  list(filter: AgentTemplateFilter): Promise<Page<AgentTemplate>>;
  delete(id: string): Promise<void>;
  /**
   * Insert a built-in, or overwrite the existing one with the same name.
   *
   * The re-seed path: on every boot the platform upserts its shipped templates
   * so a fixed catalogue stays current without accumulating duplicates. Keyed on
   * `name` among built-ins (the partial unique index), so an edited built-in
   * cannot silently shadow the shipped one.
   */
  upsertBuiltin(template: AgentTemplate): Promise<AgentTemplate>;
}

export interface AuditRepository {
  append(entry: AuditEntry): Promise<AuditEntry>;
  list(filter: AuditFilter): Promise<Page<AuditEntry>>;
  /** Retention sweep. Audit rows outlive event rows. */
  prune(before: number): Promise<number>;
  /**
   * Verify the tamper-evident hash chain over the retained audit entries.
   *
   * Walks every entry in chain order, recomputing each hash and checking that it
   * links to the one before it, so any edit, insert, delete or reorder of a
   * historical row is detected — and located. Legitimately-pruned rows are
   * accounted for via the head checkpoint, so retention does not read as tampering.
   */
  verifyChain(): Promise<ChainVerification>;
}

/** The outcome of an audit hash-chain verification. */
export interface ChainVerification {
  /** True when every retained entry links intact from the pruned checkpoint. */
  ok: boolean;
  /** How many entries were checked. */
  checked: number;
  /**
   * The break, when `ok` is false: the seq at which verification failed, the id
   * of the offending row (when there is one), and what went wrong.
   */
  brokenAtSeq?: number;
  brokenId?: string;
  reason?: string;
}

/**
 * Records the outcome of a mutation against a client-supplied key, so a retried
 * request returns the original result rather than performing the work twice.
 */
export interface IdempotencyRepository {
  /**
   * Reserve a key. Returns `{ reserved: true }` when this caller owns it, or
   * the stored record when someone already has. A reserved-but-incomplete
   * record means a concurrent request is in flight.
   *
   * `leaseMs` is the short *in-flight* lease (not the retention window): an
   * abandoned reservation self-heals once it lapses, and `complete` extends the
   * expiry to the full retention window.
   */
  reserve(
    key: string,
    scope: string,
    now: number,
    leaseMs: number,
  ): Promise<{ reserved: true } | { reserved: false; record: IdempotencyRecord }>;
  complete(
    key: string,
    scope: string,
    statusCode: number,
    response: string,
    at: number,
    /** Retention window applied to the completed record, from `at`. */
    retentionTtlMs: number,
    /** Fingerprint of the request body, so a reused key with a different one is refused. */
    requestHash?: string,
  ): Promise<void>;
  /** Release a reservation whose request failed, so a retry can proceed. */
  release(key: string, scope: string): Promise<void>;
  prune(before: number): Promise<number>;
}

export interface IdempotencyRecord {
  key: string;
  scope: string;
  /** `undefined` while the original request is still running. */
  statusCode?: number;
  response?: string;
  /**
   * Hash of the request body this key was completed with.
   *
   * A key identifies one request. Without this, reusing a key for a different
   * body returned the *first* request's response — a 200 describing a resource
   * the caller never asked for, with nothing to signal the mistake.
   */
  requestHash?: string;
  createdAt: number;
  completedAt?: number;
  expiresAt: number;
}

/**
 * The per-(workspace, UTC-day) token counter behind the daily-token quota.
 *
 * Incremented atomically as usage is billed (in the same transaction as the
 * session-usage update), so the daily total is exact and readable in O(1) —
 * enforceable on every model completion, not just at session admission, and
 * without the per-request scan of all today's sessions the quota used before.
 * Billed tokens are input + output; cache tokens are excluded, matching the
 * quota's definition.
 */
export interface UsageRepository {
  /** Add to a workspace's counters for `utcDay` (UTC-midnight epoch), atomically. */
  addTokens(
    workspaceId: string,
    utcDay: number,
    inputTokens: number,
    outputTokens: number,
    costMicros: number,
  ): Promise<void>;
  /** Billed tokens (input + output) for a workspace on `utcDay`; 0 when absent. */
  tokensToday(workspaceId: string, utcDay: number): Promise<number>;
  /** Billed cost (micro-dollars) for a workspace on `utcDay`; 0 when absent. */
  costToday(workspaceId: string, utcDay: number): Promise<number>;
  /**
   * Atomically admit-and-reserve an estimate against the daily caps, or refuse.
   * Counts billed + already-reserved so concurrent completions cannot race past a
   * cap: admits only if `billed + reserved + est <= limit` for tokens (and for
   * cost when `costLimit > 0`; `0` means unlimited cost). On admission the estimate
   * is held in the reserved columns until {@link releaseDaily}. Atomic under
   * BEGIN IMMEDIATE.
   */
  reserveDaily(
    workspaceId: string,
    utcDay: number,
    estTokens: number,
    estMicros: number,
    tokenLimit: number,
    costLimit: number,
  ): Promise<{ admitted: boolean; dimension?: 'tokensPerDay' | 'costPerDay'; tokensUsed: number; costUsed: number }>;
  /**
   * Release a previously-held reservation (at settle, or on a failed completion).
   * Clamped at 0 so a double-release cannot drive the counter negative. Call inside
   * the settle transaction so release and the real-usage fold commit together.
   */
  releaseDaily(workspaceId: string, utcDay: number, estTokens: number, estMicros: number): Promise<void>;
  /**
   * The per-day usage rows for a workspace over `[fromDay, toDay]` (inclusive,
   * UTC-midnight epochs), oldest first. Absent days are simply omitted — a gap
   * means zero usage that day. Backs the usage-history report.
   */
  usageBetween(workspaceId: string, fromDay: number, toDay: number): Promise<UsageDay[]>;
}

/** One day's billed usage for a workspace, from the daily counter. */
export interface UsageDay {
  /** UTC-midnight epoch for the day. */
  utcDay: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

/**
 * Durable billing-dedup markers: which turns of which sandbox generations were
 * already billed via the `/completions` proxy, so the matching `turn.completed`
 * report is not billed a second time.
 *
 * Durability is the whole point. The usage fold is durable (session row + daily
 * counter), so a marker kept only in process memory is lost on a control-plane
 * restart — and a `turn.completed` that arrives after the restart bills the same
 * usage again. `mark` is therefore called INSIDE the same store transaction as
 * the fold (so the two commit or roll back together), and `consume` is an atomic
 * check-and-delete so two concurrent reports of the same turn cannot both bill.
 *
 * Keyed by `sandboxId`, not the session alone. A session outlives its sandbox: on
 * a lost-sandbox recovery or a spec-changing upgrade it re-queues with the same id
 * onto a fresh sandbox whose turn counter resets, so a marker for the old
 * generation's turn N must never dedup the new generation's turn N (that would
 * UNDER-bill). `sandboxId` changes at exactly that boundary and is stable across a
 * control-plane restart/rebind, so it fingerprints the generation — correctness no
 * longer depends on sweeping markers on every re-queue path.
 *
 * `turn` is the real turn number (>= 0), or the sentinel {@link TURNLESS_BILLED_TURN}
 * (-1) for the per-sandbox fallback flag when a completion omits its turn.
 * `clearSession` and the {@link BilledTurnRepository.prune} retention sweep bound
 * growth; the CASCADE on the session row is the backstop.
 */
export interface BilledTurnRepository {
  /**
   * Record that `(sessionId, sandboxId, turn)` was billed via `/completions`.
   * Idempotent: a multi-call tool loop marks the same turn once. Must be called
   * inside the fold's transaction.
   */
  mark(sessionId: string, sandboxId: string, turn: number, at: number): void;
  /**
   * Atomically consume the marker for `(sessionId, sandboxId, turn)`: delete it and
   * report whether it existed. `true` means the turn was already billed via
   * `/completions`, so the caller skips billing the report. Must be called inside
   * the report-fold's transaction so the check and the fold are one unit.
   */
  consume(sessionId: string, sandboxId: string, turn: number): boolean;
  /**
   * Non-destructive existence check for `(sessionId, sandboxId, turn)`, for a
   * dedup that must be idempotent rather than one-shot: a `turn.completed` report
   * keyed by turn dedups against the marker WITHOUT removing it, so a repeated
   * report of the same turn (a buggy/foreign runtime posting it twice, or two in
   * one batch) is deduped too instead of billing again. Must be called inside the
   * report-fold's transaction.
   */
  has(sessionId: string, sandboxId: string, turn: number): boolean;
  /** Drop every marker for a session (all generations), at its terminal transition. */
  clearSession(sessionId: string): void;
  /** Delete markers recorded before `before` (retention sweep). Returns the count. */
  prune(before: number): Promise<number>;
}

/** Sentinel `turn` for the per-sandbox turn-less fallback flag; real turns are >= 0. */
export const TURNLESS_BILLED_TURN = -1;

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Aggregate handle. Services take this, not individual repositories. */
export interface Store {
  readonly workspaces: WorkspaceRepository;
  readonly agents: AgentRepository;
  readonly agentVersions: AgentVersionRepository;
  readonly sessions: SessionRepository;
  readonly events: EventRepository;
  readonly sandboxes: SandboxRepository;
  readonly credentials: CredentialRepository;
  readonly connectors: ConnectorRepository;
  readonly bindings: BindingRepository;
  readonly receipts: ReceiptRepository;
  readonly datasets: DatasetRepository;
  readonly documents: DocumentRepository;
  readonly models: ModelRepository;
  readonly principals: PrincipalRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly resourceGrants: ResourceGrantRepository;
  readonly artifacts: ArtifactRepository;
  readonly memories: MemoryRepository;
  readonly agentTemplates: AgentTemplateRepository;
  readonly audit: AuditRepository;
  readonly idempotency: IdempotencyRepository;
  readonly usage: UsageRepository;
  readonly billedTurns: BilledTurnRepository;
  /**
   * Run `fn` atomically. Nested calls join the enclosing transaction.
   *
   * `fn` must be synchronous — see `TransactionFn`.
   */
  transaction<T>(fn: TransactionFn<T>): Promise<T>;
  close(): Promise<void>;
}
