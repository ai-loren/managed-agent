/**
 * Server-sent events with exact resume.
 *
 * The problem this solves: a client watching a session disconnects — a laptop
 * sleeps, a proxy times out — and must resume without missing or repeating an
 * event. The mechanism is small but every part is load-bearing:
 *
 *  1. Each frame's SSE `id:` field carries the event's `seq`. Browsers send the
 *     last one back as `Last-Event-ID` automatically, so resume needs no client
 *     code at all.
 *  2. On connect we *first* replay persisted events from the requested
 *     sequence, *then* attach the live subscription — and events arriving
 *     during the replay are buffered rather than dropped, so there is no gap at
 *     the handover.
 *  3. Anything already sent during replay is suppressed by sequence when the
 *     live feed takes over, so there is no duplicate either.
 *
 * A consumer that cannot keep up gets a `stream.lagged` frame naming the
 * earliest sequence still available and re-reads from the log, rather than the
 * server buffering without limit on its behalf.
 */

import type { ServerResponse } from 'node:http';

import { type Clock, type Logger } from '@ma/core';
import type { SessionEvent } from '@ma/contracts';
import type { EventBus } from '@ma/engine';
import type { Store } from '@ma/store';

export interface SseOptions {
  bus: EventBus;
  store: Store;
  clock: Clock;
  logger?: Logger;
  /** Idle interval between keep-alive comments. */
  heartbeatMs?: number;
  /** Events replayed per batch during catch-up. */
  replayBatchSize?: number;
  /**
   * Live events held while replay catches up, before the client is declared
   * lagged. Bounded for the same reason the bus bounds its own queues.
   */
  replayBufferLimit?: number;
  /**
   * How long to wait for a blocked client's socket to `drain` before giving up
   * and disconnecting it. A client that has stopped reading must not pin server
   * memory; it resumes later from its `Last-Event-ID`, so nothing is lost.
   */
  drainTimeoutMs?: number;
}

export interface StreamRequest {
  sessionId: string;
  /** Inclusive lower bound. Usually `Last-Event-ID + 1`. */
  fromSeq: number;
  /** Type filters; `tool.` matches the namespace. */
  types?: string[];
  signal: AbortSignal;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_REPLAY_BATCH = 200;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
/**
 * Cap on the hand-over buffer.
 *
 * The bus bounds each subscriber's queue and drops with a `stream.lagged`
 * signal rather than growing — but that bound did not reach here. This buffer
 * is filled from `onEvent`, which returns immediately, so the bus sees a fast
 * subscriber and hands over everything; 20,000 events published during one
 * replay produced a 20,000-entry buffer with no signal to anyone. Memory then
 * scales with events-during-replay times concurrent replaying clients.
 *
 * Generous enough that an ordinary catch-up never trips it: a replay is
 * typically far quicker than the session produces this many events.
 */
const DEFAULT_REPLAY_BUFFER = 2000;

/**
 * Write one SSE frame. Returns `res.write()`'s backpressure signal from the last
 * chunk: `false` means the socket buffer is full and the caller should wait for
 * `drain` before writing more.
 */
function writeEvent(res: ServerResponse, event: SessionEvent): boolean {
  // The `id:` line is what makes browser reconnection resume correctly.
  res.write(`id: ${event.seq}\n`);
  res.write(`event: ${event.type}\n`);
  return res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeComment(res: ServerResponse, text: string): boolean {
  return res.write(`: ${text}\n\n`);
}

/**
 * Wait for the socket to drain, bounded by a timeout.
 *
 * Resolves `true` when the socket emits `drain` (buffer emptied, safe to keep
 * writing), `false` on the timeout, an abort, or the socket closing — the caller
 * then stops rather than buffering for a client that has stopped reading. Every
 * listener and the timer are cleaned up on whichever path settles first, so this
 * cannot leak a `drain`/`close` listener or keep the process alive.
 */
function waitForDrain(
  res: ServerResponse,
  clock: Clock,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = new AbortController();
    let settled = false;
    const settle = (drained: boolean): void => {
      if (settled) return;
      settled = true;
      timer.abort();
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(drained);
    };
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    const onAbort = (): void => settle(false);
    res.once('drain', onDrain);
    // A client that disconnects mid-backpressure settles the wait immediately,
    // rather than dangling until the drain timeout.
    res.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    void clock.sleep(timeoutMs, timer.signal).then(
      () => settle(false),
      () => {
        /* aborted because drain/abort/close won the race */
      },
    );
  });
}

/**
 * Tell the client it fell behind, without an `id:` line.
 *
 * This used to go through `writeEvent` with `seq: lastSent`, which re-emitted a
 * sequence the client had already been given. A browser stores the last `id:`
 * it saw and resumes from it, so the notice rewound the cursor by one and the
 * next connection replayed that event — a duplicate produced by the very frame
 * warning about a gap. A notice is metadata about the stream, not a position in
 * it, so it carries no id at all.
 */
function writeLagged(res: ServerResponse, info: Record<string, unknown>): void {
  res.write(`event: stream.lagged\n`);
  res.write(`data: ${JSON.stringify(info)}\n\n`);
}

export class SseBridge {
  readonly #options: SseOptions;

  constructor(options: SseOptions) {
    this.#options = options;
  }

  /**
   * Stream a session's events until the client disconnects.
   *
   * Resolves when the stream ends. The caller has already written headers via
   * `openStream`.
   */
  async stream(request: StreamRequest, res: ServerResponse): Promise<void> {
    const { bus, store, clock, logger } = this.#options;
    const heartbeatMs = this.#options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const batchSize = this.#options.replayBatchSize ?? DEFAULT_REPLAY_BATCH;
    const drainTimeoutMs = this.#options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

    // Buffer live events arriving while we replay history. Without this there
    // is a window between "finished reading the log" and "subscribed" where an
    // event would be lost.
    const pending: SessionEvent[] = [];
    const pendingLimit = this.#options.replayBufferLimit ?? DEFAULT_REPLAY_BUFFER;
    let replaying = true;
    let overflowed = false;
    let lastSent = request.fromSeq - 1;
    let closed = false;

    const heartbeat = this.#startHeartbeat(res, heartbeatMs, () => closed);

    const finish = (): void => {
      if (closed) return;
      closed = true;
      heartbeat.abort();
      subscription.close();
      res.end();
    };

    /**
     * Write one event, honouring backpressure. If the socket buffer is full,
     * wait for it to drain before returning — pacing the caller (the replay loop
     * or the live pump) to the client instead of buffering without limit. A
     * client that never drains within the timeout is disconnected. Returns false
     * when the stream ended (drain timed out, or it was already closed), so the
     * caller stops.
     */
    const emit = async (event: SessionEvent): Promise<boolean> => {
      if (closed) return false;
      // Suppress anything replay already delivered, so the handover produces
      // no duplicates.
      if (event.seq <= lastSent) return true;
      lastSent = event.seq;
      if (writeEvent(res, event) === false) {
        const drained = await waitForDrain(res, clock, drainTimeoutMs, request.signal);
        if (!drained) {
          finish();
          return false;
        }
      }
      return !closed;
    };

    // The live write queue. `onEvent` is synchronous (it cannot await drain), so
    // it enqueues and a pump drains the queue with backpressure. Bounded like the
    // replay buffer: on overflow, drop and signal `stream.lagged` once, matching
    // the bus's own contract — the client re-reads from the log, the source of
    // truth, so nothing is lost.
    const liveQueue: SessionEvent[] = [];
    let pumping = false;
    let handedOver = false;
    let liveOverflowed = false;
    const pump = async (): Promise<void> => {
      // Do not run until the pending-flush has completed. The flush and the pump
      // share the monotonic `lastSent` cursor, and `emit` advances it before
      // awaiting drain; if the pump emitted a higher live seq while the flush was
      // parked mid-drain, `lastSent` would jump past un-flushed lower-seq pending
      // events and `emit` would silently suppress them — a permanent gap. Live
      // events still *enqueue* during the flush; they are only *emitted* after it.
      if (pumping || !handedOver) return;
      pumping = true;
      try {
        while (!closed && liveQueue.length > 0) {
          const next = liveQueue.shift()!;
          // eslint-disable-next-line no-await-in-loop -- backpressure is the point
          if (!(await emit(next))) return;
        }
        if (!closed && liveOverflowed) {
          liveOverflowed = false;
          writeLagged(res, { earliestSeq: lastSent + 1, droppedCount: 0, during: 'live' });
        }
      } finally {
        pumping = false;
      }
    };

    const subscription = bus.subscribe({
      sessionId: request.sessionId,
      ...(request.types ? { types: request.types } : {}),
      onEvent: (event) => {
        if (replaying) {
          if (pending.length >= pendingLimit) {
            // Drop rather than grow, matching the bus's contract. The client is
            // told below, once, and can resume from the sequence it last saw —
            // the log is the source of truth, so nothing is actually lost.
            overflowed = true;
            return;
          }
          pending.push(event);
          return;
        }
        // Live: enqueue for the backpressure-aware pump rather than writing here
        // (this callback cannot await drain).
        if (liveQueue.length >= pendingLimit) {
          liveOverflowed = true;
          return;
        }
        liveQueue.push(event);
        void pump();
      },
      onLagged: ({ earliestSeq, droppedCount }) => {
        if (closed) return;
        // Tell the client where it can resume from rather than silently
        // dropping events it will never learn about.
        writeLagged(res, { earliestSeq, droppedCount });
      },
    });

    request.signal.addEventListener('abort', finish, { once: true });
    res.on('close', finish);

    try {
      // Replay history in batches so a long log does not build one huge buffer,
      // and pace each write to the client so a slow consumer cannot make the
      // socket buffer grow without bound.
      let cursor = request.fromSeq;
      for (;;) {
        if (closed) return;
        const batch = await store.events.read(request.sessionId, {
          fromSeq: cursor,
          limit: batchSize,
          ...(request.types ? { types: request.types } : {}),
        });
        if (batch.length === 0) break;
        for (const event of batch) {
          if (!(await emit(event))) return; // disconnected mid-replay
        }
        cursor = batch[batch.length - 1]!.seq + 1;
        if (batch.length < batchSize) break;
      }

      // Hand over: flush what arrived during replay, then go live. `replaying`
      // stops new events routing to `pending`; they enqueue to `liveQueue`
      // instead, but the pump stays gated by `handedOver` until this flush is
      // done, so no live event is emitted (and `lastSent` cannot jump) until
      // every buffered pending event has been written.
      replaying = false;
      for (const event of pending) {
        if (!(await emit(event))) return;
      }
      pending.length = 0;

      if (overflowed && !closed) {
        // Reported after the flush, so `earliestSeq` names the first sequence
        // the client has not seen. Nothing is actually lost here: an event
        // dropped from the hand-over buffer is still in the log, and the replay
        // loop above reads it. This says "memory was capped", not "data gone".
        writeLagged(res, { earliestSeq: lastSent + 1, droppedCount: 0, during: 'replay' });
      }

      // The flush is complete: open the live pump and drain anything that queued
      // during it, in order, after the pending events.
      handedOver = true;
      void pump();

      // Stay open until the client leaves.
      await new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        request.signal.addEventListener('abort', () => resolve(), { once: true });
        res.on('close', () => resolve());
      });
    } catch (error) {
      logger?.error('sse stream failed', { sessionId: request.sessionId, error });
    } finally {
      finish();
    }
  }

  /**
   * Periodic keep-alive comments.
   *
   * A silent stream is indistinguishable from a dead one to an intermediary,
   * and proxies close idle connections. A comment costs almost nothing and
   * keeps the socket demonstrably alive.
   */
  #startHeartbeat(res: ServerResponse, intervalMs: number, isClosed: () => boolean): AbortController {
    const controller = new AbortController();
    const tick = async (): Promise<void> => {
      while (!controller.signal.aborted && !isClosed()) {
        try {
          await this.#options.clock.sleep(intervalMs, controller.signal);
        } catch {
          return; // aborted
        }
        if (controller.signal.aborted || isClosed()) return;
        writeComment(res, 'heartbeat');
      }
    };
    void tick();
    return controller;
  }
}

/**
 * Write SSE headers and disable buffering.
 *
 * `X-Accel-Buffering: no` matters in practice: nginx buffers responses by
 * default, which turns a live stream into one delivery at the end.
 */
export function openStream(res: ServerResponse, requestId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': requestId,
  });
  // Flush the headers so the client sees the stream open immediately rather
  // than after the first event.
  res.flushHeaders?.();
}

/**
 * The sequence to resume from.
 *
 * `Last-Event-ID` is set by the browser automatically on reconnect and wins
 * over an explicit query parameter, because it reflects what this client
 * actually received rather than what it asked for when it first connected.
 */
/**
 * A sequence from untrusted input, or `undefined` if it is not one.
 *
 * `Number()` is deliberately not used alone. It maps `''` and `'   '` to 0,
 * which passes `Number.isInteger` — so an empty `Last-Event-ID`, which a
 * browser sends before it has received anything, resolved to "resume from 1"
 * and silently skipped the first event of the session. It also accepts `0x10`
 * and `1e10`, neither of which this protocol ever emits, and saturates values
 * past `MAX_SAFE_INTEGER` into a nearby integer rather than rejecting them.
 *
 * Digits only, therefore, with an explicit bound.
 */
function parseSeq(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[0-9]{1,15}$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function resolveFromSeq(
  lastEventId: string | string[] | undefined,
  fromSeqParam: string | null,
): number {
  const header = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const fromHeader = parseSeq(header);
  // `+ 1`: the header names the last event the client *received*, so it
  // resumes from the next one.
  if (fromHeader !== undefined) return fromHeader + 1;

  const fromParam = parseSeq(fromSeqParam ?? undefined);
  if (fromParam !== undefined) return fromParam;

  return 0;
}
