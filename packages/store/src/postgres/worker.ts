/**
 * The store's Postgres connection, in a worker thread so the main thread can
 * wait on it synchronously (see `bridge.ts`). Requests are answered one at a
 * time, in order; each answer is posted, then signalled through shared memory.
 */

import { workerData, type MessagePort } from 'node:worker_threads';

import { PgConnection, PgConnectionError, PgServerError, type PgConnectOptions, type PgStatement } from './protocol.ts';

export type WorkerRequest =
  | { id: number; op: 'connect' }
  | { id: number; op: 'query'; schema: string; statements: PgStatement[]; resultOf: number; reconnect: boolean }
  | { id: number; op: 'exec'; schema: string; sql: string; reconnect: boolean }
  | { id: number; op: 'close' };

/** A request before it is numbered. */
export type WorkerCall = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;

export interface WorkerFailure {
  kind: 'server' | 'connection' | 'internal';
  message: string;
  code?: string;
  constraint?: string;
}

export type WorkerReply =
  | { id: number; ok: true; rows: Record<string, unknown>[]; rowCount: number }
  | { id: number; ok: false; error: WorkerFailure };

const { port, signal, options } = workerData as { port: MessagePort; signal: Int32Array; options: PgConnectOptions };

let connection: PgConnection | undefined;
/** The search_path the connection is on; stores in one process may each have their own schema. */
let current = options.parameters.search_path ?? 'public';
let queue: Promise<void> = Promise.resolve();

port.on('message', (request: WorkerRequest) => {
  queue = queue
    .then(() => handle(request))
    .then((reply) => {
      port.postMessage(reply);
      Atomics.add(signal, 0, 1);
      Atomics.notify(signal, 0);
    });
});

async function handle(request: WorkerRequest): Promise<WorkerReply> {
  try {
    switch (request.op) {
      case 'connect':
        connection = await PgConnection.connect(options);
        current = options.parameters.search_path ?? 'public';
        return { id: request.id, ok: true, rows: [], rowCount: 0 };
      case 'query': {
        const live = await on(request.schema, request.reconnect);
        const result = await live.query(request.statements, request.resultOf);
        return { id: request.id, ok: true, rows: result.rows, rowCount: result.rowCount };
      }
      case 'exec': {
        const live = await on(request.schema, request.reconnect);
        await live.exec(request.sql);
        return { id: request.id, ok: true, rows: [], rowCount: 0 };
      }
      case 'close':
        connection?.close();
        connection = undefined;
        return { id: request.id, ok: true, rows: [], rowCount: 0 };
    }
  } catch (error) {
    return { id: request.id, ok: false, error: describe(error) };
  }
}

/**
 * The connection on `schema`. The switch is a round trip of its own: a SET is
 * undone with the transaction it ran in, and pipelined in front of a statement
 * that failed it would leave `current` naming a schema the connection is not on.
 */
async function on(schema: string, reconnect: boolean): Promise<PgConnection> {
  const live = await connected(reconnect);
  if (schema !== current) {
    await live.exec(`SET search_path TO ${schema}`);
    current = schema;
  }
  return live;
}

/** The connection, opened again if it was lost — but never in the middle of a transaction, whose work went with it. */
async function connected(reconnect: boolean): Promise<PgConnection> {
  if (connection?.alive) return connection;
  if (connection && !reconnect) throw new PgConnectionError('the connection to Postgres was lost in the middle of a transaction, which is rolled back');
  connection?.destroy();
  connection = await PgConnection.connect(options);
  current = options.parameters.search_path ?? 'public';
  return connection;
}

function describe(error: unknown): WorkerFailure {
  if (error instanceof PgServerError) {
    return { kind: 'server', message: error.message, code: error.code, ...(error.constraint ? { constraint: error.constraint } : {}) };
  }
  if (error instanceof PgConnectionError) return { kind: 'connection', message: error.message };
  return { kind: 'internal', message: error instanceof Error ? error.message : String(error) };
}
