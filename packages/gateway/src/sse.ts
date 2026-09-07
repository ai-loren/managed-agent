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

/** Write one SSE frame. */
function writeEvent(res: ServerResponse, event: SessionEvent): void {
  // The `id:` line is what makes browser reconnection resume correctly.
  res.write(`id: ${event.seq}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeComment(res: ServerResponse, text: string): void {
  res.write(`: ${text}\n\n`);
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

    // Buffer live events arriving while we replay history. Without this there
    // is a window between "finished reading the log" and "subscribed" where an
    // event would be lost.
    const pending: SessionEvent[] = [];
    let replaying = true;
    let lastSent = request.fromSeq - 1;
    let closed = false;

    const send = (event: SessionEvent): void => {
      if (closed) return;
      // Suppress anything replay already delivered, so the handover produces
      // no duplicates.
      if (event.seq <= lastSent) return;
      lastSent = event.seq;
      writeEvent(res, event);
    };

    const subscription = bus.subscribe({
      sessionId: request.sessionId,
      ...(request.types ? { types: request.types } : {}),
      onEvent: (event) => {
        if (replaying) pending.push(event);
        else send(event);
      },
      onLagged: ({ earliestSeq, droppedCount }) => {
        if (closed) return;
        // Tell the client where it can resume from rather than silently
        // dropping events it will never learn about.
        writeEvent(res, {
          seq: lastSent,
          id: 'lagged',
          sessionId: request.sessionId,
          workspaceId: '',
          ts: clock.now(),
          type: 'stream.lagged',
          payload: { earliestSeq, droppedCount },
        } as SessionEvent);
      },
    });

    const heartbeat = this.#startHeartbeat(res, heartbeatMs, () => closed);

    const finish = (): void => {
      if (closed) return;
      closed = true;
      heartbeat.abort();
      subscription.close();
      res.end();
    };

    request.signal.addEventListener('abort', finish, { once: true });
    res.on('close', finish);

    try {
      // Replay history in batches so a long log does not build one huge buffer.
      let cursor = request.fromSeq;
      for (;;) {
        if (closed) return;
        const batch = await store.events.read(request.sessionId, {
          fromSeq: cursor,
          limit: batchSize,
          ...(request.types ? { types: request.types } : {}),
        });
        if (batch.length === 0) break;
        for (const event of batch) send(event);
        cursor = batch[batch.length - 1]!.seq + 1;
        if (batch.length < batchSize) break;
      }

      // Hand over: flush what arrived during replay, then go live.
      replaying = false;
      for (const event of pending) send(event);
      pending.length = 0;

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
export function resolveFromSeq(
  lastEventId: string | string[] | undefined,
  fromSeqParam: string | null,
): number {
  const header = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  if (header !== undefined) {
    const parsed = Number(header);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed + 1;
  }
  if (fromSeqParam !== null) {
    const parsed = Number(fromSeqParam);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}
