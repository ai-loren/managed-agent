/**
 * The event bus.
 *
 * Durability and delivery are separated on purpose:
 *
 *  - **The log is the commit.** `publish` writes to the store first. Once that
 *    returns, the event happened, whether or not any subscriber saw it.
 *  - **Fanout is best-effort.** Live delivery to subscribers is a convenience
 *    over the durable log, never a substitute for it.
 *
 * That split is what makes a slow consumer harmless. Rather than buffering
 * without limit (memory) or silently dropping (lost events), a lagging
 * subscriber gets a `stream.lagged` frame telling it the earliest sequence
 * still available, and it re-reads from the log. Slow consumers degrade into
 * catch-up reads instead of taking the process down.
 */

import { newId, type Clock, type Logger } from '@ma/core';
import {
  isTransientEvent,
  matchesEventFilter,
  validateEventPayload,
  type EventType,
  type SessionEvent,
} from '@ma/contracts';
import type { Store } from '@ma/store';

/** What a caller hands to `publish`; the bus assigns `seq` and `id`. */
export interface EventInput<K extends EventType = EventType> {
  sessionId: string;
  workspaceId: string;
  type: K;
  payload: unknown;
  turn?: number;
  itemId?: string;
  /** Defaults to the clock. Supplied only when replaying historical events. */
  ts?: number;
}

export interface Subscription {
  /** Stop receiving events and release the buffer. */
  close(): void;
  readonly sessionId: string;
  readonly closed: boolean;
}

export interface SubscribeOptions {
  sessionId: string;
  /** Type filters; `tool.` matches the namespace. Empty means everything. */
  types?: readonly string[];
  /** Events past this point are buffered per subscriber before lagging. */
  bufferLimit?: number;
  onEvent(event: SessionEvent): void;
  /**
   * The subscriber fell behind and events were dropped. It must re-read from
   * `earliestSeq` to catch up.
   */
  onLagged?(info: { earliestSeq: number; droppedCount: number }): void;
}

const DEFAULT_BUFFER_LIMIT = 512;

interface Subscriber {
  id: string;
  sessionId: string;
  types: readonly string[];
  bufferLimit: number;
  /** Pending events not yet handed to `onEvent`. */
  queue: SessionEvent[];
  dropped: number;
  /** Set once the subscriber has lagged, so it is told exactly once. */
  lagged: boolean;
  draining: boolean;
  closed: boolean;
  onEvent(event: SessionEvent): void;
  onLagged?(info: { earliestSeq: number; droppedCount: number }): void;
}

export class EventBus {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #logger: Logger | undefined;
  /** Subscribers indexed by session, so a publish touches only its own. */
  readonly #bySession = new Map<string, Set<Subscriber>>();

  constructor(store: Store, clock: Clock, logger?: Logger) {
    this.#store = store;
    this.#clock = clock;
    this.#logger = logger;
  }

  /**
   * Append events to the log and fan them out.
   *
   * Payloads are validated against the schema for their type before the write.
   * Events arriving from a sandbox are untrusted input, and an unvalidated
   * payload would poison the log permanently — every future replay would
   * re-deliver it.
   */
  async publish(inputs: readonly EventInput[]): Promise<SessionEvent[]> {
    if (inputs.length === 0) return [];

    const sessionId = inputs[0]!.sessionId;
    const now = this.#clock.now();
    const prepared = inputs.map((input) => {
      const validation = validateEventPayload(input.type, input.payload);
      if (!validation.ok) {
        // Do not persist a malformed payload; the log is forever.
        throw new Error(
          `Invalid payload for '${input.type}': ${validation.issues
            .map((issue) => `${issue.path} ${issue.message}`)
            .join('; ')}`,
        );
      }
      return {
        id: newId('event', now),
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        ts: input.ts ?? now,
        type: input.type,
        ...(input.turn === undefined ? {} : { turn: input.turn }),
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        payload: validation.value,
      } as Omit<SessionEvent, 'seq'>;
    });

    const stored = await this.#store.events.append(sessionId, prepared);
    for (const event of stored) this.#fanout(event);
    return stored;
  }

  /** Publish one event. */
  async publishOne(input: EventInput): Promise<SessionEvent> {
    const [event] = await this.publish([input]);
    return event!;
  }

  subscribe(options: SubscribeOptions): Subscription {
    const subscriber: Subscriber = {
      id: newId('event', this.#clock.now()),
      sessionId: options.sessionId,
      types: options.types ?? [],
      bufferLimit: options.bufferLimit ?? DEFAULT_BUFFER_LIMIT,
      queue: [],
      dropped: 0,
      lagged: false,
      draining: false,
      closed: false,
      onEvent: options.onEvent,
      ...(options.onLagged ? { onLagged: options.onLagged } : {}),
    };

    let set = this.#bySession.get(options.sessionId);
    if (!set) {
      set = new Set();
      this.#bySession.set(options.sessionId, set);
    }
    set.add(subscriber);

    return {
      sessionId: options.sessionId,
      get closed() {
        return subscriber.closed;
      },
      close: () => {
        subscriber.closed = true;
        subscriber.queue.length = 0;
        const current = this.#bySession.get(options.sessionId);
        current?.delete(subscriber);
        if (current && current.size === 0) this.#bySession.delete(options.sessionId);
      },
    };
  }

  /** Live subscriber count, for metrics and tests. */
  subscriberCount(sessionId?: string): number {
    if (sessionId) return this.#bySession.get(sessionId)?.size ?? 0;
    let total = 0;
    for (const set of this.#bySession.values()) total += set.size;
    return total;
  }

  /**
   * Emit a transient frame — heartbeat or lag notice — to live subscribers
   * only. These never reach the log: replaying a heartbeat would be nonsense.
   */
  emitTransient(sessionId: string, event: SessionEvent): void {
    if (!isTransientEvent(event.type)) {
      throw new Error(`'${event.type}' is a persisted event and must go through publish()`);
    }
    this.#fanout(event);
  }

  #fanout(event: SessionEvent): void {
    const subscribers = this.#bySession.get(event.sessionId);
    if (!subscribers) return;

    for (const subscriber of subscribers) {
      if (subscriber.closed) continue;
      if (!matchesEventFilter(event.type, subscriber.types)) continue;

      if (subscriber.queue.length >= subscriber.bufferLimit) {
        // Drop rather than grow. One slow SSE client must not be able to
        // exhaust the process's memory for everyone else.
        subscriber.dropped++;
        if (!subscriber.lagged) {
          subscriber.lagged = true;
          this.#notifyLagged(subscriber, event.sessionId);
        }
        continue;
      }

      subscriber.queue.push(event);
      this.#drain(subscriber);
    }
  }

  /**
   * Hand queued events to the subscriber one at a time.
   *
   * The `draining` guard makes delivery re-entrant-safe: a handler that
   * publishes another event would otherwise recurse into this loop and deliver
   * out of order.
   */
  #drain(subscriber: Subscriber): void {
    if (subscriber.draining) return;
    subscriber.draining = true;
    try {
      while (subscriber.queue.length > 0 && !subscriber.closed) {
        const event = subscriber.queue.shift()!;
        try {
          subscriber.onEvent(event);
        } catch (error) {
          // A throwing subscriber is its own problem; it must not break the
          // publisher or the other subscribers.
          this.#logger?.warn('event subscriber threw', {
            sessionId: subscriber.sessionId,
            seq: event.seq,
            error,
          });
        }
      }
    } finally {
      subscriber.draining = false;
    }
  }

  #notifyLagged(subscriber: Subscriber, sessionId: string): void {
    void this.#store.events
      .earliestSeq(sessionId)
      .then((earliestSeq) => {
        if (subscriber.closed) return;
        subscriber.onLagged?.({ earliestSeq, droppedCount: subscriber.dropped });
        this.#logger?.warn('subscriber lagged', {
          sessionId,
          droppedCount: subscriber.dropped,
          earliestSeq,
        });
      })
      .catch((error: unknown) => {
        this.#logger?.error('failed to report lag', { sessionId, error });
      });
  }

  /** Drop every subscriber. Called during shutdown. */
  closeAll(): void {
    for (const set of this.#bySession.values()) {
      for (const subscriber of set) {
        subscriber.closed = true;
        subscriber.queue.length = 0;
      }
    }
    this.#bySession.clear();
  }
}
