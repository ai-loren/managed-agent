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
 *
 * Replicas sharing one store each have a bus, and an event reaches only the
 * bus of the process that appended it. So each session with subscribers here
 * keeps a cursor — the last sequence handed on, in order — and what another
 * process appended is read from the log: when a local event arrives past a
 * gap, and on a poll. Subscribers see one gap-free stream in sequence order;
 * SSE's resume depends on that, since it drops anything at or below the last
 * sequence it sent.
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
/** Events read per step when filling a gap from the log. */
const CATCH_UP_BATCH = 200;

export interface EventBusOptions {
  /**
   * How often to look for events other processes appended to a session with
   * subscribers here — replicas sharing one store. 0, the default, never
   * looks: one process sees every event as it publishes it.
   */
  peerPollMs?: number;
}

/** A session with subscribers here. */
interface Watch {
  /** The last sequence handed to the session's subscribers, in order; unset until read at subscription. */
  cursor: number | undefined;
  /** Events past the cursor, waiting for what comes before them. */
  held: SessionEvent[];
  catchingUp: boolean;
}

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
  readonly #watches = new Map<string, Watch>();
  readonly #peerPollMs: number;
  #polling: AbortController | undefined;

  constructor(store: Store, clock: Clock, logger?: Logger, options: EventBusOptions = {}) {
    this.#store = store;
    this.#clock = clock;
    this.#logger = logger;
    this.#peerPollMs = options.peerPollMs ?? 0;
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
    const prepared = this.#prepare(inputs);
    const stored = await this.#store.events.append(sessionId, prepared);
    for (const event of stored) this.#fanout(event);
    return stored;
  }

  /**
   * Validate and shape event inputs into storable records (no write, no fanout).
   * Exposed so a caller that must append events inside an existing transaction
   * can prepare them, write via the transaction's `events.append`, and fan out
   * after commit — see `SessionService.transition`.
   */
  prepare(inputs: readonly EventInput[]): Omit<SessionEvent, 'seq'>[] {
    return this.#prepare(inputs);
  }

  /** Deliver already-persisted events to subscribers (call after commit). */
  fanout(events: readonly SessionEvent[]): void {
    for (const event of events) this.#fanout(event);
  }

  #prepare(inputs: readonly EventInput[]): Omit<SessionEvent, 'seq'>[] {
    const now = this.#clock.now();
    return inputs.map((input) => {
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
    if (!this.#watches.has(options.sessionId)) this.#watch(options.sessionId);

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
        if (current && current.size === 0) {
          this.#bySession.delete(options.sessionId);
          this.#watches.delete(options.sessionId);
          if (this.#watches.size === 0) this.#polling?.abort();
        }
      },
    };
  }

  /**
   * Start a session's cursor at the log as it stands. Both store drivers answer
   * from the call itself, so the mark is taken at subscription: what another
   * process appends after it is this subscriber's, what came before is history.
   */
  #watch(sessionId: string): void {
    const watch: Watch = { cursor: undefined, held: [], catchingUp: true };
    this.#watches.set(sessionId, watch);
    void this.#store.events
      .lastSeq(sessionId)
      .then(
        (seq) => {
          watch.cursor = seq;
        },
        (error: unknown) => {
          this.#logger?.warn("could not read a session's last sequence; its first live event starts the stream", { sessionId, error });
        },
      )
      .finally(() => {
        watch.catchingUp = false;
        if (this.#watches.get(sessionId) === watch) this.#release(sessionId, watch);
      });
    this.#startPolling();
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
    this.#deliver(event);
  }

  /** A persisted event, handed on in sequence order. */
  #fanout(event: SessionEvent): void {
    const watch = this.#watches.get(event.sessionId);
    if (!watch) return;
    if (watch.catchingUp) {
      watch.held.push(event);
      return;
    }
    this.#admit(event.sessionId, watch, event);
  }

  /** Hand `event` on if it is next; past a gap, hold it and read what is missing from the log. */
  #admit(sessionId: string, watch: Watch, event: SessionEvent): void {
    const cursor = watch.cursor ?? event.seq - 1;
    if (event.seq <= cursor) return;
    if (event.seq === cursor + 1) {
      watch.cursor = event.seq;
      this.#deliver(event);
      return;
    }
    watch.held.push(event);
    void this.#catchUp(sessionId, watch);
  }

  /** Admit the held events; one past a new gap holds the rest behind another catch-up, which reads in order. */
  #release(sessionId: string, watch: Watch): void {
    const held = watch.held;
    watch.held = [];
    for (const event of held) {
      if (watch.catchingUp) watch.held.push(event);
      else this.#admit(sessionId, watch, event);
    }
  }

  /** Read the log past the cursor and hand it on, then whatever was held meanwhile. */
  async #catchUp(sessionId: string, watch: Watch): Promise<void> {
    if (watch.catchingUp) return;
    watch.catchingUp = true;
    try {
      for (;;) {
        const batch = await this.#store.events.read(sessionId, { fromSeq: (watch.cursor ?? 0) + 1, limit: CATCH_UP_BATCH });
        if (this.#watches.get(sessionId) !== watch) return;
        for (const event of batch) {
          if (event.seq <= (watch.cursor ?? 0)) continue;
          watch.cursor = event.seq;
          this.#deliver(event);
        }
        if (batch.length < CATCH_UP_BATCH) break;
      }
    } catch (error) {
      // Hand on what is here rather than hold it for a read that may not come:
      // the subscribers then see what one process alone would have shown them.
      this.#logger?.warn("could not read a session's log to fill a gap in its live events", { sessionId, error });
      for (const event of watch.held.sort((a, b) => a.seq - b.seq)) {
        if (event.seq <= (watch.cursor ?? 0)) continue;
        watch.cursor = event.seq;
        this.#deliver(event);
      }
      watch.held = [];
    } finally {
      watch.catchingUp = false;
    }
    if (this.#watches.get(sessionId) === watch) this.#release(sessionId, watch);
  }

  #startPolling(): void {
    if (this.#peerPollMs <= 0 || this.#polling) return;
    const controller = new AbortController();
    this.#polling = controller;
    void this.#poll(controller.signal).finally(() => {
      if (this.#polling !== controller) return;
      this.#polling = undefined;
      // A subscriber that arrived while this loop was winding down found it still set.
      if (this.#watches.size > 0) this.#startPolling();
    });
  }

  /** While anything is subscribed, look for sessions whose log moved past their cursor. */
  async #poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.#watches.size > 0) {
      try {
        await this.#clock.sleep(this.#peerPollMs, signal);
      } catch {
        return;
      }
      if (this.#watches.size === 0) return;
      try {
        const latest = await this.#store.events.lastSeqs([...this.#watches.keys()]);
        for (const [sessionId, seq] of latest) {
          const watch = this.#watches.get(sessionId);
          if (watch && !watch.catchingUp && watch.cursor !== undefined && seq > watch.cursor) void this.#catchUp(sessionId, watch);
        }
      } catch (error) {
        this.#logger?.warn('could not look for events other processes appended', { error });
      }
    }
  }

  /** Put an event in each matching subscriber's queue. */
  #deliver(event: SessionEvent): void {
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
    this.#watches.clear();
    this.#polling?.abort();
  }
}
