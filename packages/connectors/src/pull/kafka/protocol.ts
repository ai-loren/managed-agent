/**
 * The Kafka requests the consumer sends, and their responses.
 *
 * One version of each: the ones the Kafka 2.1 Java client sent. Kafka 4.0
 * dropped every version older than that baseline and kept the rest, so these
 * work from 2.1 through 4.x, and all of them predate tagged fields — the
 * encodings stay the simple fixed ones. A broker that does not offer one is
 * reported by name at connect time rather than failing mid-conversation.
 */

import { Reader, Writer } from './wire.ts';
import type { AbortedTransaction } from './records.ts';

export const API = {
  Fetch: { key: 1, version: 10 },
  ListOffsets: { key: 2, version: 4 },
  Metadata: { key: 3, version: 7 },
  OffsetCommit: { key: 8, version: 6 },
  OffsetFetch: { key: 9, version: 5 },
  FindCoordinator: { key: 10, version: 2 },
  SaslHandshake: { key: 17, version: 1 },
  ApiVersions: { key: 18, version: 2 },
  SaslAuthenticate: { key: 36, version: 1 },
} as const;

export type ApiName = keyof typeof API;

/** Error codes the consumer acts on, with Kafka's names for messages. */
export const ERRORS: Readonly<Record<number, string>> = {
  [-1]: 'UNKNOWN_SERVER_ERROR',
  1: 'OFFSET_OUT_OF_RANGE',
  2: 'CORRUPT_MESSAGE',
  3: 'UNKNOWN_TOPIC_OR_PARTITION',
  5: 'LEADER_NOT_AVAILABLE',
  6: 'NOT_LEADER_OR_FOLLOWER',
  7: 'REQUEST_TIMED_OUT',
  14: 'COORDINATOR_LOAD_IN_PROGRESS',
  15: 'COORDINATOR_NOT_AVAILABLE',
  16: 'NOT_COORDINATOR',
  22: 'ILLEGAL_GENERATION',
  24: 'INVALID_GROUP_ID',
  25: 'UNKNOWN_MEMBER_ID',
  27: 'REBALANCE_IN_PROGRESS',
  29: 'TOPIC_AUTHORIZATION_FAILED',
  30: 'GROUP_AUTHORIZATION_FAILED',
  33: 'UNSUPPORTED_SASL_MECHANISM',
  34: 'ILLEGAL_SASL_STATE',
  35: 'UNSUPPORTED_VERSION',
  58: 'SASL_AUTHENTICATION_FAILED',
  74: 'FENCED_LEADER_EPOCH',
  75: 'UNKNOWN_LEADER_EPOCH',
  76: 'UNSUPPORTED_COMPRESSION_TYPE',
  110: 'FENCED_MEMBER_EPOCH',
  113: 'STALE_MEMBER_EPOCH',
};

export function errorName(code: number): string {
  return ERRORS[code] ?? `error ${code}`;
}

/** Partition errors that mean "ask for metadata again", not "something is wrong". */
export const RETRIABLE_PARTITION_ERRORS = new Set([3, 5, 6, 7, 74, 75]);
export const COORDINATOR_ERRORS = new Set([14, 15, 16]);
/** The group has members managed by the group protocol, which own its commits. */
export const GROUP_IN_USE_ERRORS = new Set([22, 25, 27, 110, 113]);

// --- ApiVersions -------------------------------------------------------------

export function apiVersionsRequest(): Buffer {
  return Buffer.alloc(0);
}

export function apiVersionsResponse(reader: Reader): { errorCode: number; versions: Map<number, [number, number]> } {
  const errorCode = reader.int16();
  const versions = new Map<number, [number, number]>();
  for (const [key, min, max] of reader.array((r) => [r.int16(), r.int16(), r.int16()] as const)) {
    versions.set(key, [min, max]);
  }
  return { errorCode, versions };
}

// --- SASL --------------------------------------------------------------------

export function saslHandshakeRequest(mechanism: string): Buffer {
  return new Writer().string(mechanism).build();
}

export function saslHandshakeResponse(reader: Reader): { errorCode: number; mechanisms: string[] } {
  return { errorCode: reader.int16(), mechanisms: reader.array((r) => r.string()) };
}

export function saslAuthenticateRequest(bytes: Buffer): Buffer {
  return new Writer().bytes(bytes).build();
}

export function saslAuthenticateResponse(reader: Reader): { errorCode: number; errorMessage: string | null; bytes: Buffer } {
  const errorCode = reader.int16();
  const errorMessage = reader.nullableString();
  const bytes = reader.nullableBytes() ?? Buffer.alloc(0);
  return { errorCode, errorMessage, bytes };
}

// --- Metadata ----------------------------------------------------------------

export interface BrokerInfo {
  nodeId: number;
  host: string;
  port: number;
}

export interface TopicMetadata {
  errorCode: number;
  partitions: { errorCode: number; partition: number; leader: number }[];
}

export function metadataRequest(topic: string): Buffer {
  return new Writer().array([topic], (w, name) => w.string(name)).boolean(false).build();
}

export function metadataResponse(reader: Reader, topic: string): { brokers: BrokerInfo[]; topic: TopicMetadata | undefined } {
  reader.int32();
  const brokers = reader.array((r) => {
    const nodeId = r.int32();
    const host = r.string();
    const port = r.int32();
    r.nullableString();
    return { nodeId, host, port };
  });
  reader.nullableString();
  reader.int32();
  const topics = reader.array((r) => {
    const errorCode = r.int16();
    const name = r.string();
    r.boolean();
    const partitions = r.array((p) => {
      const partitionError = p.int16();
      const partition = p.int32();
      const leader = p.int32();
      p.int32();
      p.array((n) => n.int32());
      p.array((n) => n.int32());
      p.array((n) => n.int32());
      return { errorCode: partitionError, partition, leader };
    });
    return { name, errorCode, partitions };
  });
  return { brokers, topic: topics.find((entry) => entry.name === topic) };
}

// --- FindCoordinator ---------------------------------------------------------

export function findCoordinatorRequest(groupId: string): Buffer {
  return new Writer().string(groupId).int8(0).build();
}

export function findCoordinatorResponse(reader: Reader): { errorCode: number; errorMessage: string | null; broker: BrokerInfo } {
  reader.int32();
  const errorCode = reader.int16();
  const errorMessage = reader.nullableString();
  const nodeId = reader.int32();
  const host = reader.string();
  const port = reader.int32();
  return { errorCode, errorMessage, broker: { nodeId, host, port } };
}

// --- OffsetFetch / OffsetCommit -----------------------------------------------

export function offsetFetchRequest(groupId: string, topic: string, partitions: readonly number[]): Buffer {
  return new Writer()
    .string(groupId)
    .array([topic], (w, name) => w.string(name).array(partitions, (pw, partition) => pw.int32(partition)))
    .build();
}

export function offsetFetchResponse(
  reader: Reader,
): { errorCode: number; partitions: { partition: number; offset: number; errorCode: number }[] } {
  reader.int32();
  const partitions = reader
    .array((r) => {
      r.string();
      return r.array((p) => {
        const partition = p.int32();
        const offset = p.long();
        p.int32();
        p.nullableString();
        return { partition, offset, errorCode: p.int16() };
      });
    })
    .flat();
  return { errorCode: reader.int16(), partitions };
}

/**
 * Commit as a consumer with an explicit assignment does: generation -1 and no
 * member id, which a broker accepts for a group with no protocol-managed members.
 */
export function offsetCommitRequest(groupId: string, topic: string, offsets: ReadonlyMap<number, number>): Buffer {
  return new Writer()
    .string(groupId)
    .int32(-1)
    .string('')
    .array([topic], (w, name) =>
      w.string(name).array([...offsets], (pw, [partition, offset]) => pw.int32(partition).int64(offset).int32(-1).nullableString(null)),
    )
    .build();
}

export function offsetCommitResponse(reader: Reader): { partition: number; errorCode: number }[] {
  reader.int32();
  return reader
    .array((r) => {
      r.string();
      return r.array((p) => ({ partition: p.int32(), errorCode: p.int16() }));
    })
    .flat();
}

// --- ListOffsets -------------------------------------------------------------

export const LATEST = -1;
export const EARLIEST = -2;

export function listOffsetsRequest(topic: string, partitions: readonly number[], at: number): Buffer {
  return new Writer()
    .int32(-1)
    .int8(1)
    .array([topic], (w, name) =>
      w.string(name).array(partitions, (pw, partition) => pw.int32(partition).int32(-1).int64(at)),
    )
    .build();
}

export function listOffsetsResponse(reader: Reader): { partition: number; errorCode: number; offset: number }[] {
  reader.int32();
  return reader
    .array((r) => {
      r.string();
      return r.array((p) => {
        const partition = p.int32();
        const errorCode = p.int16();
        p.int64();
        const offset = p.long();
        p.int32();
        return { partition, errorCode, offset };
      });
    })
    .flat();
}

// --- Fetch -------------------------------------------------------------------

export interface FetchPartition {
  partition: number;
  offset: number;
}

export interface FetchedPartition {
  partition: number;
  errorCode: number;
  highWatermark: number;
  aborted: AbortedTransaction[];
  records: Buffer | null;
}

export function fetchRequest(
  topic: string,
  partitions: readonly FetchPartition[],
  maxWaitMs: number,
  limits: { maxBytes: number; partitionMaxBytes: number },
): Buffer {
  return new Writer()
    .int32(-1)
    .int32(maxWaitMs)
    .int32(1)
    .int32(limits.maxBytes)
    .int8(1)
    // No fetch session (id 0, epoch -1): every fetch names its partitions in full.
    .int32(0)
    .int32(-1)
    .array([topic], (w, name) =>
      w.string(name).array(partitions, (pw, { partition, offset }) =>
        pw.int32(partition).int32(-1).int64(offset).int64(-1).int32(limits.partitionMaxBytes),
      ),
    )
    .array([] as string[], (w, name) => w.string(name))
    .build();
}

export function fetchResponse(reader: Reader): { errorCode: number; partitions: FetchedPartition[] } {
  reader.int32();
  const errorCode = reader.int16();
  reader.int32();
  const partitions = reader
    .array((r) => {
      r.string();
      return r.array((p) => {
        const partition = p.int32();
        const partitionError = p.int16();
        const highWatermark = p.long();
        p.int64();
        p.int64();
        const aborted = p.array((a) => ({ producerId: a.int64(), firstOffset: a.long() }));
        const records = p.nullableBytes();
        return { partition, errorCode: partitionError, highWatermark, aborted, records };
      });
    })
    .flat();
  return { errorCode, partitions };
}
