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
  JoinGroup: { key: 11, version: 3 },
  Heartbeat: { key: 12, version: 2 },
  LeaveGroup: { key: 13, version: 2 },
  SyncGroup: { key: 14, version: 2 },
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
  23: 'INCONSISTENT_GROUP_PROTOCOL',
  24: 'INVALID_GROUP_ID',
  25: 'UNKNOWN_MEMBER_ID',
  26: 'INVALID_SESSION_TIMEOUT',
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
  81: 'GROUP_MAX_SIZE_REACHED',
  110: 'FENCED_MEMBER_EPOCH',
  113: 'STALE_MEMBER_EPOCH',
};

export function errorName(code: number): string {
  return ERRORS[code] ?? `error ${code}`;
}

/** Partition errors that mean "ask for metadata again", not "something is wrong". */
export const RETRIABLE_PARTITION_ERRORS = new Set([3, 5, 6, 7, 74, 75]);
export const COORDINATOR_ERRORS = new Set([14, 15, 16]);
/** This member's generation is over: the group rebalanced without it, or is rebalancing. */
export const REJOIN_ERRORS = new Set([22, 25, 27, 110, 113]);
export const UNKNOWN_MEMBER_ID = 25;
export const INCONSISTENT_GROUP_PROTOCOL = 23;

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

export function saslAuthenticateResponse(
  reader: Reader,
): { errorCode: number; errorMessage: string | null; bytes: Buffer; sessionLifetimeMs: number } {
  const errorCode = reader.int16();
  const errorMessage = reader.nullableString();
  const bytes = reader.nullableBytes() ?? Buffer.alloc(0);
  // Non-zero when the broker expires sessions (connections.max.reauth.ms): past
  // it, the next request on the connection makes the broker close it.
  const sessionLifetimeMs = reader.remaining >= 8 ? reader.long() : 0;
  return { errorCode, errorMessage, bytes, sessionLifetimeMs };
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

export function metadataRequest(topics: readonly string[]): Buffer {
  return new Writer().array(topics, (w, name) => w.string(name)).boolean(false).build();
}

export function metadataResponse(reader: Reader): { brokers: BrokerInfo[]; topics: Map<string, TopicMetadata> } {
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
  return { brokers, topics: new Map(topics.map(({ name, ...topic }) => [name, topic])) };
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
 * Commit as the member of `generation` that `memberId` names. A broker turns away
 * a member whose generation is over, so a commit cannot land on positions that a
 * rebalance has handed to someone else.
 */
export function offsetCommitRequest(
  groupId: string,
  topic: string,
  offsets: ReadonlyMap<number, number>,
  generation: number,
  memberId: string,
): Buffer {
  return new Writer()
    .string(groupId)
    .int32(generation)
    .string(memberId)
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

// --- Group membership --------------------------------------------------------

export interface JoinedGroup {
  errorCode: number;
  generation: number;
  protocol: string;
  leader: string;
  memberId: string;
  /** Every member's subscription, for the leader to assign; empty for the others. */
  members: { memberId: string; metadata: Buffer }[];
}

export function joinGroupRequest(
  groupId: string,
  sessionTimeoutMs: number,
  rebalanceTimeoutMs: number,
  memberId: string,
  protocols: readonly { name: string; metadata: Buffer }[],
): Buffer {
  return new Writer()
    .string(groupId)
    .int32(sessionTimeoutMs)
    .int32(rebalanceTimeoutMs)
    .string(memberId)
    .string('consumer')
    .array(protocols, (w, { name, metadata }) => w.string(name).bytes(metadata))
    .build();
}

export function joinGroupResponse(reader: Reader): JoinedGroup {
  reader.int32();
  const errorCode = reader.int16();
  const generation = reader.int32();
  const protocol = reader.string();
  const leader = reader.string();
  const memberId = reader.string();
  const members = reader.array((r) => ({ memberId: r.string(), metadata: r.nullableBytes() ?? Buffer.alloc(0) }));
  return { errorCode, generation, protocol, leader, memberId, members };
}

export function syncGroupRequest(
  groupId: string,
  generation: number,
  memberId: string,
  assignments: readonly { memberId: string; assignment: Buffer }[],
): Buffer {
  return new Writer()
    .string(groupId)
    .int32(generation)
    .string(memberId)
    .array(assignments, (w, entry) => w.string(entry.memberId).bytes(entry.assignment))
    .build();
}

export function syncGroupResponse(reader: Reader): { errorCode: number; assignment: Buffer } {
  reader.int32();
  return { errorCode: reader.int16(), assignment: reader.nullableBytes() ?? Buffer.alloc(0) };
}

export function heartbeatRequest(groupId: string, generation: number, memberId: string): Buffer {
  return new Writer().string(groupId).int32(generation).string(memberId).build();
}

export function leaveGroupRequest(groupId: string, memberId: string): Buffer {
  return new Writer().string(groupId).string(memberId).build();
}

/** Heartbeat and LeaveGroup answer with nothing but an error code. */
export function errorCodeResponse(reader: Reader): number {
  reader.int32();
  return reader.int16();
}

/** A member's subscription as the Java consumer encodes it (version 0), so Kafka's tools can read it. */
export function encodeSubscription(topics: readonly string[]): Buffer {
  return new Writer().int16(0).array(topics, (w, topic) => w.string(topic)).nullableBytes(null).build();
}

/** The topics a member subscribes to; later versions only append fields. */
export function decodeSubscription(metadata: Buffer): string[] {
  const reader = new Reader(metadata);
  reader.int16();
  return reader.array((r) => r.string());
}

export function encodeAssignment(partitions: ReadonlyMap<string, readonly number[]>): Buffer {
  return new Writer()
    .int16(0)
    .array([...partitions], (w, [topic, assigned]) => w.string(topic).array(assigned, (pw, partition) => pw.int32(partition)))
    .nullableBytes(null)
    .build();
}

export function decodeAssignment(assignment: Buffer): Map<string, number[]> {
  // A member left out of the assignment gets no bytes at all.
  if (assignment.length === 0) return new Map();
  const reader = new Reader(assignment);
  reader.int16();
  return new Map(reader.array((r) => [r.string(), r.array((p) => p.int32())] as const));
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
