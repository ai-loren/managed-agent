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
 */
export type TransactionFn<T> = (tx: Store) => Promise<T>;

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

export interface AuditFilter extends PageRequest {
  workspaceId?: string;
  principalId?: string;
  action?: string;
  resourceId?: string;
  after?: number;
  before?: number;
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
  deleteForSession(sessionId: string): Promise<void>;
}

export interface SandboxRepository {
  create(sandbox: Sandbox): Promise<Sandbox>;
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
  /** Active schedules whose next fire time has arrived. */
  findDueSchedules(now: number, limit: number): Promise<Connector[]>;
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
  /** `working` receipts whose worker stopped heartbeating — become zombies. */
  findExpiredLeases(now: number, limit: number): Promise<Receipt[]>;
  deleteForConnector(connectorId: string): Promise<void>;
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
  complete(key: string, scope: string, statusCode: number, response: string, at: number): Promise<void>;
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
  readonly audit: AuditRepository;
  readonly idempotency: IdempotencyRepository;

  /** Run `fn` atomically. Nested calls join the enclosing transaction. */
  transaction<T>(fn: TransactionFn<T>): Promise<T>;
  close(): Promise<void>;
}
