/**
 * The Kafka consumer: one member of a consumer group, reading the partitions of
 * one topic the group assigns it.
 *
 * It joins through the classic group protocol (JoinGroup, SyncGroup, a
 * heartbeat, LeaveGroup on close), so connectors on one group split its
 * partitions and a member that goes away has its share handed to the others.
 * Its assignor has a name of its own: Kafka refuses to put it in a group whose
 * members chose another, so it never quietly takes partitions from someone
 * else's consumers.
 *
 * Positions advance only as far as records have been handed out and
 * acknowledged; anything decoded but not yet taken stays buffered. A rebalance
 * waits for the batch handed out to be acknowledged, so its commit lands in the
 * generation that read it, then drops what is buffered and starts again from the
 * committed positions of the new assignment. A failure anywhere throws the whole
 * consumer away, and its replacement starts again from the committed positions.
 */

import { MaError, type Clock, type Logger } from '@ma/core';
import { kafkaConfigSchema, parseOrThrow, type Connector, type KafkaConfig } from '@ma/contracts';

import { brokerAllowed, brokerNotAllowed, checkKafkaConnector } from '../adapters.ts';
import type { PulledMessage } from '../message.ts';
import type { PullBatch, PullSource, PullSourceFactory } from '../supervisor.ts';
import { assignRanges } from './assign.ts';
import { KafkaConnection, denied, protocolError, unavailable, type SaslSettings } from './connection.ts';
import {
  COORDINATOR_ERRORS,
  EARLIEST,
  INCONSISTENT_GROUP_PROTOCOL,
  LATEST,
  REJOIN_ERRORS,
  RETRIABLE_PARTITION_ERRORS,
  UNKNOWN_MEMBER_ID,
  decodeAssignment,
  decodeSubscription,
  encodeAssignment,
  encodeSubscription,
  errorCodeResponse,
  errorName,
  fetchRequest,
  fetchResponse,
  findCoordinatorRequest,
  findCoordinatorResponse,
  heartbeatRequest,
  joinGroupRequest,
  joinGroupResponse,
  leaveGroupRequest,
  listOffsetsRequest,
  listOffsetsResponse,
  metadataRequest,
  metadataResponse,
  offsetCommitRequest,
  offsetCommitResponse,
  offsetFetchRequest,
  offsetFetchResponse,
  syncGroupRequest,
  syncGroupResponse,
  type BrokerInfo,
  type JoinedGroup,
} from './protocol.ts';
import { decodeBatches, type KafkaRecord } from './records.ts';
import { KafkaProtocolError } from './wire.ts';

export interface KafkaSourceOptions {
  clock: Clock;
  /** `MA_KAFKA_BROKERS`, checked for the bootstrap brokers and every broker the cluster advertises. */
  allowedBrokers: readonly string[];
  logger?: Logger;
  clientId?: string;
  /** How long one fetch waits at the broker for data. */
  maxWaitMs?: number;
  /** How often partitions and their leaders are re-read. */
  metadataRefreshMs?: number;
  /** How long the group keeps a member that stopped heartbeating; within the broker's group.min/max.session.timeout.ms. */
  sessionTimeoutMs?: number;
  heartbeatMs?: number;
  /** How long a rebalance waits for every member to rejoin before going on without the late ones. */
  rebalanceTimeoutMs?: number;
}

const DEFAULT_MAX_WAIT_MS = 5_000;
/** Renew a SASL session at least this long, beyond the longest fetch, before it expires. */
const RENEW_SLACK_MS = 5_000;
const DEFAULT_METADATA_REFRESH_MS = 300_000;
const FETCH_LIMITS = { maxBytes: 8 * 1024 * 1024, partitionMaxBytes: 1024 * 1024 };
/**
 * The assignor this consumer offers. Kafka puts members in one group only if
 * they share one, so a group of consumers that chose others refuses this one
 * (INCONSISTENT_GROUP_PROTOCOL) instead of handing it their partitions.
 */
const PROTOCOL = 'managed-agent';
const DEFAULT_SESSION_TIMEOUT_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 3_000;
const DEFAULT_REBALANCE_TIMEOUT_MS = 60_000;
/** Beyond the rebalance timeout, for a JoinGroup or SyncGroup the coordinator holds until the group settles. */
const GROUP_REQUEST_SLACK_MS = 30_000;
/** Joins in a row that end in another rebalance before the group counts as not settling. */
const JOIN_ATTEMPTS = 10;
const LEAVE_TIMEOUT_MS = 5_000;

export function kafkaSourceFactory(options: KafkaSourceOptions): PullSourceFactory {
  return {
    settings(connector) {
      const config = parseOrThrow(kafkaConfigSchema, connector.config);
      return { maxInFlight: config.maxInFlight, filter: config };
    },

    async open(connector: Connector, secret: string | undefined, signal: AbortSignal): Promise<PullSource> {
      checkKafkaConnector(connector, options.allowedBrokers);
      const config = parseOrThrow(kafkaConfigSchema, connector.config);
      if (config.sasl && !secret) {
        throw new MaError({
          code: 'PULL_CREDENTIAL_UNUSABLE',
          category: 'precondition',
          message:
            "The connector's credential is missing, revoked or expired, so it cannot authenticate to Kafka. " +
            `Bind a usable credential holding ${config.sasl.username}'s password.`,
        });
      }
      const consumer = new KafkaConsumer(config, secret, options, signal, options.logger?.child({ connectorId: connector.id }));
      try {
        await consumer.start();
      } catch (error) {
        await consumer.close();
        throw error;
      }
      return consumer;
    },
  };
}

interface Segment {
  partition: number;
  /** The position after the whole batch: where a commit resumes once it is read. */
  next: number;
  /** Its records, decoded as they are handed out (none for a skipped batch). */
  records: Iterator<KafkaRecord>;
}

class KafkaConsumer implements PullSource {
  readonly #config: KafkaConfig;
  readonly #sasl: SaslSettings | undefined;
  readonly #options: KafkaSourceOptions;
  readonly #signal: AbortSignal;
  readonly #logger: Logger | undefined;
  readonly #maxWaitMs: number;
  readonly #refreshMs: number;
  readonly #brokers = new Map<number, BrokerInfo>();
  readonly #leaders = new Map<number, number>();
  readonly #connections = new Map<number, Promise<KafkaConnection>>();
  readonly #positions = new Map<number, number>();
  readonly #committed = new Map<number, number>();
  readonly #fetching = new Set<number>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #sessionTimeoutMs: number;
  readonly #heartbeatMs: number;
  readonly #rebalanceTimeoutMs: number;
  /** Stops the heartbeat on close; the connector's own signal stops it too. */
  readonly #heartbeatStop = new AbortController();
  #bootstrap: KafkaConnection | undefined;
  #coordinator: KafkaConnection | undefined;
  #coordinatorAddress: { host: string; port: number } | undefined;
  #buffer: Segment[] = [];
  #failure: Error | undefined;
  #rotation = 0;
  #metadataAt = 0;
  #closed = false;
  #memberId = '';
  #generation = -1;
  /** This member's partitions in its current generation. */
  #assigned = new Set<number>();
  /** The group asked its members to rejoin; acted on by the next read or heartbeat. */
  #rejoin = false;
  #rebalancing: Promise<void> | undefined;
  /** Bumped by every rebalance: a fetch begun before one adds nothing after it. */
  #epoch = 0;
  /** The batch handed out and not yet acknowledged; a rebalance waits for it. */
  #outstanding: { settled: Promise<void>; settle: () => void } | undefined;
  #heartbeats: Promise<void> | undefined;

  constructor(
    config: KafkaConfig,
    password: string | undefined,
    options: KafkaSourceOptions,
    signal: AbortSignal,
    logger: Logger | undefined,
  ) {
    this.#config = config;
    this.#sasl = config.sasl && password !== undefined ? { ...config.sasl, password } : undefined;
    this.#options = options;
    this.#signal = signal;
    this.#logger = logger;
    this.#maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.#refreshMs = options.metadataRefreshMs ?? DEFAULT_METADATA_REFRESH_MS;
    this.#sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#rebalanceTimeoutMs = options.rebalanceTimeoutMs ?? DEFAULT_REBALANCE_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    this.#bootstrap = await this.#connectBootstrap();
    await this.#refreshMetadata(this.#bootstrap);
    await this.#join();
    // Done with: later lookups go through a leader's connection, which is the
    // kind that gets renewed. Kept open, it would idle until the broker drops it.
    this.#bootstrap.close();
    this.#bootstrap = undefined;
    this.#heartbeats = this.#beat(AbortSignal.any([this.#signal, this.#heartbeatStop.signal]));
  }

  async receive(limit: number): Promise<PullBatch> {
    if (this.#closed) throw unavailable('the Kafka consumer is closed');
    // The previous batch was acknowledged or given up on: either way it holds up no rebalance now.
    this.#outstanding?.settle();
    if (this.#rejoin) await this.#rebalance();
    else await this.#rebalancing;
    if (this.#failure) throw this.#failure;
    if (this.#buffer.length === 0) await this.#fill();
    if (this.#failure) throw this.#failure;

    const messages: PulledMessage[] = [];
    const positions = new Map<number, number>();
    while (this.#buffer.length > 0 && messages.length < limit) {
      const segment = this.#buffer[0]!;
      let step: IteratorResult<KafkaRecord>;
      try {
        step = segment.records.next();
      } catch (error) {
        this.#failure = error instanceof KafkaProtocolError
          ? protocolError(`Partition ${segment.partition} of ${this.#config.topic}: ${error.message}.`, error)
          : error instanceof Error ? error : new Error(String(error));
        throw this.#failure;
      }
      if (step.done) {
        // Past the whole batch, gaps and skipped records included.
        positions.set(segment.partition, segment.next);
        this.#buffer.shift();
        continue;
      }
      messages.push(this.#message(segment.partition, step.value));
      positions.set(segment.partition, step.value.offset + 1);
    }
    const generation = this.#generation;
    let settle!: () => void;
    const outstanding = { settled: new Promise<void>((resolve) => (settle = resolve)), settle: () => settle() };
    this.#outstanding = outstanding;
    return {
      messages,
      ack: async () => {
        try {
          await this.#commit(positions, generation);
        } finally {
          outstanding.settle();
        }
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#heartbeatStop.abort();
    this.#outstanding?.settle();
    await this.#leave();
    this.#bootstrap?.close();
    this.#coordinator?.close();
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    for (const pending of connections) {
      await pending.then((connection) => connection.close()).catch(() => undefined);
    }
    await Promise.allSettled([...this.#inflight, this.#heartbeats, this.#rebalancing]);
  }

  async #connectBootstrap(): Promise<KafkaConnection> {
    let last: unknown;
    for (const address of this.#config.brokers) {
      const split = address.lastIndexOf(':');
      const host = address.slice(0, split).replace(/^\[|\]$/g, '');
      try {
        return await this.#open(host, Number(address.slice(split + 1)));
      } catch (error) {
        if (MaError.from(error).category === 'permission' || this.#signal.aborted) throw error;
        last = error;
      }
    }
    throw last instanceof Error ? last : unavailable('no bootstrap broker answered');
  }

  #open(host: string, port: number, signal: AbortSignal = this.#signal): Promise<KafkaConnection> {
    return KafkaConnection.open({
      host,
      port,
      tls: this.#config.tls,
      sasl: this.#sasl,
      clientId: this.#options.clientId ?? 'managed-agent',
      clock: this.#options.clock,
      renewMarginMs: this.#maxWaitMs + RENEW_SLACK_MS,
      signal,
    });
  }

  /**
   * Whether a connection should be replaced before its next request: the broker
   * dropped it (an idle timeout, say), or its SASL session is about to expire and
   * nothing is in flight that a reconnect would cut off.
   */
  #stale(connection: KafkaConnection): boolean {
    return connection.closed || (connection.renewDue && connection.idle);
  }

  /** Re-read the topic's partitions and their leaders; returns the partitions it had not seen before. */
  async #refreshMetadata(connection: KafkaConnection): Promise<number[]> {
    const topic = this.#config.topic;
    const response = metadataResponse(await connection.request('Metadata', metadataRequest([topic])));
    this.#brokers.clear();
    for (const broker of response.brokers) this.#brokers.set(broker.nodeId, broker);
    const metadata = response.topics.get(topic);
    const code = metadata?.errorCode ?? 3;
    if (code === 3) {
      throw new MaError({
        code: 'KAFKA_TOPIC_NOT_FOUND',
        category: 'not_found',
        message: `Topic ${topic} does not exist on the cluster at ${connection.address}. Create it, or fix config.topic.`,
      });
    }
    if (code === 29) throw denied(`The cluster refused access to topic ${topic} (TOPIC_AUTHORIZATION_FAILED). Grant the principal Describe and Read on it.`);
    if (code !== 0) throw unavailable(`The cluster answered metadata for ${topic} with ${errorName(code)}; retrying.`);

    if (metadata!.partitions.length === 0) {
      // With no partitions there is nothing to fetch from, and a consumer that
      // never waits on the network would spin on empty reads.
      throw unavailable(`The cluster lists topic ${topic} with no partitions (it may still be being created); retrying.`);
    }
    const known = new Set(this.#leaders.keys());
    for (const partition of metadata!.partitions) {
      if (partition.leader < 0) {
        throw unavailable(`Partition ${partition.partition} of ${topic} has no leader (${errorName(partition.errorCode)}); retrying.`);
      }
      this.#leaders.set(partition.partition, partition.leader);
    }
    this.#metadataAt = this.#options.clock.monotonic();
    return known.size > 0 ? [...this.#leaders.keys()].filter((partition) => !known.has(partition)) : [];
  }

  async #coordinatorConnection(): Promise<KafkaConnection> {
    if (this.#coordinator && this.#stale(this.#coordinator)) {
      // Found again rather than reconnected in place: the group may have moved.
      this.#coordinator.close();
      this.#coordinator = undefined;
    }
    if (this.#coordinator) return this.#coordinator;
    const via = this.#bootstrap ?? (await this.#anyConnection());
    const response = findCoordinatorResponse(await via.request('FindCoordinator', findCoordinatorRequest(this.#config.groupId)));
    if (response.errorCode === 30) throw this.#groupDenied();
    if (response.errorCode !== 0) {
      throw unavailable(
        `The cluster has no coordinator for group ${this.#config.groupId} yet (${errorName(response.errorCode)}${response.errorMessage ? `: ${response.errorMessage}` : ''}); retrying.`,
      );
    }
    const { host, port } = response.broker;
    this.#checkAllowed(host, port, "the group's coordinator");
    this.#coordinatorAddress = { host, port };
    this.#coordinator = await this.#open(host, port);
    return this.#coordinator;
  }

  #dropCoordinator(): void {
    this.#coordinator?.close();
    this.#coordinator = undefined;
  }

  async #anyConnection(): Promise<KafkaConnection> {
    const leader = this.#leaders.values().next();
    if (leader.done) throw unavailable('no broker to ask');
    return this.#connection(leader.value);
  }

  async #connection(nodeId: number): Promise<KafkaConnection> {
    const existing = this.#connections.get(nodeId);
    if (existing) {
      const connection = await existing;
      if (!this.#stale(connection)) return connection;
      // Replaced once, by whichever caller finds it stale first; any other caller
      // then picks up the replacement rather than opening a second one.
      if (this.#connections.get(nodeId) === existing) {
        this.#connections.delete(nodeId);
        connection.close();
      }
      return this.#connection(nodeId);
    }
    const broker = this.#brokers.get(nodeId);
    if (!broker) throw unavailable(`the cluster named broker ${nodeId} as a leader but not where it is; retrying`);
    this.#checkAllowed(broker.host, broker.port, 'advertised by the cluster');
    const pending = this.#open(broker.host, broker.port);
    pending.catch(() => {
      if (this.#connections.get(nodeId) === pending) this.#connections.delete(nodeId);
    });
    this.#connections.set(nodeId, pending);
    return pending;
  }

  #checkAllowed(host: string, port: number, role: string): void {
    const address = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    if (!brokerAllowed(this.#options.allowedBrokers, address)) throw brokerNotAllowed(address, this.#options.allowedBrokers, role);
  }

  /**
   * Positions for the assigned partitions from the group's commits; then commit a
   * starting position for those it has none for. `startFrom` applies only to a
   * group with no commits in the topic at all. A group that has read the topic
   * and lacks a position for a partition is looking at a partition added since —
   * whether a member saw it appear or not — and everything in it is unread. So
   * the whole topic's commits are read, not only this member's partitions': a
   * member assigned nothing but the new partition must not take it for a new group.
   */
  async #initPositions(coordinator: KafkaConnection, assigned: readonly number[]): Promise<void> {
    if (assigned.length === 0) return;
    const partitions = [...new Set([...this.#leaders.keys(), ...assigned])];
    const response = offsetFetchResponse(
      await coordinator.request('OffsetFetch', offsetFetchRequest(this.#config.groupId, this.#config.topic, partitions)),
    );
    this.#checkGroupError(response.errorCode, 'OffsetFetch');
    const committed = new Map<number, number>();
    for (const entry of response.partitions) {
      this.#checkGroupError(entry.errorCode, 'OffsetFetch');
      if (entry.offset >= 0) committed.set(entry.partition, entry.offset);
    }
    const missing: number[] = [];
    for (const partition of assigned) {
      const offset = committed.get(partition);
      if (offset === undefined) {
        missing.push(partition);
      } else {
        this.#positions.set(partition, offset);
        this.#committed.set(partition, offset);
      }
    }
    if (missing.length === 0) return;
    const reset = committed.size > 0 || this.#config.startFrom === 'earliest' ? EARLIEST : LATEST;
    const reached = await this.#listOffsets(missing, reset);
    for (const [partition, offset] of reached) this.#positions.set(partition, offset);
    // Committed at once: otherwise a restart before the first message would
    // resolve "latest" again and skip whatever arrived in between.
    await this.#commit(reached, this.#generation);
  }

  async #listOffsets(partitions: number[], at: number): Promise<Map<number, number>> {
    const reached = new Map<number, number>();
    for (const [leader, group] of this.#byLeader(partitions)) {
      const connection = await this.#connection(leader);
      const response = listOffsetsResponse(
        await connection.request('ListOffsets', listOffsetsRequest(this.#config.topic, group, at)),
      );
      for (const entry of response) {
        if (entry.errorCode === 29) throw denied(`The cluster refused to list offsets of ${this.#config.topic} (TOPIC_AUTHORIZATION_FAILED).`);
        if (entry.errorCode !== 0) {
          this.#metadataAt = 0;
          throw unavailable(`Partition ${entry.partition} answered ListOffsets with ${errorName(entry.errorCode)}; retrying.`);
        }
        reached.set(entry.partition, entry.offset);
      }
    }
    return reached;
  }

  async #fill(): Promise<void> {
    if (this.#options.clock.monotonic() - this.#metadataAt >= this.#refreshMs) {
      const added = await this.#refreshMetadata(await this.#anyConnection());
      if (added.length > 0) {
        // Assigned only at a rebalance; whoever gets them starts at their
        // beginning, since the group has positions elsewhere in the topic.
        this.#logger?.info('the topic gained partitions; rejoining the group so they are assigned', { topic: this.#config.topic, partitions: added });
        this.#rejoin = true;
      }
    }
    // Nothing fetched while the group rebalances: it would be for the old assignment, under the new epoch.
    if (this.#rebalancing) return;
    const idle = [...this.#assigned].filter((partition) => this.#positions.has(partition) && !this.#fetching.has(partition));
    for (const [leader, partitions] of this.#byLeader(idle)) {
      for (const partition of partitions) this.#fetching.add(partition);
      const fetch: Promise<void> = this.#fetch(leader, this.#rotate(partitions))
        .catch((error: unknown) => {
          this.#failure ??= error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          for (const partition of partitions) this.#fetching.delete(partition);
          this.#inflight.delete(fetch);
        });
      this.#inflight.add(fetch);
    }
    // The first leader to answer is enough; the others keep fetching and add to
    // the buffer when they answer, so one quiet broker's long poll does not hold
    // up another's records.
    if (this.#inflight.size > 0) await Promise.race(this.#inflight);
  }

  async #fetch(leader: number, partitions: number[]): Promise<void> {
    const epoch = this.#epoch;
    const connection = await this.#connection(leader);
    const requested = partitions.map((partition) => ({ partition, offset: this.#positions.get(partition)! }));
    const response = fetchResponse(
      await connection.request(
        'Fetch',
        fetchRequest(this.#config.topic, requested, this.#maxWaitMs, FETCH_LIMITS),
        this.#maxWaitMs + 30_000,
      ),
    );
    if (response.errorCode !== 0) throw unavailable(`${connection.address} answered Fetch with ${errorName(response.errorCode)}; retrying.`);

    for (const fetched of response.partitions) {
      const offset = requested.find((entry) => entry.partition === fetched.partition)?.offset;
      // A rebalance since, here or while looking up an earlier partition's
      // oldest offset: the positions it asked from are not this member's to move.
      if (offset === undefined || this.#closed || epoch !== this.#epoch) continue;
      if (fetched.errorCode === 1) {
        // The position fell off the log (retention deleted it). Resuming from the
        // oldest message still there loses only what is already gone.
        const [earliest] = [...(await this.#listOffsets([fetched.partition], EARLIEST)).values()];
        this.#logger?.warn('a Kafka position fell off the log; resuming from the oldest retained message', {
          topic: this.#config.topic,
          partition: fetched.partition,
          from: offset,
          to: earliest,
        });
        if (earliest !== undefined) this.#positions.set(fetched.partition, earliest);
        continue;
      }
      if (RETRIABLE_PARTITION_ERRORS.has(fetched.errorCode)) {
        this.#metadataAt = 0;
        throw unavailable(`Partition ${fetched.partition} answered Fetch with ${errorName(fetched.errorCode)}; re-reading leaders.`);
      }
      if (fetched.errorCode === 29) throw denied(`The cluster refused to let this consumer read ${this.#config.topic} (TOPIC_AUTHORIZATION_FAILED). Grant Read on the topic.`);
      if (fetched.errorCode !== 0) throw protocolError(`Partition ${fetched.partition} answered Fetch with ${errorName(fetched.errorCode)}.`);
      if (!fetched.records || fetched.records.length === 0) continue;

      let decoded: ReturnType<typeof decodeBatches>;
      try {
        decoded = decodeBatches(fetched.records, offset, fetched.aborted);
      } catch (error) {
        if (error instanceof KafkaProtocolError) {
          throw protocolError(`Partition ${fetched.partition} of ${this.#config.topic}: ${error.message}.`, error);
        }
        throw error;
      }
      if (decoded.complete > 0 && decoded.nextOffset <= offset) {
        // Whole batches that end before the position asked for: fetching again
        // would get them again, forever, with nothing ever delivered.
        throw protocolError(
          `Partition ${fetched.partition} of ${this.#config.topic} answered a fetch from offset ${offset} with record ` +
            'batches that end before it, so the position cannot advance; the broker or its data is broken.',
        );
      }
      for (const batch of decoded.batches) {
        this.#buffer.push({ partition: fetched.partition, next: batch.next, records: batch.records() });
      }
      this.#positions.set(fetched.partition, decoded.nextOffset);
    }
  }

  #message(partition: number, record: KafkaRecord): PulledMessage {
    return {
      // The timestamp tells a recreated topic's offset 0 from the old one's, so
      // a fresh event is not taken for one delivered before the topic was dropped.
      transportId: `${this.#config.topic}/${partition}/${record.offset}/${record.timestamp}`,
      body: record.value ?? undefined,
      ...(record.key ? { key: keyText(record.key) } : {}),
      headers: record.headers,
    };
  }

  /**
   * Commit as the member of the generation that read these positions. Once that
   * generation is over the partitions may be someone else's, so nothing is
   * committed: whoever reads them next reads those records again, which a
   * connector's receipts recognise, rather than have its own position moved.
   */
  async #commit(positions: ReadonlyMap<number, number>, generation: number): Promise<void> {
    const changed = new Map([...positions].filter(([partition, next]) => this.#committed.get(partition) !== next));
    if (changed.size === 0) return;
    if (generation !== this.#generation) {
      this.#notCommitted(changed, 'the group rebalanced since they were read');
      return;
    }
    const coordinator = await this.#coordinatorConnection();
    let response: ReturnType<typeof offsetCommitResponse>;
    try {
      response = offsetCommitResponse(
        await coordinator.request(
          'OffsetCommit',
          offsetCommitRequest(this.#config.groupId, this.#config.topic, changed, generation, this.#memberId),
        ),
      );
    } catch (error) {
      this.#coordinator = undefined;
      throw error;
    }
    const over = response.find((entry) => REJOIN_ERRORS.has(entry.errorCode));
    if (over) {
      this.#rejoin = true;
      this.#notCommitted(changed, `the coordinator answered ${errorName(over.errorCode)}`);
      return;
    }
    for (const entry of response) this.#checkGroupError(entry.errorCode, 'OffsetCommit');
    for (const [partition, next] of changed) this.#committed.set(partition, next);
  }

  #notCommitted(positions: ReadonlyMap<number, number>, reason: string): void {
    this.#logger?.info('positions read before a rebalance were not committed; whoever reads those partitions next reads them again', {
      topic: this.#config.topic,
      partitions: [...positions.keys()],
      reason,
    });
  }

  #checkGroupError(code: number, call: string): void {
    if (code === 0) return;
    const group = this.#config.groupId;
    if (COORDINATOR_ERRORS.has(code)) {
      this.#dropCoordinator();
      throw unavailable(`The coordinator for group ${group} answered ${call} with ${errorName(code)}; finding it again.`);
    }
    if (code === INCONSISTENT_GROUP_PROTOCOL) {
      throw new MaError({
        code: 'KAFKA_GROUP_IN_USE',
        category: 'conflict',
        message:
          `Consumer group ${group} has members other than this platform's connectors: they chose another assignor, and ` +
          `Kafka keeps the two apart (${call} answered INCONSISTENT_GROUP_PROTOCOL). Give this connector a groupId of its own.`,
      });
    }
    if (code === 26) {
      throw protocolError(
        `The cluster refused a session timeout of ${this.#sessionTimeoutMs} ms for group ${group} (INVALID_SESSION_TIMEOUT); ` +
          "the brokers' group.min.session.timeout.ms and group.max.session.timeout.ms must admit it.",
      );
    }
    if (code === 81) {
      throw protocolError(
        `Consumer group ${group} has as many members as the cluster allows (GROUP_MAX_SIZE_REACHED). Give this connector ` +
          "a groupId of its own, or raise the brokers' group.max.size.",
      );
    }
    if (code === 30) throw this.#groupDenied();
    if (code === 29) throw denied(`The cluster refused ${call} on topic ${this.#config.topic} (TOPIC_AUTHORIZATION_FAILED).`);
    throw protocolError(`${call} for group ${group} failed with ${errorName(code)}.`);
  }

  /**
   * Join the group, take this member's assignment (computing everyone's when
   * this member leads), and read positions for it. Answers that mean "the group
   * moved on while joining" join again, a bounded number of times.
   */
  async #join(): Promise<void> {
    const group = this.#config.groupId;
    const timeoutMs = this.#rebalanceTimeoutMs + GROUP_REQUEST_SLACK_MS;
    for (let attempt = 1; ; attempt++) {
      // Closing leaves the group, which answers a JoinGroup the coordinator holds
      // with UNKNOWN_MEMBER_ID; joining again then would add a member no one runs.
      if (this.#closed) throw unavailable('the Kafka consumer is closed');
      const coordinator = await this.#coordinatorConnection();
      const joined = joinGroupResponse(
        await coordinator.request(
          'JoinGroup',
          joinGroupRequest(group, this.#sessionTimeoutMs, this.#rebalanceTimeoutMs, this.#memberId, [
            { name: PROTOCOL, metadata: encodeSubscription([this.#config.topic]) },
          ]),
          timeoutMs,
        ),
      );
      if (joined.errorCode === UNKNOWN_MEMBER_ID) {
        this.#memberId = '';
      } else if (!REJOIN_ERRORS.has(joined.errorCode)) {
        this.#checkGroupError(joined.errorCode, 'JoinGroup');
        this.#memberId = joined.memberId;
        const assignments = joined.leader === joined.memberId ? await this.#assign(joined.members) : [];
        const synced = syncGroupResponse(
          await coordinator.request('SyncGroup', syncGroupRequest(group, joined.generation, joined.memberId, assignments), timeoutMs),
        );
        if (synced.errorCode === 0) {
          let assignment: Map<string, number[]>;
          try {
            assignment = decodeAssignment(synced.assignment);
          } catch (error) {
            throw protocolError(`The assignment group ${group}'s leader handed this member could not be read.`, error);
          }
          // Together: a commit pairs this generation with exactly these partitions.
          this.#generation = joined.generation;
          this.#assigned = new Set(assignment.get(this.#config.topic) ?? []);
          break;
        }
        if (synced.errorCode === UNKNOWN_MEMBER_ID) this.#memberId = '';
        else if (!REJOIN_ERRORS.has(synced.errorCode)) this.#checkGroupError(synced.errorCode, 'SyncGroup');
      }
      if (attempt >= JOIN_ATTEMPTS) {
        throw unavailable(`Consumer group ${group} rebalanced again on each of ${JOIN_ATTEMPTS} attempts to join it; retrying.`);
      }
    }
    this.#positions.clear();
    this.#committed.clear();
    if ([...this.#assigned].some((partition) => !this.#leaders.has(partition))) {
      // The leader saw partitions this member's metadata does not have yet.
      await this.#refreshMetadata(await this.#coordinatorConnection());
    }
    await this.#initPositions(await this.#coordinatorConnection(), [...this.#assigned]);
  }

  /** As the leader: every member's partitions, from their subscriptions and the cluster's metadata now. */
  async #assign(members: JoinedGroup['members']): Promise<{ memberId: string; assignment: Buffer }[]> {
    let subscriptions: { memberId: string; topics: string[] }[];
    try {
      subscriptions = members.map(({ memberId, metadata }) => ({ memberId, topics: decodeSubscription(metadata) }));
    } catch (error) {
      throw protocolError(`A member of group ${this.#config.groupId} sent a subscription that could not be read.`, error);
    }
    const topics = [...new Set(subscriptions.flatMap((subscription) => subscription.topics))];
    // The coordinator's connection, idle now: a leader's may be holding a fetch's
    // long poll, and the whole group waits for this assignment.
    const response = metadataResponse(await (await this.#coordinatorConnection()).request('Metadata', metadataRequest(topics)));
    const partitions = new Map(
      [...response.topics]
        .filter(([, topic]) => topic.errorCode === 0)
        .map(([name, topic]) => [name, topic.partitions.map((partition) => partition.partition)]),
    );
    return [...assignRanges(subscriptions, partitions)].map(([memberId, assigned]) => ({ memberId, assignment: encodeAssignment(assigned) }));
  }

  /**
   * Rejoin, once the batch handed out has been acknowledged — its commit is
   * still this generation's, which the coordinator accepts while the group waits
   * for its members. One rebalance at a time; a failure is the consumer's.
   */
  #rebalance(): Promise<void> {
    this.#rebalancing ??= this.#rejoinGroup();
    return this.#rebalancing;
  }

  async #rejoinGroup(): Promise<void> {
    // Before the first await, so no read in between hands out what was fetched
    // for the old assignment, and every fetch begun before is dropped on arrival.
    this.#rejoin = false;
    this.#epoch++;
    this.#buffer = [];
    try {
      await this.#outstanding?.settled;
      await this.#join();
    } catch (error) {
      this.#failure ??= error instanceof Error ? error : new Error(String(error));
    } finally {
      this.#rebalancing = undefined;
    }
  }

  /**
   * Keep the membership alive, and notice when the group wants its members back.
   * A missed beat is not fatal — the session outlasts several — so a failed one
   * is retried at the next; only a refusal ends the consumer.
   */
  async #beat(signal: AbortSignal): Promise<void> {
    let failing = false;
    while (!this.#closed && !this.#failure) {
      try {
        await this.#options.clock.sleep(this.#heartbeatMs, signal);
      } catch {
        return;
      }
      if (this.#rejoin) void this.#rebalance();
      if (this.#rebalancing || this.#memberId === '') continue;
      try {
        const coordinator = await this.#coordinatorConnection();
        const code = errorCodeResponse(
          await coordinator.request('Heartbeat', heartbeatRequest(this.#config.groupId, this.#generation, this.#memberId)),
        );
        failing = false;
        if (REJOIN_ERRORS.has(code)) {
          this.#rejoin = true;
          void this.#rebalance();
        } else {
          this.#checkGroupError(code, 'Heartbeat');
        }
      } catch (error) {
        if (this.#closed) return;
        if (MaError.from(error).category === 'permission') {
          this.#failure ??= error instanceof Error ? error : new Error(String(error));
          return;
        }
        if (!failing) this.#logger?.warn('a heartbeat to the group coordinator failed; retrying at the next', { error });
        failing = true;
      }
    }
  }

  /**
   * Leave the group, so the others take this member's partitions now rather
   * than after its session times out. Over a connection of its own when the
   * coordinator's is busy or gone: the broker answers one request per connection
   * at a time and holds a JoinGroup until the rebalance ends, and stopping the
   * connector closes the connections it opened.
   */
  async #leave(): Promise<void> {
    const memberId = this.#memberId;
    const address = this.#coordinatorAddress;
    this.#memberId = '';
    if (memberId === '' || !address) return;
    const existing = this.#coordinator && !this.#coordinator.closed && !this.#rebalancing ? this.#coordinator : undefined;
    let connection: KafkaConnection | undefined;
    try {
      connection = existing ?? (await this.#open(address.host, address.port, AbortSignal.timeout(LEAVE_TIMEOUT_MS)));
      errorCodeResponse(await connection.request('LeaveGroup', leaveGroupRequest(this.#config.groupId, memberId), LEAVE_TIMEOUT_MS));
    } catch (error) {
      this.#logger?.info('could not leave the consumer group; the coordinator drops this member when its session times out', { error });
    } finally {
      if (connection && connection !== existing) connection.close();
    }
  }

  #groupDenied(): MaError {
    return denied(`The cluster refused access to consumer group ${this.#config.groupId} (GROUP_AUTHORIZATION_FAILED). Grant the principal Read on the group.`);
  }

  #byLeader(partitions: readonly number[]): Map<number, number[]> {
    const groups = new Map<number, number[]>();
    for (const partition of partitions) {
      const leader = this.#leaders.get(partition);
      if (leader === undefined || leader < 0) continue;
      const group = groups.get(leader) ?? [];
      group.push(partition);
      groups.set(leader, group);
    }
    return groups;
  }

  /**
   * A different partition first each time. A broker always returns the first
   * partition's first batch whole, however large; a batch bigger than the
   * per-partition limit anywhere else arrives cut off and makes no progress
   * until its partition gets a turn at the front.
   */
  #rotate(partitions: number[]): number[] {
    const shift = this.#rotation++ % partitions.length;
    return [...partitions.slice(shift), ...partitions.slice(0, shift)];
  }
}

/** The key as text when it is UTF-8, so two binary keys never collapse into one replacement string. */
function keyText(key: Buffer): string {
  const text = key.toString('utf8');
  return Buffer.from(text, 'utf8').equals(key) ? text : `base64:${key.toString('base64')}`;
}
