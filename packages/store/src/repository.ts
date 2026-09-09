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
  EventType,
  Model,
  Principal,
  Receipt,
  ReceiptStatus,
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
  update(id: string, patch: Partial<Session>): Promise<Session>;
  list(filter: SessionFilter): Promise<Page<Session>>;
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
  countActive(workspaceId: string): Promise<number>;
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
   * already inside their window.
   */
  findSessionsWithExpiredEvents(before: number, limit: number): Promise<string[]>;
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
  findExpiredLeases(now: number, limit: number): Promise<Sandbox[]>;
  countActive(workspaceId: string): Promise<number>;
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
  deleteForConnector(connectorId: string): Promise<void>;
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
  /** `working` receipts whose worker stopped heartbeating — become zombies. */
  findExpiredLeases(now: number, limit: number): Promise<Receipt[]>;
  deleteForConnector(connectorId: string): Promise<void>;
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
}

export interface DocumentRepository {
  create(document: Document): Promise<Document>;
  get(id: string): Promise<Document | undefined>;
  update(id: string, patch: Partial<Document>): Promise<Document>;
  list(filter: DocumentFilter): Promise<Page<Document>>;
  delete(id: string): Promise<void>;
  deleteForDataset(datasetId: string): Promise<void>;
  /** Documents awaiting ingestion, oldest first. */
  findPending(limit: number): Promise<Document[]>;
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
  list(page: PageRequest): Promise<Page<Principal>>;
  delete(id: string): Promise<void>;
}

export interface ApiKeyRepository {
  create(key: ApiKey): Promise<ApiKey>;
  get(id: string): Promise<ApiKey | undefined>;
  /** Authentication path: look up by hash, never by the token itself. */
  getByHash(tokenHash: string): Promise<ApiKey | undefined>;
  listForPrincipal(principalId: string): Promise<ApiKey[]>;
  update(id: string, patch: Partial<ApiKey>): Promise<ApiKey>;
  delete(id: string): Promise<void>;
}

export interface AuditRepository {
  append(entry: AuditEntry): Promise<AuditEntry>;
  list(filter: AuditFilter): Promise<Page<AuditEntry>>;
  /** Retention sweep. Audit rows outlive event rows. */
  prune(before: number): Promise<number>;
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
   */
  reserve(
    key: string,
    scope: string,
    now: number,
    ttlMs: number,
  ): Promise<{ reserved: true } | { reserved: false; record: IdempotencyRecord }>;
  complete(
    key: string,
    scope: string,
    statusCode: number,
    response: string,
    at: number,
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
  readonly artifacts: ArtifactRepository;
  readonly memories: MemoryRepository;
  readonly audit: AuditRepository;
  readonly idempotency: IdempotencyRepository;

  /**
   * Run `fn` atomically. Nested calls join the enclosing transaction.
   *
   * `fn` must be synchronous — see `TransactionFn`.
   */
  transaction<T>(fn: TransactionFn<T>): Promise<T>;
  close(): Promise<void>;
}
