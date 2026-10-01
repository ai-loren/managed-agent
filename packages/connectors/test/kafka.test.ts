/**
 * The Kafka client, offline: wire encoding, record batches, codecs, SCRAM, and
 * the consumer against a fake broker that can be made to fail on cue. The real
 * brokers are in apps/server/test/kafka-pull.docker.test.ts.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { gzipSync, zstdCompressSync } from 'node:zlib';

import { MaError, nullLogger, systemClock, type Logger } from '@ma/core';
import type { Connector } from '@ma/contracts';

import { kafkaSourceFactory, type PullSource } from '../src/index.ts';
import { decompress, lz4, snappy } from '../src/pull/kafka/compression.ts';
import { crc32c } from '../src/pull/kafka/crc32c.ts';
import { API, fetchRequest, offsetCommitRequest } from '../src/pull/kafka/protocol.ts';
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
  let payload = Buffer.concat(records);
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
  const count = batch.control ? 1 : batch.records.length;
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
    const commit = offsetCommitRequest('g', 't', new Map([[2, 7]]));
    assert.equal(
      commit.toString('hex'),
      [
        '0001', '67', // group id
        'ffffffff', // generation -1: a member with an explicit assignment
        '0000', // no member id
        '00000001', '0001', '74', // one topic
        '00000001', '00000002', '0000000000000007', 'ffffffff', 'ffff', // partition 2 at 7, no epoch, no metadata
      ].join(''),
    );
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
      FindCoordinator: 3, SaslHandshake: Infinity, ApiVersions: 3, SaslAuthenticate: 2,
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

  test("reproduces RFC 7677's SCRAM-SHA-256 exchange", () => {
    const client = new ScramClient('sha256', 'user', 'pencil', 'rOprNGfwEbeRWgbNEkqO');
    assert.equal(client.first(), 'n,,n=user,r=rOprNGfwEbeRWgbNEkqO');
    assert.equal(
      client.final(serverFirst),
      'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
    );
    assert.doesNotThrow(() => client.verify('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4='));
  });

  test('escapes the characters SCRAM reserves in a username', () => {
    assert.equal(new ScramClient('sha512', 'a=b,c', 'p', 'nonce').first(), 'n,,n=a=3Db=2Cc,r=nonce');
  });

  test('refuses a server that does not know the password, or tries to cheapen the hash', () => {
    const fresh = (): ScramClient => new ScramClient('sha256', 'user', 'pencil', 'rOprNGfwEbeRWgbNEkqO');
    const answered = fresh();
    answered.final(serverFirst);
    assert.throws(() => answered.verify('v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), ScramError);
    assert.throws(() => answered.verify('e=invalid-proof'), /rejected the login: invalid-proof/);
    assert.throws(() => fresh().final(serverFirst.replace('i=4096', 'i=1000')), /1000 iterations/);
    assert.throws(() => fresh().final(serverFirst.replace('r=rOprNGfwEbeRWgbNEkqO%', 'r=someoneelse%')), /did not extend the client nonce/);
    assert.throws(() => fresh().final('r=rOprNGfwEbeRWgbNEkqO,s=W22Z,i=4096'), /did not extend/);
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

/**
 * Just enough of a broker: one node that leads every partition and coordinates
 * every group, with `inject` to make the next answer to an API fail.
 */
class FakeBroker {
  readonly partitions = new Map<number, FakePartition>();
  readonly committed = new Map<number, number>();
  readonly commits: Map<number, number>[] = [];
  /** The partitions of each Fetch, in the order the request named them. */
  readonly fetchOrder: number[][] = [];
  advertisedHost = '127.0.0.1';
  versions = new Map<number, [number, number]>(Object.values(API).map(({ key, version }) => [key, [0, version + 2]]));
  topicError = 0;
  readonly #inject = new Map<string, number[]>();
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
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

  /** Make the next answers to `api` carry these error codes, one per answer. */
  inject(api: string, ...codes: number[]): void {
    this.#inject.set(api, [...(this.#inject.get(api) ?? []), ...codes]);
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
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readInt32BE(0)) {
        const frame = buffered.subarray(4, 4 + buffered.readInt32BE(0));
        buffered = buffered.subarray(4 + frame.length);
        const reader = new Reader(frame);
        const key = reader.int16();
        reader.int16();
        const correlation = reader.int32();
        reader.nullableString();
        const body = this.#answer(key, reader);
        const out = Buffer.alloc(8);
        out.writeInt32BE(4 + body.length, 0);
        out.writeInt32BE(correlation, 4);
        socket.write(Buffer.concat([out, body]));
      }
    });
  }

  #answer(key: number, reader: Reader): Buffer {
    const w = new Writer();
    switch (key) {
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
        reader.int32();
        reader.string();
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
        const code = this.#take('OffsetCommit');
        if (code === 0) {
          this.commits.push(offsets);
          for (const [partition, offset] of offsets) this.committed.set(partition, offset);
        }
        return w.int32(0).array(['orders'], (x, name) => x.string(name).array([...offsets.keys()], (p, partition) => p.int32(partition).int16(code))).build();
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
              const data = error ? Buffer.alloc(0) : Buffer.concat(log.batches.filter((batch) => Number(batch.readBigInt64BE(0)) + batch.readInt32BE(23) >= offset));
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

describe('the Kafka consumer, against a fake broker', () => {
  let broker: FakeBroker;
  let source: PullSource | undefined;
  let warnings: string[] = [];
  const logger: Logger = { ...nullLogger, warn: (message) => warnings.push(message), child: () => logger };

  afterEach(async () => {
    await source?.close();
    source = undefined;
    await broker?.stop();
    warnings = [];
  });

  async function open(config: Record<string, unknown> = {}, allowed?: string[]): Promise<PullSource> {
    const brokers = [`127.0.0.1:${broker.port}`];
    const factory = kafkaSourceFactory({ clock: systemClock, allowedBrokers: allowed ?? brokers, logger, maxWaitMs: 50 });
    const connector = {
      id: 'cn_kafka',
      type: 'kafka',
      name: 'orders',
      config: { brokers, topic: 'orders', groupId: 'g', startFrom: 'earliest', ...config },
    } as unknown as Connector;
    source = await factory.open(connector, undefined, new AbortController().signal);
    return source;
  }

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

  test('a group owned by protocol-managed members is reported, with the fix', async () => {
    broker = new FakeBroker(1);
    await broker.start();
    broker.append(0, ['x']);
    const consumer = await open();
    const batch = await consumer.receive(10, new AbortController().signal);
    broker.inject('OffsetCommit', 22);
    await assert.rejects(batch.ack(), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'KAFKA_GROUP_IN_USE');
      assert.match(error.message, /groupId of its own/);
      return true;
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
