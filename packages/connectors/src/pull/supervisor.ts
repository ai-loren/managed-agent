/**
 * Pull consumers: connectors that read from a broker instead of being posted to.
 *
 * One loop per active connector. Each message becomes a receipt through the same
 * `enqueue` an inbound request goes through, and only then is it acknowledged
 * to the broker (deleted from the queue, its offset committed). A crash between
 * the two re-reads the message, and the receipt's dedupe on the message's
 * identity makes that second read a duplicate rather than a second run — so the
 * broker's at-least-once delivery becomes one delivery per event.
 *
 * Reading stops while the connector has `maxInFlight` deliveries waiting or
 * running: a backlog stays in the broker, durable and visible there, instead of
 * being copied into pending receipts that each start an agent.
 *
 * Replicas sharing one store share the connectors: each holds a lease on the
 * ones it reads (`pullLeases`), renewed every scan, and takes its share of the
 * first `capacity` × live replicas active ones, in the listing's order. One
 * over its share, or holding one past that line, gives it back, so a replica
 * that joins finds work and a new workspace's first connector displaces the
 * busiest one's newest; the leases of one that died lapse and are taken over.
 */

import { MaError, randomToken, type Clock, type Logger } from '@ma/core';
import type { Connector } from '@ma/contracts';
import type { Store } from '@ma/store';

import type { DeliveryPipeline } from '../pipeline.ts';
import { normalizePulled, type PulledEventConfig, type PulledMessage } from './message.ts';

export interface PullBatch {
  readonly messages: readonly PulledMessage[];
  /**
   * Acknowledge the whole batch to the broker. Called once every message in it
   * has a receipt or was dropped — never before, which is what makes a crash
   * cost a re-read rather than a lost event.
   */
  ack(): Promise<void>;
}

export interface PullSource {
  /**
   * The next messages, at most `limit`; empty when the broker's long poll ended
   * with nothing. Rejects when `signal` aborts.
   */
  receive(limit: number, signal: AbortSignal): Promise<PullBatch>;
  close(): Promise<void>;
}

export interface PullSettings {
  maxInFlight: number;
  filter: PulledEventConfig;
}

export interface PullSourceFactory {
  /** The connector's consumer settings; throws a validation error for a malformed config. */
  settings(connector: Connector): PullSettings;
  /** Connect. `secret` is the connector's credential, `undefined` when it has none or it is unusable. */
  open(connector: Connector, secret: string | undefined, signal: AbortSignal): Promise<PullSource>;
}

export type PullOutcome = 'enqueued' | 'duplicate' | 'ignored';

export interface PullSupervisorOptions {
  store: Store;
  clock: Clock;
  pipeline: DeliveryPipeline;
  /** The connector types consumed, each with how to read it. */
  sources: Readonly<Record<string, PullSourceFactory>>;
  logger?: Logger;
  /** How often to look for connectors that were activated, deactivated or edited. */
  scanMs?: number;
  /** Observe each message's outcome — for metrics. Best-effort. */
  onMessage?: (type: string, outcome: PullOutcome) => void;
  /** This process among the replicas sharing the store; random when absent. */
  replicaId?: string;
  /** The most pull connectors this replica reads at once. */
  capacity?: number;
}

const DEFAULT_SCAN_MS = 5_000;
/** Pull connectors one replica reads at once. */
const DEFAULT_CAPACITY = 200;
/** How many of the connectors past every replica's capacity are told they are not being read, per scan. */
const OVER_CAPACITY_REPORTED = 100;
/** Scans a lease outlasts unrenewed, before another replica may take its connector. */
const LEASE_SCANS = 3;
/** A replica not seen for this long is forgotten. */
const FORGET_REPLICA_MS = 60 * 60_000;
const ROOM_POLL_MS = 1_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** The shortest an empty read may take before the next one. */
const MIN_EMPTY_POLL_MS = 1_000;

interface Loop {
  fingerprint: string;
  abort: AbortController;
  done: Promise<void>;
}

export class PullSupervisor {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #pipeline: DeliveryPipeline;
  readonly #sources: Readonly<Record<string, PullSourceFactory>>;
  readonly #logger: Logger | undefined;
  readonly #scanMs: number;
  readonly #onMessage: ((type: string, outcome: PullOutcome) => void) | undefined;
  readonly #replicaId: string;
  readonly #capacity: number;
  readonly #loops = new Map<string, Loop>();
  #stop: AbortController | undefined;
  #scanning: Promise<void> | undefined;

  constructor(options: PullSupervisorOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#pipeline = options.pipeline;
    this.#sources = options.sources;
    this.#logger = options.logger;
    this.#scanMs = options.scanMs ?? DEFAULT_SCAN_MS;
    this.#onMessage = options.onMessage;
    this.#replicaId = options.replicaId ?? `replica_${randomToken(9)}`;
    this.#capacity = options.capacity ?? DEFAULT_CAPACITY;
  }

  /** Connector ids being consumed right now. */
  get consuming(): string[] {
    return [...this.#loops.keys()];
  }

  /** Start scanning; `stop()` must be awaited before starting again. */
  start(): void {
    if (this.#stop) return;
    const stop = new AbortController();
    this.#stop = stop;
    this.#scanning = (async () => {
      while (!stop.signal.aborted) {
        await this.scan();
        try {
          await this.#clock.sleep(this.#scanMs, stop.signal);
        } catch {
          return;
        }
      }
    })();
  }

  /** Stop every consumer, wait for each to close its connection, and give its lease back. */
  async stop(): Promise<void> {
    this.#stop?.abort();
    await this.#scanning;
    this.#stop = undefined;
    this.#scanning = undefined;
    await this.#end([...this.#loops.keys()]);
    try {
      // Not counted as live any more either, or the others' shares would stay
      // too small to take what this one gave back.
      await this.#store.pullLeases.leave(this.#replicaId);
    } catch (error) {
      // They lapse on their own; another replica takes them a few scans later.
      this.#logger?.warn('could not give pull connector leases back on stopping', { error });
    }
  }

  /**
   * Reconcile the running consumers with the active connectors and this
   * replica's share of them: renew what it holds, give back what is over its
   * share, claim what is free up to it, and restart an edited connector (new
   * queue, new credential).
   */
  async scan(): Promise<void> {
    const now = this.#clock.now();
    const leaseMs = this.#scanMs * LEASE_SCANS;
    let listed: Connector[];
    let replicas: number;
    try {
      await this.#store.pullLeases.heartbeat(this.#replicaId, now, now - FORGET_REPLICA_MS);
      replicas = Math.max(1, await this.#store.pullLeases.liveReplicas(now - leaseMs));
      listed = await this.#store.connectors.findActiveByTypes(Object.keys(this.#sources), this.#capacity * replicas + OVER_CAPACITY_REPORTED);
    } catch (error) {
      this.#logger?.error('could not list pull connectors; will retry', { error });
      return;
    }
    if (this.#stop?.signal.aborted) return;

    let mine: Set<string>;
    try {
      mine = new Set(await this.#store.pullLeases.renew(this.#replicaId, [...this.#loops.keys()], now + leaseMs));
    } catch (error) {
      // What this replica holds may lapse and be taken; stop reading rather
      // than read beside the next holder.
      this.#logger?.error('could not renew pull connector leases; stopping their consumers until it can', { error });
      await this.#end([...this.#loops.keys()]);
      return;
    }

    const active = new Map(listed.map((connector) => [connector.id, connector]));
    const ended: string[] = [];
    for (const [id, loop] of this.#loops) {
      const connector = active.get(id);
      if (connector && mine.has(id) && fingerprint(connector) === loop.fingerprint) continue;
      ended.push(id);
    }
    await this.#end(ended);

    // What the replicas read between them: the first `capacity` each, in the
    // listing's order, so a new workspace's first connector displaces another's
    // newest. Over the share the ones last in line go back first, and so does
    // any lease past that line or on a connector no longer active.
    const readable = listed.slice(0, this.#capacity * replicas);
    const readableIds = new Set(readable.map((connector) => connector.id));
    const share = Math.ceil(readable.length / replicas);
    const holding = readable.filter((connector) => mine.has(connector.id));
    const surplus = [...holding.slice(share).map((connector) => connector.id), ...[...mine].filter((id) => !readableIds.has(id))];
    if (surplus.length > 0) {
      await this.#end(surplus);
      for (const id of surplus) mine.delete(id);
      try {
        await this.#store.pullLeases.release(this.#replicaId, surplus);
      } catch (error) {
        this.#logger?.warn('could not give pull connector leases back; they lapse on their own', { error });
      }
    }

    for (const connector of readable) {
      if (mine.size >= share) break;
      if (mine.has(connector.id)) continue;
      try {
        if (await this.#store.pullLeases.claim(connector.id, this.#replicaId, now, now + leaseMs)) mine.add(connector.id);
      } catch (error) {
        this.#logger?.warn('could not claim a pull connector; will retry', { connectorId: connector.id, error });
      }
    }

    for (const connector of readable) {
      if (!mine.has(connector.id) || this.#loops.has(connector.id)) continue;
      // Read now, so no longer waiting — not only once its first read returns.
      if (connector.error?.code === 'PULL_OVER_CAPACITY') await this.#setError(connector, undefined);
      const abort = new AbortController();
      this.#loops.set(connector.id, {
        fingerprint: fingerprint(connector),
        abort,
        done: this.#consume(connector, abort.signal),
      });
    }

    // Past the line no replica reads: told so where their owners look, once
    // whoever read them last has let go.
    const beyond = listed.slice(this.#capacity * replicas);
    if (beyond.length > 0) {
      let held: Set<string>;
      try {
        held = new Set(await this.#store.pullLeases.held(beyond.map((connector) => connector.id), now));
      } catch {
        return;
      }
      const waiting = beyond.filter((connector) => !held.has(connector.id)).slice(0, OVER_CAPACITY_REPORTED);
      if (waiting.length > 0) {
        this.#logger?.warn('more pull connectors are active than the replicas read; the rest are not being read', {
          perReplica: this.#capacity,
          replicas,
        });
        for (const connector of waiting) await this.#reportOverCapacity(connector);
      }
    }
  }

  /** Stop these connectors' consumers and wait for them. */
  async #end(ids: readonly string[]): Promise<void> {
    const loops = ids.flatMap((id) => {
      const loop = this.#loops.get(id);
      if (!loop) return [];
      this.#loops.delete(id);
      loop.abort.abort();
      return [loop];
    });
    await Promise.all(loops.map((loop) => loop.done));
  }

  async #consume(connector: Connector, signal: AbortSignal): Promise<void> {
    const factory = this.#sources[connector.type]!;
    const logger = this.#logger?.child({ connectorId: connector.id, connectorType: connector.type });
    let errorShown = connector.error !== undefined;
    let lastError = '';
    let backoff = INITIAL_BACKOFF_MS;

    while (!signal.aborted) {
      let source: PullSource | undefined;
      try {
        const settings = factory.settings(connector);
        const secret = await this.#pipeline.connectorSecret(connector);
        source = await factory.open(connector, secret, signal);
        while (!signal.aborted) {
          const room = await this.#room(connector, settings.maxInFlight, signal);
          // Stopped while counting: a poll now holds the stop up for a whole
          // broker wait (a Kafka fetch's maxWait) for nothing.
          if (signal.aborted) break;
          const polledAt = this.#clock.monotonic();
          const batch = await source.receive(room, signal);
          if (errorShown) {
            errorShown = !(await this.#setError(connector, undefined));
            lastError = '';
          }
          for (const message of batch.messages) await this.#ingest(connector, message, settings, logger);
          await batch.ack();
          backoff = INITIAL_BACKOFF_MS;
          if (batch.messages.length === 0) {
            // A broker paces an idle consumer by holding its poll open. One that
            // answers "nothing" at once would be polled in a tight loop, and when
            // nothing in the loop waits on I/O it never lets the event loop turn,
            // stalling every other connector and request in the process.
            const elapsed = this.#clock.monotonic() - polledAt;
            if (elapsed < MIN_EMPTY_POLL_MS) await this.#clock.sleep(MIN_EMPTY_POLL_MS - elapsed, signal);
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        const failure = MaError.from(error);
        const summary = `${failure.code}: ${failure.message}`;
        if (summary !== lastError) {
          // Logged and recorded when it changes, not on every retry: a broker that
          // is down for an hour is one entry and one connector error, not sixty.
          logger?.error('pull consumer failed; retrying', { error, retryInMs: backoff });
          lastError = summary;
          if (await this.#setError(connector, failure)) errorShown = true;
        }
        try {
          await this.#clock.sleep(backoff, signal);
        } catch {
          break;
        }
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      } finally {
        await source?.close().catch((error: unknown) => logger?.warn('closing a pull source failed', { error }));
      }
    }
  }

  /** How many more deliveries the connector may have in flight, waiting until it is at least one. */
  async #room(connector: Connector, maxInFlight: number, signal: AbortSignal): Promise<number> {
    for (;;) {
      const inFlight = await this.#store.receipts.list({
        connectorId: connector.id,
        statuses: ['pending', 'working'],
        limit: maxInFlight,
      });
      const room = maxInFlight - inFlight.items.length;
      if (room > 0) return room;
      await this.#clock.sleep(ROOM_POLL_MS, signal);
    }
  }

  async #ingest(
    connector: Connector,
    message: PulledMessage,
    settings: PullSettings,
    logger: Logger | undefined,
  ): Promise<void> {
    const trigger = normalizePulled(message, connector, settings.filter);
    if (!trigger) {
      this.#observe(connector.type, 'ignored');
      return;
    }
    const { receipt, created } = await this.#pipeline.enqueue(connector, trigger);
    if (!created) {
      logger?.info('pulled a message already delivered; acknowledging it again', {
        transportId: message.transportId,
        receiptId: receipt.id,
      });
    }
    this.#observe(connector.type, created ? 'enqueued' : 'duplicate');
  }

  async #reportOverCapacity(connector: Connector): Promise<void> {
    if (connector.error?.code === 'PULL_OVER_CAPACITY') return;
    await this.#setError(
      connector,
      new MaError({
        code: 'PULL_OVER_CAPACITY',
        category: 'quota',
        message:
          `More pull connectors are active than this deployment's replicas read (${this.#capacity} each), so this one ` +
          "is not being read. Deactivate pull connectors that are not needed, or add a replica; workspaces' first " +
          'connectors are read before any workspace gets more, so the busiest workspaces wait first.',
      }),
    );
  }

  /** Record (or clear) the consumer's error on the connector. Returns whether it was written. */
  async #setError(connector: Connector, failure: MaError | undefined): Promise<boolean> {
    const now = this.#clock.now();
    try {
      await this.#store.connectors.update(connector.id, {
        error: failure
          ? {
              code: failure.code,
              message: failure.message,
              details: failure.details ?? {},
              occurredAt: now,
              retryable: true,
            }
          : undefined,
        updatedAt: now,
      });
      return true;
    } catch (error) {
      this.#logger?.warn('could not record a pull consumer error on its connector', {
        connectorId: connector.id,
        error,
      });
      return false;
    }
  }

  #observe(type: string, outcome: PullOutcome): void {
    try {
      this.#onMessage?.(type, outcome);
    } catch (error) {
      this.#logger?.error('pull onMessage observer failed', { error });
    }
  }
}

/** What a running consumer depends on; any change restarts it. */
function fingerprint(connector: Connector): string {
  return JSON.stringify([connector.type, connector.config, connector.secretCredentialId ?? null]);
}
