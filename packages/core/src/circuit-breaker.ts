/**
 * A per-key circuit breaker.
 *
 * Retry absorbs a *transient* failure; this handles a *sustained* one. Once a key
 * (here, a model id) has failed enough times in a short window, the breaker
 * "opens" and every subsequent `canAttempt` returns `allowed: false` until a
 * cooldown elapses — so a caller can skip a dependency it has strong evidence is
 * down, instantly, instead of paying a full retry budget every time and hammering
 * a provider that is already struggling.
 *
 * Three states, standard semantics:
 *  - `closed`    — healthy; calls flow. Failures accumulate in a rolling window.
 *  - `open`      — tripped; `canAttempt` is false until `openedAt + resetMs`.
 *  - `half-open` — after the cooldown, exactly ONE probe is allowed through.
 *                  Success closes the breaker; failure re-opens it for another
 *                  cooldown.
 *
 * Fail-safe by construction: it only ever *skips* a key it has evidence is down,
 * always re-probes after the cooldown, and never blocks a healthy key — so the
 * worst a mistake can do is fail over a moment too eagerly or too late, never
 * lock a key out permanently.
 *
 * In-process and clock-injected, like `withRetry`. State is intentionally not
 * persisted: it is a health signal, cheap to re-learn in one window after a
 * restart. `failureThreshold: 0` (or `enabled: false`) disables it — `canAttempt`
 * is then always allowed, which is exactly the behaviour of not having one.
 */

import { type Clock, systemClock } from './clock.ts';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  clock?: Clock;
  /** Failures within `windowMs` that trip the breaker. `0` disables it. */
  failureThreshold: number;
  /** Rolling window over which failures are counted, in ms. */
  windowMs: number;
  /** How long a tripped breaker stays open before allowing a probe, in ms. */
  resetMs: number;
}

interface KeyState {
  /** Timestamps of recent failures, pruned to the rolling window on access. */
  failures: number[];
  /** When the breaker last opened; `undefined` while closed. */
  openedAt: number | undefined;
  /** True once the single half-open probe has been claimed, until it settles. */
  probing: boolean;
}

export class CircuitBreaker {
  readonly #clock: Clock;
  readonly #failureThreshold: number;
  readonly #windowMs: number;
  readonly #resetMs: number;
  readonly #keys = new Map<string, KeyState>();

  constructor(options: CircuitBreakerOptions) {
    this.#clock = options.clock ?? systemClock;
    this.#failureThreshold = options.failureThreshold;
    this.#windowMs = options.windowMs;
    this.#resetMs = options.resetMs;
  }

  /**
   * Whether the breaker is effectively off (never trips, always allows).
   *
   * Requires both a positive threshold and a positive window: a zero (or
   * negative) window would prune every failure the instant it is recorded, so the
   * breaker could never trip — an "enabled but inert" state that is a
   * misconfiguration, not a feature. Treating it as disabled makes the behaviour
   * honest (and `stateOf`/`canAttempt` consistent) rather than silently dead.
   */
  get enabled(): boolean {
    return this.#failureThreshold > 0 && this.#windowMs > 0;
  }

  #get(key: string): KeyState {
    let state = this.#keys.get(key);
    if (!state) {
      state = { failures: [], openedAt: undefined, probing: false };
      this.#keys.set(key, state);
    }
    return state;
  }

  /**
   * Decide whether a call to `key` may proceed, and report the state that
   * decision was made in.
   *
   * The half-open probe is claimed *synchronously* here — the first caller after
   * the cooldown flips `probing` and is allowed; concurrent callers see `probing`
   * and are refused — so exactly one request probes a maybe-recovered dependency
   * even under async interleaving. The caller MUST later call `recordSuccess` or
   * `recordFailure` so the probe settles; otherwise the breaker stays half-open
   * and no further probe is admitted until it does.
   */
  canAttempt(key: string): { allowed: boolean; state: BreakerState } {
    if (!this.enabled) return { allowed: true, state: 'closed' };
    const state = this.#get(key);

    // Closed: allowed, unless a prune-independent trip is already recorded.
    if (state.openedAt === undefined) return { allowed: true, state: 'closed' };

    const now = this.#clock.now();
    // Still within the open cooldown: skip.
    if (now < state.openedAt + this.#resetMs) {
      return { allowed: false, state: 'open' };
    }

    // Cooldown elapsed → half-open. Admit exactly one probe.
    if (state.probing) {
      // Another request already holds the probe; treat as still-open for us.
      return { allowed: false, state: 'half-open' };
    }
    state.probing = true;
    return { allowed: true, state: 'half-open' };
  }

  /**
   * Record a success.
   *
   * A recovered half-open probe fully resets the key — closed, history cleared,
   * fresh start. A *closed-state* success does NOT wipe the rolling failure
   * window: wiping on every success would make the breaker trip only on failures
   * *uninterrupted* by a success, so a provider failing intermittently (a 50%
   * outage, successes interleaved with failures) would keep resetting the count
   * and never trip — the opposite of what a breaker is for. Closed-state failures
   * instead age out by time, in `recordFailure`'s window prune, so the breaker
   * trips on "N failures within `windowMs`" as documented.
   */
  recordSuccess(key: string): void {
    if (!this.enabled) return;
    const state = this.#get(key);
    // recordSuccess only runs after an *allowed* attempt: either closed (openedAt
    // undefined, probing false) or a half-open probe (probing true). Only the
    // probe case resets — a closed success leaves the rolling window intact.
    if (state.probing) {
      state.failures = [];
      state.openedAt = undefined;
      state.probing = false;
    }
  }

  /**
   * Record a failure of an attempt.
   *
   * `countsTowardTrip` (default true) governs the *closed* state only: a
   * retryable provider failure counts toward the threshold, a non-retryable one
   * (a caller error) does not — passing `false` lets a caller settle an attempt
   * without tripping a healthy key on a bad request.
   *
   * A *half-open* probe is different: it must settle regardless, or `probing`
   * stays stuck forever and the key is never probed again. So a failed probe
   * always clears `probing` and re-opens for another cooldown — `countsTowardTrip`
   * is irrelevant there. Re-opening (rather than closing) on a non-clean probe is
   * the fail-safe choice: it never falsely trusts a key, and it always re-probes.
   */
  recordFailure(key: string, countsTowardTrip = true): void {
    if (!this.enabled) return;
    const state = this.#get(key);
    const now = this.#clock.now();

    // A settled half-open probe re-opens immediately, whatever the error was —
    // this is what prevents a stuck `probing` flag from locking the key out.
    if (state.probing) {
      state.probing = false;
      state.openedAt = now;
      state.failures = [now];
      return;
    }

    // Closed: a non-counting failure (a caller error) must not trip a healthy key.
    if (!countsTowardTrip) return;

    // Closed and counting: record within the rolling window and trip at the
    // threshold.
    state.failures.push(now);
    state.failures = state.failures.filter((at) => at > now - this.#windowMs);
    if (state.failures.length >= this.#failureThreshold) {
      state.openedAt = now;
    }
  }

  /** The current state of `key`, for observability. Does not admit a probe. */
  stateOf(key: string): BreakerState {
    if (!this.enabled) return 'closed';
    const state = this.#keys.get(key);
    if (!state || state.openedAt === undefined) return 'closed';
    if (state.probing) return 'half-open';
    const now = this.#clock.now();
    return now < state.openedAt + this.#resetMs ? 'open' : 'half-open';
  }
}
