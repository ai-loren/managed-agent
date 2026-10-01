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
 */

import { MaError, type Clock, type Logger } from '@ma/core';
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
}

const DEFAULT_SCAN_MS = 5_000;
const MAX_CONNECTORS = 200;
const ROOM_POLL_MS = 1_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

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

  /** Stop every consumer and wait for each to close its connection. */
  async stop(): Promise<void> {
    this.#stop?.abort();
    await this.#scanning;
    this.#stop = undefined;
    this.#scanning = undefined;
    const loops = [...this.#loops.values()];
    this.#loops.clear();
    for (const loop of loops) loop.abort.abort();
    await Promise.all(loops.map((loop) => loop.done));
  }

  /**
   * Reconcile the running consumers with the active connectors: start new ones,
   * stop deactivated ones, restart an edited one (new queue, new credential).
   */
  async scan(): Promise<void> {
    let connectors: Connector[];
    try {
      connectors = await this.#store.connectors.findActiveByTypes(Object.keys(this.#sources), MAX_CONNECTORS);
    } catch (error) {
      this.#logger?.error('could not list pull connectors; will retry', { error });
      return;
    }
    if (connectors.length === MAX_CONNECTORS) {
      this.#logger?.warn('more active pull connectors than one replica consumes; the rest wait', {
        consumed: MAX_CONNECTORS,
      });
    }
    if (this.#stop?.signal.aborted) return;

    const wanted = new Map(connectors.map((connector) => [connector.id, connector]));
    for (const [id, loop] of this.#loops) {
      const connector = wanted.get(id);
      if (!connector || fingerprint(connector) !== loop.fingerprint) {
        this.#loops.delete(id);
        loop.abort.abort();
        await loop.done;
      }
    }
    for (const connector of connectors) {
      if (this.#loops.has(connector.id)) continue;
      const abort = new AbortController();
      this.#loops.set(connector.id, {
        fingerprint: fingerprint(connector),
        abort,
        done: this.#consume(connector, abort.signal),
      });
    }
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
          const batch = await source.receive(room, signal);
          if (errorShown) {
            errorShown = !(await this.#setError(connector, undefined));
            lastError = '';
          }
          for (const message of batch.messages) await this.#ingest(connector, message, settings, logger);
          await batch.ack();
          backoff = INITIAL_BACKOFF_MS;
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
