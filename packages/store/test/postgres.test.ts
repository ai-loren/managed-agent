/**
 * The Postgres driver without a Postgres: its SQL translation, its URL, the
 * wire protocol against a stand-in server, and the statements the bridge sends
 * for reads, writes and transactions — the shapes the store's serialization
 * rests on. A real server runs the whole suite in postgres.docker.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

import { MaError } from '@ma/core';

import { describeDatabase, parsePostgresUrl, PgDatabase } from '../src/index.ts';
import { jsonIsTrue, jsonNumber, jsonText } from '../src/dialect.ts';
import { PgConnection, PgConnectionError, PgServerError, type PgConnectOptions } from '../src/postgres/protocol.ts';
import { migrationToPostgres, toPostgres } from '../src/postgres/translate.ts';
import type { FakeOptions, FakeRecord } from './support/fake-postgres.ts';

async function fakePostgres(options: Partial<FakeOptions> = {}) {
  const worker = new Worker(new URL('./support/fake-postgres.ts', import.meta.url), {
    workerData: { auth: 'trust', password: 'right-password', answers: [], ...options } satisfies FakeOptions,
  });
  const [{ port }] = (await once(worker, 'message')) as [{ port: number }];
  return {
    port,
    async records(): Promise<FakeRecord> {
      const reply = once(worker, 'message');
      worker.postMessage('records');
      return ((await reply) as [{ records: FakeRecord }])[0].records;
    },
    async close(): Promise<void> {
      const exited = once(worker, 'exit');
      worker.postMessage('close');
      await exited;
    },
  };
}

const connectOptions = (port: number, overrides: Partial<PgConnectOptions> = {}): PgConnectOptions => ({
  host: '127.0.0.1',
  port,
  user: 'ma',
  password: 'right-password',
  database: 'ma',
  sslmode: 'disable',
  connectTimeoutMs: 2_000,
  parameters: {},
  ...overrides,
});

describe('SQLite SQL, as Postgres takes it', () => {
  test('placeholders are numbered, never inside literals, quoted names or comments', () => {
    assert.equal(
      toPostgres(`SELECT '?' AS q, "a?b" FROM t WHERE x = ? -- is it? 'quoted'\n AND y = ?`),
      `SELECT '?' AS q, "a?b" FROM t WHERE x = $1 -- is it? 'quoted'\n AND y = $2`,
    );
    assert.equal(toPostgres(`SELECT 'it''s ?' WHERE a = ?`), `SELECT 'it''s ?' WHERE a = $1`);
  });

  test("SQLite's IS compares NULL as a value; IS NULL stays as it is", () => {
    assert.equal(toPostgres('WHERE a IS ? AND b IS NOT ? AND c IS NULL'), 'WHERE a IS NOT DISTINCT FROM $1 AND b IS DISTINCT FROM $2 AND c IS NULL');
  });

  test('the planner hint goes, the two-argument MAX and instr are renamed, LIKE folds case as SQLite does', () => {
    assert.equal(toPostgres('SELECT MAX(seq) FROM events INDEXED BY idx_events_ts WHERE ts < ?'), 'SELECT MAX(seq) FROM events WHERE ts < $1');
    assert.equal(toPostgres('SET n = MAX(0, n - ?), m = MAX( 0 , m)'), 'SET n = GREATEST(0, n - $1), m = GREATEST(0, m)');
    assert.equal(toPostgres('coalesce(instr(s.text, ?), 0)'), 'coalesce(strpos(s.text, $1), 0)');
    assert.equal(toPostgres(`WHERE name LIKE ? AND kind NOT LIKE 'LIKE%'`), `WHERE name ILIKE $1 AND kind NOT ILIKE 'LIKE%'`);
  });

  test('insert-or-ignore becomes an insert that does nothing on conflict', () => {
    assert.equal(toPostgres('INSERT OR IGNORE INTO billed_turns (a) VALUES (?)'), 'INSERT INTO billed_turns (a) VALUES ($1) ON CONFLICT DO NOTHING');
  });

  test('a table definition maps the types, text to the byte-order collation, and drops comments', () => {
    assert.equal(
      migrationToPostgres(`CREATE TABLE t (\n  id TEXT PRIMARY KEY, -- the user's id\n  n INTEGER NOT NULL DEFAULT 0,\n  r REAL, b BLOB, kind TEXT NOT NULL DEFAULT 'TEXT'\n)`).replace(/\s+/g, ' ').trim(),
      `CREATE TABLE t ( id TEXT COLLATE "C" PRIMARY KEY, n BIGINT NOT NULL DEFAULT 0, r DOUBLE PRECISION, b BYTEA, kind TEXT COLLATE "C" NOT NULL DEFAULT 'TEXT' )`,
    );
    assert.equal(migrationToPostgres('ALTER TABLE s ADD COLUMN at INTEGER'), 'ALTER TABLE s ADD COLUMN at BIGINT');
    assert.equal(migrationToPostgres(`CREATE INDEX i ON t(kind) WHERE kind = 'TEXT' AND n = 1`), `CREATE INDEX i ON t(kind) WHERE kind = 'TEXT' AND n = 1`);
  });

  test('reading inside a JSON column says what the caller compares', () => {
    assert.equal(jsonText('sqlite', 'p', 'a.b'), "json_extract(p, '$.a.b')");
    assert.equal(jsonText('postgres', 'p', 'a.b'), "(p::jsonb #>> '{a,b}')");
    assert.equal(jsonNumber('postgres', 'v.spec', 'sandbox.prewarm'), "(v.spec::jsonb #>> '{sandbox,prewarm}')::numeric");
    assert.equal(jsonIsTrue('sqlite', 'error', 'retryable'), "json_extract(error, '$.retryable') = 1");
    assert.equal(jsonIsTrue('postgres', 'error', 'retryable'), "(error::jsonb #> '{retryable}') = 'true'::jsonb");
  });
});

describe('the Postgres URL', () => {
  test('defaults: the server port, TLS where offered, the public schema, ten seconds to connect', () => {
    const parsed = parsePostgresUrl('postgres://ma@db.internal/agents');
    assert.equal(parsed.host, 'db.internal');
    assert.equal(parsed.port, 5432);
    assert.equal(parsed.database, 'agents');
    assert.equal(parsed.sslmode, 'prefer');
    assert.equal(parsed.schema, 'public');
    assert.equal(parsed.connectTimeoutMs, 10_000);
    assert.equal(parsed.password, undefined);
    assert.equal(parsePostgresUrl('postgresql://ma:p%40ss@[::1]:5433/x?schema=tenant_a&sslmode=verify-full').password, 'p@ss');
    assert.equal(parsePostgresUrl('postgres://ma@[::1]:5433/x').host, '::1');
    assert.equal(parsePostgresUrl('postgres://ma@db/x', 'from-file').password, 'from-file');
  });

  test('a mistake is refused with what to do, and never with the password', () => {
    const cases: [string, RegExp, string?][] = [
      ['postgres://ma:hunter2@db:port/ma', /looks like postgres:\/\/user@host:5432\/database/],
      ['mysql://ma@db/ma', /starts postgres:\/\/ or postgresql:\/\/; got mysql:/],
      ['postgres://db/ma', /names its user/],
      ['postgres://ma:hunter2@db/ma?sslmode=sometimes', /sslmode is "sometimes"; expected one of disable, prefer, require, verify-ca, verify-full/],
      ['postgres://ma:hunter2@db/ma?search_path=x', /parameter search_path, which this driver does not read; it takes sslmode, sslrootcert, schema and connect_timeout/],
      ['postgres://ma:hunter2@db/ma?schema=Tenant-A', /schema name is lower-case letters, digits and underscores/],
      ['postgres://ma:hunter2@db/ma?connect_timeout=0', /connect_timeout is seconds, a whole number from 1/],
      ['postgres://ma:hunter2@db/ma', /given twice/, 'file-password'],
    ];
    for (const [url, pattern, password] of cases) {
      assert.throws(
        () => parsePostgresUrl(url, password),
        (error: unknown) => MaError.is(error) && error.category === 'validation' && pattern.test(error.message) && !error.message.includes('hunter2'),
        url,
      );
    }
  });

  test('the database is logged without its password', () => {
    assert.equal(describeDatabase('postgres://ma:hunter2@db:5432/ma?schema=x'), 'postgres://ma:***@db:5432/ma?schema=x');
    assert.equal(describeDatabase('./data/managed-agent.db'), './data/managed-agent.db');
  });
});

describe('the wire protocol', () => {
  test('logs in with SCRAM-SHA-256, and checks the server knew the password too', async () => {
    const server = await fakePostgres({ auth: 'scram' });
    try {
      const connection = await PgConnection.connect(connectOptions(server.port, { parameters: { search_path: 'tenant_a' } }));
      connection.close();
      const { startup } = await server.records();
      assert.equal(startup[0]!.user, 'ma');
      assert.equal(startup[0]!.search_path, 'tenant_a');
      assert.equal(startup[0]!.client_encoding, 'UTF8');
      await assert.rejects(PgConnection.connect(connectOptions(server.port, { password: 'wrong-password' })), (error: unknown) => error instanceof PgServerError && error.code === '28P01');
    } finally {
      await server.close();
    }
    const impostor = await fakePostgres({ auth: 'scram-bad-signature' });
    try {
      await assert.rejects(
        PgConnection.connect(connectOptions(impostor.port)),
        (error: unknown) => error instanceof PgConnectionError && /SCRAM login to Postgres failed: the server's signature does not match/.test(error.message),
      );
    } finally {
      await impostor.close();
    }
  });

  test('logs in with MD5', async () => {
    const server = await fakePostgres({ auth: 'md5' });
    try {
      (await PgConnection.connect(connectOptions(server.port))).close();
      assert.match((await server.records()).passwords[0]!, /^md5[0-9a-f]{32}$/);
    } finally {
      await server.close();
    }
  });

  test('does not send a password in cleartext over an unencrypted connection, nor speak methods it does not know', async () => {
    const cleartext = await fakePostgres({ auth: 'cleartext' });
    try {
      await assert.rejects(PgConnection.connect(connectOptions(cleartext.port)), /cleartext over an unencrypted connection.*sslmode=require/);
      assert.deepEqual((await cleartext.records()).passwords, []);
    } finally {
      await cleartext.close();
    }
    const gss = await fakePostgres({ auth: 'gss' });
    try {
      await assert.rejects(PgConnection.connect(connectOptions(gss.port)), /authentication method 7, which this client does not speak; use scram-sha-256 or md5/);
    } finally {
      await gss.close();
    }
    const scram = await fakePostgres({ auth: 'scram' });
    try {
      await assert.rejects(PgConnection.connect(connectOptions(scram.port, { password: undefined })), /asks ma for a password and none was given.*MA_DATABASE_PASSWORD_FILE/);
    } finally {
      await scram.close();
    }
  });

  test('TLS: a server without it is refused unless TLS was only preferred, and bytes after its answer are refused', async () => {
    const plain = await fakePostgres({ sslAnswer: 'N' });
    try {
      await assert.rejects(PgConnection.connect(connectOptions(plain.port, { sslmode: 'require' })), /does not offer TLS, and sslmode is require/);
      (await PgConnection.connect(connectOptions(plain.port, { sslmode: 'prefer' }))).close();
    } finally {
      await plain.close();
    }
    const injected = await fakePostgres({ sslAnswer: 'SX' });
    try {
      await assert.rejects(PgConnection.connect(connectOptions(injected.port, { sslmode: 'require' })), /more than one byte; refusing the connection/);
    } finally {
      await injected.close();
    }
  });

  test('connect_timeout bounds the whole login: a stalled TLS handshake or login gives up', async () => {
    const tls = await fakePostgres({ sslAnswer: 'S' });
    try {
      await assert.rejects(PgConnection.connect(connectOptions(tls.port, { sslmode: 'require', connectTimeoutMs: 300 })), /no TLS handshake within 300 ms/);
    } finally {
      await tls.close();
    }
    const login = await fakePostgres({ stallLogin: true });
    try {
      await assert.rejects(PgConnection.connect(connectOptions(login.port, { connectTimeoutMs: 300 })), /no login within 300 ms/);
    } finally {
      await login.close();
    }
  });

  test('values come back as the SQLite driver returns them, and parameters go as text', async () => {
    const server = await fakePostgres({
      answers: [{
        match: '^SELECT',
        fields: [['flag', 16], ['off', 16], ['n', 20], ['x', 1700], ['s', 25], ['b', 17], ['z', 25]],
        rows: [['t', 'f', '42', '1.5', 'text', '\\x0102ff', null]],
        tag: 'SELECT 1',
      }],
    });
    try {
      const connection = await PgConnection.connect(connectOptions(server.port));
      const result = await connection.query([{ sql: 'SELECT $1, $2, $3, $4', params: ['a\0b', new Uint8Array([1, 2]), 1.5, null] }]);
      connection.close();
      assert.deepEqual(result, { rows: [{ flag: 1, off: 0, n: 42, x: 1.5, s: 'text', b: new Uint8Array([1, 2, 255]), z: null }], rowCount: 1 });
      const sent = (await server.records()).pipelines[0]![0]!.params;
      assert.deepEqual(sent, ['a\uFFFDb', '\\x0102', '1.5', null], 'NUL is not storable in Postgres text');
    } finally {
      await server.close();
    }
  });

  test("a pipeline returns the chosen statement's result; a failure carries the server's code, never its detail", async () => {
    const server = await fakePostgres({
      answers: [
        { match: '^UPDATE', tag: 'UPDATE 3' },
        { match: '^INSERT', error: { S: 'ERROR', C: '23505', M: 'duplicate key value violates unique constraint "t_pkey"', D: 'Key (id)=(secret-value) already exists.', n: 't_pkey' } },
      ],
    });
    try {
      const connection = await PgConnection.connect(connectOptions(server.port));
      const updated = await connection.query([{ sql: 'SAVEPOINT a' }, { sql: 'UPDATE t SET x = 1' }, { sql: 'RELEASE SAVEPOINT a' }], 1);
      assert.equal(updated.rowCount, 3);
      await assert.rejects(connection.query([{ sql: 'INSERT INTO t VALUES (1)' }, { sql: 'UPDATE t SET x = 2' }]), (error: unknown) => {
        assert.ok(error instanceof PgServerError);
        assert.equal(error.code, '23505');
        assert.equal(error.constraint, 't_pkey');
        assert.doesNotMatch(error.message, /secret-value/);
        return true;
      });
      assert.equal((await connection.query([{ sql: 'UPDATE t SET x = 3' }])).rowCount, 3, 'the connection is usable after an error');
      connection.close();
    } finally {
      await server.close();
    }
  });

  test('a dropped connection fails what is in flight, and says it is dead', async () => {
    const server = await fakePostgres({ dropOn: 'DELETE' });
    try {
      const connection = await PgConnection.connect(connectOptions(server.port));
      await assert.rejects(connection.query([{ sql: 'DELETE FROM t' }]), PgConnectionError);
      assert.equal(connection.alive, false);
    } finally {
      await server.close();
    }
  });
});

describe('what the bridge sends', () => {
  const LOCK = 'SELECT pg_advisory_xact_lock($1, $2)';
  const open = (port: number, schema = 'tenant_a'): PgDatabase =>
    new PgDatabase({ url: `postgres://ma@127.0.0.1:${port}/ma?sslmode=disable&schema=${schema}`, callTimeoutMs: 5_000 });
  const sqlOf = (records: FakeRecord) => records.pipelines.map((pipeline) => pipeline.map((statement) => statement.sql));

  test('a read takes no lock; a write takes the store’s lock in its own implicit transaction, keyed by schema', async () => {
    const server = await fakePostgres();
    const a = open(server.port);
    const b = open(server.port, 'tenant_b');
    try {
      a.get('SELECT * FROM t WHERE id = ?', ['x']);
      a.run('UPDATE t SET n = ? WHERE id = ?', [1, 'x']);
      b.run('DELETE FROM t WHERE id = ?', ['y']);
      const records = await server.records();
      assert.deepEqual(sqlOf(records), [
        ['SELECT * FROM t WHERE id = $1'],
        [LOCK, 'UPDATE t SET n = $1 WHERE id = $2'],
        [LOCK, 'DELETE FROM t WHERE id = $1'],
      ]);
      assert.deepEqual(records.pipelines[1]![1]!.params, ['1', 'x']);
      const [namespace, keyA] = records.pipelines[1]![0]!.params;
      const [, keyB] = records.pipelines[2]![0]!.params;
      assert.equal(namespace, String(0x6d61));
      assert.notEqual(keyA, keyB, 'two schemas on one server do not contend');
      assert.deepEqual(records.simple, ['SET search_path TO tenant_b'], 'one connection, switched to the other store’s schema');
      assert.equal(records.startup.length, 1);
    } finally {
      a.close();
      b.close();
      await server.close();
    }
  });

  test('a transaction begins with the lock, runs each statement under a savepoint of its own, and commits', async () => {
    const server = await fakePostgres();
    const db = open(server.port);
    try {
      assert.equal(db.transaction(() => (db.run('INSERT INTO t (id) VALUES (?)', ['x']), 'done')), 'done');
      assert.deepEqual(sqlOf(await server.records()), [
        ['BEGIN', LOCK],
        ['SAVEPOINT ma_statement', 'INSERT INTO t (id) VALUES ($1)', 'RELEASE SAVEPOINT ma_statement'],
        ['COMMIT'],
      ]);
    } finally {
      db.close();
      await server.close();
    }
  });

  test('a failed statement inside a transaction undoes only itself, as in SQLite, and the transaction carries on', async () => {
    const server = await fakePostgres({
      answers: [{ match: '^INSERT', error: { S: 'ERROR', C: '23505', M: 'duplicate key value violates unique constraint "t_pkey"', D: 'Key (id)=(secret) already exists.', n: 't_pkey' } }],
    });
    const db = open(server.port);
    try {
      let caught: unknown;
      db.transaction(() => {
        try {
          db.run('INSERT INTO t (id) VALUES (?)', ['x']);
        } catch (error) {
          caught = error;
        }
        db.run('UPDATE t SET n = 1');
      });
      assert.equal((caught as { code?: unknown }).code, '23505');
      assert.equal((caught as { constraint?: unknown }).constraint, 't_pkey');
      assert.deepEqual(sqlOf(await server.records()), [
        ['BEGIN', LOCK],
        ['SAVEPOINT ma_statement', 'INSERT INTO t (id) VALUES ($1)', 'RELEASE SAVEPOINT ma_statement'],
        ['ROLLBACK TO SAVEPOINT ma_statement', 'RELEASE SAVEPOINT ma_statement'],
        ['SAVEPOINT ma_statement', 'UPDATE t SET n = 1', 'RELEASE SAVEPOINT ma_statement'],
        ['COMMIT'],
      ]);
    } finally {
      db.close();
      await server.close();
    }
  });

  test('an error out of the callback rolls back: a nested call to its savepoint, the outer one whole', async () => {
    const server = await fakePostgres();
    const db = open(server.port);
    try {
      assert.throws(() =>
        db.transaction(() => {
          assert.throws(() => db.transaction(() => {
            throw new Error('inner');
          }), /inner/);
          throw new Error('outer');
        }), /outer/);
      assert.deepEqual(sqlOf(await server.records()), [['BEGIN', LOCK], ['SAVEPOINT ma_sp_1'], ['ROLLBACK TO SAVEPOINT ma_sp_1'], ['ROLLBACK']]);
      assert.equal(db.inTransaction, false);
    } finally {
      db.close();
      await server.close();
    }
  });

  test('waiting past the lock timeout is STORE_BUSY, and a statement past its limit is reported as cancelled', async () => {
    const server = await fakePostgres({
      answers: [
        { match: 'pg_advisory_xact_lock', error: { S: 'ERROR', C: '55P03', M: 'canceling statement due to lock timeout' } },
        { match: '^SELECT', error: { S: 'ERROR', C: '57014', M: 'canceling statement due to statement timeout' } },
      ],
    });
    const db = open(server.port);
    try {
      assert.throws(() => db.run('UPDATE t SET n = 1'), (error: unknown) => MaError.is(error) && error.code === 'STORE_BUSY' && error.retryable === true && error.retryAfterSeconds === 1);
      assert.throws(() => db.get('SELECT 1'), (error: unknown) => MaError.is(error) && error.code === 'STORE_UNAVAILABLE' && /ran past 30 s and was cancelled/.test(error.message));
    } finally {
      db.close();
      await server.close();
    }
  });

  test('a connection lost in a transaction is not replaced inside it; the next statement after it reconnects', async () => {
    const server = await fakePostgres({ dropOn: '^UPDATE' });
    const db = open(server.port);
    try {
      assert.throws(() =>
        db.transaction(() => {
          assert.throws(() => db.run('UPDATE t SET n = 1'), (error: unknown) => MaError.is(error) && error.code === 'STORE_UNAVAILABLE');
          db.run('INSERT INTO t (id) VALUES (?)', ['after']);
        }), (error: unknown) => MaError.is(error) && /lost in the middle of a transaction/.test(error.message));
      db.get('SELECT 1');
      const records = await server.records();
      assert.ok(!sqlOf(records).flat().some((sql) => sql.startsWith('INSERT')), 'nothing ran outside the transaction it belonged to');
      assert.equal(records.startup.length, 2, 'reconnected once the transaction was over');
    } finally {
      db.close();
      await server.close();
    }
  });

  test('a call that times out gives the connection up, and the rest of its transaction is refused rather than run on a new one', async () => {
    const server = await fakePostgres({ hangOn: '^UPDATE' });
    const db = new PgDatabase({ url: `postgres://ma@127.0.0.1:${server.port}/ma?sslmode=disable&schema=hung`, callTimeoutMs: 500 });
    try {
      assert.throws(() =>
        db.transaction(() => {
          assert.throws(() => db.run('UPDATE t SET n = 1'), (error: unknown) => MaError.is(error) && /did not answer within 1 s, so the connection was dropped/.test(error.message));
          db.run('INSERT INTO t (id) VALUES (?)', ['after']);
        }), (error: unknown) => MaError.is(error) && /dropped in the middle of a transaction, which is rolled back/.test(error.message));
      db.get('SELECT 1');
      const records = await server.records();
      assert.ok(!sqlOf(records).flat().some((sql) => sql.startsWith('INSERT')), 'nothing ran outside the transaction it belonged to');
      assert.equal(records.startup.length, 2, 'a new connection, once the transaction was over');
    } finally {
      db.close();
      await server.close();
    }
  });

  test("another store's statement cannot run inside a transaction it did not open", async () => {
    const server = await fakePostgres();
    const a = open(server.port);
    const b = open(server.port, 'tenant_b');
    try {
      a.transaction(() => {
        assert.throws(() => b.get('SELECT 1'), /another has a transaction open on it/);
      });
      b.get('SELECT 1');
    } finally {
      a.close();
      b.close();
      await server.close();
    }
  });
});
