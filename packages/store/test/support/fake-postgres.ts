/**
 * A stand-in Postgres for the driver's tests. It runs in a worker thread: the
 * driver's calls block the thread that makes them, so a server on that thread
 * could never answer. It speaks enough of the protocol to log a client in by
 * each method, answer pipelines as scripted, and record what it was sent.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';

export interface FakeAnswer {
  /** A regular expression the statement's SQL is matched against. */
  match: string;
  error?: Record<string, string>;
  fields?: [string, number][];
  rows?: (string | null)[][];
  tag?: string;
}

export interface FakeOptions {
  auth: 'trust' | 'scram' | 'scram-bad-signature' | 'md5' | 'cleartext' | 'gss';
  password: string;
  /** What to answer a TLS request with; `N` when absent. */
  sslAnswer?: string;
  answers: FakeAnswer[];
  /** Drop the connection on a statement matching this. */
  dropOn?: string;
  /** Never answer a pipeline with a statement matching this. */
  hangOn?: string;
  /** Never answer the startup message. */
  stallLogin?: boolean;
}

export interface FakeRecord {
  startup: Record<string, string>[];
  passwords: string[];
  pipelines: { sql: string; params: (string | null)[] }[][];
  simple: string[];
}

const options = workerData as FakeOptions;
const record: FakeRecord = { startup: [], passwords: [], pipelines: [], simple: [] };

const sockets = new Set<Socket>();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  // A client that hangs up mid-login is a case under test, not a crash.
  socket.on('error', () => {});
  void serve(socket).catch(() => socket.destroy());
});
server.listen(0, '127.0.0.1', () => parentPort!.postMessage({ port: (server.address() as { port: number }).port }));
parentPort!.on('message', (message: string) => {
  if (message === 'records') parentPort!.postMessage({ records: record });
  if (message === 'close') {
    // Not waiting for clients to hang up: a failing test leaves its connection open.
    for (const socket of sockets) socket.destroy();
    process.exit(0);
  }
});

function frames(socket: Socket) {
  let buffer = Buffer.alloc(0);
  const waiting: ((value: Buffer) => void)[] = [];
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    waiting.shift()?.(Buffer.alloc(0));
  });
  const fill = async (size: number): Promise<void> => {
    while (buffer.length < size) await new Promise<Buffer>((resolve) => waiting.push(resolve));
  };
  return {
    /** A message without a type byte: the TLS request and the startup. */
    async untyped(): Promise<Buffer> {
      await fill(4);
      const length = buffer.readInt32BE(0);
      await fill(length);
      const body = buffer.subarray(4, length);
      buffer = buffer.subarray(length);
      return body;
    },
    async typed(): Promise<{ type: string; body: Buffer }> {
      await fill(5);
      const length = buffer.readInt32BE(1);
      await fill(1 + length);
      const message = { type: String.fromCharCode(buffer[0]!), body: buffer.subarray(5, 1 + length) };
      buffer = buffer.subarray(1 + length);
      return message;
    },
  };
}

const int32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};
const int16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
};
const cstring = (value: string): Buffer => Buffer.concat([Buffer.from(value), Buffer.from([0])]);
const frame = (type: string, body: Buffer): Buffer => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
const auth = (code: number, extra: Buffer = Buffer.alloc(0)): Buffer => frame('R', Buffer.concat([int32(code), extra]));
const ready = frame('Z', Buffer.from('I'));

function errorFrame(fields: Record<string, string>): Buffer {
  return frame('E', Buffer.concat([...Object.entries(fields).map(([key, value]) => Buffer.concat([Buffer.from(key), cstring(value)])), Buffer.from([0])]));
}

async function serve(socket: Socket): Promise<void> {
  const read = frames(socket);
  let first = await read.untyped();
  if (first.readInt32BE(0) === 80_877_103) {
    socket.write(options.sslAnswer ?? 'N');
    if ((options.sslAnswer ?? 'N') !== 'N') return;
    first = await read.untyped();
  }
  const parts = first.subarray(4).toString('utf8').split('\0');
  const startup: Record<string, string> = {};
  for (let index = 0; index + 1 < parts.length; index += 2) if (parts[index]) startup[parts[index]!] = parts[index + 1]!;
  record.startup.push(startup);
  if (options.stallLogin) return;

  if (!(await login(socket, read, startup.user ?? ''))) return;
  socket.write(Buffer.concat([auth(0), frame('S', Buffer.concat([cstring('server_version'), cstring('17.0')])), frame('K', Buffer.alloc(8)), ready]));

  let pipeline: { sql: string; params: (string | null)[] }[] = [];
  for (;;) {
    const message = await read.typed();
    if (message.type === 'X') {
      socket.end();
      return;
    }
    if (message.type === 'Q') {
      const sql = message.body.subarray(0, message.body.length - 1).toString('utf8');
      record.simple.push(sql);
      socket.write(Buffer.concat([frame('C', cstring('OK')), ready]));
    } else if (message.type === 'P') {
      const nameEnd = message.body.indexOf(0);
      const sqlEnd = message.body.indexOf(0, nameEnd + 1);
      pipeline.push({ sql: message.body.subarray(nameEnd + 1, sqlEnd).toString('utf8'), params: [] });
    } else if (message.type === 'B') {
      pipeline.at(-1)!.params = bindParams(message.body);
    } else if (message.type === 'S') {
      record.pipelines.push(pipeline);
      if (options.dropOn && pipeline.some((statement) => new RegExp(options.dropOn!).test(statement.sql))) return void socket.destroy();
      const hang = options.hangOn !== undefined && pipeline.some((statement) => new RegExp(options.hangOn!).test(statement.sql));
      if (!hang) socket.write(Buffer.concat([...answer(pipeline), ready]));
      pipeline = [];
    }
  }
}

function bindParams(body: Buffer): (string | null)[] {
  let at = body.indexOf(0) + 1;
  at = body.indexOf(0, at) + 1;
  const formats = body.readInt16BE(at);
  at += 2 + formats * 2;
  const count = body.readInt16BE(at);
  at += 2;
  const params: (string | null)[] = [];
  for (let index = 0; index < count; index++) {
    const length = body.readInt32BE(at);
    at += 4;
    if (length < 0) {
      params.push(null);
      continue;
    }
    params.push(body.subarray(at, at + length).toString('utf8'));
    at += length;
  }
  return params;
}

/** Each statement's messages, up to the first error, after which Postgres skips to the Sync. */
function answer(pipeline: { sql: string }[]): Buffer[] {
  const out: Buffer[] = [];
  for (const statement of pipeline) {
    const scripted = options.answers.find((candidate) => new RegExp(candidate.match).test(statement.sql));
    out.push(frame('1', Buffer.alloc(0)), frame('2', Buffer.alloc(0)));
    if (scripted?.error) {
      out.push(errorFrame(scripted.error));
      return out;
    }
    if (scripted?.fields) {
      out.push(
        frame(
          'T',
          Buffer.concat([
            int16(scripted.fields.length),
            ...scripted.fields.map(([name, type]) => Buffer.concat([cstring(name), int32(0), int16(0), int32(type), int16(-1), int32(-1), int16(0)])),
          ]),
        ),
      );
      for (const row of scripted.rows ?? []) {
        out.push(
          frame(
            'D',
            Buffer.concat([int16(row.length), ...row.map((value) => (value === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(value)), Buffer.from(value)])))]),
          ),
        );
      }
    } else {
      out.push(frame('n', Buffer.alloc(0)));
    }
    out.push(frame('C', cstring(scripted?.tag ?? `${statement.sql.trim().split(/\s+/)[0]!.toUpperCase()} 0`)));
  }
  return out;
}

async function login(socket: Socket, read: ReturnType<typeof frames>, user: string): Promise<boolean> {
  const fail = (message: string) => {
    socket.write(errorFrame({ S: 'FATAL', C: '28P01', M: message }));
    socket.end();
    return false;
  };
  switch (options.auth) {
    case 'trust':
      return true;
    case 'gss':
      socket.write(auth(7));
      return false;
    case 'cleartext': {
      socket.write(auth(3));
      const message = await read.typed();
      const password = message.body.subarray(0, message.body.length - 1).toString('utf8');
      record.passwords.push(password);
      return password === options.password || fail('password authentication failed');
    }
    case 'md5': {
      const salt = randomBytes(4);
      socket.write(auth(5, salt));
      const message = await read.typed();
      const sent = message.body.subarray(0, message.body.length - 1).toString('utf8');
      record.passwords.push(sent);
      const inner = createHash('md5').update(options.password + user).digest('hex');
      return sent === `md5${createHash('md5').update(inner).update(salt).digest('hex')}` || fail('password authentication failed');
    }
    default: {
      socket.write(auth(10, Buffer.concat([cstring('SCRAM-SHA-256'), Buffer.from([0])])));
      const initial = await read.typed();
      const mechanismEnd = initial.body.indexOf(0);
      const clientFirst = initial.body.subarray(mechanismEnd + 5).toString('utf8');
      const clientFirstBare = clientFirst.slice(clientFirst.indexOf(',', clientFirst.indexOf(',') + 1) + 1);
      const clientNonce = /r=([^,]+)/.exec(clientFirstBare)![1]!;
      const salt = randomBytes(16);
      const serverFirst = `r=${clientNonce}${randomBytes(12).toString('base64')},s=${salt.toString('base64')},i=4096`;
      socket.write(auth(11, Buffer.from(serverFirst)));
      const final = (await read.typed()).body.toString('utf8');
      const withoutProof = final.slice(0, final.lastIndexOf(',p='));
      const proof = Buffer.from(final.slice(final.lastIndexOf(',p=') + 3), 'base64');
      const salted = pbkdf2Sync(options.password, salt, 4096, 32, 'sha256');
      const clientKey = createHmac('sha256', salted).update('Client Key').digest();
      const storedKey = createHash('sha256').update(clientKey).digest();
      const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
      const signature = createHmac('sha256', storedKey).update(authMessage).digest();
      const recovered = Buffer.alloc(32);
      for (let index = 0; index < 32; index++) recovered[index] = proof[index]! ^ signature[index]!;
      if (!timingSafeEqual(createHash('sha256').update(recovered).digest(), storedKey)) return fail('password authentication failed');
      const serverKey = createHmac('sha256', salted).update('Server Key').digest();
      const verifier = options.auth === 'scram-bad-signature' ? randomBytes(32) : createHmac('sha256', serverKey).update(authMessage).digest();
      socket.write(auth(12, Buffer.from(`v=${verifier.toString('base64')}`)));
      return true;
    }
  }
}
