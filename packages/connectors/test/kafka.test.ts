/**
 * The Kafka client, offline: wire encoding, record batches, codecs, SCRAM, and
 * the consumer against a fake broker that can be made to fail on cue. The real
 * brokers are in apps/server/test/kafka-pull.docker.test.ts.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { gzipSync, zstdCompressSync } from 'node:zlib';

import { MaError, TestClock, nullLogger, systemClock, type Clock, type Logger } from '@ma/core';
import type { Connector } from '@ma/contracts';

import { kafkaSourceFactory, type PullSource } from '../src/index.ts';
import { decompress, lz4, snappy } from '../src/pull/kafka/compression.ts';
import { crc32c } from '../src/pull/kafka/crc32c.ts';
import { assignRanges } from '../src/pull/kafka/assign.ts';
import { API, decodeAssignment, decodeSubscription, encodeAssignment, encodeSubscription, fetchRequest, offsetCommitRequest } from '../src/pull/kafka/protocol.ts';
import { decodeRecords } from '../src/pull/kafka/records.ts';
import { ScramClient, ScramError } from '../src/pull/kafka/scram.ts';
import { KafkaProtocolError, Reader, Writer } from '../src/pull/kafka/wire.ts';

// ---------------------------------------------------------------------------
// A record batch encoder (message format v2), for building what a broker holds
// ---------------------------------------------------------------------------

interface TestRecord {
  offsetDelta?: number;
  timestampDelta?: number;
  key?: string | null;
  value?: string | null;
  headers?: Record<string, string>;
}

interface TestBatch {
  baseOffset: number;
  records: TestRecord[];
  lastOffsetDelta?: number;
  baseTimestamp?: number;
  maxTimestamp?: number;
  producerId?: bigint;
  transactional?: boolean;
  control?: 'commit' | 'abort';
  logAppendTime?: boolean;
  codec?: 'gzip' | 'zstd';
  magic?: number;
  corruptCrc?: boolean;
  /** Raw bytes after the records, counted as one more record: a record that is broken. */
  trailing?: Buffer;
}

function uvarint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

const varint = (value: number): Buffer => uvarint(value >= 0 ? value * 2 : -value * 2 - 1);

function lengthPrefixed(value: Buffer | null): Buffer {
  return value === null ? varint(-1) : Buffer.concat([varint(value.length), value]);
}

function encodeRecord(record: TestRecord, index: number): Buffer {
  const body = Buffer.concat([
    Buffer.from([0]),
    varint(record.timestampDelta ?? 0),
    varint(record.offsetDelta ?? index),
    lengthPrefixed(record.key === undefined || record.key === null ? null : Buffer.from(record.key)),
    lengthPrefixed(record.value === undefined ? Buffer.from('') : record.value === null ? null : Buffer.from(record.value)),
    varint(Object.keys(record.headers ?? {}).length),
    ...Object.entries(record.headers ?? {}).flatMap(([name, value]) => [lengthPrefixed(Buffer.from(name)), lengthPrefixed(Buffer.from(value))]),
  ]);
  return Buffer.concat([varint(body.length), body]);
}

function encodeBatch(batch: TestBatch): Buffer {
  const records = batch.control
    ? [encodeRecord({ key: null, value: null }, 0)].map(() => {
        const key = Buffer.alloc(4);
        key.writeInt16BE(0, 0);
        key.writeInt16BE(batch.control === 'abort' ? 0 : 1, 2);
        const body = Buffer.concat([Buffer.from([0]), varint(0), varint(0), lengthPrefixed(key), lengthPrefixed(Buffer.alloc(6)), varint(0)]);
        return Buffer.concat([varint(body.length), body]);
      })
    : batch.records.map(encodeRecord);
  let payload = Buffer.concat([...records, ...(batch.trailing ? [batch.trailing] : [])]);
  let codec = 0;
  if (batch.codec === 'gzip') {
    payload = gzipSync(payload);
    codec = 1;
  } else if (batch.codec === 'zstd') {
    payload = zstdCompressSync(payload);
    codec = 4;
  }
  const attributes =
    codec | (batch.logAppendTime ? 0x08 : 0) | (batch.transactional || batch.control ? 0x10 : 0) | (batch.control ? 0x20 : 0);
  const count = batch.control ? 1 : batch.records.length + (batch.trailing ? 1 : 0);
  const afterCrc = new Writer()
    .int16(attributes)
    .int32(batch.lastOffsetDelta ?? Math.max(0, count - 1))
    .int64(batch.baseTimestamp ?? 1_000)
    .int64(batch.maxTimestamp ?? batch.baseTimestamp ?? 1_000)
    .int64(batch.producerId ?? -1n)
    .int16(0)
    .int32(0)
    .int32(count)
    .build();
  const body = Buffer.concat([afterCrc, payload]);
  const header = Buffer.alloc(21);
  header.writeBigInt64BE(BigInt(batch.baseOffset), 0);
  header.writeInt32BE(9 + body.length, 8);
  header.writeInt32BE(0, 12);
  header.writeInt8(batch.magic ?? 2, 16);
  header.writeUInt32BE((crc32c(body) ^ (batch.corruptCrc ? 1 : 0)) >>> 0, 17);
  return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe('Kafka primitives', () => {
  test('CRC-32C matches the standard check value', () => {
    assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
  });

  test('zigzag varints round-trip across the signed range', () => {
    for (const value of [0, -1, 1, -64, 63, 300, -300, 2 ** 31 - 1, -(2 ** 31), 2 ** 40]) {
      assert.equal(new Reader(varint(value)).varint(), value);
    }
  });

  test('a truncated frame is a protocol error, not a short read', () => {
    assert.throws(() => new Reader(Buffer.from([0, 5, 0x61])).string(), KafkaProtocolError);
    assert.throws(() => new Reader(Buffer.from([0x7f, 0xff, 0xff, 0xff])).array((r) => r.int8()), KafkaProtocolError);
  });

  test('requests are laid out field by field as the protocol defines them', () => {
    const commit = offsetCommitRequest('g', 't', new Map([[2, 7]]), 3, 'm-1');
    assert.equal(
      commit.toString('hex'),
      [
        '0001', '67', // group id
        '00000003', // the generation that read it
        '0003', '6d2d31', // the member that read it
        '00000001', '0001', '74', // one topic
        '00000001', '00000002', '0000000000000007', 'ffffffff', 'ffff', // partition 2 at 7, no epoch, no metadata
      ].join(''),
    );
    assert.equal(
      encodeSubscription(['t']).toString('hex'),
      ['0000', '00000001', '0001', '74', 'ffffffff'].join(''), // version 0, one topic, no user data
    );
    assert.equal(
      encodeAssignment(new Map([['t', [4, 1]]])).toString('hex'),
      ['0000', '00000001', '0001', '74', '00000002', '00000004', '00000001', 'ffffffff'].join(''),
    );
    assert.deepEqual(decodeAssignment(encodeAssignment(new Map([['t', [4, 1]]]))), new Map([['t', [4, 1]]]));
    assert.deepEqual(decodeAssignment(Buffer.alloc(0)), new Map(), 'a member left out of the assignment');
    const fetch = fetchRequest('t', [{ partition: 1, offset: 9 }], 500, { maxBytes: 4096, partitionMaxBytes: 1024 });
    assert.equal(
      fetch.toString('hex'),
      [
        'ffffffff', '000001f4', '00000001', '00001000', // replica -1, wait 500, min 1 byte, max 4096
        '01', // read_committed
        '00000000', 'ffffffff', // no fetch session
        '00000001', '0001', '74', '00000001', '00000001', 'ffffffff', '0000000000000009', 'ffffffffffffffff', '00000400',
        '00000000', // nothing forgotten
      ].join(''),
    );
  });

  test('every API the consumer speaks predates flexible versions', () => {
    // The first flexible version of each; tagged fields would change every encoding here.
    const firstFlexible: Record<string, number> = {
      Fetch: 12, ListOffsets: 6, Metadata: 9, OffsetCommit: 8, OffsetFetch: 6,
      FindCoordinator: 3, JoinGroup: 6, Heartbeat: 4, LeaveGroup: 4, SyncGroup: 4,
      SaslHandshake: Infinity, ApiVersions: 3, SaslAuthenticate: 2,
    };
    for (const [name, { version }] of Object.entries(API)) assert.ok(version < firstFlexible[name]!, name);
  });
});

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

describe('Kafka codecs', () => {
  const xerial = (...blocks: Buffer[]): Buffer =>
    Buffer.concat([
      Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00, 0, 0, 0, 1, 0, 0, 0, 1]),
      ...blocks.flatMap((block) => {
        const length = Buffer.alloc(4);
        length.writeInt32BE(block.length);
        return [length, block];
      }),
    ]);

  // "abc", then a 1-byte-offset copy of 9 overlapping itself, then a 2-byte-offset copy.
  const snappyBlock = Buffer.from([12 + 4, 0x08, 0x61, 0x62, 0x63, 0x15, 0x03, (4 - 1) << 2 | 2, 0x0c, 0x00]);

  test('snappy: a raw block, with copies that overlap their own output', () => {
    assert.equal(snappy(snappyBlock, 1024).toString(), 'abcabcabcabcabca');
  });

  test('snappy: the xerial framing the Java client writes, across blocks', () => {
    assert.equal(snappy(xerial(snappyBlock, snappyBlock), 1024).toString(), 'abcabcabcabcabca'.repeat(2));
  });

  test('snappy: a block that claims more than the limit is refused before allocating it', () => {
    assert.throws(() => snappy(Buffer.from([0x80, 0x80, 0x80, 0x40, 0x00]), 1024), /inflates past 1024/);
    assert.throws(() => snappy(Buffer.from([3, 0x01, 0x05]), 1024), /corrupt/);
  });

  const lz4Frame = (...blocks: { data: Buffer; raw?: boolean }[]): Buffer =>
    Buffer.concat([
      Buffer.from([0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82]),
      ...blocks.flatMap(({ data, raw }) => {
        const size = Buffer.alloc(4);
        size.writeUInt32LE((data.length | (raw ? 0x80000000 : 0)) >>> 0);
        return [size, data];
      }),
      Buffer.alloc(4),
    ]);
  // literals "abc", match offset 3 length 9, then a final literal "Z".
  const lz4Block = Buffer.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00, 0x10, 0x5a]);

  test('lz4: frames of compressed and stored blocks', () => {
    assert.equal(lz4(lz4Frame({ data: lz4Block }, { data: Buffer.from('!!'), raw: true }), 1024).toString(), 'abcabcabcabcZ!!');
  });

  test('lz4: a match reaching before the start is corrupt, and output past the limit is refused', () => {
    assert.throws(() => lz4(lz4Frame({ data: Buffer.from([0x15, 0x61, 0x09, 0x00]) }), 1024), /corrupt/);
    assert.throws(() => lz4(lz4Frame({ data: lz4Block }), 8), /inflates past 8/);
  });

  test('gzip and zstd come from zlib, bounded the same way', () => {
    assert.equal(decompress(1, gzipSync('hello'), 1024).toString(), 'hello');
    assert.equal(decompress(4, zstdCompressSync('hello'), 1024).toString(), 'hello');
    assert.throws(() => decompress(1, gzipSync(Buffer.alloc(64 * 1024)), 1024), /gzip record batch inflates past 1024/);
    assert.throws(() => decompress(4, zstdCompressSync(Buffer.alloc(64 * 1024)), 1024), /zstd record batch inflates past 1024/);
    assert.throws(() => decompress(6, Buffer.alloc(1), 1024), /codec 6/);
  });
});

// ---------------------------------------------------------------------------
// Record batches
// ---------------------------------------------------------------------------

describe('Kafka record batches', () => {
  test('records carry their offset, key, value, headers and timestamp; earlier ones are dropped', () => {
    const data = encodeBatch({
      baseOffset: 40,
      baseTimestamp: 5_000,
      records: [
        { key: 'a', value: 'first' },
        { key: null, value: 'second', timestampDelta: 7, headers: { ce_type: 'order.created', trace: 'x' } },
        { key: 'c', value: null },
      ],
    });
    const { records, nextOffset } = decodeRecords(data, 41, []);
    assert.equal(nextOffset, 43);
    assert.deepEqual(
      records.map((record) => [record.offset, record.key?.toString() ?? null, record.value?.toString() ?? null, record.timestamp, record.headers]),
      [
        [41, null, 'second', 5_007, { ce_type: 'order.created', trace: 'x' }],
        [42, 'c', null, 5_000, {}],
      ],
    );
  });

  test('a batch cut off at the size limit is left for the next fetch', () => {
    const whole = encodeBatch({ baseOffset: 0, records: [{ value: 'a' }, { value: 'b' }] });
    const next = encodeBatch({ baseOffset: 2, records: [{ value: 'c' }] });
    const { records, nextOffset } = decodeRecords(Buffer.concat([whole, next.subarray(0, next.length - 3)]), 0, []);
    assert.deepEqual(records.map((record) => record.value?.toString()), ['a', 'b']);
    assert.equal(nextOffset, 2);
  });

  test('compressed batches decode, and a compacted gap still advances past the batch', () => {
    const data = Buffer.concat([
      encodeBatch({ baseOffset: 0, codec: 'gzip', records: [{ value: 'g1' }, { value: 'g2', offsetDelta: 3 }], lastOffsetDelta: 5 }),
      encodeBatch({ baseOffset: 6, codec: 'zstd', records: [{ value: 'z1' }] }),
    ]);
    const { records, nextOffset } = decodeRecords(data, 0, []);
    assert.deepEqual(records.map((record) => [record.offset, record.value?.toString()]), [[0, 'g1'], [3, 'g2'], [6, 'z1']]);
    assert.equal(nextOffset, 7);
  });

  test('read_committed: an aborted transaction and every control batch are skipped', () => {
    const data = Buffer.concat([
      encodeBatch({ baseOffset: 10, producerId: 7n, transactional: true, records: [{ value: 'aborted write' }] }),
      encodeBatch({ baseOffset: 11, producerId: 8n, transactional: true, records: [{ value: 'other producer' }] }),
      encodeBatch({ baseOffset: 12, producerId: 7n, control: 'abort', records: [] }),
      encodeBatch({ baseOffset: 13, producerId: 8n, control: 'commit', records: [] }),
      encodeBatch({ baseOffset: 14, producerId: 7n, transactional: true, records: [{ value: 'committed later' }] }),
      encodeBatch({ baseOffset: 15, records: [{ value: 'plain' }] }),
    ]);
    const { records, nextOffset } = decodeRecords(data, 10, [{ producerId: 7n, firstOffset: 10 }]);
    assert.deepEqual(records.map((record) => record.value?.toString()), ['other producer', 'committed later', 'plain']);
    assert.equal(nextOffset, 16);
  });

  test('an aborted transaction is skipped only from its first offset on', () => {
    const data = Buffer.concat([
      encodeBatch({ baseOffset: 0, producerId: 7n, transactional: true, records: [{ value: 'earlier, committed' }] }),
      encodeBatch({ baseOffset: 1, producerId: 7n, control: 'commit', records: [] }),
      encodeBatch({ baseOffset: 2, producerId: 7n, transactional: true, records: [{ value: 'aborted' }] }),
    ]);
    const { records } = decodeRecords(data, 0, [{ producerId: 7n, firstOffset: 2 }]);
    assert.deepEqual(records.map((record) => record.value?.toString()), ['earlier, committed']);
  });

  test('log-append time replaces the producer timestamp', () => {
    const data = encodeBatch({ baseOffset: 0, baseTimestamp: 1, maxTimestamp: 9_999, logAppendTime: true, records: [{ value: 'x', timestampDelta: 5 }] });
    assert.equal(decodeRecords(data, 0, []).records[0]!.timestamp, 9_999);
  });

  test('a corrupt batch, an old message format or a malformed length is refused with its offset', () => {
    assert.throws(() => decodeRecords(encodeBatch({ baseOffset: 3, corruptCrc: true, records: [{ value: 'x' }] }), 0, []), /offset 3 fails its CRC check/);
    assert.throws(() => decodeRecords(encodeBatch({ baseOffset: 4, magic: 1, records: [{ value: 'x' }] }), 0, []), /offset 4 is in message format v1 \(written before Kafka 0\.11\)/);
    const short = Buffer.alloc(20);
    short.writeBigInt64BE(5n, 0);
    short.writeInt32BE(8, 8);
    assert.throws(() => decodeRecords(short, 0, []), /offset 5 declares a length of 8 bytes/);
  });
});

// ---------------------------------------------------------------------------
// SCRAM
// ---------------------------------------------------------------------------

describe('SCRAM', () => {
  // RFC 7677, section 3.
  const serverFirst = 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';

  test("reproduces RFC 7677's SCRAM-SHA-256 exchange", async () => {
    const client = new ScramClient('sha256', 'user', 'pencil', 'rOprNGfwEbeRWgbNEkqO');
    assert.equal(client.first(), 'n,,n=user,r=rOprNGfwEbeRWgbNEkqO');
    assert.equal(
      await client.final(serverFirst),
      'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
    );
    assert.doesNotThrow(() => client.verify('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4='));
  });

  test('stretches the key off the event loop, and refuses more iterations than Kafka stores', async () => {
    const client = new ScramClient('sha512', 'user', 'pencil', 'rOprNGfwEbeRWgbNEkqO');
    let turned = false;
    const turn = new Promise<void>((resolve) => setImmediate(() => {
      turned = true;
      resolve();
    }));
    const answer = client.final(serverFirst.replace('i=4096', 'i=16384'));
    assert.equal(turned, false, 'nothing ran yet');
    await Promise.all([answer, turn]);
    assert.ok(turned, 'the event loop turned while the key was derived');
    await assert.rejects(
      new ScramClient('sha512', 'user', 'pencil', 'rOprNGfwEbeRWgbNEkqO').final(serverFirst.replace('i=4096', 'i=16385')),
      /16385 iterations; expected 4096–16384/,
    );
  });

  test('escapes the characters SCRAM reserves in a username', () => {
    assert.equal(new ScramClient('sha512', 'a=b,c', 'p', 'nonce').first(), 'n,,n=a=3Db=2Cc,r=nonce');
  });

  test('refuses a server that does not know the password, or tries to cheapen the hash', async () => {
    const fresh = (): ScramClient => new ScramClient('sha256', 'user', 'pencil', 'rOprNGfwEbeRWgbNEkqO');
    const answered = fresh();
    await answered.final(serverFirst);
    assert.throws(() => answered.verify('v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), ScramError);
    assert.throws(() => answered.verify('e=invalid-proof'), /rejected the login: invalid-proof/);
    await assert.rejects(fresh().final(serverFirst.replace('i=4096', 'i=1000')), /1000 iterations/);
    await assert.rejects(fresh().final(serverFirst.replace('r=rOprNGfwEbeRWgbNEkqO%', 'r=someoneelse%')), /did not extend the client nonce/);
    await assert.rejects(fresh().final('r=rOprNGfwEbeRWgbNEkqO,s=W22Z,i=4096'), /did not extend/);
  });
});

// ---------------------------------------------------------------------------
// The consumer, against a fake broker
// ---------------------------------------------------------------------------

interface FakePartition {
  batches: Buffer[];
  logStart: number;
  logEnd: number;
}

interface FakeMember {
  id: string;
  protocols: string[];
  metadata: Buffer;
  /** Answers the member's JoinGroup, held until every member has joined. */
  join?: (body: Buffer) => void;
  /** Answers the member's SyncGroup, held until the leader has sent the assignment. */
  sync?: (body: Buffer) => void;
}

const joinAnswer = (code: number): Buffer => new Writer().int32(0).int16(code).int32(-1).string('').string('').string('').array([], () => {}).build();
const syncAnswer = (code: number, assignment: Buffer = Buffer.alloc(0)): Buffer => new Writer().int32(0).int16(code).bytes(assignment).build();

/**
 * Just enough of a broker: one node that leads every partition and coordinates
 * every group, with `inject` to make the next answer to an API fail. It answers
 * one request per connection at a time, as a broker does, and coordinates one
 * group the classic way: a join starts a rebalance that ends once every member
 * has joined, and the leader's SyncGroup hands out the assignment.
 */
class FakeBroker {
  readonly partitions = new Map<number, FakePartition>();
  readonly committed = new Map<number, number>();
  readonly commits: Map<number, number>[] = [];
  /** Who each accepted commit came from. */
  readonly committers: { generation: number; memberId: string }[] = [];
  readonly members = new Map<string, FakeMember>();
  readonly leaves: string[] = [];
  generation = 0;
  state: 'Empty' | 'PreparingRebalance' | 'CompletingRebalance' | 'Stable' = 'Empty';
  leader = '';
  readonly assignments = new Map<string, Buffer>();
  #memberCount = 0;
  readonly #holds = new Map<number, Promise<void>>();
  /** The partitions of each Fetch, in the order the request named them. */
  readonly fetchOrder: number[][] = [];
  advertisedHost = '127.0.0.1';
  versions = new Map<number, [number, number]>(Object.values(API).map(({ key, version }) => [key, [0, version + 2]]));
  topicError = 0;
  /** Sent with each SASL login; non-zero means sessions expire. */
  sessionLifetimeMs = 0;
  /** SASL logins completed. */
  authentications = 0;
  readonly #inject = new Map<string, number[]>();
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  /** Connections whose SASL session has expired: their next request closes them, as a broker does. */
  readonly #expired = new Set<Socket>();
  readonly #always = new Map<number, Buffer>();
  port = 0;

  constructor(partitions: number) {
    for (let partition = 0; partition < partitions; partition++) this.partitions.set(partition, { batches: [], logStart: 0, logEnd: 0 });
    this.#server = createServer((socket) => this.#serve(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    this.port = (this.#server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  append(partition: number, values: string[]): void {
    const log = this.partitions.get(partition)!;
    log.batches.push(encodeBatch({ baseOffset: log.logEnd, records: values.map((value) => ({ key: `k${partition}`, value })) }));
    log.logEnd += values.length;
  }

  /** Append a batch built as described, holding `count` offsets. */
  appendBatch(partition: number, batch: Omit<TestBatch, 'baseOffset'>, count: number): void {
    const log = this.partitions.get(partition)!;
    log.batches.push(encodeBatch({ ...batch, baseOffset: log.logEnd }));
    log.logEnd += count;
  }

  /** Answer every fetch of the partition with these bytes, whatever offset it asks for. */
  serveAlways(partition: number, data: Buffer): void {
    this.#always.set(partition, data);
  }

  /** Expire every open connection's SASL session. */
  expireSessions(): void {
    for (const socket of this.#sockets) this.#expired.add(socket);
  }

  /** Drop every open connection, as an idle timeout would. */
  dropConnections(): void {
    for (const socket of this.#sockets) socket.destroy();
  }

  /** Make the next answers to `api` carry these error codes, one per answer. */
  inject(api: string, ...codes: number[]): void {
    this.#inject.set(api, [...(this.#inject.get(api) ?? []), ...codes]);
  }

  /** Hold every answer to `api` until the returned function is called. */
  hold(api: 'Fetch' | 'ListOffsets' | 'Metadata'): () => void {
    let release!: () => void;
    this.#holds.set(API[api].key, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      this.#holds.delete(API[api].key);
      release();
    };
  }

  /** A member some other client put in the group, which then went quiet: it never rejoins. */
  addMember(protocol: string): string {
    const id = `${protocol}-${++this.#memberCount}`;
    this.members.set(id, { id, protocols: [protocol], metadata: encodeSubscription(['orders']) });
    if (this.state === 'Empty') {
      this.generation++;
      this.state = 'Stable';
      this.leader = id;
    } else {
      this.#prepareRebalance();
    }
    return id;
  }

  /** Drop a member as its session timing out would. */
  expire(memberId: string): void {
    const member = this.members.get(memberId);
    if (!member) return;
    this.members.delete(memberId);
    member.join?.(joinAnswer(25));
    member.sync?.(syncAnswer(25));
    if (this.members.size === 0) {
      this.state = 'Empty';
      return;
    }
    this.#prepareRebalance();
    this.#completeJoin();
  }

  #prepareRebalance(): void {
    if (this.state === 'PreparingRebalance') return;
    this.state = 'PreparingRebalance';
    for (const member of this.members.values()) {
      member.sync?.(syncAnswer(27));
      member.sync = undefined;
    }
  }

  #completeJoin(): void {
    const members = [...this.members.values()];
    if (this.state !== 'PreparingRebalance' || members.length === 0 || members.some((member) => !member.join)) return;
    this.generation++;
    this.state = 'CompletingRebalance';
    if (!this.members.has(this.leader)) this.leader = members[0]!.id;
    this.assignments.clear();
    const protocol = members[0]!.protocols.find((name) => members.every((member) => member.protocols.includes(name)))!;
    for (const member of members) {
      const answer = member.join!;
      member.join = undefined;
      answer(
        new Writer()
          .int32(0)
          .int16(0)
          .int32(this.generation)
          .string(protocol)
          .string(this.leader)
          .string(member.id)
          .array(member.id === this.leader ? members : [], (w, each) => w.string(each.id).bytes(each.metadata))
          .build(),
      );
    }
  }

  #take(api: string): number {
    const queue = this.#inject.get(api);
    return queue?.shift() ?? 0;
  }

  #serve(socket: Socket): void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffered = Buffer.alloc(0);
    let queue = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readInt32BE(0)) {
        const frame = buffered.subarray(4, 4 + buffered.readInt32BE(0));
        buffered = buffered.subarray(4 + frame.length);
        queue = queue
          .then(async () => {
            const reader = new Reader(frame);
            const key = reader.int16();
            reader.int16();
            const correlation = reader.int32();
            reader.nullableString();
            if (this.#expired.has(socket) && key !== API.SaslHandshake.key && key !== API.SaslAuthenticate.key) {
              socket.destroy();
              return;
            }
            const body = await this.#answer(key, reader, socket);
            await this.#holds.get(key);
            if (socket.destroyed) return;
            const out = Buffer.alloc(8);
            out.writeInt32BE(4 + body.length, 0);
            out.writeInt32BE(correlation, 4);
            socket.write(Buffer.concat([out, body]));
          })
          .catch(() => {
            socket.destroy();
          });
      }
    });
  }

  #answer(key: number, reader: Reader, socket: Socket): Buffer | Promise<Buffer> {
    const w = new Writer();
    switch (key) {
      case API.SaslHandshake.key:
        reader.string();
        return w.int16(0).array(['PLAIN'], (x, name) => x.string(name)).build();
      case API.SaslAuthenticate.key:
        reader.nullableBytes();
        this.authentications++;
        this.#expired.delete(socket);
        return w.int16(0).nullableString(null).bytes(Buffer.alloc(0)).int64(this.sessionLifetimeMs).build();
      case API.ApiVersions.key:
        return w.int16(0).array([...this.versions], (x, [api, [min, max]]) => x.int16(api).int16(min).int16(max)).int32(0).build();
      case API.Metadata.key:
        return w
          .int32(0)
          .array([0], (x) => x.int32(1).string(this.advertisedHost).int32(this.port).nullableString(null))
          .nullableString('fake')
          .int32(1)
          .array(['orders'], (x, name) =>
            x.int16(this.topicError).string(name).boolean(false).array([...this.partitions.keys()], (p, partition) =>
              p.int16(0).int32(partition).int32(1).int32(0).array([1], (n, id) => n.int32(id)).array([1], (n, id) => n.int32(id)).array([] as number[], (n, id) => n.int32(id)),
            ),
          )
          .build();
      case API.FindCoordinator.key:
        return w.int32(0).int16(0).nullableString(null).int32(1).string(this.advertisedHost).int32(this.port).build();
      case API.OffsetFetch.key: {
        reader.string();
        const asked = reader.array((r) => {
          r.string();
          return r.array((p) => p.int32());
        }).flat();
        return w
          .int32(0)
          .array(['orders'], (x, name) =>
            x.string(name).array(asked, (p, partition) => p.int32(partition).int64(this.committed.get(partition) ?? -1).int32(-1).nullableString(null).int16(0)),
          )
          .int16(0)
          .build();
      }
      case API.OffsetCommit.key: {
        reader.string();
        const generation = reader.int32();
        const memberId = reader.string();
        const offsets = new Map<number, number>();
        reader.array((r) => {
          r.string();
          r.array((p) => {
            const partition = p.int32();
            offsets.set(partition, p.long());
            p.int32();
            p.nullableString();
          });
        });
        let code = this.#take('OffsetCommit');
        if (code === 0) {
          // As the classic coordinator: a member of the current generation may commit
          // while the group waits for its members, not while the leader assigns.
          if (generation < 0) code = this.members.size > 0 ? 25 : 0;
          else if (!this.members.has(memberId)) code = 25;
          else if (generation !== this.generation) code = 22;
          else if (this.state === 'CompletingRebalance') code = 27;
        }
        if (code === 0) {
          this.commits.push(offsets);
          this.committers.push({ generation, memberId });
          for (const [partition, offset] of offsets) this.committed.set(partition, offset);
        }
        return w.int32(0).array(['orders'], (x, name) => x.string(name).array([...offsets.keys()], (p, partition) => p.int32(partition).int16(code))).build();
      }
      case API.JoinGroup.key: {
        reader.string();
        reader.int32();
        reader.int32();
        let memberId = reader.string();
        reader.string();
        const protocols = reader.array((r) => ({ name: r.string(), metadata: r.nullableBytes() ?? Buffer.alloc(0) }));
        const injected = this.#take('JoinGroup');
        if (injected) return joinAnswer(injected);
        if (memberId !== '' && !this.members.has(memberId)) return joinAnswer(25);
        const others = [...this.members.values()].filter((member) => member.id !== memberId);
        const chosen = protocols.find(({ name }) => others.every((member) => member.protocols.includes(name)));
        if (!chosen) return joinAnswer(23);
        if (memberId === '') memberId = `member-${++this.#memberCount}`;
        const member = this.members.get(memberId) ?? { id: memberId, protocols: [], metadata: Buffer.alloc(0) };
        member.protocols = protocols.map(({ name }) => name);
        member.metadata = chosen.metadata;
        this.members.set(memberId, member);
        this.#prepareRebalance();
        return new Promise<Buffer>((resolve) => {
          member.join = resolve;
          this.#completeJoin();
        });
      }
      case API.SyncGroup.key: {
        reader.string();
        const generation = reader.int32();
        const memberId = reader.string();
        const assignments = reader.array((r) => ({ memberId: r.string(), assignment: r.nullableBytes() ?? Buffer.alloc(0) }));
        const injected = this.#take('SyncGroup');
        if (injected) return syncAnswer(injected);
        const member = this.members.get(memberId);
        if (!member) return syncAnswer(25);
        if (generation !== this.generation) return syncAnswer(22);
        if (this.state === 'PreparingRebalance') return syncAnswer(27);
        if (this.state === 'Stable') return syncAnswer(0, this.assignments.get(memberId));
        if (memberId !== this.leader) return new Promise<Buffer>((resolve) => (member.sync = resolve));
        for (const entry of assignments) this.assignments.set(entry.memberId, entry.assignment);
        this.state = 'Stable';
        for (const other of this.members.values()) {
          other.sync?.(syncAnswer(0, this.assignments.get(other.id)));
          other.sync = undefined;
        }
        return syncAnswer(0, this.assignments.get(memberId));
      }
      case API.Heartbeat.key: {
        reader.string();
        const generation = reader.int32();
        const memberId = reader.string();
        const code =
          this.#take('Heartbeat') ||
          (!this.members.has(memberId) ? 25 : generation !== this.generation ? 22 : this.state === 'PreparingRebalance' ? 27 : 0);
        return w.int32(0).int16(code).build();
      }
      case API.LeaveGroup.key: {
        reader.string();
        const memberId = reader.string();
        this.leaves.push(memberId);
        if (!this.members.has(memberId)) return w.int32(0).int16(25).build();
        this.expire(memberId);
        return w.int32(0).int16(0).build();
      }
      case API.ListOffsets.key: {
        reader.int32();
        reader.int8();
        const asked = reader.array((r) => {
          r.string();
          return r.array((p) => {
            const partition = p.int32();
            p.int32();
            return { partition, at: p.long() };
          });
        }).flat();
        return w
          .int32(0)
          .array(['orders'], (x, name) =>
            x.string(name).array(asked, (p, { partition, at }) => {
              const log = this.partitions.get(partition)!;
              return p.int32(partition).int16(0).int64(-1).int64(at === -2 ? log.logStart : log.logEnd).int32(0);
            }),
          )
          .build();
      }
      case API.Fetch.key: {
        reader.int32();
        reader.int32();
        reader.int32();
        reader.int32();
        reader.int8();
        reader.int32();
        reader.int32();
        const asked = reader.array((r) => {
          r.string();
          return r.array((p) => {
            const partition = p.int32();
            p.int32();
            const offset = p.long();
            p.int64();
            p.int32();
            return { partition, offset };
          });
        }).flat();
        this.fetchOrder.push(asked.map(({ partition }) => partition));
        const code = this.#take('Fetch');
        return w
          .int32(0)
          .int16(0)
          .int32(0)
          .array(['orders'], (x, name) =>
            x.string(name).array(asked, (p, { partition, offset }) => {
              const log = this.partitions.get(partition)!;
              const outOfRange = offset < log.logStart || offset > log.logEnd;
              const error = code || (outOfRange ? 1 : 0);
              const data = error
                ? Buffer.alloc(0)
                : this.#always.get(partition) ?? Buffer.concat(log.batches.filter((batch) => Number(batch.readBigInt64BE(0)) + batch.readInt32BE(23) >= offset));
              return p.int32(partition).int16(error).int64(log.logEnd).int64(log.logEnd).int64(log.logStart).array([] as number[], (a, id) => a.int32(id)).bytes(data);
            }),
          )
          .build();
      }
      default:
        throw new Error(`the fake broker does not answer API ${key}`);
    }
  }
}

describe('the range assignor', () => {
  test('splits each topic among the members subscribed to it in ranges, by member id, the first ones taking the remainder', () => {
    const assigned = assignRanges(
      [{ memberId: 'm-b', topics: ['t'] }, { memberId: 'm-c', topics: ['t', 'u'] }, { memberId: 'm-a', topics: ['t'] }],
      new Map([['t', [4, 0, 3, 1, 2]], ['u', [1, 0]]]),
    );
    assert.deepEqual(assigned.get('m-a'), new Map([['t', [0, 1]]]));
    assert.deepEqual(assigned.get('m-b'), new Map([['t', [2, 3]]]));
    assert.deepEqual(assigned.get('m-c'), new Map([['t', [4]], ['u', [0, 1]]]));
  });

  test('a member past the partitions gets an empty assignment, and a topic the cluster does not have none', () => {
    const assigned = assignRanges(
      [{ memberId: 'a', topics: ['t'] }, { memberId: 'b', topics: ['t'] }, { memberId: 'c', topics: ['missing'] }],
      new Map([['t', [0]]]),
    );
    assert.deepEqual([...assigned], [['a', new Map([['t', [0]]])], ['b', new Map()], ['c', new Map()]]);
  });
});

describe('the Kafka consumer, against a fake broker', () => {
  let broker: FakeBroker;
  let sources: PullSource[] = [];
  let warnings: string[] = [];
  let infos: string[] = [];
  const logger: Logger = { ...nullLogger, warn: (message) => warnings.push(message), info: (message) => infos.push(message), child: () => logger };

  afterEach(async () => {
    for (const source of sources) await source.close();
    sources = [];
    await broker?.stop();
    warnings = [];
    infos = [];
  });

  async function open(
    config: Record<string, unknown> = {},
    allowed?: string[],
    options: { secret?: string; clock?: Clock; signal?: AbortSignal; metadataRefreshMs?: number } = {},
  ): Promise<PullSource> {
    const brokers = [`127.0.0.1:${broker.port}`];
    const factory = kafkaSourceFactory({
      clock: options.clock ?? systemClock,
      allowedBrokers: allowed ?? brokers,
      logger,
      maxWaitMs: 50,
      heartbeatMs: 10,
      ...(options.metadataRefreshMs !== undefined ? { metadataRefreshMs: options.metadataRefreshMs } : {}),
    });
    const connector = {
      id: 'cn_kafka',
      type: 'kafka',
      name: 'orders',
      secretCredentialId: 'cr_kafka',
      config: { brokers, topic: 'orders', groupId: 'g', startFrom: 'earliest', ...config },
    } as unknown as Connector;
    const source = await factory.open(connector, options.secret, options.signal ?? new AbortController().signal);
    sources.push(source);
    return source;
  }

  async function until(what: string, done: () => boolean): Promise<void> {
    for (let round = 0; !done(); round++) {
      if (round > 1_000) assert.fail(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  const settled = (members: number) => () => broker.state === 'Stable' && broker.members.size === members;

  async function drain(from: PullSource, limit = 100): Promise<string[]> {
    const values: string[] = [];
    for (let round = 0; round < 20; round++) {
      const batch = await from.receive(limit, new AbortController().signal);
      values.push(...batch.messages.map((message) => message.body?.toString() ?? '<tombstone>'));
      await batch.ack();
      if (batch.messages.length === 0 && round > 2) break;
    }
    return values;
  }

  test('reads every partition from the committed position and commits only what it handed out', async () => {
    broker = new FakeBroker(2);
    await broker.start();
    broker.append(0, ['p0-a', 'p0-b', 'p0-c']);
    broker.append(1, ['p1-a']);
    broker.committed.set(0, 1);
    const consumer = await open();

    const first = await consumer.receive(1, new AbortController().signal);
    assert.equal(first.messages.length, 1);
    await first.ack();
    const [, handedPartition, handedOffset] = first.messages[0]!.transportId.split('/').map(Number);
    assert.deepEqual(
      [...broker.committed].sort(),
      handedPartition === 0 ? [[0, handedOffset! + 1], [1, 0]] : [[0, 1], [1, handedOffset! + 1]],
      'the commit covers the one record handed out, not everything fetched',
    );
    const rest = await drain(consumer);
    assert.deepEqual([first.messages[0]!.body!.toString(), ...rest].sort(), ['p0-b', 'p0-c', 'p1-a']);
    assert.deepEqual([...broker.committed].sort(), [[0, 3], [1, 1]]);
    assert.equal(first.messages[0]!.key, first.messages[0]!.body!.toString().startsWith('p0') ? 'k0' : 'k1');
    assert.match(first.messages[0]!.transportId, /^orders\/[01]\/\d+\/1000$/);
  });

  test('a batch handed out but not acknowledged is read again by the next consumer', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.append(0, ['one', 'two']);
    const consumer = await open();
    const batch = await consumer.receive(10, new AbortController().signal);
    assert.equal(batch.messages.length, 2);
    await consumer.close();

    const again = await open();
    assert.deepEqual(await drain(again), ['one', 'two']);
  });

  test('a record fetched but not yet handed out is read again by the next consumer', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.append(0, ['one', 'two', 'three']);
    const consumer = await open();
    const batch = await consumer.receive(1, new AbortController().signal);
    assert.deepEqual(batch.messages.map((m) => m.body?.toString()), ['one']);
    await batch.ack();
    await consumer.close();

    const again = await open();
    assert.deepEqual(await drain(again), ['two', 'three']);
  });

  test('a group starting from latest commits that position at once, so a restart does not skip what arrives in between', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.append(0, ['history']);
    const first = await open({ startFrom: 'latest' });
    assert.deepEqual([...broker.committed], [[0, 1]], 'the starting position is committed before any message');
    await first.close();
    broker.append(0, ['arrived while down']);
    const second = await open({ startFrom: 'latest' });
    assert.deepEqual(await drain(second), ['arrived while down']);
  });

  test('a position that fell off the log resumes from the oldest retained message, and says so', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.append(0, ['gone', 'gone too', 'kept']);
    broker.partitions.get(0)!.logStart = 2;
    broker.committed.set(0, 0);
    const consumer = await open();
    assert.deepEqual(await drain(consumer), ['kept']);
    assert.ok(warnings.some((message) => /fell off the log/.test(message)), warnings.join('\n'));
  });

  test('renews a SASL session the broker is about to expire, between reads, so no read fails over it', async () => {
    broker = new FakeBroker(1);
    broker.sessionLifetimeMs = 60_000;
    await broker.start();
    broker.append(0, ['before']);
    const clock = new TestClock(1_700_000_000_000);
    const consumer = await open({ sasl: { mechanism: 'plain', username: 'reader', allowCleartextPassword: true } }, undefined, { secret: 'pw', clock });
    assert.deepEqual(await drain(consumer), ['before']);
    const logins = broker.authentications;

    // Past the renewal mark, short of the lifetime; the broker now treats those sessions as over.
    await clock.advance(50_000);
    broker.expireSessions();
    broker.append(0, ['after']);
    assert.deepEqual(await drain(consumer), ['after']);
    assert.ok(broker.authentications > logins, 'it logged in afresh instead of reusing an expired session');
  });

  test('a session that does not expire is never renewed', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.append(0, ['one']);
    const clock = new TestClock(1_700_000_000_000);
    const consumer = await open({ sasl: { mechanism: 'plain', username: 'reader', allowCleartextPassword: true } }, undefined, { secret: 'pw', clock });
    await drain(consumer);
    const logins = broker.authentications;
    await clock.advance(24 * 60 * 60_000);
    broker.append(0, ['two']);
    assert.deepEqual(await drain(consumer), ['two']);
    assert.equal(broker.authentications, logins);
  });

  test('a connection the broker dropped while idle is replaced on its next use', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.append(0, ['one']);
    const consumer = await open();
    const batch = await consumer.receive(10, new AbortController().signal);
    // An idle timeout on the broker's side closes the coordinator's connection between commits.
    broker.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await batch.ack();
    assert.deepEqual([...broker.committed], [[0, 1]]);
    broker.append(0, ['two']);
    assert.deepEqual(await drain(consumer), ['two']);
  });

  test('a partition the group has no position for, in a group that has one elsewhere, is read from its beginning', async () => {
    // Added while no consumer ran, or before a running one re-read the topic; a
    // fresh consumer resolving "latest" for it committed past what it never read.
    broker = new FakeBroker(2);
    await broker.start();
    broker.append(0, ['read long ago']);
    broker.committed.set(0, 1);
    broker.append(1, ['in the new partition', 'and another']);
    const consumer = await open({ startFrom: 'latest' });
    assert.deepEqual((await drain(consumer)).sort(), ['and another', 'in the new partition']);
  });

  test('records are decoded as they are handed out, not a whole fetch at once', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    // One good record, then one whose length runs past the batch.
    broker.appendBatch(0, { codec: 'gzip', records: [{ key: 'k', value: 'first' }], trailing: Buffer.from([0x64, 0x00, 0x00]) }, 2);
    const consumer = await open();
    const first = await consumer.receive(1, new AbortController().signal);
    assert.deepEqual(first.messages.map((message) => message.body?.toString()), ['first'], 'the broken record has not been read yet');
    await first.ack();
    await assert.rejects(consumer.receive(1, new AbortController().signal), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'KAFKA_PROTOCOL_ERROR');
      assert.match(error.message, /^Partition 0 of orders: truncated/);
      return true;
    });
    assert.deepEqual([...broker.committed], [[0, 1]], 'what was handed out stays committed; the broken record is read again next time');
  });

  test('a fetch whose batches end before the position asked for fails instead of repeating forever', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.serveAlways(0, encodeBatch({ baseOffset: 0, records: [], lastOffsetDelta: -1 }));
    const consumer = await open();
    await assert.rejects(consumer.receive(10, new AbortController().signal), /end before it, so the position cannot advance/);
  });

  test('a topic listed with no partitions is refused rather than read as empty forever', async () => {
    broker = new FakeBroker(0);
    await broker.start();
    await assert.rejects(open(), (error: unknown) => MaError.is(error) && error.code === 'KAFKA_UNAVAILABLE' && /with no partitions/.test(error.message));
  });

  test('a partition that moved leader fails the consumer as retryable, for a fresh one to re-read leaders', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.append(0, ['x']);
    const consumer = await open();
    broker.inject('Fetch', 6);
    await assert.rejects(consumer.receive(10, new AbortController().signal), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'KAFKA_UNAVAILABLE');
      assert.match(error.message, /NOT_LEADER_OR_FOLLOWER; re-reading leaders/);
      return true;
    });
  });

  describe('as a member of its group', () => {
    test("joins with an assignor of its own and a subscription Kafka's tools can read, and commits as its generation's member", async () => {
      broker = new FakeBroker(2);
      await broker.start();
      broker.append(0, ['a']);
      broker.append(1, ['b']);
      const consumer = await open();
      const [member] = [...broker.members.values()];
      assert.deepEqual(member!.protocols, ['managed-agent']);
      assert.deepEqual(decodeSubscription(member!.metadata), ['orders']);
      assert.deepEqual((await drain(consumer)).sort(), ['a', 'b']);
      assert.ok(broker.committers.length > 0);
      assert.deepEqual(new Set(broker.committers.map(({ generation, memberId }) => `${generation}/${memberId}`)), new Set([`${broker.generation}/${member!.id}`]));
    });

    test('connectors on one group split its partitions, and each record reaches one of them', async () => {
      broker = new FakeBroker(4);
      await broker.start();
      for (const partition of [0, 1, 2, 3]) broker.append(partition, [`p${partition}`]);
      const first = await open();
      const second = await open();
      await until('the group to settle with both', settled(2));
      assert.deepEqual((await drain(first)).sort(), ['p0', 'p1'], 'the first member by id takes the first range');
      assert.deepEqual((await drain(second)).sort(), ['p2', 'p3']);
    });

    test('a member that closes leaves the group, and the others take its partitions at once', async () => {
      broker = new FakeBroker(2);
      await broker.start();
      const first = await open();
      const second = await open();
      await until('the group to settle with both', settled(2));
      const leaving = [...broker.members.keys()].find((id) => id !== broker.leader)!;
      await second.close();
      assert.deepEqual(broker.leaves, [leaving]);
      await until('the group to settle with one', settled(1));
      broker.append(0, ['p0 after']);
      broker.append(1, ['p1 after']);
      assert.deepEqual((await drain(first)).sort(), ['p0 after', 'p1 after']);
    });

    test('a batch handed out as the group starts to rebalance is committed in its generation first, so no one reads it again', async () => {
      broker = new FakeBroker(2);
      await broker.start();
      broker.append(0, ['x', 'y']);
      broker.append(1, ['z']);
      const first = await open();
      const batch = await first.receive(10, new AbortController().signal);
      assert.equal(batch.messages.length, 3);
      const joining = open();
      await until('the rebalance to begin', () => broker.state === 'PreparingRebalance');
      // Long enough for the first member's heartbeat to hear of it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await batch.ack();
      const second = await joining;
      await until('the group to settle with both', settled(2));
      assert.deepEqual([...broker.committed].sort(), [[0, 2], [1, 1]]);
      assert.deepEqual([...(await drain(first)), ...(await drain(second))], []);
    });

    test('records fetched but not handed out are dropped at a rebalance, for whoever is assigned them to read', async () => {
      broker = new FakeBroker(2);
      await broker.start();
      broker.append(0, ['p0-a']);
      broker.append(1, ['p1-a', 'p1-b']);
      const first = await open();
      const one = await first.receive(1, new AbortController().signal);
      await one.ack();
      const second = await open();
      await until('the group to settle with both', settled(2));
      const read = [...one.messages.map((message) => message.body!.toString()), ...(await drain(first)), ...(await drain(second))];
      assert.deepEqual(read.sort(), ['p0-a', 'p1-a', 'p1-b']);
    });

    test('a fetch the group rebalanced under is dropped on arrival, not handed out', async () => {
      broker = new FakeBroker(2);
      await broker.start();
      broker.append(0, ['p0']);
      broker.append(1, ['p1']);
      const first = await open();
      const memberId = [...broker.members.keys()][0]!;
      const release = broker.hold('Fetch');
      const reading = first.receive(10, new AbortController().signal);
      await until('the fetch to be asked', () => broker.fetchOrder.length > 0);
      // A member that never rejoins holds the rebalance open.
      const quiet = broker.addMember('managed-agent');
      await until('the first member to rejoin', () => broker.members.get(memberId)?.join !== undefined);
      release();
      assert.deepEqual((await reading).messages, []);
      broker.expire(quiet);
      await until('the group to settle with one', settled(1));
      assert.deepEqual((await drain(first)).sort(), ['p0', 'p1']);
    });

    test('a member the group dropped commits nothing it handed out, and the next owner reads it again', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      broker.append(0, ['once']);
      const first = await open();
      const dropped = [...broker.members.keys()][0]!;
      const batch = await first.receive(10, new AbortController().signal);
      assert.deepEqual(batch.messages.map((message) => message.body!.toString()), ['once']);
      broker.expire(dropped);
      const second = await open();
      await batch.ack();
      assert.ok(!broker.committers.some(({ memberId }, index) => memberId === dropped && broker.commits[index]!.get(0) === 1), 'not committed');
      assert.ok(infos.some((message) => /were not committed/.test(message)), infos.join('\n'));
      assert.deepEqual(await drain(second), ['once']);
      await until('the dropped member to rejoin without reading again', settled(2));
    });

    test('a commit turned away for a stale generation is not an error: the member rejoins, and the record is read again', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      broker.append(0, ['again']);
      const consumer = await open();
      const generation = broker.generation;
      const batch = await consumer.receive(10, new AbortController().signal);
      broker.inject('OffsetCommit', 22);
      await batch.ack();
      assert.deepEqual(await drain(consumer), ['again']);
      assert.ok(broker.generation > generation, 'it rejoined');
    });

    test('a member the coordinator forgot joins again as a new one', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      const consumer = await open();
      const forgotten = [...broker.members.keys()][0]!;
      broker.expire(forgotten);
      await until('a new member', () => settled(1)() && !broker.members.has(forgotten));
      broker.append(0, ['after']);
      assert.deepEqual(await drain(consumer), ['after']);
    });

    test('partitions added to the topic are assigned at a rebalance and read from their beginning', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      broker.append(0, ['history']);
      const consumer = await open({ startFrom: 'latest' }, undefined, { metadataRefreshMs: 0 });
      assert.deepEqual(await drain(consumer), []);
      const generation = broker.generation;
      broker.partitions.set(1, { batches: [], logStart: 0, logEnd: 0 });
      broker.append(1, ['in the new partition']);
      assert.deepEqual(await drain(consumer), ['in the new partition']);
      assert.ok(broker.generation > generation, 'the group rebalanced');
    });

    test('a group whose members chose another assignor is refused, with the fix, and keeps its partitions', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      broker.addMember('range');
      await assert.rejects(open(), (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'KAFKA_GROUP_IN_USE');
        assert.match(error.message, /other than this platform's connectors.*groupId of its own/);
        return true;
      });
      assert.deepEqual([...broker.members.keys()], ['range-1']);
    });

    test('closing while the group waits on a quiet member leaves at once, over a connection of its own', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      const consumer = await open();
      const memberId = [...broker.members.keys()][0]!;
      const quiet = broker.addMember('managed-agent');
      await until('the member to rejoin', () => broker.members.get(memberId)?.join !== undefined);
      const started = performance.now();
      await consumer.close();
      assert.ok(performance.now() - started < 2_000, 'not held behind the JoinGroup the coordinator holds');
      assert.deepEqual(broker.leaves, [memberId]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual([...broker.members.keys()], [quiet], 'and it did not join again on its way out');
    });

    test('closing with a batch not yet acknowledged does not wait on it', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      broker.append(0, ['held']);
      const consumer = await open();
      const memberId = [...broker.members.keys()][0]!;
      await consumer.receive(10, new AbortController().signal);
      broker.addMember('managed-agent');
      await new Promise((resolve) => setTimeout(resolve, 50));
      await consumer.close();
      assert.deepEqual(broker.leaves, [memberId]);
    });

    test('a batch acknowledged after this member moved on to a new generation is not committed, and starts no rebalance', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      broker.append(0, ['first', 'second']);
      const consumer = await open();
      const stale = await consumer.receive(1, new AbortController().signal);
      broker.addMember('managed-agent');
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Reading again gives the first batch up, so the rejoin goes ahead without it.
      const reading = consumer.receive(10, new AbortController().signal);
      await until('the member to rejoin', () => [...broker.members.values()].some((member) => member.join));
      broker.expire([...broker.members.keys()].find((id) => id.startsWith('managed-agent'))!);
      const current = await reading;
      assert.deepEqual(current.messages.map((message) => message.body!.toString()), ['first', 'second']);
      await current.ack();
      const generation = broker.generation;
      await stale.ack();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(broker.generation, generation, 'no rejoin over it');
      assert.deepEqual([...broker.committed], [[0, 2]], 'the position the current generation committed stands');
      assert.ok(infos.some((message) => /were not committed/.test(message)), infos.join('\n'));
    });

    test('a rejoin a read asked for goes ahead while nothing reads', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      const consumer = await open({}, undefined, { metadataRefreshMs: 0 });
      const generation = broker.generation;
      broker.partitions.set(1, { batches: [], logStart: 0, logEnd: 0 });
      // This read sees the new partition and asks for a rejoin; nothing reads after it.
      await (await consumer.receive(10, new AbortController().signal)).ack();
      await until('the rejoin, with no read to start it', () => broker.generation > generation && settled(1)());
    });

    test('a fetch answered after a rebalance began adds nothing past a position it had to look up', async () => {
      broker = new FakeBroker(2);
      await broker.start();
      broker.append(0, ['gone', 'kept']);
      broker.partitions.get(0)!.logStart = 1;
      broker.committed.set(0, 0);
      broker.append(1, ['p1']);
      const first = await open();
      const release = broker.hold('ListOffsets');
      const reading = first.receive(10, new AbortController().signal);
      await until('the lookup of the oldest retained offset', () => broker.fetchOrder.length > 0);
      const second = await open();
      await until('the group to settle with both', settled(2));
      release();
      const read = [...(await reading).messages.map((message) => message.body!.toString()), ...(await drain(first)), ...(await drain(second))];
      assert.deepEqual(read.sort(), ['kept', 'p1'], 'each record once');
    });

    test('nothing is fetched while the group rebalances', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      broker.append(0, ['p0']);
      const consumer = await open({}, undefined, { metadataRefreshMs: 0 });
      const release = broker.hold('Metadata');
      const reading = consumer.receive(10, new AbortController().signal);
      const quiet = broker.addMember('managed-agent');
      await until('the member to rejoin', () => [...broker.members.values()].some((member) => member.join));
      const fetches = broker.fetchOrder.length;
      release();
      assert.deepEqual((await reading).messages, []);
      assert.equal(broker.fetchOrder.length, fetches);
      broker.expire(quiet);
      assert.deepEqual(await drain(consumer), ['p0']);
    });

    test('a member assigned nothing but a partition added since reads it from its beginning, though the group starts from latest', async () => {
      broker = new FakeBroker(2);
      await broker.start();
      const first = await open({ startFrom: 'latest' });
      const second = await open({ startFrom: 'latest' });
      await until('the group to settle with both', settled(2));
      broker.partitions.set(2, { batches: [], logStart: 0, logEnd: 0 });
      broker.append(2, ['in the new partition']);
      // A rebalance for another reason: the leader assigns from the topic as it is
      // now, and the other member learns of the partition from its assignment.
      const generation = broker.generation;
      broker.inject('Heartbeat', 27);
      await until('the rebalance', () => broker.generation > generation && settled(2)());
      const read = [...(await drain(first)), ...(await drain(second))];
      assert.deepEqual(read, ['in the new partition']);
      assert.equal(broker.generation, generation + 1, 'one rebalance, not a second for the partition it was handed');
    });

    test('a group that rebalances on every join is given up on after ten tries, as retryable', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      broker.inject('JoinGroup', ...Array.from({ length: 10 }, () => 27));
      await assert.rejects(open(), (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'KAFKA_UNAVAILABLE');
        assert.match(error.message, /rebalanced again on each of 10 attempts/);
        return true;
      });
    });

    test("a session timeout the brokers do not allow, or a full group, is reported with the setting to change", async () => {
      broker = new FakeBroker(1);
      await broker.start();
      broker.inject('JoinGroup', 26, 81);
      await assert.rejects(open(), /group\.min\.session\.timeout\.ms and group\.max\.session\.timeout\.ms must admit it/);
      await assert.rejects(open(), /GROUP_MAX_SIZE_REACHED.*groupId of its own, or raise the brokers' group\.max\.size/);
    });

    test('stopped by its connector, it still leaves the group', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      const stop = new AbortController();
      const consumer = await open({}, undefined, { signal: stop.signal });
      const memberId = [...broker.members.keys()][0]!;
      stop.abort();
      await consumer.close();
      assert.deepEqual(broker.leaves, [memberId]);
    });

    test('a heartbeat the cluster refuses ends the consumer with the reason', async () => {
      broker = new FakeBroker(1);
      await broker.start();
      const consumer = await open();
      broker.inject('Heartbeat', 30);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await assert.rejects(consumer.receive(10, new AbortController().signal), (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'KAFKA_ACCESS_DENIED');
        assert.match(error.message, /GROUP_AUTHORIZATION_FAILED/);
        return true;
      });
    });
  });

  test('a broker the cluster advertises outside MA_KAFKA_BROKERS is not connected to', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.advertisedHost = 'localhost';
    await assert.rejects(open({}, [`127.0.0.1:${broker.port}`]), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'PULL_ENDPOINT_NOT_ALLOWED');
      assert.match(error.message, new RegExp(`localhost:${broker.port} \\((the group's coordinator|advertised by the cluster)\\)`));
      return true;
    });
  });

  test('a broker without a version the consumer speaks is named at connect time', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.versions.set(API.Fetch.key, [12, 17]);
    await assert.rejects(open(), /does not offer Fetch v10/);
  });

  test('a missing topic is reported as such', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.topicError = 3;
    await assert.rejects(open(), (error: unknown) => MaError.is(error) && error.code === 'KAFKA_TOPIC_NOT_FOUND' && /Create it, or fix config\.topic/.test(error.message));
  });

  test('the partition asked for first rotates, so an oversized batch anywhere gets its turn', async () => {
    broker = new FakeBroker(3);
    await broker.start();
    const consumer = await open();
    for (let round = 0; round < 3; round++) await (await consumer.receive(10, new AbortController().signal)).ack();
    assert.deepEqual(broker.fetchOrder.slice(0, 3), [[0, 1, 2], [1, 2, 0], [2, 0, 1]]);
  });
});
