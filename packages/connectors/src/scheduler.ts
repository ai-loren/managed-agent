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
  /** Credential expiry sweeps run here; absent means no sweep. */
  credentials?: {
    sweepExpiry(workspaceId: string): Promise<{ expired: number; expiring: number }>;
  };
  logger?: Logger;
  /** How often to look for due schedules and work. */
  tickMs?: number;
  /** Deliveries processed per tick before yielding. */
  batchSize?: number;
  /**
   * How long audit rows are kept, in days. Audit is a platform-wide compliance
   * concern (rows can be system-level, with no owning workspace), so retention
   * is a single global window rather than per workspace. `0` — the default —
   * disables pruning: the audit trail is kept forever unless an operator sets a
   * window, which is the safe default for a compliance log.
   */
  auditRetentionDays?: number;
  /**
   * Reclaim lapsed sandbox leases.
   *
   * Returns the ids it reaped, so the sessions holding them can be told. It
   * used to return nothing, which is why `handleSandboxLost` had no caller: the
   * one place that knew a sandbox had vanished threw the information away.
   */
  onSandboxReap?: () => Promise<readonly string[] | void>;
  /**
   * Observe each completed tick's report. For metrics: the platform translates
   * the per-tick deltas into counters. Kept as a callback so this package stays
   * free of any metrics dependency. Best-effort — a throw here must not fail the
   * tick, so the scheduler guards it.
   */
  onTick?: (report: TickReport) => void;
}

export interface TickReport {
  /** Queued sessions moved into provisioning this tick. */
  sessionsStarted: number;
  /** Idle sessions rolled onto their agent's new production version. */
  sessionsUpgraded: number;
  schedulesFired: number;
  deliveriesProcessed: number;
  zombiesReaped: number;
  sessionsExpired: number;
  /** Events dropped past their workspace's retention window. */
  eventsPruned: number;
  /** Audit rows dropped past the global retention window (0 when disabled). */
  auditPruned: number;
  /** Expired idempotency keys dropped this tick. */
  idempotencyPruned: number;
  /** Credentials marked expired this tick. */
  credentialsExpired: number;
  durationMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Lower bound of `eventRetentionDays` (the schema's `min`).
 *
 * The candidate query uses the shortest window any workspace could set, so it
 * cannot miss a session whose workspace prunes aggressively. Each candidate's
 * actual cutoff comes from its own workspace.
 */
const MIN_RETENTION_DAYS = 1;

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_BATCH = 10;

export class Scheduler {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #pipeline: DeliveryPipeline;
  readonly #sessions: SessionService;
  readonly #credentials:
    | { sweepExpiry(workspaceId: string): Promise<{ expired: number; expiring: number }> }
    | undefined;
  readonly #logger: Logger | undefined;
  readonly #tickMs: number;
  readonly #batchSize: number;
  readonly #auditRetentionMs: number;
  readonly #onSandboxReap: (() => Promise<readonly string[] | void>) | undefined;
  readonly #onTick: ((report: TickReport) => void) | undefined;

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
    this.#credentials = options.credentials;
    this.#logger = options.logger;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.#auditRetentionMs = (options.auditRetentionDays ?? 0) * DAY_MS;
    this.#onSandboxReap = options.onSandboxReap;
    this.#onTick = options.onTick;
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
        sessionsStarted: 0,
        sessionsUpgraded: 0,
        schedulesFired: 0,
        deliveriesProcessed: 0,
        zombiesReaped: 0,
        sessionsExpired: 0,
        eventsPruned: 0,
        auditPruned: 0,
        idempotencyPruned: 0,
        credentialsExpired: 0,
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
      // Each sweep is isolated: one sweep's failure (a transient SQLITE_BUSY on
      // its batch-fetch, or a single corrupt row that makes its decode throw)
      // must not skip every sweep ordered after it. Before this, the sweeps were
      // bare sequential awaits under a lone `finally`, so a throw escaped `tick()`
      // to `#loop` and silently dropped delivery draining, zombie reaping, session
      // expiry, retention prunes and the credential sweep for that pass —
      // platform-wide, and every pass if the trigger was a persistent bad row.
      const sessionsStarted = await this.#runSweep('provisionQueued', () => this.provisionQueued());
      const sessionsUpgraded = await this.#runSweep('applyUpgrades', () => this.applyUpgrades());
      const schedulesFired = await this.#runSweep('fireDueSchedules', () => this.fireDueSchedules());
      const deliveriesProcessed = await this.#runSweep('drainDeliveries', () => this.drainDeliveries());
      const zombiesReaped = await this.#runSweep(
        'reapZombies',
        async () => (await this.#pipeline.reapZombies()).length,
      );
      const sessionsExpired = await this.#runSweep('expireSessions', () => this.expireSessions());
      const eventsPruned = await this.#runSweep('pruneExpiredEvents', () => this.pruneExpiredEvents());
      const auditPruned = await this.#runSweep('pruneExpiredAudit', () => this.pruneExpiredAudit());
      const idempotencyPruned = await this.#runSweep('pruneExpiredIdempotency', () =>
        this.pruneExpiredIdempotency(),
      );

      if (this.#onSandboxReap) {
        try {
          const reaped = await this.#onSandboxReap();
          // Sessions pointing at a reaped sandbox are told, so they can
          // re-provision rather than sitting `ready` against nothing.
          if (Array.isArray(reaped) && reaped.length > 0) {
            await this.recoverLostSandboxes(reaped);
          }
        } catch (error) {
          this.#logger?.error('sandbox reap failed', { error });
        }
      }

      const credentialsExpired = await this.#runSweep('sweepCredentials', () => this.sweepCredentials());

      const report: TickReport = {
        sessionsStarted,
        sessionsUpgraded,
        schedulesFired,
        deliveriesProcessed,
        zombiesReaped,
        sessionsExpired,
        eventsPruned,
        auditPruned,
        idempotencyPruned,
        credentialsExpired,
        durationMs: this.#clock.monotonic() - startedAt,
      };
      if (this.#onTick) {
        // Best-effort observation (metrics) — never let it fail the tick.
        try {
          this.#onTick(report);
        } catch (error) {
          this.#logger?.error('scheduler onTick observer failed', { error });
        }
      }
      return report;
    } finally {
      this.#ticking = false;
      this.#inFlight = undefined;
      settle();
    }
  }

  /**
   * Run one sweep in isolation: on failure, log it and return `0` (no work done
   * this pass) rather than let the throw abort the rest of the tick. This is what
   * makes the sweeps independent — a transient batch-fetch error, or a single
   * poison row that makes a sweep's decode throw, costs that one sweep this pass
   * and nothing more, instead of starving every sweep ordered after it.
   */
  async #runSweep(name: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      this.#logger?.error('scheduler sweep failed', { sweep: name, error });
      return 0;
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
        // An unparseable schedule would throw on every tick forever. Disable
        // it and record why, so an operator sees a broken connector rather
        // than a log full of the same error. Guard the disable itself the same
        // way the unfireable-config path below does: if the store write throws
        // (a locked database), leaving it for the next tick is far better than
        // letting it escape and abort the rest of this tick's periodic work.
        await this.#disableSchedule(
          connector.id,
          'The schedule configuration could not be parsed',
          now,
        ).catch((disableError) => {
          this.#logger?.error('failed to disable an unparseable schedule', {
            connectorId: connector.id,
            error: disableError,
          });
        });
        continue;
      }

      // Compute the next fire time *before* claiming, in its own guard. This is
      // the one step that throws on a schema-valid but semantically-invalid
      // config — a cron `60 0 * * *` (minute out of range) or a timezone
      // `Mars/Phobos`. That throw used to escape `fireDueSchedules` and, because
      // it happened before `claimSchedule` advanced `next_fire_at`, re-threw on
      // every tick forever, halting all periodic work. Only *this* failure means
      // the config is broken, so only this failure disables the connector.
      let next: number | undefined;
      try {
        next = nextFireTime(config.cron, config.timezone, now);
      } catch (error) {
        this.#logger?.error('a schedule has an unfireable config; disabling it', {
          connectorId: connector.id,
          error,
        });
        await this.#disableSchedule(
          connector.id,
          error instanceof Error ? error.message : 'The schedule configuration is invalid',
          now,
        ).catch((disableError) => {
          // If even disabling fails (a transient store error), leave it for the
          // next tick rather than letting it halt this one.
          this.#logger?.error('failed to disable a broken schedule', {
            connectorId: connector.id,
            error: disableError,
          });
        });
        continue;
      }

      // `undefined` means the cron is well-formed but names no real time — a day
      // that never exists (`0 0 30 2 *`), or nothing within the ~10-year search
      // horizon (which is wide enough to cover the sparsest *valid* cron, every
      // leap-day Feb 29, across the century leap gap — so undefined genuinely
      // means unfireable, not merely sparse). It must be disabled, NOT treated as
      // "retry soon": the claim below would otherwise re-arm it every minute
      // forever. Disable it with the same fail-closed handling as an invalid
      // config.
      if (next === undefined) {
        this.#logger?.error('a schedule names no real fire time; disabling it', {
          connectorId: connector.id,
          cron: config.cron,
        });
        await this.#disableSchedule(
          connector.id,
          'The schedule names no real time (e.g. a day-of-month that never occurs)',
          now,
        ).catch((disableError) => {
          this.#logger?.error('failed to disable an unfireable schedule', {
            connectorId: connector.id,
            error: disableError,
          });
        });
        continue;
      }

      // Everything below is store I/O, not config evaluation. A transient error
      // here (SQLITE_BUSY under write contention, say) must NOT be mistaken for
      // a bad config: disabling a valid connector on a locked database would
      // take a healthy schedule permanently out of service. Let it propagate to
      // the caller, which logs it and moves on; the schedule stays active and
      // the next tick retries it. It is isolated per-connector so one failure
      // does not skip the rest of the batch.
      try {
        // `fireAt` comes from the query that selected this row, not from a
        // fresh read. Re-reading it was the double-fire bug: a second replica
        // read the value the first had already advanced and then
        // compare-and-set it to itself, which matches — so both claimed the
        // tick, and the receipt the second minted for *tomorrow* deduplicated
        // tomorrow's real run away. A nightly report fired twice one night and
        // then never again.
        const expected = fireAt;

        // Claim before doing anything: whoever advances the time owns this tick.
        // `next` is guaranteed defined here — an undefined next fire time was
        // handled above by disabling the schedule, so it can never fall through
        // as a "retry in 60s" that would re-fire every minute.
        const claimed = this.#store.connectors.claimSchedule(
          connector.id,
          expected,
          next,
          now,
        );
        if (!claimed) continue;

        // A tick the scheduler was too late to honour is dropped rather than
        // run at the wrong time — a nightly report firing at noon after an
        // outage is worse than not firing.
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
      } catch (error) {
        // A store error after the config was already validated. The connector is
        // not broken, so it is left active and simply retried next tick; only
        // this connector's turn is lost, not the whole batch.
        this.#logger?.error('a schedule could not be fired this tick; will retry', {
          connectorId: connector.id,
          error,
        });
      }
    }

    return fired;
  }

  /**
   * Take a schedule connector out of service after its config proved unfireable.
   *
   * Reserved for genuine config faults — an unparseable body, or a cron/timezone
   * that cannot produce a fire time. A transient store error is never routed
   * here: disabling a valid connector because the database was briefly locked
   * would take a healthy schedule permanently out of service (`findDueSchedules`
   * only selects `active`, and `INVALID_SCHEDULE_CONFIG` is `retryable: false`).
   */
  async #disableSchedule(connectorId: string, message: string, now: number): Promise<void> {
    await this.#store.connectors.update(connectorId, {
      status: 'failed',
      error: {
        code: 'INVALID_SCHEDULE_CONFIG',
        message,
        details: {},
        occurredAt: now,
        retryable: false,
      },
      updatedAt: now,
    });
  }

  async #hasRunningSession(connector: Connector): Promise<boolean> {
    if (!connector.agentId) return false;
    // "Is a previous run *of this schedule* still doing work?" — scoped to this
    // connector's own sessions. Without the connector scope it counted every live
    // session for the agent (a human's chat, another connector's run, an unrelated
    // idle session that lingers ~24h under new_per_event), so a sub-daily schedule
    // could be silently skipped forever by traffic that has nothing to do with it.
    //
    // Deliberately narrower than SESSION_ACTIVE_STATUSES (which the archive guard
    // uses to mean "still holds a sandbox"). `terminating` is winding down, its
    // work over, so a new run should proceed rather than be skipped; but `idle`
    // (served a turn and waiting, still mid-conversation) is very much a run in
    // progress and must count, or two scheduled runs would overlap.
    const active = await this.#store.sessions.list({
      workspaceId: connector.workspaceId,
      agentId: connector.agentId,
      connectorId: connector.id,
      statuses: ['queued', 'provisioning', 'ready', 'running', 'idle'],
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
      responseContext: {},
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
   * Provision sessions that are waiting to run.
   *
   * Without this the platform accepts a session and never starts it: `create`
   * leaves it `queued`, and `submit` refuses anything that is not `ready`, so
   * the core loop — create a session, send it a prompt, get output — did not
   * work at all. `SessionService.start` existed and was called only by tests.
   *
   * This also re-provisions a session recovering from a lost sandbox:
   * `handleSandboxLost` returns an in-TTL session to `queued`, so it flows back
   * through exactly this path rather than needing a second, less-guarded one.
   *
   * Bounded per tick so one burst of sessions cannot monopolise the loop that
   * also fires schedules and reaps zombies. `start` transitions out of `queued`
   * with a compare-and-set, so two replicas seeing the same row produce one
   * winner and one conflict — which is expected here, not an error, and is the
   * single claim that stops a session from being provisioned twice.
   */
  async provisionQueued(limit = 5): Promise<number> {
    const queued = await this.#store.sessions.findQueued(limit);
    let started = 0;

    for (const session of queued) {
      try {
        await this.#sessions.start(session.id);
        started++;
      } catch (error) {
        // Losing the race to another replica is normal. A genuine provisioning
        // failure has already been recorded on the session row by `start`,
        // which is where an operator looks — logging it again at error level
        // would make a full sandbox pool look like a platform fault.
        this.#logger?.debug('could not provision a queued session', {
          sessionId: session.id,
          error,
        });
      }
    }

    return started;
  }

  /**
   * Roll idle sessions onto their agent's new production version.
   *
   * Level-triggered: it re-reads which sessions are behind each tick, so an
   * upgrade published while a session was mid-turn is applied once it goes idle,
   * without anyone tracking pending upgrades. Each session's agent's current
   * production version is the target; `SessionService.upgrade` re-pins and
   * rebinds (or re-provisions if the sandbox spec changed), and refuses anything
   * not safely idle, so a losing race or a busy session is a no-op here.
   */
  async applyUpgrades(limit = 5): Promise<number> {
    const behind = await this.#store.sessions.findUpgradable(limit);
    let upgraded = 0;

    for (const session of behind) {
      try {
        const agent = await this.#store.agents.get(session.agentId);
        const target = agent?.productionVersion;
        if (target === undefined || target <= session.resolvedVersion) continue;
        const result = await this.#sessions.upgrade(session.id, target);
        if (result.resolvedVersion >= target) upgraded++;
      } catch (error) {
        // A failed upgrade is not fatal: the session keeps running its old
        // version and the sweep retries next tick.
        this.#logger?.warn('could not upgrade a session', { sessionId: session.id, error });
      }
    }

    return upgraded;
  }

  /**
   * Tell sessions whose sandbox was reaped, so they can recover.
   *
   * The broker marks a sandbox `lost` and destroys it, but nothing told the
   * *session* — `handleSandboxLost` had no caller, so a session whose
   * environment vanished sat in `ready` forever, pointing at a sandbox that no
   * longer existed. The parity table claimed "a lost sandbox re-provisions";
   * this is what makes that true.
   *
   * A session inside its TTL returns to `queued` and is provisioned afresh by
   * the provisioning sweep on the next tick — through the same atomic
   * queued→provisioning claim a first start uses, so a lost sandbox cannot be
   * re-provisioned twice. One past its TTL fails, because re-provisioning work
   * nobody is waiting for burns capacity.
   */
  async recoverLostSandboxes(sandboxIds: readonly string[]): Promise<number> {
    let recovered = 0;

    for (const sandboxId of sandboxIds) {
      try {
        // Direct lookup, not a capped scan: a sandbox is held by at most one
        // non-terminal session, and listing "the first 50 active sessions" then
        // filtering client-side silently missed the holder in any workspace with
        // more than 50 active sessions — leaving it `ready` against a dead sandbox
        // forever, the exact leak this recovery exists to close.
        const holder = await this.#store.sessions.getBySandboxId(sandboxId);
        if (!holder) continue;
        await this.#sessions.handleSandboxLost(holder.id, true);
        recovered++;
      } catch (error) {
        this.#logger?.warn('could not notify a session of its lost sandbox', {
          sandboxId,
          error,
        });
      }
    }

    return recovered;
  }

  /**
   * Expire credentials that have passed their date.
   *
   * `sweepExpiry` had no production caller, so a credential's `expiresAt` was
   * recorded and never acted on: an expired secret stayed `active` and an
   * agent kept exchanging it.
   */
  async sweepCredentials(limit = 20): Promise<number> {
    if (!this.#credentials) return 0;
    let expired = 0;

    // Per workspace, because the service scopes the sweep that way — a
    // credential belongs to a tenant and so does the decision to expire it.
    // Bounded per tick like every other sweep here.
    const workspaces = await this.#store.workspaces.list({ limit });
    for (const workspace of workspaces.items) {
      try {
        const result = await this.#credentials.sweepExpiry(workspace.id);
        expired += result.expired;
      } catch (error) {
        this.#logger?.warn('credential expiry sweep failed', {
          workspaceId: workspace.id,
          error,
        });
      }
    }

    return expired;
  }

  /**
   * Drop events past their workspace's retention window.
   *
   * `docs/operations.md` describes this as an operating behaviour, and nothing
   * was doing it — `events.prune` had no production caller, so every session's
   * log grew forever and the events table became the largest thing in the
   * database with no way to shrink it.
   *
   * Retention is per workspace, so the window is read from the owning
   * workspace's quota rather than a global setting. Pruning truncates the head
   * and never leaves a hole: `seqBefore` finds the highest expired sequence and
   * everything at or below it goes, so a lagging consumer can always resume
   * from `earliestSeq`.
   */
  async pruneExpiredEvents(limit = 20): Promise<number> {
    const now = this.#clock.now();
    // The *shortest* window any workspace could set, which is the earliest an
    // event could possibly expire. Using the longest was backwards — nothing is
    // ever older than ten years, so the sweep found no candidates at all and
    // silently did nothing, which is precisely the failure this whole method
    // exists to fix.
    //
    // Each candidate's real cutoff is then read from its own workspace below;
    // this query only narrows the scan.
    const earliest = now - MIN_RETENTION_DAYS * DAY_MS;
    const sessionIds = await this.#store.events.findSessionsWithExpiredEvents(earliest, limit);
    let pruned = 0;

    for (const sessionId of sessionIds) {
      try {
        const session = await this.#store.sessions.get(sessionId);
        if (!session) continue;
        const workspace = await this.#store.workspaces.get(session.workspaceId);
        if (!workspace) continue;

        const cutoff = now - workspace.quota.eventRetentionDays * DAY_MS;
        const expiredThrough = await this.#store.events.seqBefore(sessionId, cutoff);
        if (expiredThrough === 0) continue;

        pruned += await this.#store.events.prune(sessionId, expiredThrough + 1);
      } catch (error) {
        // One unprunable session must not stop the sweep.
        this.#logger?.warn('failed to prune a session log', { sessionId, error });
      }
    }

    return pruned;
  }

  /**
   * Drop audit rows past the global retention window.
   *
   * `audit.prune` was fully implemented and had no production caller, so the
   * audit trail grew forever — the same "implemented but unwired" gap that left
   * event logs, credential expiry and sandbox recovery silently inert until each
   * was connected to this loop.
   *
   * Retention is a single global window, not per workspace: an audit row can be
   * system-level (no owning workspace), and a compliance log is a
   * platform-wide policy rather than a per-tenant setting. Disabled by default
   * (`auditRetentionDays: 0`) — deleting a compliance record is not something to
   * do unless an operator has chosen a window, so the safe default is to keep
   * everything.
   */
  async pruneExpiredAudit(): Promise<number> {
    if (this.#auditRetentionMs <= 0) return 0;
    const cutoff = this.#clock.now() - this.#auditRetentionMs;
    try {
      return await this.#store.audit.prune(cutoff);
    } catch (error) {
      // A failed sweep must not take the tick down; it retries next tick.
      this.#logger?.warn('failed to prune the audit trail', { error });
      return 0;
    }
  }

  /**
   * Drop idempotency keys past their own expiry.
   *
   * `idempotency.prune` was fully implemented and had no production caller, so
   * the `idempotency_keys` table grew forever — the same "implemented but
   * unwired" gap that left event logs, the audit trail, credential expiry and
   * sandbox recovery silently inert until each was connected to this loop.
   *
   * Unlike audit, this needs no retention policy: an idempotency key already
   * carries its own `expiresAt`, and an expired one is dead weight — `reserve`
   * already treats it as reclaimable. So the cutoff is simply "now": every key
   * already past its TTL is deleted. Nothing else references the row, so there is
   * no cascade to worry about, and a key deleted a moment before a late retry
   * behaves exactly as an unknown key does — a fresh reservation, which is the
   * correct outcome once the guarantee window has elapsed.
   */
  async pruneExpiredIdempotency(): Promise<number> {
    try {
      return await this.#store.idempotency.prune(this.#clock.now());
    } catch (error) {
      // A failed sweep must not take the tick down; it retries next tick.
      this.#logger?.warn('failed to prune expired idempotency keys', { error });
      return 0;
    }
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
    if (next === undefined) {
      // Well-formed cron that names no real time (e.g. a day that never exists).
      // Disabling it — rather than silently writing an undefined next fire and
      // leaving the connector `active` but dormant — tells the operator at
      // activation/edit time that the schedule can never run, instead of it just
      // never firing with no signal. Mirrors the fire-loop's handling. The search
      // horizon is wide enough that a legitimately-sparse cron (every Feb 29)
      // resolves, so undefined here means genuinely unfireable.
      await this.#disableSchedule(
        connectorId,
        'The schedule names no real time (e.g. a day-of-month that never occurs)',
        this.#clock.now(),
      );
      return undefined;
    }
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
