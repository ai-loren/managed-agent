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

/** Seconds until the next UTC midnight, when the token window rolls over. */
function secondsUntilDailyReset(now: number): number {
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
   * Tokens consumed today, summed from session usage.
   *
   * Cache tokens are excluded from the billed figure because they are charged
   * at a different rate; counting them here would make the limit mean something
   * different for cache-heavy agents.
   */
  async tokensUsedToday(workspaceId: string): Promise<number> {
    const now = this.#clock.now();
    const date = new Date(now);
    const startOfDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

    let total = 0;
    let cursor: string | undefined;
    do {
      const page = await this.#store.sessions.list({
        workspaceId,
        createdAfter: startOfDay,
        includeArchived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const session of page.items) {
        total += session.usage.inputTokens + session.usage.outputTokens;
      }
      cursor = page.nextCursor;
    } while (cursor);

    return total;
  }

  /** A snapshot of every dimension, for the console and for `GET /quota`. */
  async snapshot(workspace: Workspace): Promise<{ limits: QuotaLimits; usage: QuotaUsage[] }> {
    const [sessions, sandboxes, agents, tokens] = await Promise.all([
      this.#store.sessions.countActive(workspace.id),
      this.#store.sandboxes.countActive(workspace.id),
      this.#store.agents.countByWorkspace(workspace.id),
      this.tokensUsedToday(workspace.id),
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
        // Reported as zero rather than omitted. `maxStorageMb` is a declared
        // limit and `storageMb` a declared dimension, but nothing stores bytes
        // yet — artifacts are not built. Leaving it out of the snapshot meant
        // an operator saw four of five limits with nothing to say the fifth
        // existed, and would reasonably read that as "storage is unlimited"
        // rather than "storage is unimplemented".
        //
        // When artifacts land, `observed` becomes their summed size and the
        // admission check goes beside the others above. Until then this says
        // the limit exists and nothing is consuming it, which is true.
        { dimension: 'storageMb', limit: workspace.quota.maxStorageMb, observed: 0 },
      ],
    };
  }
}
