/**
 * The Kafka consumer: read every partition of one topic, commit under a group.
 *
 * It behaves like a Java consumer given an explicit assignment of all
 * partitions: it reads committed positions, fetches from each partition's
 * leader, and commits as a groupless member (generation -1). It does not join
 * the group's rebalancing — two replicas both read everything, and the
 * receipt's dedupe on each record's identity makes the second copy a
 * duplicate. What it buys is a client small enough to own.
 *
 * Positions advance only as far as records have been handed out and
 * acknowledged; anything decoded but not yet taken stays buffered. A failure
 * anywhere throws the whole consumer away, and its replacement starts again
 * from the committed positions.
 */

import { MaError, type Clock, type Logger } from '@ma/core';
import { kafkaConfigSchema, parseOrThrow, type Connector, type KafkaConfig } from '@ma/contracts';

import { brokerAllowed, brokerNotAllowed, checkKafkaConnector } from '../adapters.ts';
import type { PulledMessage } from '../message.ts';
import type { PullBatch, PullSource, PullSourceFactory } from '../supervisor.ts';
import { KafkaConnection, denied, protocolError, unavailable, type SaslSettings } from './connection.ts';
import {
  COORDINATOR_ERRORS,
  EARLIEST,
  GROUP_IN_USE_ERRORS,
  LATEST,
  RETRIABLE_PARTITION_ERRORS,
  errorName,
  fetchRequest,
  fetchResponse,
  findCoordinatorRequest,
  findCoordinatorResponse,
  listOffsetsRequest,
  listOffsetsResponse,
  metadataRequest,
  metadataResponse,
  offsetCommitRequest,
  offsetCommitResponse,
  offsetFetchRequest,
  offsetFetchResponse,
  type BrokerInfo,
} from './protocol.ts';
import { decodeRecords, type KafkaRecord } from './records.ts';
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
}

const DEFAULT_MAX_WAIT_MS = 5_000;
const DEFAULT_METADATA_REFRESH_MS = 300_000;
const FETCH_LIMITS = { maxBytes: 8 * 1024 * 1024, partitionMaxBytes: 1024 * 1024 };

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

interface Entry {
  partition: number;
  /** The position after this entry: where a commit taken here resumes. */
  next: number;
  /** Absent for a span the consumer skips (a control batch, an aborted transaction). */
  message?: PulledMessage;
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
  #bootstrap: KafkaConnection | undefined;
  #coordinator: KafkaConnection | undefined;
  #buffer: Entry[] = [];
  #failure: Error | undefined;
  #rotation = 0;
  #metadataAt = 0;
  #closed = false;

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
  }

  async start(): Promise<void> {
    this.#bootstrap = await this.#connectBootstrap();
    await this.#refreshMetadata(this.#bootstrap);
    const coordinator = await this.#coordinatorConnection();
    await this.#initPositions(coordinator, [...this.#leaders.keys()], this.#config.startFrom === 'earliest' ? EARLIEST : LATEST);
  }

  async receive(limit: number): Promise<PullBatch> {
    if (this.#closed) throw unavailable('the Kafka consumer is closed');
    if (this.#buffer.length === 0) await this.#fill();
    if (this.#failure) throw this.#failure;

    const messages: PulledMessage[] = [];
    const positions = new Map<number, number>();
    let taken = 0;
    for (; taken < this.#buffer.length; taken++) {
      const entry = this.#buffer[taken]!;
      if (entry.message) {
        if (messages.length >= limit) break;
        messages.push(entry.message);
      }
      positions.set(entry.partition, entry.next);
    }
    this.#buffer = this.#buffer.slice(taken);
    return { messages, ack: () => this.#commit(positions) };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#bootstrap?.close();
    this.#coordinator?.close();
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    for (const pending of connections) {
      await pending.then((connection) => connection.close()).catch(() => undefined);
    }
    await Promise.allSettled([...this.#inflight]);
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

  #open(host: string, port: number): Promise<KafkaConnection> {
    return KafkaConnection.open({
      host,
      port,
      tls: this.#config.tls,
      sasl: this.#sasl,
      clientId: this.#options.clientId ?? 'managed-agent',
      signal: this.#signal,
    });
  }

  async #refreshMetadata(connection: KafkaConnection): Promise<void> {
    const topic = this.#config.topic;
    const response = metadataResponse(await connection.request('Metadata', metadataRequest(topic)), topic);
    this.#brokers.clear();
    for (const broker of response.brokers) this.#brokers.set(broker.nodeId, broker);
    const code = response.topic?.errorCode ?? 3;
    if (code === 3) {
      throw new MaError({
        code: 'KAFKA_TOPIC_NOT_FOUND',
        category: 'not_found',
        message: `Topic ${topic} does not exist on the cluster at ${connection.address}. Create it, or fix config.topic.`,
      });
    }
    if (code === 29) throw denied(`The cluster refused access to topic ${topic} (TOPIC_AUTHORIZATION_FAILED). Grant the principal Describe and Read on it.`);
    if (code !== 0) throw unavailable(`The cluster answered metadata for ${topic} with ${errorName(code)}; retrying.`);

    const known = new Set(this.#leaders.keys());
    for (const partition of response.topic!.partitions) {
      if (partition.leader < 0) {
        throw unavailable(`Partition ${partition.partition} of ${topic} has no leader (${errorName(partition.errorCode)}); retrying.`);
      }
      this.#leaders.set(partition.partition, partition.leader);
    }
    this.#metadataAt = this.#options.clock.monotonic();
    const added = [...this.#leaders.keys()].filter((partition) => !known.has(partition));
    if (known.size > 0 && added.length > 0) {
      // Partitions created while this consumer ran: their history is all new, so
      // they start from the beginning rather than skipping what arrived first.
      this.#logger?.info('the topic gained partitions', { topic, partitions: added });
      await this.#initPositions(await this.#coordinatorConnection(), added, EARLIEST);
    }
  }

  async #coordinatorConnection(): Promise<KafkaConnection> {
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
    this.#coordinator = await this.#open(host, port);
    return this.#coordinator;
  }

  async #anyConnection(): Promise<KafkaConnection> {
    const leader = this.#leaders.values().next();
    if (leader.done) throw unavailable('no broker to ask');
    return this.#connection(leader.value);
  }

  #connection(nodeId: number): Promise<KafkaConnection> {
    const existing = this.#connections.get(nodeId);
    if (existing) return existing;
    const broker = this.#brokers.get(nodeId);
    if (!broker) return Promise.reject(unavailable(`the cluster named broker ${nodeId} as a leader but not where it is; retrying`));
    this.#checkAllowed(broker.host, broker.port, 'advertised by the cluster');
    const pending = this.#open(broker.host, broker.port);
    pending.catch(() => this.#connections.delete(nodeId));
    this.#connections.set(nodeId, pending);
    return pending;
  }

  #checkAllowed(host: string, port: number, role: string): void {
    const address = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    if (!brokerAllowed(this.#options.allowedBrokers, address)) throw brokerNotAllowed(address, this.#options.allowedBrokers, role);
  }

  /** Positions from the group's commits, or `reset` where it has none; then commit them. */
  async #initPositions(coordinator: KafkaConnection, partitions: number[], reset: number): Promise<void> {
    const response = offsetFetchResponse(
      await coordinator.request('OffsetFetch', offsetFetchRequest(this.#config.groupId, this.#config.topic, partitions)),
    );
    this.#checkGroupError(response.errorCode, 'OffsetFetch');
    const missing: number[] = [];
    for (const entry of response.partitions) {
      this.#checkGroupError(entry.errorCode, 'OffsetFetch');
      if (entry.offset >= 0) {
        this.#positions.set(entry.partition, entry.offset);
        this.#committed.set(entry.partition, entry.offset);
      } else {
        missing.push(entry.partition);
      }
    }
    if (missing.length === 0) return;
    const reached = await this.#listOffsets(missing, reset);
    for (const [partition, offset] of reached) this.#positions.set(partition, offset);
    // Committed at once: otherwise a restart before the first message would
    // resolve "latest" again and skip whatever arrived in between.
    await this.#commit(reached);
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
      await this.#refreshMetadata(await this.#anyConnection());
    }
    const idle = [...this.#leaders.keys()].filter((partition) => !this.#fetching.has(partition));
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
      if (offset === undefined || this.#closed) continue;
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

      let decoded: ReturnType<typeof decodeRecords>;
      try {
        decoded = decodeRecords(fetched.records, offset, fetched.aborted);
      } catch (error) {
        if (error instanceof KafkaProtocolError) {
          throw protocolError(`Partition ${fetched.partition} of ${this.#config.topic}: ${error.message}.`, error);
        }
        throw error;
      }
      let next = offset;
      for (const record of decoded.records) {
        next = record.offset + 1;
        this.#buffer.push({ partition: fetched.partition, next, message: this.#message(fetched.partition, record) });
      }
      if (decoded.nextOffset > next) this.#buffer.push({ partition: fetched.partition, next: decoded.nextOffset });
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

  async #commit(positions: ReadonlyMap<number, number>): Promise<void> {
    const changed = new Map([...positions].filter(([partition, next]) => this.#committed.get(partition) !== next));
    if (changed.size === 0) return;
    const coordinator = await this.#coordinatorConnection();
    let response: ReturnType<typeof offsetCommitResponse>;
    try {
      response = offsetCommitResponse(
        await coordinator.request('OffsetCommit', offsetCommitRequest(this.#config.groupId, this.#config.topic, changed)),
      );
    } catch (error) {
      this.#coordinator = undefined;
      throw error;
    }
    for (const entry of response) this.#checkGroupError(entry.errorCode, 'OffsetCommit');
    for (const [partition, next] of changed) this.#committed.set(partition, next);
  }

  #checkGroupError(code: number, call: string): void {
    if (code === 0) return;
    const group = this.#config.groupId;
    if (COORDINATOR_ERRORS.has(code)) {
      this.#coordinator?.close();
      this.#coordinator = undefined;
      throw unavailable(`The coordinator for group ${group} answered ${call} with ${errorName(code)}; finding it again.`);
    }
    if (GROUP_IN_USE_ERRORS.has(code)) {
      throw new MaError({
        code: 'KAFKA_GROUP_IN_USE',
        category: 'conflict',
        message:
          `Consumer group ${group} has members that joined through the group protocol (${call} answered ${errorName(code)}), ` +
          'and they own its offsets. Give this connector a groupId of its own.',
      });
    }
    if (code === 30) throw this.#groupDenied();
    if (code === 29) throw denied(`The cluster refused ${call} on topic ${this.#config.topic} (TOPIC_AUTHORIZATION_FAILED).`);
    throw protocolError(`${call} for group ${group} failed with ${errorName(code)}.`);
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
