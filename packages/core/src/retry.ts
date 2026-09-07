/**
 * Retry with exponential backoff and full jitter.
 *
 * Two rules, both learned from the failure modes this platform must survive:
 *
 *  1. **Only retry what is retryable.** `MaError.retryable` is the authority.
 *     Retrying a validation error is a bug that turns one 400 into five.
 *  2. **Always jitter.** Synchronised retries from many workers are how a brief
 *     blip becomes a thundering herd. We use full jitter (`random(0, delay)`),
 *     which minimises contention better than equal or decorrelated jitter for
 *     our access pattern.
 *
 * Note the deliberate omission: this helper never retries a *mutation* whose
 * outcome is unknown. Callers that mutate pass `retryable: () => false` for
 * ambiguous failures, or route through the idempotency layer instead.
 */

import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import { MaError, timeout as timeoutError } from './errors.ts';

export interface RetryPolicy {
  /** Total attempts including the first. `3` means one try plus two retries. */
  maxAttempts: number;
  /** Delay before the first retry, in ms. */
  initialDelayMs: number;
  /** Ceiling for the computed delay, before jitter. */
  maxDelayMs: number;
  /** Growth factor per attempt. */
  multiplier: number;
  /** Whether to apply full jitter. Off only in tests that assert timings. */
  jitter: boolean;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 10_000,
  multiplier: 2,
  jitter: true,
};

/** Slower, more patient policy for provisioning and other minute-scale work. */
export const PROVISIONING_RETRY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: true,
};

export interface RetryOptions {
  policy?: Partial<RetryPolicy>;
  clock?: Clock;
  signal?: AbortSignal;
  /** Override the retryability decision. Defaults to `MaError.retryable`. */
  retryable?: (error: unknown, attempt: number) => boolean;
  /** Observe each failed attempt — for logging and metrics. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Label used in timeout errors. */
  name?: string;
}

function defaultRetryable(error: unknown): boolean {
  return MaError.is(error) ? error.retryable : false;
}

/** The delay before retry number `attempt` (1-based), in ms. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const exponential = policy.initialDelayMs * policy.multiplier ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return policy.jitter ? Math.round(random() * capped) : Math.round(capped);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...options.policy };
  const clock = options.clock ?? systemClock;
  const isRetryable = options.retryable ?? defaultRetryable;

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= policy.maxAttempts || !isRetryable(error, attempt)) throw error;

      // Honour a server-supplied Retry-After over our own computed backoff.
      const hinted = MaError.is(error) ? error.retryAfterSeconds : undefined;
      const delayMs =
        hinted !== undefined ? hinted * 1000 : backoffDelay(attempt, policy);

      options.onRetry?.({ attempt, delayMs, error });
      await clock.sleep(delayMs, options.signal);
    }
  }
  throw lastError;
}

/** Reject with a `TIMEOUT` error if `promise` outlives `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name = 'operation',
  clock: Clock = systemClock,
): Promise<T> {
  const controller = new AbortController();
  const timer = clock.sleep(ms, controller.signal).then(() => {
    throw timeoutError(name, ms);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    // Cancel the timer so a fast success does not keep a pending sleep around.
    controller.abort();
  }
}
