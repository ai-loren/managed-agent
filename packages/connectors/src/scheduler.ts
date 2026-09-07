/**
 * The scheduler.
 *
 * Runs the platform's periodic work: firing cron schedules, draining the
 * delivery queue, and reaping anything whose lease lapsed. One component rather
 * than several daemons, because these jobs share the same concerns — they must
 * be safe to run in more than one replica, and they must not pile up when a
 * tick takes longer than its interval.
 *
 * Both properties come from the same two mechanisms: every claim is a
 * compare-and-set in the store, and a tick that overruns is skipped rather than
 * queued.
 */

import { newId, type Clock, type Logger } from '@ma/core';
import {
  parseOrThrow,
  scheduleConfigSchema,
  type Connector,
  type ScheduleConfig,
} from '@ma/contracts';
import type { Store } from '@ma/store';
import type { SessionService } from '@ma/engine';

import { scheduleTrigger } from './adapters.ts';
import { nextFireTime } from './cron.ts';
import type { DeliveryPipeline } from './pipeline.ts';

export interface SchedulerOptions {
  store: Store;
  clock: Clock;
  pipeline: DeliveryPipeline;
  sessions: SessionService;
  logger?: Logger;
  /** How often to look for due schedules and work. */
  tickMs?: number;
  /** Deliveries processed per tick before yielding. */
  batchSize?: number;
  /** Called when a sandbox lease lapses, so the broker can reclaim it. */
  onSandboxReap?: () => Promise<void>;
}

export interface TickReport {
  schedulesFired: number;
  deliveriesProcessed: number;
  zombiesReaped: number;
  sessionsExpired: number;
  durationMs: number;
}

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_BATCH = 10;

export class Scheduler {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #pipeline: DeliveryPipeline;
  readonly #sessions: SessionService;
  readonly #logger: Logger | undefined;
  readonly #tickMs: number;
  readonly #batchSize: number;
  readonly #onSandboxReap: (() => Promise<void>) | undefined;

  #running = false;
  #ticking = false;
  /** The in-flight tick, so `stop` can await it instead of polling for it. */
  #inFlight: Promise<unknown> | undefined;
  #stop: AbortController | undefined;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#pipeline = options.pipeline;
    this.#sessions = options.sessions;
    this.#logger = options.logger;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.#onSandboxReap = options.onSandboxReap;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Start ticking until `stop` is called. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stop = new AbortController();
    void this.#loop(this.#stop.signal);
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#stop?.abort();

    // Await the tick rather than polling for it. `while (this.#ticking) await
    // Promise.resolve()` spins on the *microtask* queue, which starves the
    // macrotask queue — so if the in-flight tick is waiting on I/O or a timer
    // it can never make progress and `stop` never returns. This runs in
    // `platform.stop()` before `store.close()`, so shutdown wedged with it.
    try {
      await this.#inFlight;
    } catch {
      // A tick that failed on its way out is already logged by the loop; it
      // must not stop shutdown.
    }
  }

  async #loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        // A failing tick must not stop the scheduler: the next one may succeed,
        // and a dead scheduler silently stops every cron job on the platform.
        this.#logger?.error('scheduler tick failed', { error });
      }
      try {
        await this.#clock.sleep(this.#tickMs, signal);
      } catch {
        return; // aborted
      }
    }
  }

  /**
   * One pass over the platform's periodic work.
   *
   * Skipped entirely if the previous tick is still running, so a slow pass
   * cannot cause overlapping passes to fight over the same rows.
   */
  async tick(): Promise<TickReport> {
    if (this.#ticking) {
      return {
        schedulesFired: 0,
        deliveriesProcessed: 0,
        zombiesReaped: 0,
        sessionsExpired: 0,
        durationMs: 0,
      };
    }

    this.#ticking = true;
    const startedAt = this.#clock.monotonic();

    // Published so `stop` has something to await. Resolved in the `finally`
    // below, on every path including failure.
    let settle = (): void => {};
    this.#inFlight = new Promise<void>((resolve) => {
      settle = resolve;
    });

    try {
      const schedulesFired = await this.fireDueSchedules();
      const deliveriesProcessed = await this.drainDeliveries();
      const zombiesReaped = (await this.#pipeline.reapZombies()).length;
      const sessionsExpired = await this.expireSessions();

      if (this.#onSandboxReap) {
        try {
          await this.#onSandboxReap();
        } catch (error) {
          this.#logger?.error('sandbox reap failed', { error });
        }
      }

      return {
        schedulesFired,
        deliveriesProcessed,
        zombiesReaped,
        sessionsExpired,
        durationMs: this.#clock.monotonic() - startedAt,
      };
    } finally {
      this.#ticking = false;
      this.#inFlight = undefined;
      settle();
    }
  }

  /**
   * Fire every schedule whose time has come.
   *
   * The claim is a compare-and-set on `next_fire_at`, so two scheduler replicas
   * seeing the same due schedule produce exactly one delivery: the first
   * advances the time and the second's update matches no rows.
   */
  async fireDueSchedules(): Promise<number> {
    const now = this.#clock.now();
    const due = await this.#store.connectors.findDueSchedules(now, this.#batchSize);
    let fired = 0;

    for (const { connector, fireAt } of due) {
      const config = safeConfig(connector);
      if (!config) {
        // An unparseable schedule would throw on every tick forever. Disable it
        // and record why, so an operator sees a broken connector rather than a
        // log full of the same error.
        await this.#store.connectors.update(connector.id, {
          status: 'failed',
          error: {
            code: 'INVALID_SCHEDULE_CONFIG',
            message: 'The schedule configuration could not be parsed',
            details: {},
            occurredAt: now,
            retryable: false,
          },
          updatedAt: now,
        });
        continue;
      }

      // `fireAt` comes from the query that selected this row, not from a fresh
      // read. Re-reading it was the double-fire bug: a second replica read the
      // value the first had already advanced and then compare-and-set it to
      // itself, which matches — so both claimed the tick, and the receipt the
      // second minted for *tomorrow* deduplicated tomorrow's real run away. A
      // nightly report fired twice one night and then never again.
      const expected = fireAt;
      const next = nextFireTime(config.cron, config.timezone, now);

      // Claim before doing anything: whoever advances the time owns this tick.
      const claimed = this.#store.connectors.claimSchedule(
        connector.id,
        expected,
        next ?? now + 60_000,
        now,
      );
      if (!claimed) continue;

      // A tick the scheduler was too late to honour is dropped rather than run
      // at the wrong time — a nightly report firing at noon after an outage is
      // worse than not firing.
      const lateBy = now - expected;
      if (lateBy > config.misfireGraceSeconds * 1000) {
        this.#logger?.warn('skipped a missed schedule', {
          connectorId: connector.id,
          lateByMs: lateBy,
        });
        continue;
      }

      if (config.enabledUntil !== undefined && now > config.enabledUntil) continue;
      if (config.enabledFrom !== undefined && now < config.enabledFrom) continue;

      if (config.skipIfRunning && (await this.#hasRunningSession(connector))) {
        this.#logger?.info('skipped a schedule whose previous run is still going', {
          connectorId: connector.id,
        });
        continue;
      }

      await this.#enqueue(connector, expected);
      fired++;
    }

    return fired;
  }

  async #hasRunningSession(connector: Connector): Promise<boolean> {
    if (!connector.agentId) return false;
    const active = await this.#store.sessions.list({
      workspaceId: connector.workspaceId,
      agentId: connector.agentId,
      statuses: ['queued', 'provisioning', 'ready', 'running'],
      limit: 1,
    });
    return active.items.length > 0;
  }

  /** Create the receipt a scheduled fire represents. */
  async #enqueue(connector: Connector, firedAt: number): Promise<void> {
    const trigger = scheduleTrigger(connector, firedAt);
    const now = this.#clock.now();

    await this.#store.receipts.createIfAbsent({
      id: newId('receipt', now),
      connectorId: connector.id,
      workspaceId: connector.workspaceId,
      externalEventId: trigger.externalEventId,
      status: 'pending',
      attempt: 0,
      maxAttempts: 3,
      payloadSummary: trigger.summary,
      createdAt: now,
      updatedAt: now,
      createdBy: `schedule:${connector.id}`,
    });
  }

  /** Process pending deliveries, up to the batch size. */
  async drainDeliveries(): Promise<number> {
    let processed = 0;
    while (processed < this.#batchSize) {
      const worked = await this.#pipeline.processNext();
      if (!worked) break;
      processed++;
    }
    return processed;
  }

  /**
   * Terminate sessions past their logical lease.
   *
   * Without this an abandoned session holds its sandbox and its quota slot
   * until someone notices.
   */
  async expireSessions(limit = 20): Promise<number> {
    const now = this.#clock.now();
    const expired = await this.#store.sessions.findExpired(now, limit);
    let count = 0;

    for (const session of expired) {
      try {
        // Through `shutdown` rather than two raw transitions: driving the
        // status directly skipped the sandbox release, so an expired session
        // reached `terminated` while its environment kept running — the very
        // leak this method exists to prevent. It was only reclaimed later, by
        // lease expiry, and not at all if the lease outlived the TTL.
        await this.#sessions.shutdown(session, 'session expired', {
          type: 'session.expired',
          payload: { expiredAt: session.expiresAt ?? now },
        });
        count++;
      } catch (error) {
        // Losing a race with a user terminating the same session is normal.
        this.#logger?.debug('could not expire a session', { sessionId: session.id, error });
      }
    }
    return count;
  }

  /**
   * Set a schedule's next fire time. Called when one is activated or edited.
   */
  async scheduleNext(connectorId: string): Promise<number | undefined> {
    const connector = await this.#store.connectors.get(connectorId);
    if (!connector || connector.type !== 'schedule') return undefined;

    const config = safeConfig(connector);
    if (!config) return undefined;
    if (connector.status !== 'active') {
      this.#store.connectors.setNextFire(connectorId, undefined, this.#clock.now());
      return undefined;
    }

    const next = nextFireTime(config.cron, config.timezone, this.#clock.now());
    this.#store.connectors.setNextFire(connectorId, next, this.#clock.now());
    return next;
  }
}

/**
 * Parse a schedule's config, or `undefined` when it is malformed.
 *
 * Returning rather than throwing lets the caller disable the connector once,
 * instead of the scheduler rethrowing the same error on every tick forever.
 */
function safeConfig(connector: Connector): ScheduleConfig | undefined {
  try {
    return parseOrThrow(scheduleConfigSchema, connector.config);
  } catch {
    return undefined;
  }
}
