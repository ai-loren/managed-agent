/**
 * A PostgreSQL client for the version 3 wire protocol: TLS by SSLRequest,
 * SCRAM-SHA-256 or MD5 password login, and the extended query protocol with
 * every value as text. No dependency. It runs in the store's worker thread
 * (see `bridge.ts`), one request at a time.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { ScramClient, ScramError } from '@ma/core';

export type PgValue = string | number | bigint | null | Uint8Array;

export const SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

export interface PgConnectOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  sslmode: SslMode;
  /** A CA bundle for `verify-ca` / `verify-full`; otherwise the system's. */
  sslrootcert?: string;
  connectTimeoutMs: number;
  /** Run-time parameters set as the backend starts. */
  parameters: Record<string, string>;
}

export interface PgResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** An error the server reported. `detail` is kept off the message: it quotes row values. */
export class PgServerError extends Error {
  readonly code: string;
  readonly severity: string;
  readonly constraint: string | undefined;

  constructor(fields: Map<string, string>) {
    super(fields.get('M') ?? 'the server reported an error');
    this.code = fields.get('C') ?? '';
    this.severity = fields.get('S') ?? '';
    this.constraint = fields.get('n');
  }
}

/** The connection failed or was lost; whatever was in flight is in an unknown state. */
export class PgConnectionError extends Error {}

/** SCRAM iteration bounds: RFC 7677's floor, and well above OWASP's 600,000 for PBKDF2-SHA256. */
const SCRAM_MIN_ITERATIONS = 4096;
const SCRAM_MAX_ITERATIONS = 1_000_000;

interface Message {
  type: string;
  body: Buffer;
}

/** One statement of a pipeline; only the last one's rows are returned. */
export interface PgStatement {
  sql: string;
  params?: readonly PgValue[];
}

export class PgConnection {
  readonly #socket: Socket;
  readonly #encrypted: boolean;
  #buffer: Buffer = Buffer.alloc(0);
  readonly #messages: Message[] = [];
  #waiter: ((message: Message | Error) => void) | undefined;
  #failure: Error | undefined;

  private constructor(socket: Socket, encrypted: boolean) {
    this.#socket = socket;
    this.#encrypted = encrypted;
    socket.on('data', (chunk: Buffer) => this.#receive(chunk));
    socket.on('error', (error) => this.#fail(new PgConnectionError(`the connection to Postgres failed: ${error.message}`)));
    socket.on('close', () => this.#fail(new PgConnectionError('the connection to Postgres closed')));
  }

  get alive(): boolean {
    return this.#failure === undefined;
  }

  static async connect(options: PgConnectOptions): Promise<PgConnection> {
    const { socket, encrypted } = await open(options);
    const connection = new PgConnection(socket, encrypted);
    // The login is bounded as the TCP connect is: a server that stops
    // answering half way would otherwise hold the worker for good.
    const stalled = () => socket.destroy(new Error(`no login within ${options.connectTimeoutMs} ms`));
    socket.setTimeout(options.connectTimeoutMs, stalled);
    try {
      await connection.#startup(options);
    } catch (error) {
      socket.destroy();
      throw error;
    }
    socket.setTimeout(0);
    socket.removeListener('timeout', stalled);
    return connection;
  }

  /**
   * Run statements as one pipeline: one round trip, and outside an explicit
   * transaction one implicit transaction, so a lock taken by an earlier
   * statement is held through the last. A failing statement skips the rest.
   * The result is statement `resultOf`'s, the last by default.
   */
  async query(statements: readonly PgStatement[], resultOf = statements.length - 1): Promise<PgResult> {
    const parts: Buffer[] = [];
    for (const statement of statements) {
      parts.push(frame('P', Buffer.concat([cstring(''), cstring(statement.sql), int16(0)])));
      parts.push(frame('B', bind(statement.params ?? [])));
      parts.push(frame('D', Buffer.concat([Buffer.from('P'), cstring('')])));
      parts.push(frame('E', Buffer.concat([cstring(''), int32(0)])));
    }
    parts.push(frame('S', Buffer.alloc(0)));
    this.#write(Buffer.concat(parts));

    let fields: { name: string; type: number }[] = [];
    const rows: Record<string, unknown>[] = [];
    let rowCount = 0;
    let current = 0;
    let error: PgServerError | undefined;
    for (;;) {
      const message = await this.#next();
      switch (message.type) {
        case 'T':
          if (current === resultOf) fields = rowDescription(message.body);
          break;
        case 'D':
          if (current === resultOf) rows.push(dataRow(message.body, fields));
          break;
        case 'C':
          if (current === resultOf) rowCount = commandCount(message.body);
          current++;
          break;
        case 'I':
          current++;
          break;
        case 'E':
          error = new PgServerError(errorFields(message.body));
          break;
        case 'Z':
          if (error) throw error;
          return { rows, rowCount };
        default:
          // ParseComplete, BindComplete, NoData, notices, parameter status.
          break;
      }
    }
  }

  /** The simple query protocol, for DDL: any number of statements, no parameters. */
  async exec(sql: string): Promise<void> {
    this.#write(frame('Q', cstring(sql)));
    let error: PgServerError | undefined;
    for (;;) {
      const message = await this.#next();
      if (message.type === 'E') error = new PgServerError(errorFields(message.body));
      if (message.type === 'Z') {
        if (error) throw error;
        return;
      }
    }
  }

  close(): void {
    if (this.#failure) return;
    this.#write(frame('X', Buffer.alloc(0)));
    this.#socket.end();
    this.#fail(new PgConnectionError('the connection to Postgres was closed'));
  }

  destroy(): void {
    this.#socket.destroy();
  }

  async #startup(options: PgConnectOptions): Promise<void> {
    const pairs: Buffer[] = [int32(196_608)];
    for (const [key, value] of Object.entries({
      user: options.user,
      database: options.database,
      application_name: 'managed-agent',
      client_encoding: 'UTF8',
      ...options.parameters,
    })) {
      pairs.push(cstring(key), cstring(value));
    }
    pairs.push(Buffer.from([0]));
    this.#write(withLength(Buffer.concat(pairs)));

    let scram: ScramClient | undefined;
    for (;;) {
      const message = await this.#next();
      if (message.type === 'E') throw new PgServerError(errorFields(message.body));
      if (message.type === 'Z') return;
      if (message.type !== 'R') continue;
      const code = message.body.readInt32BE(0);
      if (code === 0) continue;
      const password = options.password;
      if (password === undefined) {
        throw new PgConnectionError(`Postgres asks ${options.user} for a password and none was given; put it in the URL or MA_DATABASE_PASSWORD_FILE.`);
      }
      if (code === 3) {
        if (!this.#encrypted) {
          throw new PgConnectionError(
            'Postgres asked for the password in cleartext over an unencrypted connection, which would send it as written. ' +
              'Use sslmode=require or stronger, or configure the server for scram-sha-256.',
          );
        }
        this.#write(frame('p', cstring(password)));
      } else if (code === 5) {
        const inner = createHash('md5').update(password + options.user).digest('hex');
        const outer = createHash('md5').update(inner).update(message.body.subarray(4, 8)).digest('hex');
        this.#write(frame('p', cstring(`md5${outer}`)));
      } else if (code === 10) {
        const mechanisms = message.body.subarray(4).toString('utf8').split('\0').filter((name) => name.length > 0);
        if (!mechanisms.includes('SCRAM-SHA-256')) {
          throw new PgConnectionError(`Postgres offers only ${mechanisms.join(', ')}; this client speaks SCRAM-SHA-256.`);
        }
        // Postgres takes the user from the startup message and ignores SCRAM's.
        scram = new ScramClient('sha256', '', password, { minIterations: SCRAM_MIN_ITERATIONS, maxIterations: SCRAM_MAX_ITERATIONS });
        const first = Buffer.from(scram.first(), 'utf8');
        this.#write(frame('p', Buffer.concat([cstring('SCRAM-SHA-256'), int32(first.length), first])));
      } else if (code === 11) {
        if (!scram) throw new PgConnectionError('Postgres continued a SCRAM exchange that was never started');
        const final = await scram.final(message.body.subarray(4).toString('utf8')).catch(rethrowScram);
        this.#write(frame('p', Buffer.from(final, 'utf8')));
      } else if (code === 12) {
        if (!scram) throw new PgConnectionError('Postgres finished a SCRAM exchange that was never started');
        try {
          scram.verify(message.body.subarray(4).toString('utf8'));
        } catch (error) {
          rethrowScram(error);
        }
      } else {
        throw new PgConnectionError(`Postgres asks for authentication method ${code}, which this client does not speak; use scram-sha-256 or md5.`);
      }
    }
  }

  #write(data: Buffer): void {
    if (this.#failure) throw this.#failure;
    this.#socket.write(data);
  }

  #receive(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 5) {
      const length = this.#buffer.readInt32BE(1);
      if (this.#buffer.length < 1 + length) break;
      const message = { type: String.fromCharCode(this.#buffer[0]!), body: this.#buffer.subarray(5, 1 + length) };
      this.#buffer = this.#buffer.subarray(1 + length);
      const waiter = this.#waiter;
      if (waiter) {
        this.#waiter = undefined;
        waiter(message);
      } else {
        this.#messages.push(message);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.(error);
  }

  #next(): Promise<Message> {
    const queued = this.#messages.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#waiter = (message) => (message instanceof Error ? reject(message) : resolve(message));
    });
  }
}

function rethrowScram(error: unknown): never {
  if (error instanceof ScramError) throw new PgConnectionError(`SCRAM login to Postgres failed: ${error.message}.`);
  throw error;
}

/** TCP, then TLS if the mode asks for it and the server agrees. */
async function open(options: PgConnectOptions): Promise<{ socket: Socket; encrypted: boolean }> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const attempt = netConnect({ host: options.host, port: options.port });
    const stalled = () => attempt.destroy(new Error(`no answer within ${options.connectTimeoutMs} ms`));
    attempt.setTimeout(options.connectTimeoutMs, stalled);
    attempt.once('connect', () => {
      // Disabling the timer leaves its listener, which the login's timeout would fire too.
      attempt.setTimeout(0);
      attempt.removeListener('timeout', stalled);
      resolve(attempt);
    });
    attempt.once('error', (error) => reject(new PgConnectionError(`could not connect to Postgres at ${options.host}:${options.port}: ${error.message}`)));
  });
  socket.setNoDelay(true);
  if (options.sslmode === 'disable') return { socket, encrypted: false };

  socket.write(Buffer.concat([int32(8), int32(80_877_103)]));
  const answer = await new Promise<Buffer>((resolve, reject) => {
    socket.once('data', resolve);
    socket.once('error', reject);
  });
  // Anything after the one-byte answer arrived before encryption, where anyone
  // on the path could have put it (CVE-2021-23222).
  if (answer.length !== 1) {
    socket.destroy();
    throw new PgConnectionError('Postgres answered the TLS request with more than one byte; refusing the connection');
  }
  if (answer[0] === 0x4e) {
    if (options.sslmode === 'prefer') return { socket, encrypted: false };
    socket.destroy();
    throw new PgConnectionError(`Postgres at ${options.host}:${options.port} does not offer TLS, and sslmode is ${options.sslmode}. Enable TLS on the server, or use sslmode=disable on a trusted network.`);
  }
  const verify = options.sslmode === 'verify-ca' || options.sslmode === 'verify-full';
  const secure = await new Promise<Socket>((resolve, reject) => {
    const upgraded = tlsConnect({
      socket,
      ...(isIP(options.host) === 0 ? { servername: options.host } : {}),
      rejectUnauthorized: verify,
      ...(options.sslrootcert ? { ca: readFileSync(options.sslrootcert) } : {}),
      ...(options.sslmode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
    });
    const stalled = () => upgraded.destroy(new Error(`no TLS handshake within ${options.connectTimeoutMs} ms`));
    upgraded.setTimeout(options.connectTimeoutMs, stalled);
    upgraded.once('secureConnect', () => {
      upgraded.setTimeout(0);
      upgraded.removeListener('timeout', stalled);
      resolve(upgraded);
    });
    upgraded.once('error', (error) => reject(new PgConnectionError(`TLS with Postgres at ${options.host}:${options.port} failed: ${error.message}`)));
  });
  return { socket: secure, encrypted: true };
}

function int16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

function withLength(body: Buffer): Buffer {
  return Buffer.concat([int32(body.length + 4), body]);
}

function frame(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type), withLength(body)]);
}

/** Bind every parameter as text and ask for every result as text. */
function bind(params: readonly PgValue[]): Buffer {
  const parts: Buffer[] = [cstring(''), cstring(''), int16(0), int16(params.length)];
  for (const value of params) {
    const text = encode(value);
    if (text === null) {
      parts.push(int32(-1));
    } else {
      parts.push(int32(text.length), text);
    }
  }
  parts.push(int16(0));
  return Buffer.concat(parts);
}

function encode(value: PgValue): Buffer | null {
  if (value === null || value === undefined) return null;
  // Postgres text cannot hold NUL, which the SQLite driver stores; refusing it
  // would fail the write of an event whose payload carries one.
  if (typeof value === 'string') return Buffer.from(value.replaceAll('\0', '\uFFFD'), 'utf8');
  if (typeof value === 'number' || typeof value === 'bigint') return Buffer.from(String(value), 'utf8');
  return Buffer.from(`\\x${Buffer.from(value).toString('hex')}`, 'utf8');
}

function rowDescription(body: Buffer): { name: string; type: number }[] {
  const count = body.readInt16BE(0);
  const fields: { name: string; type: number }[] = [];
  let at = 2;
  for (let index = 0; index < count; index++) {
    const end = body.indexOf(0, at);
    const name = body.subarray(at, end).toString('utf8');
    at = end + 1;
    const type = body.readInt32BE(at + 6);
    at += 18;
    fields.push({ name, type });
  }
  return fields;
}

function dataRow(body: Buffer, fields: readonly { name: string; type: number }[]): Record<string, unknown> {
  const count = body.readInt16BE(0);
  const row: Record<string, unknown> = {};
  let at = 2;
  for (let index = 0; index < count; index++) {
    const length = body.readInt32BE(at);
    at += 4;
    const field = fields[index];
    const name = field?.name ?? `column${index}`;
    if (length < 0) {
      row[name] = null;
      continue;
    }
    row[name] = decode(field?.type ?? 25, body.subarray(at, at + length).toString('utf8'));
    at += length;
  }
  return row;
}

/**
 * Text to a value as the SQLite driver returns one: numbers for numeric types,
 * 1 and 0 for booleans (SQLite has none, and callers compare with 1), bytes
 * for bytea, and text for the rest.
 */
function decode(type: number, text: string): unknown {
  switch (type) {
    case 16:
      return text === 't' ? 1 : 0;
    case 20:
    case 21:
    case 23:
    case 26:
    case 700:
    case 701:
    case 1700:
      return Number(text);
    case 17:
      return new Uint8Array(Buffer.from(text.startsWith('\\x') ? text.slice(2) : text, 'hex'));
    default:
      return text;
  }
}

/** Rows a command touched: the last number of its tag (`INSERT 0 3`, `UPDATE 2`, `SELECT 5`). */
function commandCount(body: Buffer): number {
  const tag = body.subarray(0, body.length - 1).toString('utf8');
  const count = Number(tag.split(' ').at(-1));
  return Number.isInteger(count) ? count : 0;
}

function errorFields(body: Buffer): Map<string, string> {
  const fields = new Map<string, string>();
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const code = String.fromCharCode(body[at]!);
    const end = body.indexOf(0, at + 1);
    fields.set(code, body.subarray(at + 1, end).toString('utf8'));
    at = end + 1;
  }
  return fields;
}
