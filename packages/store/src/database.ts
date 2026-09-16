/**
 * SQLite database handle.
 *
 * Wraps `node:sqlite` with the pragmas, migration runner and transaction
 * semantics the platform needs. The choice of SQLite for the reference driver
 * is deliberate: the whole control plane runs on a laptop with no external
 * service, which makes the test suite fast and honest — tests exercise the real
 * driver rather than a mock that agrees with whatever the code does.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { conflict, internalError, systemClock, type Clock, type Logger } from '@ma/core';

import { MIGRATIONS, migrationChecksum, type Migration } from './migrations.ts';
import type { Row, SqlValue } from './mapping.ts';

export interface DatabaseOptions {
  /** File path, or `:memory:` for an ephemeral database. */
  location: string;
  logger?: Logger;
  /** Used only to stamp migration rows; injected so tests stay deterministic. */
  clock?: Clock;
  /**
   * How long to wait for a lock before giving up. SQLite serialises writers, so
   * a busy timeout is what turns "database is locked" from an error into a
   * short wait under normal contention.
   */
  busyTimeoutMs?: number;
}

/** Wraps the driver so callers never import `node:sqlite` directly. */
export class Database {
  readonly #db: DatabaseSync;
  readonly #logger: Logger | undefined;
  readonly #clock: Clock;
  readonly #statements = new Map<string, StatementSync>();
  #transactionDepth = 0;
  #closed = false;

  constructor(options: DatabaseOptions) {
    this.#db = new DatabaseSync(options.location);
    this.#logger = options.logger;
    this.#clock = options.clock ?? systemClock;

    // WAL lets readers proceed during a write, which matters because the SSE
    // bridge reads the event log continuously while turns are appending to it.
    this.#db.exec('PRAGMA journal_mode = WAL');
    // NORMAL trades a fsync per commit for one per checkpoint. Safe under WAL
    // against process crashes; only an OS-level crash can lose recent commits,
    // which is an acceptable trade for an event log that is already replayable.
    this.#db.exec('PRAGMA synchronous = NORMAL');
    // Off by default in SQLite, and we rely on ON DELETE CASCADE.
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  }

  /** Prepared statements are cached: the same SQL is prepared once per handle. */
  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Run a statement that returns no rows. */
  run(sql: string, params: readonly SqlValue[] = []): { changes: number; lastInsertRowid: number } {
    this.#assertOpen();
    const result = this.#prepare(sql).run(...(params as SqlValue[]));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  /** Every matching row. */
  all(sql: string, params: readonly SqlValue[] = []): Row[] {
    this.#assertOpen();
    return this.#prepare(sql).all(...(params as SqlValue[])) as Row[];
  }

  /** The first matching row, or `undefined`. */
  get(sql: string, params: readonly SqlValue[] = []): Row | undefined {
    this.#assertOpen();
    return this.#prepare(sql).get(...(params as SqlValue[])) as Row | undefined;
  }

  /** Multi-statement DDL, outside the prepared-statement cache. */
  exec(sql: string): void {
    this.#assertOpen();
    this.#db.exec(sql);
  }

  /**
   * Run `fn` atomically.
   *
   * Nested calls join the enclosing transaction via savepoints rather than
   * opening a second one, so a service that composes two repository operations
   * gets atomicity whether or not its caller already started a transaction.
   *
   * The callback is synchronous by design: `node:sqlite` is synchronous, and
   * allowing `await` inside a transaction would let unrelated work interleave
   * while a write lock is held.
   */
  transaction<T>(fn: () => T): T {
    this.#assertOpen();
    const depth = this.#transactionDepth;
    const savepoint = `sp_${depth}`;

    if (depth === 0) this.#db.exec('BEGIN IMMEDIATE');
    else this.#db.exec(`SAVEPOINT ${savepoint}`);
    this.#transactionDepth++;

    try {
      const result = fn();
      // COMMIT/RELEASE first, THEN drop the depth. Decrementing before the commit
      // meant a throwing COMMIT (SQLITE_FULL, an I/O error, a busy-timeout — and
      // SQLite keeps the transaction open on a failed COMMIT) fell into the catch,
      // which decremented a *second* time, leaving the depth two below where it
      // started: the connection still had an open transaction but the counter said
      // it did not, so the next `transaction()` issued `BEGIN` on top of it or
      // skipped its own rollback. Restore the depth deterministically to its entry
      // value in the catch instead of blind-decrementing.
      if (depth === 0) this.#db.exec('COMMIT');
      else this.#db.exec(`RELEASE ${savepoint}`);
      this.#transactionDepth = depth;
      return result;
    } catch (error) {
      this.#transactionDepth = depth;
      try {
        if (depth === 0) this.#db.exec('ROLLBACK');
        else this.#db.exec(`ROLLBACK TO ${savepoint}`);
      } catch (rollbackError) {
        // A failed rollback leaves the connection in an unknown state; surface
        // it rather than masking the original error with a confusing one.
        this.#logger?.error('transaction rollback failed', { error: rollbackError });
      }
      throw error;
    }
  }

  get inTransaction(): boolean {
    return this.#transactionDepth > 0;
  }

  /**
   * Explicit transaction control, for the async store wrapper.
   *
   * `transaction()` above cannot span an `await`, so the store serializes async
   * transactions itself and drives them through these three methods. They are
   * not for general use: an unbalanced `begin` holds the write lock until the
   * process exits.
   */
  begin(): void {
    this.#assertOpen();
    if (this.#transactionDepth > 0) {
      throw internalError('begin() called while a transaction is already open');
    }
    this.#db.exec('BEGIN IMMEDIATE');
    this.#transactionDepth++;
  }

  commit(): void {
    this.#assertOpen();
    if (this.#transactionDepth === 0) throw internalError('commit() called with no open transaction');
    this.#db.exec('COMMIT');
    this.#transactionDepth--;
  }

  rollback(): void {
    if (this.#closed || this.#transactionDepth === 0) return;
    try {
      this.#db.exec('ROLLBACK');
    } catch (error) {
      this.#logger?.error('rollback failed', { error });
    } finally {
      this.#transactionDepth--;
    }
  }

  /**
   * Apply pending migrations.
   *
   * Each runs in its own transaction with its checksum recorded. A checksum
   * mismatch means an already-applied migration was edited, which would leave
   * environments silently divergent — so we refuse to start instead.
   */
  migrate(migrations: readonly Migration[] = MIGRATIONS): number {
    this.#assertOpen();
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);

    const applied = new Map<number, { name: string; checksum: string }>();
    for (const row of this.all('SELECT id, name, checksum FROM schema_migrations')) {
      applied.set(Number(row.id), { name: String(row.name), checksum: String(row.checksum) });
    }

    const ordered = [...migrations].sort((a, b) => a.id - b.id);
    let count = 0;

    for (const migration of ordered) {
      const checksum = migrationChecksum(migration);
      const previous = applied.get(migration.id);

      if (previous) {
        if (previous.checksum !== checksum) {
          throw conflict(
            `Migration ${migration.id} (${migration.name}) was modified after being applied`,
            { migrationId: migration.id, expected: previous.checksum, actual: checksum },
          );
        }
        continue;
      }

      this.transaction(() => {
        for (const statement of migration.statements) this.#db.exec(statement);
        this.run(
          'INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          [migration.id, migration.name, checksum, this.#clock.now()],
        );
      });

      this.#logger?.info('migration applied', { id: migration.id, name: migration.name });
      count++;
    }

    return count;
  }

  /** Reclaim space and refresh the query planner's statistics. */
  maintenance(): void {
    this.#assertOpen();
    this.#db.exec('PRAGMA optimize');
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw internalError('Database handle is closed');
  }
}

/** Open a database and bring its schema up to date. */
export function openDatabase(options: DatabaseOptions): Database {
  const database = new Database(options);
  database.migrate();
  return database;
}
