/**
 * Quota admission.
 *
 * Admission happens *before* work starts, and refusal is a first-class outcome:
 * a `queued` session with a stated reason beats a 500 from deep inside the
 * broker. That is the difference between backpressure a user can understand and
 * an outage they cannot.
 *
 * Token quota is windowed per UTC day and derived from the event log rather
 * than a counter column, so it cannot drift out of step with what actually
 * happened — at the cost of an aggregate query, which is acceptable because
 * admission is not on the hot path of a turn.
 */

import { quotaExceeded, validationError, type Clock } from '@ma/core';
import type { QuotaLimits, Workspace } from '@ma/contracts';
import type { Store, UsageDay } from '@ma/store';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Widest span a single usage-history query may cover — a year plus a leap day. */
const MAX_USAGE_HISTORY_DAYS = 366;

/** The dimensions admission can refuse on. */
export type QuotaDimension =
  | 'concurrentSessions'
  | 'sandboxes'
  | 'tokensPerDay'
  | 'costPerDay'
  | 'agents'
  | 'storageMb'
  | 'knowledgeChunks';

export interface QuotaUsage {
  dimension: QuotaDimension;
  limit: number;
  observed: number;
}

export interface AdmissionResult {
  admitted: boolean;
  /** Present when refused; names the dimension and the numbers. */
  refusal?: QuotaUsage;
  /** How long the caller should wait before retrying, in seconds. */
  retryAfterSeconds?: number;
}

/** The UTC-midnight epoch for `now` — the key for the daily usage counter. */
export function utcDayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Seconds until the next UTC midnight, when the token window rolls over. */
export function secondsUntilDailyReset(now: number): number {
  const date = new Date(now);
  const midnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}

export class QuotaService {
  readonly #store: Store;
  readonly #clock: Clock;

  constructor(store: Store, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  /**
   * Can this workspace start another session?
   *
   * Checked dimensions are the ones a new session immediately consumes. Token
   * quota is included because admitting a session into an exhausted budget just
   * produces a failure one turn later, with a sandbox already provisioned.
   */
  async admitSession(workspace: Workspace): Promise<AdmissionResult> {
    const limits = workspace.quota;

    const sessions = await this.#store.sessions.countActive(workspace.id);
    if (sessions >= limits.maxConcurrentSessions) {
      return {
        admitted: false,
        refusal: {
          dimension: 'concurrentSessions',
          limit: limits.maxConcurrentSessions,
          observed: sessions,
        },
        // Sessions end continuously, so a short retry is genuinely likely to
        // succeed — unlike a daily token budget.
        retryAfterSeconds: 30,
      };
    }

    const sandboxes = await this.#store.sandboxes.countActive(workspace.id);
    if (sandboxes >= limits.maxSandboxes) {
      return {
        admitted: false,
        refusal: { dimension: 'sandboxes', limit: limits.maxSandboxes, observed: sandboxes },
        retryAfterSeconds: 30,
      };
    }

    const tokens = await this.tokensUsedToday(workspace.id);
    if (tokens >= limits.maxTokensPerDay) {
      return {
        admitted: false,
        refusal: { dimension: 'tokensPerDay', limit: limits.maxTokensPerDay, observed: tokens },
        retryAfterSeconds: secondsUntilDailyReset(this.#clock.now()),
      };
    }

    // A daily cost ceiling, in micro-dollars. `0` means no cost cap (opt-in),
    // unlike the token dimension where `0` blocks all — so skip the check at 0.
    if (limits.maxCostMicrosPerDay > 0) {
      const cost = await this.costUsedToday(workspace.id);
      if (cost >= limits.maxCostMicrosPerDay) {
        return {
          admitted: false,
          refusal: { dimension: 'costPerDay', limit: limits.maxCostMicrosPerDay, observed: cost },
          retryAfterSeconds: secondsUntilDailyReset(this.#clock.now()),
        };
      }
    }

    return { admitted: true };
  }

  /** Throwing variant, for call sites where refusal is exceptional. */
  async requireSessionAdmission(workspace: Workspace): Promise<void> {
    const result = await this.admitSession(workspace);
    if (result.admitted) return;
    const refusal = result.refusal!;
    throw quotaExceeded(
      refusal.dimension,
      refusal.limit,
      refusal.observed,
      result.retryAfterSeconds,
    );
  }

  async admitAgent(workspace: Workspace): Promise<AdmissionResult> {
    const agents = await this.#store.agents.countByWorkspace(workspace.id);
    if (agents >= workspace.quota.maxAgents) {
      return {
        admitted: false,
        refusal: { dimension: 'agents', limit: workspace.quota.maxAgents, observed: agents },
      };
    }
    return { admitted: true };
  }

  async requireAgentAdmission(workspace: Workspace): Promise<void> {
    const result = await this.admitAgent(workspace);
    if (result.admitted) return;
    const refusal = result.refusal!;
    throw quotaExceeded(refusal.dimension, refusal.limit, refusal.observed);
  }

  /**
   * Tokens billed today, read from the exact per-workspace daily counter.
   *
   * The counter is incremented in the same transaction as each usage record
   * (`SessionService.recordUsage`), so this is exact and O(1) — cheap enough to
   * check on every model completion, not just at session admission. Billed =
   * input + output; cache tokens are excluded (charged at a different rate), the
   * same definition the counter accumulates.
   */
  async tokensUsedToday(workspaceId: string): Promise<number> {
    return this.#store.usage.tokensToday(workspaceId, utcDayStart(this.#clock.now()));
  }

  /**
   * Cost billed today, in micro-dollars, from the same exact daily counter as
   * `tokensUsedToday` — so the cost budget is enforced as cheaply and exactly as
   * the token budget, and both read a single row.
   */
  async costUsedToday(workspaceId: string): Promise<number> {
    return this.#store.usage.costToday(workspaceId, utcDayStart(this.#clock.now()));
  }

  /**
   * Atomically admit-and-reserve an estimated spend against today's caps, or
   * refuse. This is the race-safe replacement for a read-then-compare gate: N
   * concurrent completions cannot all observe the same under-cap snapshot and
   * proceed, because the reservation counts billed + already-reserved and is held
   * atomically. The held estimate must be released with {@link releaseDailyBudget}
   * once the call settles (whether it billed or failed).
   */
  async reserveDailyBudget(
    workspaceId: string,
    estTokens: number,
    estMicros: number,
    tokenLimit: number,
    costLimit: number,
  ): Promise<{
    admitted: boolean;
    dimension?: 'tokensPerDay' | 'costPerDay';
    tokensUsed: number;
    costUsed: number;
    /** The UTC day the estimate is held against; hand it back on release. */
    day: number;
  }> {
    const day = utcDayStart(this.#clock.now());
    const decision = await this.#store.usage.reserveDaily(workspaceId, day, estTokens, estMicros, tokenLimit, costLimit);
    return { ...decision, day };
  }

  /**
   * Release an estimate held by {@link reserveDailyBudget}, against the `day` it
   * was held on. A call can straddle midnight; releasing against "today" would
   * then shrink the new day's in-flight reservations (admitting a call that
   * should be refused) and leave yesterday's estimate held for good.
   */
  async releaseDailyBudget(workspaceId: string, estTokens: number, estMicros: number, day?: number): Promise<void> {
    return this.#store.usage.releaseDaily(
      workspaceId,
      day ?? utcDayStart(this.#clock.now()),
      estTokens,
      estMicros,
    );
  }

  /**
   * The per-day token+cost usage series for a workspace over an inclusive date
   * range, plus a summed total — the spend history behind `GET …/usage`.
   *
   * `fromDay`/`toDay` are any timestamps in the desired days; they are floored to
   * their UTC day so a caller need not align them. The span is bounded
   * (`MAX_USAGE_HISTORY_DAYS`) so a fat-fingered or hostile range cannot scan the
   * whole table — an over-long or reversed range is refused loudly. Absent days
   * are omitted (a gap is zero usage), which the response documents.
   */
  async usageHistory(
    workspaceId: string,
    fromDay?: number,
    toDay?: number,
  ): Promise<{ days: UsageDay[]; total: { inputTokens: number; outputTokens: number; costMicros: number } }> {
    // Default window: the last 30 days ending today. The service owns the clock,
    // so the route need not (and cannot) supply "now".
    const now = this.#clock.now();
    const to = utcDayStart(toDay ?? now);
    const from = utcDayStart(fromDay ?? to - 29 * DAY_MS);
    // Defense in depth against a non-finite bound: an out-of-range epoch-ms (or any
    // NaN that slipped past the caller's parsing) makes `utcDayStart` return NaN,
    // and every guard below is a comparison that NaN passes silently (`NaN < from`,
    // `NaN > MAX` are both false), so the range would resolve to an empty scan and
    // a misleading 200. Reject a non-finite bound explicitly — the gateway's
    // parseDay already bounds its input, this keeps any other caller honest too.
    if (!Number.isFinite(to) || !Number.isFinite(from)) {
      throw validationError('A usage range bound is not a valid date');
    }
    if (to < from) throw validationError('The usage range end is before its start');
    const span = Math.round((to - from) / DAY_MS) + 1;
    if (span > MAX_USAGE_HISTORY_DAYS) {
      throw validationError(`A usage range may span at most ${MAX_USAGE_HISTORY_DAYS} days`);
    }
    const days = await this.#store.usage.usageBetween(workspaceId, from, to);
    const total = days.reduce(
      (sum, d) => ({
        inputTokens: sum.inputTokens + d.inputTokens,
        outputTokens: sum.outputTokens + d.outputTokens,
        costMicros: sum.costMicros + d.costMicros,
      }),
      { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    );
    return { days, total };
  }

  /** A snapshot of every dimension, for the console and for `GET /quota`. */
  async snapshot(workspace: Workspace): Promise<{ limits: QuotaLimits; usage: QuotaUsage[] }> {
    const [sessions, sandboxes, agents, tokens, cost, storageBytes, knowledgeChunks] = await Promise.all([
      this.#store.sessions.countActive(workspace.id),
      this.#store.sandboxes.countActive(workspace.id),
      this.#store.agents.countByWorkspace(workspace.id),
      this.tokensUsedToday(workspace.id),
      this.costUsedToday(workspace.id),
      this.#store.artifacts.totalBytes(workspace.id),
      this.#store.datasets.knowledgeChunksForWorkspace(workspace.id),
    ]);

    return {
      limits: workspace.quota,
      usage: [
        {
          dimension: 'concurrentSessions',
          limit: workspace.quota.maxConcurrentSessions,
          observed: sessions,
        },
        { dimension: 'sandboxes', limit: workspace.quota.maxSandboxes, observed: sandboxes },
        { dimension: 'agents', limit: workspace.quota.maxAgents, observed: agents },
        { dimension: 'tokensPerDay', limit: workspace.quota.maxTokensPerDay, observed: tokens },
        // Micro-dollars spent today against the daily cost ceiling (0 = no cap).
        { dimension: 'costPerDay', limit: workspace.quota.maxCostMicrosPerDay, observed: cost },
        // Real usage now that artifacts store bytes: the summed size of this
        // workspace's live artifacts, in MB, against the limit that
        // `ArtifactService.publish` enforces at upload time. (Earlier this was a
        // hardcoded 0 because artifact storage was not yet built.)
        {
          dimension: 'storageMb',
          limit: workspace.quota.maxStorageMb,
          observed: Math.floor(storageBytes / (1024 * 1024)),
        },
        // Indexed knowledge chunks against the cap enforced at ingestion
        // (`IngestionPipeline.process` refuses a document that would overflow it,
        // because BM25 search is an in-process O(chunks) synchronous scan).
        {
          dimension: 'knowledgeChunks',
          limit: workspace.quota.maxKnowledgeChunks,
          observed: knowledgeChunks,
        },
      ],
    };
  }
}
