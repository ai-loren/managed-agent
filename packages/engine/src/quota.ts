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

import { quotaExceeded, type Clock } from '@ma/core';
import type { QuotaLimits, Workspace } from '@ma/contracts';
import type { Store } from '@ma/store';

/** The dimensions admission can refuse on. */
export type QuotaDimension =
  | 'concurrentSessions'
  | 'sandboxes'
  | 'tokensPerDay'
  | 'costPerDay'
  | 'agents'
  | 'storageMb';

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

  /** A snapshot of every dimension, for the console and for `GET /quota`. */
  async snapshot(workspace: Workspace): Promise<{ limits: QuotaLimits; usage: QuotaUsage[] }> {
    const [sessions, sandboxes, agents, tokens, cost, storageBytes] = await Promise.all([
      this.#store.sessions.countActive(workspace.id),
      this.#store.sandboxes.countActive(workspace.id),
      this.#store.agents.countByWorkspace(workspace.id),
      this.tokensUsedToday(workspace.id),
      this.costUsedToday(workspace.id),
      this.#store.artifacts.totalBytes(workspace.id),
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
      ],
    };
  }
}
