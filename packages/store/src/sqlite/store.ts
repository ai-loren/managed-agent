/**
 * The SQLite store — composition of every repository over one database handle.
 */

import { systemClock, type Clock, type Logger } from '@ma/core';

import { Database, openDatabase, type DatabaseOptions } from '../database.ts';
import type { Store, TransactionFn } from '../repository.ts';
import {
  SqliteAgentRepository,
  SqliteAgentVersionRepository,
  SqliteWorkspaceRepository,
} from './agents.ts';
import {
  SqliteBindingRepository,
  SqliteConnectorRepository,
  SqliteReceiptRepository,
} from './connectors.ts';
import { SqliteEventRepository } from './events.ts';
import {
  SqliteAgentTemplateRepository,
  SqliteApiKeyRepository,
  SqliteArtifactRepository,
  SqliteAuditRepository,
  SqliteCredentialRepository,
  SqliteDatasetRepository,
  SqliteDocumentRepository,
  SqliteIdempotencyRepository,
  SqliteMemoryRepository,
  SqliteModelRepository,
  SqlitePrincipalRepository,
  SqliteResourceGrantRepository,
} from './resources.ts';
import { SqliteSandboxRepository, SqliteSessionRepository } from './sessions.ts';

export interface SqliteStoreOptions extends DatabaseOptions {
  clock?: Clock;
}

export class SqliteStore implements Store {
  readonly workspaces: SqliteWorkspaceRepository;
  readonly agents: SqliteAgentRepository;
  readonly agentVersions: SqliteAgentVersionRepository;
  readonly sessions: SqliteSessionRepository;
  readonly events: SqliteEventRepository;
  readonly sandboxes: SqliteSandboxRepository;
  readonly credentials: SqliteCredentialRepository;
  readonly connectors: SqliteConnectorRepository;
  readonly bindings: SqliteBindingRepository;
  readonly receipts: SqliteReceiptRepository;
  readonly datasets: SqliteDatasetRepository;
  readonly documents: SqliteDocumentRepository;
  readonly models: SqliteModelRepository;
  readonly principals: SqlitePrincipalRepository;
  readonly apiKeys: SqliteApiKeyRepository;
  readonly resourceGrants: SqliteResourceGrantRepository;
  readonly artifacts: SqliteArtifactRepository;
  readonly memories: SqliteMemoryRepository;
  readonly agentTemplates: SqliteAgentTemplateRepository;
  readonly audit: SqliteAuditRepository;
  readonly idempotency: SqliteIdempotencyRepository;

  readonly #db: Database;
  /** Tail of the transaction queue; see `transaction`. */
  #queue: Promise<void> = Promise.resolve();

  constructor(db: Database, clock: Clock = systemClock) {
    this.#db = db;
    this.workspaces = new SqliteWorkspaceRepository(db);
    this.agents = new SqliteAgentRepository(db);
    this.agentVersions = new SqliteAgentVersionRepository(db);
    this.sessions = new SqliteSessionRepository(db);
    this.events = new SqliteEventRepository(db, clock);
    this.sandboxes = new SqliteSandboxRepository(db);
    this.credentials = new SqliteCredentialRepository(db);
    this.connectors = new SqliteConnectorRepository(db);
    this.bindings = new SqliteBindingRepository(db);
    this.receipts = new SqliteReceiptRepository(db);
    this.datasets = new SqliteDatasetRepository(db);
    this.documents = new SqliteDocumentRepository(db);
    this.models = new SqliteModelRepository(db);
    this.principals = new SqlitePrincipalRepository(db);
    this.apiKeys = new SqliteApiKeyRepository(db);
    this.resourceGrants = new SqliteResourceGrantRepository(db);
    this.artifacts = new SqliteArtifactRepository(db);
    this.memories = new SqliteMemoryRepository(db);
    this.agentTemplates = new SqliteAgentTemplateRepository(db);
    this.audit = new SqliteAuditRepository(db);
    this.idempotency = new SqliteIdempotencyRepository(db);
  }

  /** Direct handle, for maintenance and tests. Services must not reach for it. */
  get database(): Database {
    return this.#db;
  }

  /**
   * Run `fn` atomically.
   *
   * The hard constraint: SQLite gives us one connection, and a transaction is
   * connection-scoped. Anything written on that connection while a transaction
   * is open is *inside* it, whether or not the writer knows a transaction
   * exists.
   *
   * This used to take an async callback and hold `BEGIN IMMEDIATE` open across
   * its `await` points, which produced two bugs. A plain repository write
   * issued by an unrelated task while the transaction was parked landed inside
   * it and was destroyed by its `ROLLBACK` — silent data loss in a task that
   * never used a transaction and did nothing wrong. And the documented "nested
   * calls join the enclosing transaction" deadlocked: the join branch was
   * chained onto the queue behind the very transaction it was nested inside,
   * which was waiting on it, with no timeout.
   *
   * Both come from one root cause — an await window during which the
   * connection is committed to a transaction the rest of the process cannot
   * see. So the callback is now synchronous, and the window does not exist.
   * Nothing can interleave, nesting works through savepoints, and the compiler
   * enforces it at every call site rather than a comment asking politely.
   *
   * This is viable because every repository method here is synchronous work
   * wrapped in `Promise.resolve` for interface conformance — the write has
   * already happened by the time the promise exists. A driver with genuinely
   * async I/O (a pooled Postgres, say) would hand each caller its own
   * connection and could widen this signature again; constraining it now to a
   * hypothetical driver, at the cost of a live data-loss bug, would be the
   * wrong trade.
   */
  transaction<T>(fn: TransactionFn<T>): Promise<T> {
    // A nested call throws rather than rejecting. Its parent is a synchronous
    // callback that cannot await, so a rejected promise there would go
    // unhandled and the savepoint's failure would be invisible — the caller
    // would see an inner unit of work "succeed" while its writes rolled back.
    // A synchronous throw is catchable with a plain try/catch, which is the
    // only thing a synchronous callback can do about it.
    if (this.#db.inTransaction) return Promise.resolve(this.#db.transaction(() => fn(this)));

    // At the top level the signature's promise is the contract, so a failure
    // arrives as a rejection: a caller holding the promise to await later must
    // not have it thrown past them synchronously.
    try {
      return Promise.resolve(this.#db.transaction(() => fn(this)));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  close(): Promise<void> {
    this.#db.close();
    return Promise.resolve();
  }
}

/** Open a SQLite-backed store with its schema migrated. */
export function createSqliteStore(options: SqliteStoreOptions): SqliteStore {
  const db = openDatabase(options);
  return new SqliteStore(db, options.clock);
}

/** An in-memory store for tests. */
export function createMemoryStore(logger?: Logger, clock?: Clock): SqliteStore {
  return createSqliteStore({
    location: ':memory:',
    ...(logger ? { logger } : {}),
    ...(clock ? { clock } : {}),
  });
}
