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
  SqliteApiKeyRepository,
  SqliteAuditRepository,
  SqliteCredentialRepository,
  SqliteDatasetRepository,
  SqliteDocumentRepository,
  SqliteIdempotencyRepository,
  SqliteModelRepository,
  SqlitePrincipalRepository,
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
   * The subtlety: `fn` is async, but SQLite gives us one connection and a
   * transaction is connection-scoped. If two transactions interleaved on that
   * connection, the second `BEGIN` would either fail or silently join the
   * first, and a rollback would discard the other's work. Node being
   * single-threaded does not help — `await` inside a transaction is exactly
   * where another task gets to run.
   *
   * So transactions are serialized through a promise chain. Concurrent callers
   * queue rather than interleave. This is a real throughput ceiling on the
   * SQLite driver, and an honest one: SQLite serializes writers anyway. A
   * pooled Postgres driver would instead hand each caller its own connection,
   * which is why this method takes a `Store` — callers use the one they are
   * given rather than the outer instance.
   */
  transaction<T>(fn: TransactionFn<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.#db.inTransaction) {
        // Already inside one: join it. Savepoints would let us nest, but the
        // caller asked for atomicity and it already has it.
        return fn(this);
      }

      this.#db.begin();
      try {
        const result = await fn(this);
        this.#db.commit();
        return result;
      } catch (error) {
        this.#db.rollback();
        throw error;
      }
    };

    // Chain onto the tail so transactions run one at a time. The catch keeps a
    // failed transaction from poisoning the queue for everyone after it.
    const queued = this.#queue.then(run, run);
    this.#queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
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
