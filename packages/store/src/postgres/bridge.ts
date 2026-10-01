/**
 * The Postgres driver: the synchronous `SqlDatabase` the repositories are
 * written against, over a connection a worker thread holds.
 *
 * Each call posts to the worker and blocks this thread until it answers — the
 * blocking the SQLite driver does too, and what keeps a transaction's callback
 * synchronous: nothing else runs on this thread while one is open, so no other
 * task's statement can land inside it (see `SqliteStore.transaction`).
 *
 * The store's invariants are written against SQLite's single writer, so writes
 * here are serialized the same way, across every replica: a transaction takes
 * a transaction-scoped advisory lock as it begins, and a write outside one
 * takes it for its own implicit transaction. Postgres gives the replicas one
 * shared state, not more write throughput.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { receiveMessageOnPort, MessageChannel, Worker, type MessagePort } from 'node:worker_threads';

import { MaError, conflict, internalError, systemClock, validationError, type Clock, type Logger } from '@ma/core';

import type { SqlDatabase } from '../database.ts';
import type { Row, SqlValue } from '../mapping.ts';
import { MIGRATIONS, migrationChecksum, type Migration } from '../migrations.ts';
import { SSL_MODES, type PgConnectOptions, type PgStatement, type SslMode } from './protocol.ts';
import { migrationToPostgres, toPostgres } from './translate.ts';
import type { WorkerCall, WorkerFailure, WorkerReply } from './worker.ts';

export interface PgDatabaseOptions {
  /** `postgres://user[:password]@host[:port]/database[?sslmode=…&schema=…&sslrootcert=…&connect_timeout=…]` */
  url: string;
  /** In place of one in the URL, which must then carry none (`MA_DATABASE_PASSWORD_FILE`). */
  password?: string;
  /** In place of the URL's `schema`, which is created at migration if it does not exist. */
  schema?: string;
  logger?: Logger;
  clock?: Clock;
  /** How long one call may wait for the worker before the connection is given up; for tests. */
  callTimeoutMs?: number;
}

/** A statement Postgres runs longer than this is cancelled, so a stuck one cannot hold this thread. */
const STATEMENT_TIMEOUT_MS = 30_000;
/** Waiting longer for the write lock fails as STORE_BUSY, like SQLite's busy timeout. */
const LOCK_TIMEOUT_MS = 5_000;
/** The worker's answer must come within this, or the connection is given up. */
const CALL_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 10_000;
/** First key of the advisory lock pair, so the store's lock does not collide with another application's. */
const LOCK_NAMESPACE = 0x6d61;
const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

/** Parse a `postgres://` URL into what the client connects with. Never echoes the password. */
export function parsePostgresUrl(url: string, password?: string): PgConnectOptions & { schema: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw validationError('A Postgres URL looks like postgres://user@host:5432/database; MA_DATABASE starts postgres:// but does not parse as a URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw validationError(`A Postgres URL starts postgres:// or postgresql://; got ${parsed.protocol}//.`);
  }
  if (password !== undefined && parsed.password) {
    throw validationError('The Postgres password is given twice, in MA_DATABASE and in MA_DATABASE_PASSWORD_FILE; keep one.');
  }
  const user = decodeURIComponent(parsed.username);
  if (!user) throw validationError('A Postgres URL names its user: postgres://user@host/database.');
  const params = parsed.searchParams;
  for (const key of params.keys()) {
    if (!['sslmode', 'sslrootcert', 'schema', 'connect_timeout'].includes(key)) {
      throw validationError(`MA_DATABASE has the parameter ${key}, which this driver does not read; it takes sslmode, sslrootcert, schema and connect_timeout.`);
    }
  }
  const sslmode = (params.get('sslmode') ?? 'prefer') as SslMode;
  if (!SSL_MODES.includes(sslmode)) {
    throw validationError(`MA_DATABASE's sslmode is ${JSON.stringify(sslmode)}; expected one of ${SSL_MODES.join(', ')}.`);
  }
  const schema = params.get('schema') ?? 'public';
  assertSchemaName(schema);
  const connectTimeout = Number(params.get('connect_timeout') ?? '10');
  if (!Number.isInteger(connectTimeout) || connectTimeout < 1) {
    throw validationError(`MA_DATABASE's connect_timeout is seconds, a whole number from 1; got ${JSON.stringify(params.get('connect_timeout'))}.`);
  }
  const secret = password ?? (parsed.password ? decodeURIComponent(parsed.password) : undefined);
  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, '$1') || 'localhost',
    port: parsed.port ? Number(parsed.port) : 5432,
    user,
    ...(secret !== undefined ? { password: secret } : {}),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || user,
    sslmode,
    ...(params.get('sslrootcert') ? { sslrootcert: params.get('sslrootcert')! } : {}),
    connectTimeoutMs: connectTimeout * 1000,
    parameters: {},
    schema,
  };
}

function assertSchemaName(schema: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw validationError(`A schema name is lower-case letters, digits and underscores, starting with a letter or underscore; got ${JSON.stringify(schema)}.`);
  }
}

/** A worker and its connection, shared by every store in this process on the same server and login. */
class Channel {
  readonly #worker: Worker;
  readonly #port: MessagePort;
  readonly #signal: Int32Array;
  #nextId = 0;
  #users = 0;
  /** The store with a transaction open; nothing else may run on the connection until it ends. */
  owner: PgDatabase | undefined;
  broken = false;

  constructor(options: PgConnectOptions) {
    const { port1, port2 } = new MessageChannel();
    this.#signal = new Int32Array(new SharedArrayBuffer(4));
    this.#worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { port: port2, signal: this.#signal, options },
      transferList: [port2],
    });
    this.#worker.unref();
    port1.unref();
    this.#port = port1;
  }

  join(): void {
    this.#users++;
  }

  /** True when this was the last store using it. */
  leave(): boolean {
    this.#users--;
    return this.#users <= 0;
  }

  call(request: WorkerCall, timeoutMs: number): WorkerReply {
    const id = ++this.#nextId;
    this.#port.postMessage({ ...request, id });
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const seen = Atomics.load(this.#signal, 0);
      const received = receiveMessageOnPort(this.#port);
      if (received) {
        const reply = received.message as WorkerReply;
        if (reply.id === id) return reply;
        continue;
      }
      const left = deadline - performance.now();
      if (left <= 0) {
        this.broken = true;
        void this.#worker.terminate();
        throw new MaError({
          code: 'STORE_UNAVAILABLE',
          category: 'unavailable',
          retryable: true,
          message: `Postgres did not answer within ${Math.round(timeoutMs / 1000)} s, so the connection was dropped. Whether a write in flight was made is unknown; check the database is reachable.`,
        });
      }
      Atomics.wait(this.#signal, 0, seen, left);
    }
  }

  close(): void {
    try {
      this.call({ op: 'close' }, 5_000);
    } catch {
      // Closing a connection that will not answer: the worker goes regardless.
    }
    void this.#worker.terminate();
  }
}

const channels = new Map<string, Channel>();

export class PgDatabase implements SqlDatabase {
  readonly dialect = 'postgres' as const;
  readonly #options: PgConnectOptions;
  readonly #key: string;
  readonly #schema: string;
  readonly #lock: [number, number];
  readonly #logger: Logger | undefined;
  readonly #clock: Clock;
  readonly #callTimeoutMs: number;
  #channel: Channel;
  #depth = 0;
  #closed = false;

  constructor(options: PgDatabaseOptions) {
    const parsed = parsePostgresUrl(options.url, options.password);
    const schema = options.schema ?? parsed.schema;
    assertSchemaName(schema);
    this.#schema = schema;
    this.#options = {
      ...parsed,
      parameters: {
        search_path: schema,
        statement_timeout: String(STATEMENT_TIMEOUT_MS),
        lock_timeout: String(LOCK_TIMEOUT_MS),
        TimeZone: 'UTC',
      },
    };
    this.#key = createHash('sha256')
      .update(JSON.stringify([parsed.host, parsed.port, parsed.user, parsed.password ?? '', parsed.database, parsed.sslmode, parsed.sslrootcert ?? '']))
      .digest('hex');
    this.#lock = [LOCK_NAMESPACE, createHash('sha256').update(schema).digest().readInt32BE(0)];
    this.#logger = options.logger;
    this.#clock = options.clock ?? systemClock;
    this.#callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.#channel = this.#acquire();
  }

  #acquire(): Channel {
    let channel = channels.get(this.#key);
    if (!channel || channel.broken) {
      channel = new Channel(this.#options);
      channels.set(this.#key, channel);
      const reply = channel.call({ op: 'connect' }, this.#options.connectTimeoutMs + 10_000);
      if (!reply.ok) {
        channels.delete(this.#key);
        channel.close();
        throw failure(reply.error);
      }
    }
    channel.join();
    return channel;
  }

  run(sql: string, params: readonly SqlValue[] = []): { changes: number; lastInsertRowid: number } {
    return { changes: this.#query(sql, params).rowCount, lastInsertRowid: 0 };
  }

  all(sql: string, params: readonly SqlValue[] = []): Row[] {
    return this.#query(sql, params).rows;
  }

  get(sql: string, params: readonly SqlValue[] = []): Row | undefined {
    return this.#query(sql, params).rows[0];
  }

  exec(sql: string): void {
    this.#assertOpen();
    this.#call({ op: 'exec', schema: this.#schema, sql: migrationToPostgres(sql), reconnect: this.#depth === 0 });
  }

  /**
   * Run `fn` atomically, nested calls through savepoints, as the SQLite driver
   * does. Inside, each statement runs under a savepoint of its own: a failed
   * statement in SQLite undoes only itself, while in Postgres it would abort
   * the whole transaction, and a caller that catches a conflict and carries on
   * would find every later statement refused.
   */
  transaction<T>(fn: () => T): T {
    this.#assertOpen();
    const depth = this.#depth;
    const savepoint = `ma_sp_${depth}`;
    if (depth === 0) {
      this.#statements([{ sql: 'BEGIN' }, { sql: 'SELECT pg_advisory_xact_lock($1, $2)', params: this.#lock }], 1, true);
      this.#channel.owner = this;
    } else {
      this.#statements([{ sql: `SAVEPOINT ${savepoint}` }], 0, false);
    }
    this.#depth++;
    try {
      const result = fn();
      this.#statements([{ sql: depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}` }], 0, false);
      this.#depth = depth;
      if (depth === 0) this.#channel.owner = undefined;
      return result;
    } catch (error) {
      this.#depth = depth;
      try {
        this.#statements([{ sql: depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}` }], 0, false);
      } catch (rollbackError) {
        this.#logger?.error('transaction rollback failed', { error: rollbackError });
      }
      if (depth === 0) this.#channel.owner = undefined;
      throw error;
    }
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  begin(): void {
    this.#assertOpen();
    if (this.#depth > 0) throw internalError('begin() called while a transaction is already open');
    this.#statements([{ sql: 'BEGIN' }, { sql: 'SELECT pg_advisory_xact_lock($1, $2)', params: this.#lock }], 1, true);
    this.#channel.owner = this;
    this.#depth++;
  }

  commit(): void {
    this.#assertOpen();
    if (this.#depth === 0) throw internalError('commit() called with no open transaction');
    this.#statements([{ sql: 'COMMIT' }], 0, false);
    this.#depth--;
    this.#channel.owner = undefined;
  }

  rollback(): void {
    if (this.#closed || this.#depth === 0) return;
    try {
      this.#statements([{ sql: 'ROLLBACK' }], 0, false);
    } catch (error) {
      this.#logger?.error('rollback failed', { error });
    } finally {
      this.#depth--;
      this.#channel.owner = undefined;
    }
  }

  /**
   * Apply pending migrations — the same list, ids and checksums as SQLite's,
   * translated, with the adaptations below. A session lock spans the run, so
   * two replicas booting together apply each migration once.
   */
  migrate(migrations: readonly Migration[] = MIGRATIONS): number {
    this.#assertOpen();
    this.#statements([{ sql: 'SELECT pg_advisory_lock($1, $2)', params: this.#lock }], 0, true);
    try {
      // Looked up first: CREATE SCHEMA IF NOT EXISTS still needs the right to
      // create schemas, which a login given an existing schema may not have.
      if (this.#statements([{ sql: 'SELECT 1 FROM pg_namespace WHERE nspname = $1', params: [this.#schema] }], 0, true).rows.length === 0) {
        this.#call({ op: 'exec', schema: 'public', sql: `CREATE SCHEMA ${this.#schema}`, reconnect: true });
      }
      this.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`);
      const applied = new Map<number, string>();
      for (const row of this.all('SELECT id, checksum FROM schema_migrations')) applied.set(Number(row.id), String(row.checksum));

      let count = 0;
      for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
        const checksum = migrationChecksum(migration);
        const previous = applied.get(migration.id);
        if (previous !== undefined) {
          if (previous !== checksum) {
            throw conflict(`Migration ${migration.id} (${migration.name}) was modified after being applied`, {
              migrationId: migration.id,
              expected: previous,
              actual: checksum,
            });
          }
          continue;
        }
        const adaptation = POSTGRES_ADAPTATIONS[migration.id];
        this.transaction(() => {
          migration.statements.forEach((statement, index) => {
            if (!adaptation?.skip?.includes(index)) this.exec(statement);
          });
          for (const statement of adaptation?.after ?? []) this.exec(statement);
          this.run('INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)', [
            migration.id,
            migration.name,
            checksum,
            this.#clock.now(),
          ]);
        });
        this.#logger?.info('migration applied', { id: migration.id, name: migration.name });
        count++;
      }
      return count;
    } finally {
      this.#statements([{ sql: 'SELECT pg_advisory_unlock($1, $2)', params: this.#lock }], 0, true);
    }
  }

  maintenance(): void {
    this.#assertOpen();
    this.#call({ op: 'exec', schema: this.#schema, sql: 'ANALYZE', reconnect: true });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#channel.leave()) {
      channels.delete(this.#key);
      this.#channel.close();
    }
  }

  #query(sql: string, params: readonly SqlValue[]): { rows: Row[]; rowCount: number } {
    this.#assertOpen();
    const statement: PgStatement = { sql: toPostgres(sql), params };
    if (this.#depth > 0) {
      try {
        return this.#statements([{ sql: 'SAVEPOINT ma_statement' }, statement, { sql: 'RELEASE SAVEPOINT ma_statement' }], 1, false);
      } catch (error) {
        try {
          this.#statements([{ sql: 'ROLLBACK TO SAVEPOINT ma_statement' }, { sql: 'RELEASE SAVEPOINT ma_statement' }], 0, false);
        } catch {
          // The transaction went with its connection; the caller's rollback reports it.
        }
        throw error;
      }
    }
    if (WRITE.test(statement.sql)) {
      return this.#statements([{ sql: 'SELECT pg_advisory_xact_lock($1, $2)', params: this.#lock }, statement], 1, true);
    }
    return this.#statements([statement], 0, true);
  }

  #statements(statements: PgStatement[], resultOf: number, reconnect: boolean): { rows: Row[]; rowCount: number } {
    const reply = this.#call({ op: 'query', schema: this.#schema, statements, resultOf, reconnect });
    return { rows: reply.rows, rowCount: reply.rowCount };
  }

  #call(request: WorkerCall): Extract<WorkerReply, { ok: true }> {
    if (this.#channel.broken) {
      // A fresh connection inside a transaction would run the rest of it
      // outside any transaction: the first part rolled back, the rest kept.
      if (this.#depth > 0) {
        throw new MaError({
          code: 'STORE_UNAVAILABLE',
          category: 'unavailable',
          retryable: true,
          message: 'The connection to Postgres was dropped in the middle of a transaction, which is rolled back. Retry once the database is reachable.',
        });
      }
      this.#channel.leave();
      this.#channel = this.#acquire();
    }
    if (this.#channel.owner !== undefined && this.#channel.owner !== this) {
      throw internalError('Two stores in this process share one Postgres connection, and another has a transaction open on it.');
    }
    const reply = this.#channel.call(request, this.#callTimeoutMs);
    if (!reply.ok) throw failure(reply.error);
    return reply;
  }

  #assertOpen(): void {
    if (this.#closed) throw internalError('Database handle is closed');
  }
}

/**
 * Where a migration cannot run on Postgres as written: a statement to skip by
 * its index, or Postgres-only statements to run after the migration's own.
 */
const POSTGRES_ADAPTATIONS: Record<number, { skip?: number[]; after?: string[] }> = {
  // Receipts are claimed oldest first, ties broken by insertion order — SQLite's
  // rowid, which Postgres tables do not have. Writes are serialized, so the
  // identity's order is the commit order.
  1: { after: ['ALTER TABLE receipts ADD COLUMN rowid BIGINT GENERATED ALWAYS AS IDENTITY'] },
  // The backfill reads SQLite's json_tree. A Postgres database starts empty at
  // migration 1 — the driver came after this migration — so there is nothing to backfill.
  23: { skip: [1] },
};

/** A worker's failure as the error callers act on: busy and unreachable are retryable, the rest keep the server's code. */
function failure(error: WorkerFailure): Error {
  if (error.kind === 'server') {
    if (error.code === '55P03' || error.code === '40001' || error.code === '40P01') {
      return new MaError({
        code: 'STORE_BUSY',
        category: 'unavailable',
        retryable: true,
        retryAfterSeconds: 1,
        message: 'The database stayed locked by another writer past its lock timeout, so nothing was changed. Retry shortly.',
      });
    }
    if (error.code === '57014') {
      return new MaError({
        code: 'STORE_UNAVAILABLE',
        category: 'unavailable',
        retryable: true,
        message: `A database statement ran past ${STATEMENT_TIMEOUT_MS / 1000} s and was cancelled; nothing it did was kept.`,
      });
    }
    return Object.assign(new Error(error.message), { code: error.code, ...(error.constraint ? { constraint: error.constraint } : {}) });
  }
  if (error.kind === 'connection') {
    return new MaError({
      code: 'STORE_UNAVAILABLE',
      category: 'unavailable',
      retryable: true,
      message: `Postgres is unavailable: ${error.message}. Retry once the database is reachable.`,
    });
  }
  return internalError(error.message);
}

/** Whether `MA_DATABASE` names a Postgres server rather than a SQLite file. */
export function isPostgresUrl(location: string): boolean {
  return /^postgres(ql)?:\/\//i.test(location);
}

/** The database as it may be logged: a Postgres URL without its password. */
export function describeDatabase(location: string): string {
  if (!isPostgresUrl(location)) return location;
  try {
    const url = new URL(location);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return 'postgres://(unparseable)';
  }
}

/** The password file's content, trimmed of its trailing newline. */
export function readPasswordFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
}

/** A schema of its own, for a store that must start empty (tests). */
export function freshSchemaName(prefix = 'ma_test'): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}
